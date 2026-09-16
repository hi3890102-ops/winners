-- Staging only: replace pre-issued recovery keys with verified support requests
-- and short-lived one-time reset codes. Production remains unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table private.password_reset_requests (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references auth.users(id) on delete cascade,
  target_store_id uuid references public.stores(id) on delete set null,
  requested_affiliation text not null,
  status text not null default 'pending' check(status in ('pending','code_issued','consuming','completed','rejected','expired','uncertain')),
  requested_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  code_hash text check(code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  code_issued_at timestamptz,
  code_expires_at timestamptz,
  failed_attempts integer not null default 0 check(failed_attempts between 0 and 5),
  operation_id uuid,
  operation_finished_at timestamptz
);
create index password_reset_requests_target_time_idx on private.password_reset_requests(target_user_id,requested_at desc);
create index password_reset_requests_store_status_idx on private.password_reset_requests(target_store_id,status,requested_at);
alter table private.password_reset_requests enable row level security;
revoke all on private.password_reset_requests from public,anon,authenticated;

create table private.password_reset_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references private.password_reset_requests(id) on delete set null,
  target_user_id uuid not null,
  actor_user_id uuid,
  action text not null check(action in ('requested','code_issued','rejected','reset_started','reset_completed','reset_uncertain')),
  created_at timestamptz not null default clock_timestamp()
);
create index password_reset_events_target_time_idx on private.password_reset_events(target_user_id,created_at desc);
alter table private.password_reset_events enable row level security;
revoke all on private.password_reset_events from public,anon,authenticated;

-- Retire every previously issued backup key. The old rows remain only as an
-- audit-compatible shell and are never exposed to the browser.
update private.account_recovery_keys set key_hash=null where key_hash is not null;

create or replace function private.manee_support_recovery_service(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  uname text; affiliation text; kh text; uid uuid; actor uuid; sid uuid; rid uuid; op uuid;
  profile public.profiles%rowtype; st public.stores%rowtype; req private.password_reset_requests%rowtype;
  authorized boolean := false;
begin
  if p_action='request' then
    uname:=lower(btrim(normalize(coalesce(p_payload->>'username',''),NFKC)));
    affiliation:=btrim(normalize(coalesce(p_payload->>'affiliation',''),NFKC));
    if uname !~ '^[a-z0-9가-힣._-]{4,30}$' or length(affiliation) not between 1 and 80 then
      return jsonb_build_object('ok',true); end if;
    select * into profile from public.profiles where username=uname and status='active';
    if not found or not exists(select 1 from auth.users u where u.id=profile.user_id and (u.banned_until is null or u.banned_until<now())) then
      return jsonb_build_object('ok',true); end if;
    uid:=profile.user_id;
    if lower(affiliation) in ('본사','hq') then
      if not exists(select 1 from public.platform_admins pa where pa.user_id=uid and pa.status='active') then
        return jsonb_build_object('ok',true); end if;
    else
      select s.* into st from public.stores s join public.store_memberships sm on sm.store_id=s.id
        where sm.user_id=uid and sm.status='active' and s.archived_at is null and lower(s.name)=lower(affiliation)
        order by sm.created_at limit 1;
      if not found then return jsonb_build_object('ok',true); end if;
    end if;
    update private.password_reset_requests set status='expired',code_hash=null
      where target_user_id=uid and status in ('pending','code_issued');
    insert into private.password_reset_requests(target_user_id,target_store_id,requested_affiliation)
      values(uid,st.id,affiliation) returning id into rid;
    insert into private.password_reset_events(request_id,target_user_id,action) values(rid,uid,'requested');
    return jsonb_build_object('ok',true);

  elsif p_action='credentials' then
    uid:=(p_payload->>'user_id')::uuid; sid:=(p_payload->>'session_id')::uuid;
    if not exists(select 1 from auth.sessions s where s.id=sid and s.user_id=uid and (s.not_after is null or s.not_after>now())) then
      return jsonb_build_object('ok',false,'error','invalid_session'); end if;
    return coalesce((select jsonb_build_object('ok',true,'user_id',p.user_id,'username',p.username,'email',u.email)
      from public.profiles p join auth.users u on u.id=p.user_id
      where p.user_id=uid and p.status='active' and (u.banned_until is null or u.banned_until<now())),
      jsonb_build_object('ok',false,'error','invalid_session'));

  elsif p_action in ('issue','reject') then
    actor:=(p_payload->>'actor_user_id')::uuid; sid:=(p_payload->>'session_id')::uuid;
    rid:=(p_payload->>'request_id')::uuid;
    if not exists(select 1 from auth.sessions s join public.profiles p on p.user_id=s.user_id and p.status='active'
      where s.id=sid and s.user_id=actor and (s.not_after is null or s.not_after>now())) then
      return jsonb_build_object('ok',false,'error','invalid_session'); end if;
    select * into req from private.password_reset_requests where id=rid for update;
    if not found or req.status<>'pending' or req.requested_at<clock_timestamp()-interval '7 days' then
      return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
    authorized:=exists(select 1 from public.platform_admins pa where pa.user_id=actor and pa.status='active' and pa.role in ('super_admin','admin','support'));
    if not authorized and req.target_store_id is not null then
      authorized:=exists(select 1 from public.store_memberships mine
        join public.store_memberships target on target.store_id=mine.store_id and target.user_id=req.target_user_id
        where mine.user_id=actor and mine.store_id=req.target_store_id and mine.status='active' and mine.role='owner'
          and target.status='active' and target.role in ('staff','manager'));
    end if;
    if not authorized then return jsonb_build_object('ok',false,'error','permission_denied'); end if;
    if p_action='reject' then
      update private.password_reset_requests set status='rejected',reviewed_at=clock_timestamp(),reviewed_by=actor,code_hash=null where id=rid;
      insert into private.password_reset_events(request_id,target_user_id,actor_user_id,action) values(rid,req.target_user_id,actor,'rejected');
      return jsonb_build_object('ok',true);
    end if;
    kh:=p_payload->>'code_hash';
    if kh is null or kh !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok',false,'error','invalid_code'); end if;
    update private.password_reset_requests set status='code_issued',reviewed_at=clock_timestamp(),reviewed_by=actor,
      code_hash=kh,code_issued_at=clock_timestamp(),code_expires_at=clock_timestamp()+interval '15 minutes',failed_attempts=0
      where id=rid;
    insert into private.password_reset_events(request_id,target_user_id,actor_user_id,action) values(rid,req.target_user_id,actor,'code_issued');
    return jsonb_build_object('ok',true);

  elsif p_action='consume' then
    uname:=lower(btrim(normalize(coalesce(p_payload->>'username',''),NFKC))); kh:=p_payload->>'code_hash';
    select r.* into req from private.password_reset_requests r join public.profiles p on p.user_id=r.target_user_id
      where p.username=uname and p.status='active' and r.status='code_issued'
      order by r.code_issued_at desc limit 1 for update of r;
    if not found or req.code_expires_at<=clock_timestamp() then
      if found then update private.password_reset_requests set status='expired',code_hash=null where id=req.id; end if;
      return jsonb_build_object('ok',false,'error','invalid_recovery'); end if;
    if kh is null or req.code_hash<>kh then
      update private.password_reset_requests set failed_attempts=least(5,failed_attempts+1),
        status=case when failed_attempts+1>=5 then 'expired' else status end,
        code_hash=case when failed_attempts+1>=5 then null else code_hash end where id=req.id;
      return jsonb_build_object('ok',false,'error','invalid_recovery'); end if;
    op:=gen_random_uuid();
    update private.password_reset_requests set status='consuming',code_hash=null,operation_id=op where id=req.id;
    insert into private.password_reset_events(request_id,target_user_id,action) values(req.id,req.target_user_id,'reset_started');
    return jsonb_build_object('ok',true,'request_id',req.id,'user_id',req.target_user_id,'operation_id',op);

  elsif p_action in ('complete','uncertain') then
    uid:=(p_payload->>'user_id')::uuid; rid:=(p_payload->>'request_id')::uuid; op:=(p_payload->>'operation_id')::uuid;
    update private.password_reset_requests set status=case when p_action='complete' then 'completed' else 'uncertain' end,
      operation_finished_at=case when p_action='complete' then clock_timestamp() else null end
      where id=rid and target_user_id=uid and operation_id=op and status='consuming';
    if not found then return jsonb_build_object('ok',false,'error','operation_unavailable'); end if;
    insert into private.password_reset_events(request_id,target_user_id,action)
      values(rid,uid,case when p_action='complete' then 'reset_completed' else 'reset_uncertain' end);
    return jsonb_build_object('ok',true);
  end if;
  return jsonb_build_object('ok',false,'error','invalid_action');
end;
$$;
create function public.manee_support_recovery_service(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.manee_support_recovery_service(p_action,p_payload);
$$;
revoke all on function private.manee_support_recovery_service(text,jsonb),public.manee_support_recovery_service(text,jsonb) from public,anon,authenticated;
grant execute on function private.manee_support_recovery_service(text,jsonb),public.manee_support_recovery_service(text,jsonb) to service_role;

create function private.manee_recovery_portal()
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());
begin
  if actor is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  return jsonb_build_object('ok',true,'requests',coalesce((select jsonb_agg(q order by q.requested_at) from (
    select r.id,p.username,p.display_name,r.requested_affiliation,s.name as store_name,r.requested_at,
      case when exists(select 1 from public.platform_admins pa where pa.user_id=actor and pa.status='active' and pa.role in ('super_admin','admin','support')) then 'platform'
           else 'store_owner' end as approval_scope
    from private.password_reset_requests r join public.profiles p on p.user_id=r.target_user_id
    left join public.stores s on s.id=r.target_store_id
    where r.status='pending' and r.requested_at>=clock_timestamp()-interval '7 days' and (
      exists(select 1 from public.platform_admins pa where pa.user_id=actor and pa.status='active' and pa.role in ('super_admin','admin','support'))
      or (r.target_store_id is not null and exists(select 1 from public.store_memberships mine
          join public.store_memberships target on target.store_id=mine.store_id and target.user_id=r.target_user_id
          where mine.user_id=actor and mine.store_id=r.target_store_id and mine.status='active' and mine.role='owner'
            and target.status='active' and target.role in ('staff','manager')))
    ) order by r.requested_at limit 100
  ) q),'[]'::jsonb));
end;
$$;
create function public.manee_recovery_portal()
returns jsonb language sql security invoker set search_path='' as $$ select private.manee_recovery_portal(); $$;
revoke all on function private.manee_recovery_portal(),public.manee_recovery_portal() from public,anon;
grant execute on function private.manee_recovery_portal(),public.manee_recovery_portal() to authenticated;

-- When staging has exactly one active owner identity, use it as the initial
-- super administrator. No credential is created or changed here.
do $bootstrap$
declare uid uuid;
begin
  select min(sm.user_id::text)::uuid into uid from public.store_memberships sm
    join public.profiles p on p.user_id=sm.user_id and p.status='active'
    where sm.role='owner' and sm.status='active'
    having count(distinct sm.user_id)=1;
  if uid is not null then
    insert into public.platform_admins(user_id,role,status) values(uid,'super_admin','active')
      on conflict(user_id) do update set role='super_admin',status='active',revoked_at=null;
  end if;
end;
$bootstrap$;

commit;
