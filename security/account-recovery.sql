-- Isolated staging only. No production migration or user credential changes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.account_recovery_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  key_hash text check(key_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default clock_timestamp(),
  consumed_at timestamptz,
  operation_id uuid,
  operation_finished_at timestamptz
);
alter table private.account_recovery_keys enable row level security;
revoke all on private.account_recovery_keys from public,anon,authenticated;
create table private.account_recovery_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  action text not null check(action in ('key_issued','reset_started','reset_completed','reset_uncertain')),
  operation_id uuid,
  created_at timestamptz not null default clock_timestamp()
);
create index account_recovery_events_user_time_idx on private.account_recovery_events(user_id,created_at);
alter table private.account_recovery_events enable row level security;
revoke all on private.account_recovery_events from public,anon,authenticated;

-- A valid signed JWT can outlive logout/password reset. Check its actual session.
create function private.is_live_manee_session()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from auth.sessions s where s.id=(select case when auth.jwt()->>'session_id' ~ '^[0-9a-fA-F-]{36}$'
    then (auth.jwt()->>'session_id')::uuid else null end)
    and s.user_id=(select auth.uid()) and (s.not_after is null or s.not_after>now()));
$$;
revoke all on function private.is_live_manee_session() from public,anon;
grant execute on function private.is_live_manee_session() to authenticated;

-- Narrow service API: secrets never become client-readable table columns.
create function private.manee_recovery_service(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid; sid uuid; uname text; kh text; op uuid;
  rec private.account_recovery_keys%rowtype;
begin
  if p_action='credentials' then
    uid:=(p_payload->>'user_id')::uuid;
    sid:=(p_payload->>'session_id')::uuid;
    if not exists(select 1 from auth.sessions where id=sid and user_id=uid and (not_after is null or not_after>now())) then
      return jsonb_build_object('ok',false,'error','invalid_session'); end if;
    return coalesce((select jsonb_build_object('ok',true,'user_id',p.user_id,'username',p.username,'email',u.email)
      from public.profiles p join auth.users u on u.id=p.user_id
      where p.user_id=uid and p.status='active' and (u.banned_until is null or u.banned_until<now())),jsonb_build_object('ok',false,'error','invalid_session'));
  elsif p_action='issue' then
    uid:=(p_payload->>'user_id')::uuid; sid:=(p_payload->>'session_id')::uuid; kh:=p_payload->>'key_hash';
    perform 1 from public.profiles where user_id=uid and status='active' for update;
    if not found or kh is null or kh !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok',false,'error','invalid_session'); end if;
    if not exists(select 1 from auth.sessions where id=sid and user_id=uid and created_at>clock_timestamp()-interval '5 minutes'
      and (not_after is null or not_after>now())) then return jsonb_build_object('ok',false,'error','invalid_session'); end if;
    select * into rec from private.account_recovery_keys where user_id=uid for update;
    if found and rec.operation_id is not null and rec.operation_finished_at is null and rec.consumed_at>clock_timestamp()-interval '10 minutes' then
      return jsonb_build_object('ok',false,'error','recovery_in_progress'); end if;
    insert into private.account_recovery_keys(user_id,key_hash) values(uid,kh)
      on conflict(user_id) do update set key_hash=excluded.key_hash,issued_at=clock_timestamp(),consumed_at=null,operation_id=null,operation_finished_at=null;
    insert into private.account_recovery_events(user_id,action) values(uid,'key_issued');
    return jsonb_build_object('ok',true);
  elsif p_action='consume' then
    uname:=lower(btrim(normalize(coalesce(p_payload->>'username',''),NFKC))); kh:=p_payload->>'key_hash';
    select user_id into uid from public.profiles where username=uname and status='active' for update;
    if not found then return jsonb_build_object('ok',false,'error','invalid_recovery'); end if;
    if not exists(select 1 from auth.users where id=uid and (banned_until is null or banned_until<now())) then
      return jsonb_build_object('ok',false,'error','invalid_recovery'); end if;
    select * into rec from private.account_recovery_keys where user_id=uid for update;
    if not found or rec.key_hash is null or kh is null or rec.key_hash<>kh then
      return jsonb_build_object('ok',false,'error','invalid_recovery'); end if;
    op:=gen_random_uuid();
    update private.account_recovery_keys set key_hash=null,consumed_at=clock_timestamp(),operation_id=op,operation_finished_at=null where user_id=uid;
    insert into private.account_recovery_events(user_id,action,operation_id) values(uid,'reset_started',op);
    return jsonb_build_object('ok',true,'user_id',uid,'operation_id',op);
  elsif p_action in ('complete','uncertain') then
    uid:=(p_payload->>'user_id')::uuid; op:=(p_payload->>'operation_id')::uuid;
    -- An ambiguous network failure must never restore a consumed recovery key.
    -- Keep issuance paused briefly if the Auth request's outcome is unknown.
    update private.account_recovery_keys set operation_finished_at=case when p_action='complete' then clock_timestamp() else null end
      where user_id=uid and operation_id=op and operation_finished_at is null;
    if not found then return jsonb_build_object('ok',false,'error','operation_unavailable'); end if;
    insert into private.account_recovery_events(user_id,action,operation_id)
      values(uid,case when p_action='complete' then 'reset_completed' else 'reset_uncertain' end,op);
    return jsonb_build_object('ok',true);
  end if;
  return jsonb_build_object('ok',false,'error','invalid_action');
end;
$$;
create function public.manee_recovery_service(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.manee_recovery_service(p_action,p_payload);
$$;
revoke all on function private.manee_recovery_service(text,jsonb),public.manee_recovery_service(text,jsonb) from public,anon,authenticated;
grant execute on function private.manee_recovery_service(text,jsonb),public.manee_recovery_service(text,jsonb) to service_role;

-- Restrictive policies do not grant new permissions; they also constrain existing
-- permissive policies for signed-in users. Remaining anonymous legacy policies
-- still require the separate, full RLS rollout before production.
do $policies$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('create policy manee_live_session_required on public.%I as restrictive for all to authenticated using ((select private.is_live_manee_session())) with check ((select private.is_live_manee_session()))',t.tablename);
  end loop;
end;
$policies$;

-- Guard the roots of existing privileged authorization paths, preserving their
-- exact definitions otherwise. Abort on unexpected upstream changes.
do $guards$
declare fn text; body text; updated text;
begin
  foreach fn in array array['private.has_store_membership(uuid,text[])','private.has_platform_role(text[])',
    'private.has_franchise_membership(uuid,text[])','private.is_platform_admin()'] loop
    body:=pg_get_functiondef(fn::regprocedure);
    updated:=regexp_replace(body,'select exists','select private.is_live_manee_session() and exists');
    if updated=body then raise exception 'Unexpected authorization function: %',fn; end if;
    execute updated;
  end loop;
  body:=pg_get_functiondef('private.manee_staff_portal(text,jsonb)'::regprocedure);
  updated:=replace(body,'if actor is null then','if actor is null or not private.is_live_manee_session() then');
  if updated=body then raise exception 'Unexpected staff portal'; end if;
  execute updated;
end;
$guards$;
commit;
