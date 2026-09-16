-- Store-level staff joining. Run AFTER staff Auth, recovery and permission migrations.
-- Staging first; production requires a separate approved security-v2 rollout.
-- Codes locate stores; they NEVER grant membership without owner approval.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.stores add column if not exists staff_join_code text;
create unique index if not exists stores_staff_join_code_key on public.stores(staff_join_code) where staff_join_code is not null;
-- Preserve all issued codes, including retired ones, so they cannot be reassigned.
create table if not exists private.store_staff_code_history (
  code text primary key check(code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  store_id uuid not null,
  issued_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz
);
create index if not exists store_staff_code_history_store_idx on private.store_staff_code_history(store_id);
alter table private.store_staff_code_history enable row level security;
revoke all on private.store_staff_code_history from public,anon,authenticated;
insert into private.store_staff_code_history(code,store_id,activated_at)
select staff_join_code,id,now() from public.stores where staff_join_code is not null
on conflict(code) do nothing;

create or replace function private.generate_store_staff_code()
returns text language plpgsql volatile set search_path='' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := decode(replace(gen_random_uuid()::text,'-',''),'hex');
  value bigint:=0; candidate text:=''; i integer;
begin
  -- The first five bytes of a random UUID contain 40 random bits (no version bits).
  for i in 0..4 loop value:=(value<<8) | get_byte(bytes,i)::bigint; end loop;
  for i in 1..8 loop
    candidate:=substr(alphabet,(value & 31)::int+1,1)||candidate;
    value:=value>>5;
  end loop;
  return candidate;
end;
$$;
create or replace function private.reserve_store_staff_code(p_store_id uuid)
returns text language plpgsql volatile security definer set search_path='' as $$
declare candidate text; i integer;
begin
  if p_store_id is null then raise exception 'Store required' using errcode='22023'; end if;
  for i in 1..100 loop
    candidate:=private.generate_store_staff_code();
    insert into private.store_staff_code_history(code,store_id) values(candidate,p_store_id)
      on conflict(code) do nothing;
    if found then return candidate; end if;
  end loop;
  raise exception 'Code allocation busy; retry' using errcode='40001';
end;
$$;
revoke all on function private.generate_store_staff_code(),private.reserve_store_staff_code(uuid) from public,anon,authenticated;

create or replace function private.assign_store_staff_code()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    -- Ignore caller-supplied codes. Every new store gets a server-assigned code.
    new.staff_join_code:=private.reserve_store_staff_code(new.id);
  elsif new.staff_join_code is not distinct from old.staff_join_code then
    return new;
  end if;
  perform 1 from private.store_staff_code_history
    where code=new.staff_join_code and store_id=new.id and activated_at is null for update;
  if not found then raise exception 'Use the owner code rotation action' using errcode='42501'; end if;
  if tg_op='UPDATE' then
    update private.store_staff_code_history set retired_at=now() where code=old.staff_join_code;
  end if;
  update private.store_staff_code_history set activated_at=now() where code=new.staff_join_code;
  return new;
end;
$$;
revoke all on function private.assign_store_staff_code() from public,anon,authenticated;
drop trigger if exists stores_assign_staff_join_code on public.stores;
create trigger stores_assign_staff_join_code before insert or update of staff_join_code on public.stores
  for each row execute function private.assign_store_staff_code();
do $backfill$
declare r record;
begin
  for r in select id from public.stores where staff_join_code is null order by id for update loop
    update public.stores set staff_join_code=private.reserve_store_staff_code(r.id) where id=r.id;
  end loop;
end
$backfill$;
alter table public.stores alter column staff_join_code set not null;

-- Refuse ambiguous historical requests rather than deleting existing records.
do $preflight$
begin
  if exists(select 1 from private.staff_link_requests where status='pending'
    group by requester_user_id,store_id having count(*)>1) then
    raise exception 'Review duplicate pending employee/store requests before migration';
  end if;
end
$preflight$;
alter table private.staff_link_requests alter column crew_id drop not null;
create unique index if not exists staff_link_pending_requester_store_idx
  on private.staff_link_requests(requester_user_id,store_id) where status='pending';

do $rename$
begin
  if to_regprocedure('private.manee_staff_portal_v1(text,jsonb)') is null then
    alter function private.manee_staff_portal(text,jsonb) rename to manee_staff_portal_v1;
  end if;
end
$rename$;
-- Do not leave the old employee-code entry point callable by clients.
revoke all on function private.manee_staff_portal_v1(text,jsonb) from public,anon,authenticated;

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
  if actor is null or not private.is_live_manee_session() then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  select * into profile from public.profiles where user_id=actor and status='active' for share;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  if p_action in ('session','cancel','crew','revoke') then
    return private.manee_staff_portal_v1(p_action,p_payload);
  end if;
  if p_action is null or p_action not in ('preview','request','owner_list','regenerate_store_code','approve','reject') then
    raise exception 'Unknown action' using errcode='22023';
  end if;

  if p_action in ('preview','request') then
    -- Serialize per account, including requests to different stores, before the pending limit check.
    if p_action='request' then
      perform pg_advisory_xact_lock(hashtextextended('manee-store-link:'||actor::text,0));
    end if;
    if not public.consume_auth_rate_limit('staff_store_link_'||p_action,md5(actor::text),300,
      case when p_action='preview' then 20 else 10 end) then
      return jsonb_build_object('ok',false,'error','rate_limited');
    end if;
    if length(coalesce(p_payload->>'code',''))>64 then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    code:=upper(regexp_replace(coalesce(p_payload->>'code',''),'[[:space:]-]','','g'));
    if code !~ '^[A-HJ-NP-Z2-9]{8}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into st from public.stores where staff_join_code=code and archived_at is null for share;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    if p_action='preview' then return jsonb_build_object('ok',true,'store_name',st.name); end if;

    select * into member from public.store_memberships where user_id=actor and store_id=st.id;
    if found and member.role='owner' then return jsonb_build_object('ok',false,'error','store_account_conflict'); end if;
    if member.id is not null and member.status='active' then return jsonb_build_object('ok',false,'error','already_linked'); end if;
    update private.staff_link_requests set status='expired',reviewed_at=now()
      where requester_user_id=actor and status='pending' and expires_at<=now();
    select id into rid from private.staff_link_requests
      where requester_user_id=actor and store_id=st.id and status='pending';
    if rid is not null then return jsonb_build_object('ok',true,'request_id',rid); end if;
    if (select count(*) from private.staff_link_requests where requester_user_id=actor and status='pending')>=10 then
      return jsonb_build_object('ok',false,'error','too_many_pending');
    end if;
    -- Client-supplied crew/user/store/role IDs are intentionally ignored.
    insert into private.staff_link_requests(requester_user_id,store_id,crew_id)
      values(actor,st.id,null) returning id into rid;
    return jsonb_build_object('ok',true,'request_id',rid);
  end if;

  if p_action in ('owner_list','regenerate_store_code') then
    begin sid:=(p_payload->>'store_id')::uuid;
    exception when invalid_text_representation then raise exception 'Owner permission required' using errcode='42501'; end;
    if p_action='regenerate_store_code' then
      select * into st from public.stores where id=sid and archived_at is null for update;
    else
      select * into st from public.stores where id=sid and archived_at is null for share;
    end if;
    if not found or not private.has_store_membership(sid,array['owner']::text[]) then
      raise exception 'Owner permission required' using errcode='42501';
    end if;
    perform 1 from public.store_memberships where user_id=actor and store_id=sid and role='owner' and status='active' for share;
    if not found then raise exception 'Owner permission required' using errcode='42501'; end if;
    if p_action='regenerate_store_code' then
      if not public.consume_auth_rate_limit('staff_store_code_rotate',md5(actor::text||sid::text),300,5) then
        return jsonb_build_object('ok',false,'error','rate_limited');
      end if;
      code:=private.reserve_store_staff_code(sid);
      update public.stores set staff_join_code=code where id=sid;
      return jsonb_build_object('ok',true,'store_join_code',code);
    end if;
    return jsonb_build_object('ok',true,'store_join_code',st.staff_join_code,
      'requests',coalesce((select jsonb_agg(q) from (
        select r.id,r.requester_user_id,r.crew_id,p.username,p.display_name,r.requested_at,r.expires_at,sm.crew_id as existing_crew_id
        from private.staff_link_requests r join public.profiles p on p.user_id=r.requester_user_id
        left join public.store_memberships sm on sm.user_id=r.requester_user_id and sm.store_id=r.store_id
        where r.store_id=sid and r.status='pending' and r.expires_at>now()
        order by r.requested_at limit 100) q),'[]'::jsonb),
      'available_crew',coalesce((select jsonb_agg(q) from (
        select c.id as crew_id,c.name as crew_name,c.position,sm.user_id as linked_user_id,sm.status as link_status
        from public.crew c left join public.store_memberships sm on sm.crew_id=c.id
        where c.store_id=sid and (c.resign_date is null or c.resign_date>(now() at time zone 'Asia/Seoul')::date)
        order by c.name,c.id) q),'[]'::jsonb),
      'links',coalesce((select jsonb_agg(q) from (
        select sm.id,c.name as crew_name,p.username,p.display_name,sm.status,sm.role
        from public.store_memberships sm join public.profiles p on p.user_id=sm.user_id
        join public.crew c on c.id=sm.crew_id and c.store_id=sm.store_id
        where sm.store_id=sid and sm.role in ('staff','manager') order by c.name) q),'[]'::jsonb),
      'attendance_edits',coalesce((select jsonb_agg(q) from (
        select r.id,c.name as crew_name,a.date,r.requested_check_in,r.requested_check_out,r.reason
        from public.attendance_edit_requests r join public.crew c on c.id=r.crew_id join public.attendance a on a.id=r.attendance_id
        where r.store_id=sid and r.status='pending' order by r.requested_at limit 100) q),'[]'::jsonb));
  end if;

  begin rid:=(p_payload->>'request_id')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'error','request_unavailable'); end;
  select * into req from private.staff_link_requests where id=rid;
  if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  sid:=req.store_id;
  select * into st from public.stores where id=sid and archived_at is null for share;
  if not found or not private.has_store_membership(sid,array['owner']::text[]) then
    raise exception 'Owner permission required' using errcode='42501';
  end if;
  perform 1 from public.store_memberships where user_id=actor and store_id=sid and role='owner' and status='active' for share;
  if not found then raise exception 'Owner permission required' using errcode='42501'; end if;
  -- Shared lock order with revoke: store -> owner membership -> crew -> request -> target membership.
  if p_action='approve' then
    begin cid:=(p_payload->>'crew_id')::uuid;
    exception when invalid_text_representation then return jsonb_build_object('ok',false,'error','record_unavailable'); end;
    if req.crew_id is not null and cid is distinct from req.crew_id then
      return jsonb_build_object('ok',false,'error','store_account_conflict');
    end if;
    select * into person from public.crew where id=cid and store_id=sid for update;
    if not found or (person.resign_date is not null and person.resign_date<=(now() at time zone 'Asia/Seoul')::date) then
      return jsonb_build_object('ok',false,'error','record_unavailable');
    end if;
  end if;
  select * into req from private.staff_link_requests where id=rid for update;
  if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  if req.status='approved' and p_action='approve' and req.crew_id=cid then
    return jsonb_build_object('ok',true,'membership_id',req.membership_id);
  end if;
  if req.status<>'pending' then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  if req.expires_at<=now() then
    update private.staff_link_requests set status='expired',reviewed_at=now() where id=rid;
    return jsonb_build_object('ok',false,'error','request_expired');
  end if;
  if p_action='reject' then
    update private.staff_link_requests set status='rejected',reviewed_at=now(),reviewed_by=actor where id=rid;
    return jsonb_build_object('ok',true);
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
    exception when unique_violation then return jsonb_build_object('ok',false,'error','connection_conflict'); end;
  else
    was_revoked:=member.status='revoked';
    update public.store_memberships set status='active',revoked_at=null where id=member.id;
  end if;
  update private.staff_link_requests set crew_id=person.id,status='approved',reviewed_at=now(),reviewed_by=actor,membership_id=member.id where id=rid;
  insert into private.staff_access_events(actor_user_id,target_user_id,store_id,crew_id,membership_id,action)
    values(actor,req.requester_user_id,sid,person.id,member.id,case when was_revoked then 'reactivated' else 'approved' end);
  return jsonb_build_object('ok',true,'membership_id',member.id);
end;
$$;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
create or replace function public.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.manee_staff_portal(p_action,p_payload); $$;
revoke all on function public.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function public.manee_staff_portal(text,jsonb) to authenticated;
commit;
