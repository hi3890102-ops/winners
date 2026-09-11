-- Employee Auth pilot. Apply to isolated staging only; production needs a separate release review.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.staff_link_requests (
  id uuid primary key default gen_random_uuid(),
  requester_user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  crew_id uuid not null references public.crew(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled','expired')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  membership_id uuid references public.store_memberships(id) on delete set null
);
create unique index staff_link_pending_requester_crew_idx on private.staff_link_requests(requester_user_id,crew_id) where status='pending';
create index staff_link_store_status_idx on private.staff_link_requests(store_id,status,requested_at);
create index staff_link_crew_idx on private.staff_link_requests(crew_id);
create index staff_link_reviewer_idx on private.staff_link_requests(reviewed_by);
create index staff_link_membership_idx on private.staff_link_requests(membership_id);
alter table private.staff_link_requests enable row level security;
revoke all on private.staff_link_requests from public,anon,authenticated;

create table private.staff_access_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  target_user_id uuid not null,
  store_id uuid not null,
  crew_id uuid not null,
  membership_id uuid not null,
  action text not null check(action in ('approved','reactivated','revoked')),
  created_at timestamptz not null default now()
);
create index staff_access_store_time_idx on private.staff_access_events(store_id,created_at);
alter table private.staff_access_events enable row level security;
revoke all on private.staff_access_events from public,anon,authenticated;

create or replace function private.has_store_membership(target_store_id uuid, allowed_roles text[] default null::text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.store_memberships sm
    join public.profiles p on p.user_id=sm.user_id and p.status='active'
    join public.stores s on s.id=sm.store_id and s.archived_at is null
    left join public.crew c on c.id=sm.crew_id and c.store_id=sm.store_id
    where sm.user_id=(select auth.uid()) and sm.store_id=target_store_id and sm.status='active'
      and (allowed_roles is null or sm.role=any(allowed_roles))
      and (sm.role='owner' or (sm.role in ('staff','manager') and c.id is not null
        and (c.resign_date is null or c.resign_date > (now() at time zone 'Asia/Seoul')::date)))
  );
$$;
create or replace function private.current_crew_id(target_store_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select sm.crew_id from public.store_memberships sm
  join public.crew c on c.id=sm.crew_id and c.store_id=sm.store_id
  where sm.user_id=(select auth.uid()) and sm.store_id=target_store_id
    and sm.status='active' and sm.role in ('staff','manager')
    and private.has_store_membership(target_store_id,array['staff','manager']::text[]) limit 1;
$$;
create or replace function private.has_sales_access(target_store_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_store_membership(target_store_id,array['owner','manager']::text[])
    or (private.has_store_membership(target_store_id,array['staff']::text[]) and exists(
      select 1 from public.crew c where c.id=private.current_crew_id(target_store_id) and c.store_id=target_store_id and c.sales_access));
$$;
revoke all on function private.has_store_membership(uuid,text[]),private.current_crew_id(uuid),private.has_sales_access(uuid) from public,anon;
grant execute on function private.has_store_membership(uuid,text[]),private.current_crew_id(uuid),private.has_sales_access(uuid) to authenticated;

create function private.bootstrap_staff_account(p_user_id uuid,p_username text,p_display_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare uname text := lower(btrim(normalize(coalesce(p_username,''),NFKC)));
begin
  if p_user_id is null or uname !~ '^[a-z0-9가-힣._-]{4,30}$'
     or length(btrim(coalesce(p_display_name,''))) not between 1 and 50
     or p_display_name ~ '[<>[:cntrl:]]' then raise exception 'Invalid staff account' using errcode='22023'; end if;
  -- The normalized unique username index arbitrates concurrent owner/staff signups.
  if public.is_manee_username_reserved(uname) then raise exception 'username_taken' using errcode='23505'; end if;
  insert into public.profiles(user_id,username,display_name,status) values(p_user_id,uname,btrim(p_display_name),'active');
  return p_user_id;
end;
$$;
create function public.bootstrap_staff_account(p_user_id uuid,p_username text,p_display_name text)
returns uuid language sql security invoker set search_path = '' as $$
  select private.bootstrap_staff_account(p_user_id,p_username,p_display_name);
$$;
revoke all on function private.bootstrap_staff_account(uuid,text,text),public.bootstrap_staff_account(uuid,text,text) from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.bootstrap_staff_account(uuid,text,text),public.bootstrap_staff_account(uuid,text,text) to service_role;

create function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  profile public.profiles%rowtype;
  req private.staff_link_requests%rowtype;
  person public.crew%rowtype;
  member public.store_memberships%rowtype;
  st public.stores%rowtype;
  rid uuid;
  sid uuid;
  code text;
  existing_role text;
  result jsonb;
  was_revoked boolean := false;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
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
  elsif p_action='request' then
    -- Return errors instead of raising: failed guesses must commit the rate counter.
    if not public.consume_auth_rate_limit('staff_link_user',md5(actor::text),300,10) then
      return jsonb_build_object('ok',false,'error','rate_limited'); end if;
    code := btrim(coalesce(p_payload->>'code',''));
    if code !~ '^[0-9]{6}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into person from public.crew where join_code=code;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into st from public.stores where id=person.store_id and archived_at is null for share;
    if not found then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    select * into person from public.crew where id=person.id and join_code=code and store_id=st.id for update;
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
    if rid is not null then return jsonb_build_object('ok',true,'request_id',rid); end if;
    if (select count(*) from private.staff_link_requests where requester_user_id=actor and status='pending')>=10 then
      return jsonb_build_object('ok',false,'error','too_many_pending'); end if;
    insert into private.staff_link_requests(requester_user_id,store_id,crew_id) values(actor,st.id,person.id) returning id into rid;
    return jsonb_build_object('ok',true,'request_id',rid);
  elsif p_action='cancel' then
    update private.staff_link_requests set status='cancelled',reviewed_at=now() where id=(p_payload->>'request_id')::uuid and requester_user_id=actor and status='pending';
    if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
    return jsonb_build_object('ok',true);
  elsif p_action='crew' then
    sid := (p_payload->>'store_id')::uuid;
    if private.current_crew_id(sid) is null then raise exception 'Membership unavailable' using errcode='42501'; end if;
    select * into person from public.crew where id=private.current_crew_id(sid) and store_id=sid;
    select role into existing_role from public.store_memberships where user_id=actor and store_id=sid and status='active';
    return jsonb_build_object('ok',true,'crew',(to_jsonb(person)-array['resident_number','bank_account','notes','join_code']) || jsonb_build_object('is_manager',existing_role='manager'));
  elsif p_action='owner_list' then
    sid := (p_payload->>'store_id')::uuid;
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
    -- Lock order: store -> crew -> request -> target membership. Every access change follows it.
    if p_action='revoke' then
      select * into member from public.store_memberships where id=(p_payload->>'membership_id')::uuid and role in ('staff','manager');
      if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
      sid := member.store_id;
      select * into person from public.crew where id=member.crew_id;
    else
      select * into req from private.staff_link_requests where id=(p_payload->>'request_id')::uuid;
      if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
      sid := req.store_id;
      select * into person from public.crew where id=req.crew_id;
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
    if req.expires_at<=now() then
      update private.staff_link_requests set status='expired',reviewed_at=now() where id=req.id;
      return jsonb_build_object('ok',false,'error','request_expired'); end if;
    if p_action='reject' then
      update private.staff_link_requests set status='rejected',reviewed_at=now(),reviewed_by=actor where id=req.id;
      return jsonb_build_object('ok',true); end if;
    if person.resign_date is not null and person.resign_date <= (now() at time zone 'Asia/Seoul')::date then
      return jsonb_build_object('ok',false,'error','record_unavailable'); end if;
    perform 1 from public.profiles where user_id=req.requester_user_id and status='active' for share;
    if not found then return jsonb_build_object('ok',false,'error','account_unavailable'); end if;
    select * into member from public.store_memberships where crew_id=person.id for update;
    if found and member.user_id<>req.requester_user_id then return jsonb_build_object('ok',false,'error','record_already_linked'); end if;
    select * into member from public.store_memberships where user_id=req.requester_user_id and store_id=sid for update;
    if found and (member.role='owner' or member.crew_id is distinct from person.id) then
      return jsonb_build_object('ok',false,'error','store_account_conflict'); end if;
    if member.id is null then
      -- These constraints also arbitrate requests for different crew rows in the same store.
      begin
        insert into public.store_memberships(user_id,store_id,crew_id,role,status) values(req.requester_user_id,sid,person.id,'staff','active') returning * into member;
      exception when unique_violation then return jsonb_build_object('ok',false,'error','connection_conflict'); end;
    else
      was_revoked := member.status='revoked';
      update public.store_memberships set status='active',revoked_at=null where id=member.id;
    end if;
    update private.staff_link_requests set status='approved',reviewed_at=now(),reviewed_by=actor,membership_id=member.id where id=req.id;
    insert into private.staff_access_events(actor_user_id,target_user_id,store_id,crew_id,membership_id,action)
      values(actor,req.requester_user_id,sid,person.id,member.id,case when was_revoked then 'reactivated' else 'approved' end);
    return jsonb_build_object('ok',true,'membership_id',member.id);
  end if;
  raise exception 'Unknown action' using errcode='22023';
end;
$$;
create function public.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = '' as $$ select private.manee_staff_portal(p_action,p_payload); $$;
revoke all on function private.manee_staff_portal(text,jsonb),public.manee_staff_portal(text,jsonb) from public,anon;
grant usage on schema private to authenticated;
grant execute on function private.manee_staff_portal(text,jsonb),public.manee_staff_portal(text,jsonb) to authenticated;

-- Protect the records that establish employee identity and payroll history.
drop policy "allow all - crew" on public.crew;
drop policy "allow all - attendance" on public.attendance;
drop policy "allow all - stores" on public.stores;
revoke all on public.crew,public.attendance,public.stores from anon;
revoke truncate,references,trigger on public.crew,public.attendance,public.stores from authenticated;
grant select,insert,update,delete on public.crew,public.attendance,public.stores to authenticated;
create policy crew_manage on public.crew for all to authenticated
  using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id));
create policy attendance_manage on public.attendance for all to authenticated
  using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id) and exists(select 1 from public.crew c where c.id=crew_id and c.store_id=attendance.store_id));
create policy attendance_self_read on public.attendance for select to authenticated using(crew_id=private.current_crew_id(store_id));
create policy stores_member_read on public.stores for select to authenticated using(private.can_view_store(id));
create policy stores_manage_update on public.stores for update to authenticated using(private.can_manage_store(id)) with check(private.can_manage_store(id));
create unique index attendance_one_open_per_crew_idx on public.attendance(crew_id) where check_out is null and crew_id is not null;

create function private.staff_clock(p_store_id uuid,p_attendance_id uuid,p_lat double precision,p_lng double precision)
returns public.attendance language plpgsql security definer set search_path = '' as $$
declare cid uuid; sid uuid; st public.stores%rowtype; a public.attendance%rowtype; local_now timestamp; business_date date;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_attendance_id is null then sid:=p_store_id;
  else select store_id into sid from public.attendance where id=p_attendance_id; end if;
  cid:=private.current_crew_id(sid);
  if cid is null then raise exception 'Membership unavailable' using errcode='42501'; end if;
  select * into st from public.stores where id=sid and archived_at is null for share;
  if not found then raise exception 'Store unavailable' using errcode='42501'; end if;
  perform 1 from public.crew where id=cid and store_id=sid for update;
  perform 1 from public.profiles where user_id=(select auth.uid()) and status='active' for share;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  perform 1 from public.store_memberships where user_id=(select auth.uid()) and store_id=sid and status='active' and crew_id=cid for share;
  if not found or private.current_crew_id(sid) is distinct from cid then raise exception 'Membership unavailable' using errcode='42501'; end if;
  if st.lat is null or st.lng is null then raise exception 'Store location is not configured'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'Current location is required'; end if;
  if private.distance_meters(st.lat,st.lng,p_lat,p_lng)>100 then raise exception 'Outside attendance radius'; end if;
  local_now:=timezone('Asia/Seoul',now());
  if p_attendance_id is null then
    if exists(select 1 from public.attendance where crew_id=cid and check_out is null) then raise exception 'Already clocked in'; end if;
    business_date:=local_now::date;
    if extract(hour from local_now)::int<coalesce(st.business_day_cutoff_hour,6) then business_date:=business_date-1; end if;
    insert into public.attendance(store_id,crew_id,date,check_in,confirmed,staff_confirmed,time_edited,staff_ack_edit)
      values(sid,cid,business_date,local_now::time,false,false,false,false) returning * into a;
  else
    select * into a from public.attendance where id=p_attendance_id and store_id=sid and crew_id=cid for update;
    if not found then raise exception 'Attendance unavailable' using errcode='42501'; end if;
    if a.check_out is not null then raise exception 'Already clocked out'; end if;
    update public.attendance set check_out=local_now::time,confirmed=false,staff_confirmed=false where id=a.id returning * into a;
  end if;
  return a;
end;
$$;
create or replace function public.clock_in(target_store_id uuid,current_lat double precision,current_lng double precision)
returns public.attendance language sql security invoker set search_path = '' as $$ select private.staff_clock(target_store_id,null,current_lat,current_lng); $$;
create or replace function public.clock_out(target_attendance_id uuid,current_lat double precision,current_lng double precision)
returns public.attendance language sql security invoker set search_path = '' as $$ select private.staff_clock(null,target_attendance_id,current_lat,current_lng); $$;
revoke all on function private.staff_clock(uuid,uuid,double precision,double precision),public.clock_in(uuid,double precision,double precision),public.clock_out(uuid,double precision,double precision) from public,anon;
grant execute on function private.staff_clock(uuid,uuid,double precision,double precision),public.clock_in(uuid,double precision,double precision),public.clock_out(uuid,double precision,double precision) to authenticated;

commit;
