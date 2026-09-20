-- NON-DESTRUCTIVE rollback for security/new-staff-self-profile.sql.
-- Only swaps function names back so the portal behaves as it did before the patch.
-- It deliberately does NOT:
--   * drop private.staff_registration_profiles (new staff's phone/bank data stays)
--   * drop crew.self_service_profile / crew.employment_setup_required
--   * drop public/private.bootstrap_staff_account_with_profile (a newer signup
--     Edge Function keeps working and keeps saving personal data)
--   * touch accounts, profiles, memberships, requests, crew rows or wages.
-- What you lose while rolled back: owner_list/session stop returning
-- personal_profile, and approve_new stops copying phone/bank into the new crew row.
-- security/new-staff-self-profile-catchup.sql is NOT part of the automated apply/recovery procedure. It changes
-- existing crew rows, so it is only ever run by hand after a preview report and a separate approval that names
-- the rows (see the file's own header).
--
-- Recovery order (identical to runbook section 5; the compat Edge Function comes FIRST):
--   1) deploy the COMPAT Edge Function (security/edge-rollback/manee-staff-signup-v1-compat.ts) so an already-open
--      new app fails loudly (HTTP 426) instead of silently losing the personal data it collects,
--   2) smoke-test it, 3) roll back the frontend, 4) run THIS file, then check with
--      security/new-staff-self-profile-verify.sql (phase 'rolled_back').
--
-- Re-apply later: run security/new-staff-self-profile.sql again (safe once this
-- file has run: it renames the restored function back to *_before_self_profile).
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $rollback$
begin
  if to_regprocedure('private.manee_staff_portal(text,jsonb)') is null then
    raise exception 'private.manee_staff_portal is missing. Restore it with security/backups/staging-obpkzecgswnfuyhwvncd-2026-09-19-before-self-profile.sql';
  end if;
  if to_regprocedure('private.manee_staff_portal_before_self_profile(text,jsonb)') is null then
    raise exception 'private.manee_staff_portal_before_self_profile is missing: already rolled back, or it was overwritten. Check with new-staff-self-profile-verify.sql before doing anything else.';
  end if;
  -- The live function must still be the wrapper. If an older patch re-ran and
  -- replaced it, swapping would put the wrong function in place.
  if position('staff_registration_profiles' in pg_get_functiondef('private.manee_staff_portal(text,jsonb)'::regprocedure))=0 then
    raise exception 'private.manee_staff_portal is not the self-profile wrapper (overwritten by an older SQL?). Nothing was changed.';
  end if;
  -- A copy left by an EARLIER rollback -> re-apply cycle is a superseded wrapper
  -- (code only, no data). Drop it so a second rollback can run.
  if to_regprocedure('private.manee_staff_portal_self_profile_disabled(text,jsonb)') is not null then
    drop function private.manee_staff_portal_self_profile_disabled(text,jsonb);
  end if;

  alter function private.manee_staff_portal(text,jsonb) rename to manee_staff_portal_self_profile_disabled;
  alter function private.manee_staff_portal_before_self_profile(text,jsonb) rename to manee_staff_portal;
end;
$rollback$;

-- ACLs travel with a function when it is renamed, so set them explicitly:
-- the restored function needs the authenticated grant that the *_before_ copy
-- had revoked, and the kept wrapper must not be callable by clients.
revoke all on function private.manee_staff_portal_self_profile_disabled(text,jsonb) from public,anon,authenticated;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
-- public.manee_staff_portal calls private.manee_staff_portal by name and is unchanged.
commit;
