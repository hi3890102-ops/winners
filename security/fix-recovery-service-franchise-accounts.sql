-- Applied directly to production and staging on 2026-09-17.
--
-- Bug found while resetting a forgotten franchise account password:
-- the self-service "비밀번호를 잊으셨나요?" flow's affiliation check in
-- private.manee_support_recovery_service('request', ...) only handled
-- two account types -- "본사"/"hq" (via platform_admins) and store
-- owner/staff (via store_memberships + stores.name). Franchise accounts
-- (franchise_memberships) had no matching branch at all, so any request
-- for a franchise username silently no-opped (the deliberately vague
-- "접수됐다" response never reveals match/no-match, so this was
-- invisible from the UI -- confirmed by directly querying
-- private.password_reset_requests before/after).
--
-- Fix: add a franchise_memberships branch, checked after the hq case
-- and before the store fallback. target_store_id stays null for a
-- franchise-type request, same as the hq case.
--
-- Verified end-to-end against production after this fix: request (via
-- the real manee-account-recovery edge function) -> HQ issues a code in
-- the UI -> reset (via the edge function) -> auth.users.encrypted_password
-- actually changed and the request reached status='completed'.
create or replace function private.manee_support_recovery_service(p_action text, p_payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
    elsif exists(select 1 from public.franchise_memberships fm join public.franchises f on f.id=fm.franchise_id
        where fm.user_id=uid and fm.status='active' and lower(f.name)=lower(affiliation)) then
      -- matched an active franchise membership by franchise name; target_store_id stays null, like the HQ case.
      null;
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
$function$;
