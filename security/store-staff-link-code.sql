-- Store-level employee connection code migration.
-- Staging first. Production only as part of security-v2 cutover.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.stores add column if not exists staff_join_code text;
create unique index if not exists stores_staff_join_code_key on public.stores(staff_join_code) where staff_join_code is not null;

create or replace function private.generate_store_staff_code()
returns text language plpgsql volatile security definer set search_path='' as $$
declare candidate text;
begin
  loop
    candidate := translate(upper(substr(md5(gen_random_uuid()::text || clock_timestamp()::text || random()::text),1,8)),'01','XY');
    exit when not exists(select 1 from public.stores where staff_join_code=candidate);
  end loop;
  return candidate;
end;
$$;
revoke all on function private.generate_store_staff_code() from public,anon,authenticated;

create or replace function private.assign_store_staff_code()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.staff_join_code is null or btrim(new.staff_join_code)='' then
    new.staff_join_code:=private.generate_store_staff_code();
  else
    new.staff_join_code:=upper(btrim(new.staff_join_code));
    if new.staff_join_code !~ '^[A-HJ-NP-Z2-9]{8}$' then
      raise exception 'Invalid store staff code' using errcode='22023';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.assign_store_staff_code() from public,anon,authenticated;

drop trigger if exists stores_assign_staff_join_code on public.stores;
create trigger stores_assign_staff_join_code
before insert on public.stores
for each row execute function private.assign_store_staff_code();

do $backfill$
declare r record; candidate text;
begin
  for r in select id from public.stores where staff_join_code is null loop
    loop
      candidate:=private.generate_store_staff_code();
      begin
        update public.stores set staff_join_code=candidate where id=r.id;
        exit;
      exception when unique_violation then
        null;
      end;
    end loop;
  end loop;
end
$backfill$;

alter table private.staff_link_requests alter column crew_id drop not null;
create unique index if not exists staff_link_pending_requester_store_idx
  on private.staff_link_requests(requester_user_id,store_id) where status='pending';

-- Keep the previous portal implementation as a rollback target, then wrap only the
-- actions whose semantics change for store-level connection codes.
do $rename$
begin
  if to_regprocedure('private.manee_staff_portal_v1(text,jsonb)') is null then
    alter function private.manee_staff_portal(text,jsonb) rename to manee_staff_portal_v1;
  end if;
end
$rename$;

create or replace function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  profile public.profiles%rowtype;
  req private.staff_link_requests%rowtype;
  person public.crew%rowtype;
  member public.store_memberships%rowtype;
  st public.stores%rowtype;
  rid uuid; sid uuid; cid uuid; code text; was_revoked boolean:=false;
begin
  if p_action not in ('preview','request','owner_list','regenerate_store_code','approve','reject') then
    return private.manee_staff_portal_v1(p_action,p_payload);
  end if;

  if actor is null or not private.is_live_manee_session() then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  select * into profile from public.profiles where user_id=actor and status='active' for share;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;

  if p_action='preview' then
    if not public.consume_auth_rate_limit('staff_store_link_preview',md5(actor::text),300,20) then
      return jsonb_build_object('ok',false,'error','rate_limited');
    end if;
    code:=upper(replace(btrim(coalesce(p_payload->>'code','')),' ',''));
    if code !~ '^[A-HJ-NP-Z2-9]{8}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into st from public.stores where staff_join_code=code and archived_at is null for share;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    return jsonb_build_object('ok',true,'store_name',st.name);
  end if;

  if p_action='request' then
    if not public.consume_auth_rate_limit('staff_store_link_request',md5(actor::text),300,10) then
      return jsonb_build_object('ok',false,'error','rate_limited');
    end if;
    code:=upper(replace(btrim(coalesce(p_payload->>'code','')),' ',''));
    if code !~ '^[A-HJ-NP-Z2-9]{8}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into st from public.stores where staff_join_code=code and archived_at is null for share;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;

    select * into member from public.store_memberships where user_id=actor and store_id=st.id;
    if found and member.role='owner' then return jsonb_build_object('ok',false,'error','store_account_conflict'); end if;
    if found and member.status='active' then return jsonb_build_object('ok',false,'error','already_linked'); end if;

    update private.staff_link_requests set status='expired',reviewed_at=now()
      where requester_user_id=actor and status='pending' and expires_at<=now();
    select id into rid from private.staff_link_requests
      where requester_user_id=actor and store_id=st.id and status='pending' and expires_at>now() limit 1;
    if rid is not null then return jsonb_build_object('ok',true,'request_id',rid); end if;
    if (select count(*) from private.staff_link_requests where requester_user_id=actor and status='pending')>=10 then
      return jsonb_build_object('ok',false,'error','too_many_pending');
    end if;
    insert into private.staff_link_requests(requester_user_id,store_id,crew_id)
      values(actor,st.id,null) returning id into rid;
    return jsonb_build_object('ok',true,'request_id',rid);
  end if;

  if p_action='owner_list' then
    sid:=(p_payload->>'store_id')::uuid;
    if not private.has_store_membership(sid,array['owner']::text[]) then
      raise exception 'Owner permission required' using errcode='42501';
    end if;
    select * into st from public.stores where id=sid and archived_at is null for share;
    if not found then raise exception 'Owner permission required' using errcode='42501'; end if;
    return jsonb_build_object(
      'ok',true,
      'store_join_code',st.staff_join_code,
      'requests',coalesce((select jsonb_agg(q) from (
        select r.id,p.username,p.display_name,r.requested_at,r.expires_at
        from private.staff_link_requests r
        join public.profiles p on p.user_id=r.requester_user_id
        where r.store_id=sid and r.status='pending' and r.expires_at>now()
        order by r.requested_at limit 100
      ) q),'[]'::jsonb),
      'available_crew',coalesce((select jsonb_agg(q) from (
        select c.id as crew_id,c.name as crew_name,c.position
        from public.crew c
        where c.store_id=sid and (c.resign_date is null or c.resign_date>(now() at time zone 'Asia/Seoul')::date)
        order by c.name
      ) q),'[]'::jsonb),
      'links',coalesce((select jsonb_agg(q) from (
        select sm.id,c.name as crew_name,p.username,p.display_name,sm.status,sm.role
        from public.store_memberships sm
        join public.profiles p on p.user_id=sm.user_id
        join public.crew c on c.id=sm.crew_id and c.store_id=sm.store_id
        where sm.store_id=sid and sm.role in ('staff','manager') order by c.name
      ) q),'[]'::jsonb),
      'attendance_edits',coalesce((select jsonb_agg(q) from (
        select r.id,c.name as crew_name,a.date,r.requested_check_in,r.requested_check_out,r.reason
        from public.attendance_edit_requests r
        join public.crew c on c.id=r.crew_id join public.attendance a on a.id=r.attendance_id
        where r.store_id=sid and r.status='pending' order by r.requested_at limit 100
      ) q),'[]'::jsonb)
    );
  end if;

  if p_action='regenerate_store_code' then
    sid:=(p_payload->>'store_id')::uuid;
    if not private.has_store_membership(sid,array['owner']::text[]) then
      raise exception 'Owner permission required' using errcode='42501';
    end if;
    select * into st from public.stores where id=sid and archived_at is null for update;
    if not found then raise exception 'Owner permission required' using errcode='42501'; end if;
    loop
      code:=private.generate_store_staff_code();
      begin
        update public.stores set staff_join_code=code where id=sid;
        exit;
      exception when unique_violation then
        null;
      end;
    end loop;
    return jsonb_build_object('ok',true,'store_join_code',code);
  end if;

  select * into req from private.staff_link_requests where id=(p_payload->>'request_id')::uuid;
  if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  sid:=req.store_id;
  select * into st from public.stores where id=sid and archived_at is null for share;
  if not found or not private.has_store_membership(sid,array['owner']::text[]) then
    raise exception 'Owner permission required' using errcode='42501';
  end if;
  perform 1 from public.store_memberships where user_id=actor and store_id=sid and role='owner' and status='active' for share;
  if not found then raise exception 'Owner permission required' using errcode='42501'; end if;
  select * into req from private.staff_link_requests where id=req.id for update;
  if req.status<>'pending' then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  if req.expires_at<=now() then
    update private.staff_link_requests set status='expired',reviewed_at=now() where id=req.id;
    return jsonb_build_object('ok',false,'error','request_expired');
  end if;

  if p_action='reject' then
    update private.staff_link_requests set status='rejected',reviewed_at=now(),reviewed_by=actor where id=req.id;
    return jsonb_build_object('ok',true);
  end if;

  begin cid:=(p_payload->>'crew_id')::uuid;
  exception when others then return jsonb_build_object('ok',false,'error','record_unavailable'); end;
  select * into person from public.crew where id=cid and store_id=sid for update;
  if not found or (person.resign_date is not null and person.resign_date<=(now() at time zone 'Asia/Seoul')::date) then
    return jsonb_build_object('ok',false,'error','record_unavailable');
  end if;
  perform 1 from public.profiles where user_id=req.requester_user_id and status='active' for share;
  if not found then return jsonb_build_object('ok',false,'error','account_unavailable'); end if;

  select * into member from public.store_memberships where crew_id=person.id for update;
  if found and member.user_id<>req.requester_user_id then
    return jsonb_build_object('ok',false,'error','record_already_linked');
  end if;
  select * into member from public.store_memberships where user_id=req.requester_user_id and store_id=sid for update;
  if found and (member.role='owner' or member.crew_id is distinct from person.id) then
    return jsonb_build_object('ok',false,'error','store_account_conflict');
  end if;
  if member.id is null then
    begin
      insert into public.store_memberships(user_id,store_id,crew_id,role,status)
        values(req.requester_user_id,sid,person.id,'staff','active') returning * into member;
    exception when unique_violation then
      return jsonb_build_object('ok',false,'error','connection_conflict');
    end;
  else
    was_revoked:=member.status='revoked';
    update public.store_memberships set status='active',revoked_at=null where id=member.id;
  end if;
  update private.staff_link_requests
    set crew_id=person.id,status='approved',reviewed_at=now(),reviewed_by=actor,membership_id=member.id
    where id=req.id;
  insert into private.staff_access_events(actor_user_id,target_user_id,store_id,crew_id,membership_id,action)
    values(actor,req.requester_user_id,sid,person.id,member.id,case when was_revoked then 'reactivated' else 'approved' end);
  return jsonb_build_object('ok',true,'membership_id',member.id);
end;
$$;

revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;

create or replace function public.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.manee_staff_portal(p_action,p_payload);
$$;
revoke all on function public.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function public.manee_staff_portal(text,jsonb) to authenticated;

commit;
