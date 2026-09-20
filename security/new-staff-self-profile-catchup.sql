-- ============================ DO NOT AUTO-RUN ============================
-- NOT part of the automated apply or recovery procedure. It changes existing
-- crew rows, so each use needs its own explicit approval:
--   1. Run ONLY the preview (no manee.catchup_confirm) and report the result
--      (candidate crew ids, store, wage, employment_setup_required) to the owner.
--   2. State which crew rows would change and what changes (phone, bank_account,
--      self_service_profile, employment_setup_required).
--   3. Write only after the approval names those rows.
-- =========================================================================
-- OPTIONAL follow-up after security/new-staff-self-profile-rollback.sql.
-- While the patch is rolled back, approve_new creates crew rows WITHOUT copying the
-- phone/bank data the new staff entered at signup. That data is still stored in
-- private.staff_registration_profiles; this fills it into those crew rows.
--
-- Safe by default: without confirmation it only reports candidates (ids, no
-- personal values). Only crew rows that satisfy ALL of these are touched:
--   * request status 'approved', crew created at/after the request (so records
--     linked to a PRE-EXISTING employee are never candidates),
--   * self_service_profile=false and both phone and bank_account are still blank,
--   * the requester has a private.staff_registration_profiles row.
-- Existing values are never overwritten; wage and conditions are never changed.
--
-- To write, run these two lines FIRST in the same session/transaction:
--   begin;
--   select set_config('manee.catchup_confirm','yes',true);
-- then this file's DO block, then commit.
do $catchup$
declare n int;
begin
  if coalesce(current_setting('manee.catchup_confirm',true),'')<>'yes' then
    raise notice 'PREVIEW ONLY: set manee.catchup_confirm=yes to write.';
    return;
  end if;
  with candidates as (
    select c.id crew_id,p.phone,p.bank_name,p.bank_account,p.account_holder
    from private.staff_link_requests r
    join public.crew c on c.id=r.crew_id
    join private.staff_registration_profiles p on p.user_id=r.requester_user_id
    where r.status='approved' and c.created_at>=r.requested_at
      and coalesce(c.self_service_profile,false)=false
      and coalesce(btrim(c.phone),'')='' and coalesce(btrim(c.bank_account),'')=''
  ), done as (
    update public.crew c set phone=k.phone,
      bank_account=concat_ws(' / ',k.bank_name,k.bank_account,k.account_holder),
      self_service_profile=true,
      employment_setup_required=(c.wage<=0)
    from candidates k where c.id=k.crew_id
    returning c.id
  ) select count(*) into n from done;
  raise notice 'filled % crew row(s)',n;
end;
$catchup$;

-- Report (ids and non-personal fields only). After a confirmed run this returns no rows.
select c.id as crew_id,c.store_id,c.created_at,c.wage,c.employment_setup_required as setup_required_now,(c.wage<=0) as setup_required_after
from private.staff_link_requests r
join public.crew c on c.id=r.crew_id
join private.staff_registration_profiles p on p.user_id=r.requester_user_id
where r.status='approved' and c.created_at>=r.requested_at
  and coalesce(c.self_service_profile,false)=false
  and coalesce(btrim(c.phone),'')='' and coalesce(btrim(c.bank_account),'')=''
order by c.created_at;
