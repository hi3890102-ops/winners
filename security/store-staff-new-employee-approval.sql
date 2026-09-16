-- Adds a forward-looking approval path for NEW employees who have no existing crew record.
-- Existing employee conversion remains available through the existing `approve` action with crew_id.
-- Apply after security/store-staff-link-code.sql.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $rename$
begin
  if to_regprocedure('private.manee_staff_portal_store_v2(text,jsonb)') is null then
    alter function private.manee_staff_portal(text,jsonb) rename to manee_staff_portal_store_v2;
  end if;
end
$rename$;
revoke all on function private.manee_staff_portal_store_v2(text,jsonb) from public,anon,authenticated;

create or replace function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid := (select auth.uid());
  actor_profile public.profiles%rowtype;
  requester_profile public.profiles%rowtype;
  req private.staff_link_requests%rowtype;
  st public.stores%rowtype;
  member public.store_memberships%rowtype;
  person public.crew%rowtype;
  rid uuid; sid uuid;
begin
  if p_action is distinct from 'approve_new' then
    return private.manee_staff_portal_store_v2(p_action,p_payload);
  end if;

  if actor is null or not private.is_live_manee_session() then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  select * into actor_profile from public.profiles where user_id=actor and status='active' for share;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;

  begin rid:=(p_payload->>'request_id')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'error','request_unavailable'); end;
  select * into req from private.staff_link_requests where id=rid;
  if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  sid:=req.store_id;

  select * into st from public.stores where id=sid and archived_at is null for share;
  if not found or not private.has_store_membership(sid,array['owner']::text[]) then
    raise exception 'Owner permission required' using errcode='42501';
  end if;
  perform 1 from public.store_memberships
    where user_id=actor and store_id=sid and role='owner' and status='active' for share;
  if not found then raise exception 'Owner permission required' using errcode='42501'; end if;

  -- Serialize retries/double taps before creating any crew record.
  select * into req from private.staff_link_requests where id=rid for update;
  if not found then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  if req.status='approved' then
    return jsonb_build_object('ok',true,'membership_id',req.membership_id,'crew_id',req.crew_id,'created_new',false);
  end if;
  if req.status<>'pending' then return jsonb_build_object('ok',false,'error','request_unavailable'); end if;
  if req.expires_at<=now() then
    update private.staff_link_requests set status='expired',reviewed_at=now() where id=rid;
    return jsonb_build_object('ok',false,'error','request_expired');
  end if;
  if req.crew_id is not null then
    return jsonb_build_object('ok',false,'error','existing_record_required');
  end if;

  select * into requester_profile from public.profiles where user_id=req.requester_user_id and status='active' for share;
  if not found then return jsonb_build_object('ok',false,'error','account_unavailable'); end if;

  select * into member from public.store_memberships
    where user_id=req.requester_user_id and store_id=sid for update;
  if found then
    -- Never create a second crew record for an account that already has store history.
    return jsonb_build_object('ok',false,'error','existing_record_required');
  end if;

  begin
    insert into public.crew(store_id,name,wage,wage_type,position,hire_date,join_code)
      values(sid,coalesce(nullif(btrim(requester_profile.display_name),''),requester_profile.username),0,'hourly','홀',
        (now() at time zone 'Asia/Seoul')::date,null)
      returning * into person;

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

create or replace function public.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.manee_staff_portal(p_action,p_payload);
$$;
revoke all on function public.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function public.manee_staff_portal(text,jsonb) to authenticated;

commit;
