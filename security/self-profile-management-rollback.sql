-- NON-DESTRUCTIVE rollback for security/self-profile-management.sql.
-- Keeps private.staff_self_profiles, private.profile_change_events and every crew value (nothing is deleted or reverted).
-- Removes the way in: the three public RPCs are revoked, the guard trigger is dropped (stores can edit the basic fields again),
-- and the staff-portal wrapper is restored to the previous version of new-staff-self-profile.sql.
-- Re-apply later: run security/self-profile-management.sql again.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
revoke all on function public.manee_my_profile_state(boolean),public.manee_save_my_profile(jsonb,integer),public.manee_owner_profile_changes(uuid,integer) from public,anon,authenticated;
revoke all on function private.my_profile_state(boolean),private.save_my_profile(jsonb,integer),private.owner_profile_changes(uuid,integer) from public,anon,authenticated;
drop trigger if exists manee_guard_self_managed_crew on public.crew;

create or replace function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  result jsonb;
  personal private.staff_registration_profiles%rowtype;
  requester uuid;
  reqs jsonb;
begin
  if auth.uid() is null or not private.is_live_manee_session() then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  result:=private.manee_staff_portal_before_self_profile(p_action,p_payload);
  if coalesce((result->>'ok')::boolean,false) is not true then return result; end if;
  if p_action='session' then
    select * into personal from private.staff_registration_profiles where user_id=auth.uid();
    if found then result:=result||jsonb_build_object('personal_profile',
      jsonb_build_object('phone',personal.phone,'bank_name',personal.bank_name,
        'bank_account',personal.bank_account,'account_holder',personal.account_holder)); end if;
  elsif p_action='owner_list' then
    select coalesce(jsonb_agg(e.value || case when p.user_id is null then '{}'::jsonb else
      jsonb_build_object('personal_profile',jsonb_build_object('phone',p.phone,'bank_name',p.bank_name,
        'bank_account',p.bank_account,'account_holder',p.account_holder)) end order by e.ordinality),'[]'::jsonb)
      into reqs
      from jsonb_array_elements(coalesce(result->'requests','[]'::jsonb)) with ordinality e(value,ordinality)
      left join private.staff_registration_profiles p on p.user_id=(e.value->>'requester_user_id')::uuid;
    result:=result||jsonb_build_object('requests',reqs);
  elsif p_action='approve_new' and coalesce((result->>'created_new')::boolean,false) then
    select requester_user_id into requester from private.staff_link_requests where id=(p_payload->>'request_id')::uuid;
    select * into personal from private.staff_registration_profiles where user_id=requester;
    if found then
      update public.crew set phone=personal.phone,
        bank_account=concat_ws(' / ',personal.bank_name,personal.bank_account,personal.account_holder),
        self_service_profile=true,employment_setup_required=true
        where id=(result->>'crew_id')::uuid;
      result:=result||jsonb_build_object('employment_setup_required',true);
    end if;
  end if;
  return result;
end;
$$;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
commit;
