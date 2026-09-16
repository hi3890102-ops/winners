-- Cutover migration for one-time 8-character staff connection codes.
-- Apply to staging now; production only immediately before the security-v2 app cutover.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists private.staff_link_code_rollout_backup (
  crew_id uuid primary key references public.crew(id) on delete cascade,
  old_join_code text,
  backed_up_at timestamptz not null default now()
);
revoke all on private.staff_link_code_rollout_backup from public,anon,authenticated;
insert into private.staff_link_code_rollout_backup(crew_id,old_join_code)
select id,join_code from public.crew where join_code is not null
on conflict (crew_id) do nothing;

do $manee_codes$
declare r record; candidate text;
begin
  for r in select id from public.crew where join_code is not null and join_code !~ '^[A-Z0-9]{8}$' loop
    loop
      candidate := upper(substr(md5(gen_random_uuid()::text || r.id::text || clock_timestamp()::text),1,8));
      begin
        update public.crew set join_code=candidate where id=r.id;
        exit;
      exception when unique_violation then
        null;
      end;
    end loop;
  end loop;
end
$manee_codes$;

create or replace function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  profile public.profiles%rowtype;
  req private.staff_link_requests%rowtype;
  person public.crew%rowtype;
  member public.store_memberships%rowtype;
  st public.stores%rowtype;
  rid uuid; sid uuid; code text; existing_role text; was_revoked boolean := false;
begin
  if actor is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into profile from public.profiles where user_id=actor and status='active' for share;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;

  if p_action='session' then
    return jsonb_build_object('ok',true,'profile',jsonb_build_object('user_id',actor,'username',profile.username,'display_name',profile.display_name),
      'memberships',coalesce((select jsonb_agg(jsonb_build_object('id',sm.id,'store_id',sm.store_id,'store_name',s.name,'role',sm.role,'crew_id',sm.crew_id,
        'lat',s.lat,'lng',s.lng,'cutoff',s.business_day_cutoff_hour,'onboarding_done',s.onboarding_done,'manager_dashboard_enabled',s.manager_dashboard_enabled) order by sm.created_at)
        from public.store_memberships sm join public.stores s on s.id=sm.store_id
        where sm.user_id=actor and sm.status='active' and private.has_store_membership(sm.store_id,array[sm.role])),'[]'::jsonb),
      'requests',coalesce((select jsonb_agg(q) from (select r.id,s.name as store_name,
        case when r.status='pending' and r.expires_at<=now() then 'expired' else r.status end as status,r.requested_at,r.expires_at
        from private.staff_link_requests r join public.stores s on s.id=r.store_id where r.requester_user_id=actor order by r.requested_at desc limit 30) q),'[]'::jsonb));
  elsif p_action='preview' then
    if not public.consume_auth_rate_limit('staff_link_preview',md5(actor::text),300,20) then
      return jsonb_build_object('ok',false,'error','rate_limited'); end if;
    code := upper(btrim(coalesce(p_payload->>'code','')));
    if code !~ '^[A-Z0-9]{8}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into person from public.crew where join_code=code;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into st from public.stores where id=person.store_id and archived_at is null for share;
    if not found or (person.resign_date is not null and person.resign_date <= (now() at time zone 'Asia/Seoul')::date) then
      return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    if exists(select 1 from public.store_memberships where crew_id=person.id and user_id<>actor) then
      return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    return jsonb_build_object('ok',true,'store_name',st.name,'crew_name',person.name);
  elsif p_action='request' then
    if not public.consume_auth_rate_limit('staff_link_request',md5(actor::text),300,10) then
      return jsonb_build_object('ok',false,'error','rate_limited'); end if;
    code := upper(btrim(coalesce(p_payload->>'code','')));
    if code !~ '^[A-Z0-9]{8}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into person from public.crew where join_code=code for update;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into st from public.stores where id=person.store_id and archived_at is null for share;
    if not found or (person.resign_date is not null and person.resign_date <= (now() at time zone 'Asia/Seoul')::date) then
      return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into member from public.store_memberships where user_id=actor and store_id=st.id;
    if found and (member.role='owner' or member.crew_id is distinct from person.id) then
      return jsonb_build_object('ok',false,'error','store_account_conflict'); end if;
    if member.id is not null and member.status='active' then return jsonb_build_object('ok',false,'error','already_linked'); end if;
    if exists(select 1 from public.store_memberships where crew_id=person.id and user_id<>actor) then
      return jsonb_build_object('ok',false,'error','record_already_linked'); end if;
    update private.staff_link_requests set status='expired',reviewed_at=now() where requester_user_id=actor and status='pending' and expires_at<=now();
    select id into rid from private.staff_link_requests where requester_user_id=actor and crew_id=person.id and status='pending';
    if rid is not null then
      update public.crew set join_code=null where id=person.id and join_code=code;
      return jsonb_build_object('ok',true,'request_id',rid); end if;
    if (select count(*) from private.staff_link_requests where requester_user_id=actor and status='pending')>=10 then
      return jsonb_build_object('ok',false,'error','too_many_pending'); end if;
    update public.crew set join_code=null where id=person.id and join_code=code;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    insert into private.staff_link_requests(requester_user_id,store_id,crew_id) values(actor,st.id,person.id) returning id into rid;
    return jsonb_build_object('ok',true,'request_id',rid);
  elsif p_action='cancel' then
    update private.staff_link_requests set status='cancelled',reviewed_at=now() where id=(p_payload->>'request_id')::uuid and requester_user_id=actor and status='pending';
    if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
    return jsonb_build_object('ok',true);
  elsif p_action='crew' then
    sid:=(p_payload->>'store_id')::uuid;
    if private.current_crew_id(sid) is null then raise exception 'Membership unavailable' using errcode='42501'; end if;
    select * into person from public.crew where id=private.current_crew_id(sid) and store_id=sid;
    select role into existing_role from public.store_memberships where user_id=actor and store_id=sid and status='active';
    return jsonb_build_object('ok',true,'crew',(to_jsonb(person)-array['resident_number','bank_account','notes','join_code']) || jsonb_build_object('is_manager',existing_role='manager'));
  elsif p_action='owner_list' then
    sid:=(p_payload->>'store_id')::uuid;
    if not private.has_store_membership(sid,array['owner']::text[]) then raise exception 'Owner permission required' using errcode='42501'; end if;
    return jsonb_build_object('ok',true,
      'requests',coalesce((select jsonb_agg(q) from (select r.id,c.name as crew_name,p.username,p.display_name,r.requested_at,r.expires_at
        from private.staff_link_requests r join public.profiles p on p.user_id=r.requester_user_id join public.crew c on c.id=r.crew_id
        where r.store_id=sid and r.status='pending' and r.expires_at>now() order by r.requested_at limit 100) q),'[]'::jsonb),
      'links',coalesce((select jsonb_agg(q) from (select sm.id,c.name as crew_name,p.username,p.display_name,sm.status,sm.role
        from public.store_memberships sm join public.profiles p on p.user_id=sm.user_id join public.crew c on c.id=sm.crew_id and c.store_id=sm.store_id
        where sm.store_id=sid and sm.role in ('staff','manager') order by c.name) q),'[]'::jsonb),
      'attendance_edits',coalesce((select jsonb_agg(q) from (select r.id,c.name as crew_name,a.date,r.requested_check_in,r.requested_check_out,r.reason
        from public.attendance_edit_requests r join public.crew c on c.id=r.crew_id join public.attendance a on a.id=r.attendance_id
        where r.store_id=sid and r.status='pending' order by r.requested_at limit 100) q),'[]'::jsonb));
  elsif p_action in ('approve','reject','revoke') then
    if p_action='revoke' then
      select * into member from public.store_memberships where id=(p_payload->>'membership_id')::uuid and role in ('staff','manager');
      if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
      sid:=member.store_id; select * into person from public.crew where id=member.crew_id;
    else
      select * into req from private.staff_link_requests where id=(p_payload->>'request_id')::uuid;
      if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
      sid:=req.store_id; select * into person from public.crew where id=req.crew_id;
    end if;
    select * into st from public.stores where id=sid and archived_at is null for share;
    if not found or not private.has_store_membership(sid,array['owner']::text[]) then raise exception 'Owner permission required' using errcode='42501'; end if;
    perform 1 from public.store_memberships where user_id=actor and store_id=sid and role='owner' and status='active' for share;
    if not found then raise exception 'Owner permission required' using errcode='42501'; end if;
    select * into person from public.crew where id=person.id and store_id=sid for update;
    if not found then return jsonb_build_object('ok',false,'error','record_unavailable'); end if;
    if p_action='revoke' then
      select * into member from public.store_memberships where id=member.id and store_id=sid and crew_id=person.id and role in ('staff','manager') for update;
      if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
      if member.status='revoked' then return jsonb_build_object('ok',true); end if;
      update public.store_memberships set status='revoked',revoked_at=now() where id=member.id;
      insert into private.staff_access_events(actor_user_id,target_user_id,store_id,crew_id,membership_id,action) values(actor,member.user_id,sid,person.id,member.id,'revoked');
      return jsonb_build_object('ok',true);
    end if;
    select * into req from private.staff_link_requests where id=req.id for update;
    if req.status='approved' and p_action='approve' then return jsonb_build_object('ok',true,'membership_id',req.membership_id); end if;
    if req.status<>'pending' then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
    if req.expires_at<=now() then update private.staff_link_requests set status='expired',reviewed_at=now() where id=req.id; return jsonb_build_object('ok',false,'error','request_expired'); end if;
    if p_action='reject' then update private.staff_link_requests set status='rejected',reviewed_at=now(),reviewed_by=actor where id=req.id; return jsonb_build_object('ok',true); end if;
    if person.resign_date is not null and person.resign_date <= (now() at time zone 'Asia/Seoul')::date then return jsonb_build_object('ok',false,'error','record_unavailable'); end if;
    perform 1 from public.profiles where user_id=req.requester_user_id and status='active' for share;
    if not found then return jsonb_build_object('ok',false,'error','account_unavailable'); end if;
    select * into member from public.store_memberships where crew_id=person.id for update;
    if found and member.user_id<>req.requester_user_id then return jsonb_build_object('ok',false,'error','record_already_linked'); end if;
    select * into member from public.store_memberships where user_id=req.requester_user_id and store_id=sid for update;
    if found and (member.role='owner' or member.crew_id is distinct from person.id) then return jsonb_build_object('ok',false,'error','store_account_conflict'); end if;
    if member.id is null then
      begin insert into public.store_memberships(user_id,store_id,crew_id,role,status) values(req.requester_user_id,sid,person.id,'staff','active') returning * into member;
      exception when unique_violation then return jsonb_build_object('ok',false,'error','connection_conflict'); end;
    else
      was_revoked:=member.status='revoked'; update public.store_memberships set status='active',revoked_at=null where id=member.id;
    end if;
    update private.staff_link_requests set status='approved',reviewed_at=now(),reviewed_by=actor,membership_id=member.id where id=req.id;
    insert into private.staff_access_events(actor_user_id,target_user_id,store_id,crew_id,membership_id,action)
      values(actor,req.requester_user_id,sid,person.id,member.id,case when was_revoked then 'reactivated' else 'approved' end);
    return jsonb_build_object('ok',true,'membership_id',member.id);
  end if;
  raise exception 'Unknown action' using errcode='22023';
end;
$$;

commit;
