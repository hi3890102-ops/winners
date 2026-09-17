-- Applied directly to production and staging on 2026-09-17, as a planned
-- follow-up to fix-manager-role-recognition.sql (flagged, not fixed, in that pass).
--
-- Gap: private.has_store_membership(...) was fixed to treat a staff
-- membership with crew.is_manager=true as satisfying a 'manager' role
-- check -- but only on the SERVER side (RLS/RPC write gates). The CLIENT
-- side (canManageBusinessData() in index.html) intentionally checks
-- state.authMemberships[].role directly and does NOT fall back to
-- crew.isManager (see security/store-permissions-ui.test.mjs, test
-- "Manager controls use current membership rather than the old employee
-- flag" -- crew.isManager is explicitly called "the old employee flag").
-- Nothing ever wrote store_memberships.role='manager': toggleManager()
-- only wrote crew.is_manager, and store_memberships had no client UPDATE
-- policy at all (self-SELECT only). Net effect: canManageBusinessData()
-- was still closed for real managers client-side (hiding vendor/fixed-
-- expense management panels) even though server-side writes now worked.
--
-- Fix: a privileged RPC that toggles crew.is_manager and syncs the
-- linked store_memberships.role ('manager' <-> 'staff') in the same
-- transaction, so the client's role-based check becomes accurate. Follows
-- the existing private-impl + public-security-invoker-wrapper pattern
-- used for get_store_crew_directory etc. (see phase-c-core-tables
-- migration). Client's toggleManager() now calls this RPC instead of a
-- plain crew.update() when MANEE_STAFF_AUTH_ENABLED.
create or replace function private.set_crew_manager_flag(target_crew_id uuid, is_manager boolean)
returns public.crew
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_store_id uuid;
  result public.crew;
begin
  select store_id into target_store_id from public.crew where id = target_crew_id;
  if target_store_id is null then
    raise exception 'Crew record not found' using errcode='P0002';
  end if;
  if not private.can_manage_store(target_store_id) then
    raise exception 'Not authorized for this store' using errcode='42501';
  end if;

  update public.crew set is_manager = set_crew_manager_flag.is_manager
    where id = target_crew_id
    returning * into result;

  update public.store_memberships
    set role = case when set_crew_manager_flag.is_manager then 'manager' else 'staff' end
    where crew_id = target_crew_id and role in ('staff','manager') and status = 'active';

  return result;
end;
$$;

revoke all on function private.set_crew_manager_flag(uuid, boolean) from public, anon;

create or replace function public.set_crew_manager_flag(target_crew_id uuid, is_manager boolean)
returns public.crew
language sql
set search_path = ''
as $$ select * from private.set_crew_manager_flag(target_crew_id, is_manager); $$;

revoke all on function public.set_crew_manager_flag(uuid, boolean) from public, anon;
grant execute on function public.set_crew_manager_flag(uuid, boolean) to authenticated;
