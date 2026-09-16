-- Add 신규 직원 승인 on top of reusable store-code onboarding.
-- Staging first. Production requires the normal security-v2 rollout approval.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $rename$
begin
  if to_regprocedure('private.manee_staff_portal_store_v1(text,jsonb)') is null then
    alter function private.manee_staff_portal(text,jsonb) rename to manee_staff_portal_store_v1;
  end if;
end
$rename$;
revoke all on function private.manee_staff_portal_store_v1(text,jsonb) from public,anon,authenticated;

create or replace function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  req private.staff_link_requests%rowtype;
  member public.store_memberships%rowtype;
  person public.crew%rowtype;
  requester public.profiles%rowtype;
  st public.stores%rowtype;
  rid uuid; sid uuid; display_name text;
begin
  if p_action is distinct from 'approve_new' then
    return private.manee_staff_portal_store_v1(p_action,p_payload);
  end if;
  if actor is null or not private.is_live_manee_session() then
    raise exception 'Authentication required' using errcode='42501';
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
  select * into req from private.staff_link_requests where id=rid for update;
  if req.status='approved' and req.membership_id is not null then
    return jsonb_build_object('ok',true,'membership_id',req.membership_id,'crew_id',req.crew_id,'created_new',true);
  end if;
  if req.status<>'pending' then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  if req.expires_at<=now() then
    update private.staff_link_requests set status='expired',reviewed_at=now() where id=rid;
    return jsonb_build_object('ok',false,'error','request_expired');
  end if;
  select * into requester from public.profiles where user_id=req.requester_user_id and status='active' for share;
  if not found then return jsonb_build_object('ok',false,'error','account_unavailable'); end if;
  select * into member from public.store_memberships where user_id=req.requester_user_id and store_id=sid for update;
  if found then
    if member.role='owner' then return jsonb_build_object('ok',false,'error','store_account_conflict'); end if;
    if member.crew_id is not null then return jsonb_build_object('ok',false,'error','existing_record_required'); end if;
    return jsonb_build_object('ok',false,'error','connection_conflict');
  end if;
  display_name:=coalesce(nullif(btrim(requester.display_name),''),requester.username,'신규 직원');
  begin
    insert into public.crew(store_id,name,wage,wage_type,position,is_manager,sales_access,join_code)
      values(sid,display_name,0,'hourly','홀',false,false,null) returning * into person;
    insert into public.store_memberships(user_id,store_id,crew_id,role,status)
      values(req.requester_user_id,sid,person.id,'staff','active') returning * into member;
  exception when unique_violation then
    return jsonb_build_object('ok',false,'error','connection_conflict');
  end;
  update private.staff_link_requests
    set crew_id=person.id,status='approved',reviewed_at=now(),reviewed_by=actor,membership_id=member.id
    where id=rid;
  insert into private.staff_access_events(actor_user_id,target_user_id,store_id,crew_id,membership_id,action)
    values(actor,req.requester_user_id,sid,person.id,member.id,'approved');
  return jsonb_build_object('ok',true,'membership_id',member.id,'crew_id',person.id,'created_new',true);
end;
$$;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
-- public.manee_staff_portal already resolves this private function by name.
commit;
