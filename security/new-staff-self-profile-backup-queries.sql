-- READ-ONLY queries for an INDEPENDENT (off-database) manual export of staging data.
-- Nothing here writes. Run in the Supabase dashboard SQL Editor of project obpkzecgswnfuyhwvncd (staging) ONLY.
--
-- STATUS: no data export exists yet. This file is a procedure, not a backup.
-- This is a PARTIAL data backup (business data + an account identity map). It is not a full database backup:
-- see runbook section 3 for what it cannot restore (passwords, login tokens, Auth settings, secrets).
-- Exporting these files is NOT proof that the data is recoverable. A backup is only called
-- "recoverable" after a restore rehearsal succeeds (runbook section 3.3).
-- The digest's row counts detect an incomplete export; its hash detects that the DATABASE changed (during the export or
-- afterwards). Neither proves the CSV content equals the database, and neither proves restorability.
--
-- The exported files contain personal data (phone, bank account, resident number, wages, attendance) and internal
-- account identifiers. Never commit them, paste them into chat, or add them to a review ZIP. Store them outside the repository.
--
-- Included: attendance, sales, expenses, payroll inputs, personal/bank data, store<->staff links, and an account
-- identity map (auth.users id/email/created_at/... WITHOUT the password hash) so the links stay traceable.
-- Excluded on purpose: password hashes and tokens, public.owner_requests (may hold legacy password hashes),
-- private.account_recovery_* and private.password_reset_* (recovery secrets), public.push_subscriptions (endpoints),
-- public.auth_rate_limits (ephemeral). Full-account recovery options are in runbook section 3.6.
--
-- File names: save each export as <t>.csv exactly as listed in the digest, e.g. public.crew.csv and
-- auth.users_identity_map.csv, next to digest.csv.
-- Order: (1) run digest -> digest.csv, (2) export the 18 files, (3) run the SAME digest again AFTER the last export
-- -> digest-after.csv (the exports are separate queries, so the data can change in between; this detects it),
-- (4) FIRST backup only: node security/backup-tools.mjs init <folder>   (writes the baseline manifest, never overwrites it)
--     later checks:        node security/backup-tools.mjs verify <folder>  (files vs the baseline)
--     database vs backup:  node security/backup-tools.mjs db-check <folder> <digest-now.csv>
-- These prove the export is complete and the files are unchanged since the baseline. They do NOT prove the CSV
-- content equals the database (the digest hash is over database rows) and do NOT prove the data can be restored.

-- 0. Digest of what you are about to export (save this output as digest.csv next to the files; run it again at the end).
select 'public.stores' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.stores x
union all select 'public.crew' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.crew x
union all select 'public.crew_pay_adjustments' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.crew_pay_adjustments x
union all select 'public.profiles' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.profiles x
union all select 'public.store_memberships' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.store_memberships x
union all select 'public.attendance' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.attendance x
union all select 'public.attendance_edit_requests' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.attendance_edit_requests x
union all select 'public.shifts' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.shifts x
union all select 'public.fixed_schedules' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.fixed_schedules x
union all select 'public.sales_reports' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.sales_reports x
union all select 'public.sales_report_photos' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.sales_report_photos x
union all select 'public.expense_entries' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.expense_entries x
union all select 'public.fixed_expenses' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.fixed_expenses x
union all select 'public.vendors' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from public.vendors x
union all select 'private.staff_link_requests' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from private.staff_link_requests x
union all select 'private.staff_access_events' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from private.staff_access_events x
union all select 'private.store_staff_code_history' as t,count(*) as n,md5(coalesce(string_agg(x::text,'|' order by x::text),'')) as h from private.store_staff_code_history x
union all select 'auth.users_identity_map' as t,count(*) as n,md5(coalesce(string_agg((id,email,created_at,last_sign_in_at,banned_until,email_confirmed_at)::text,'|' order by id),'')) as h from auth.users;

-- 1..18. One export per statement. Run each separately and use "Download CSV".
select * from public.stores;
select * from public.crew;
select * from public.crew_pay_adjustments;
select * from public.profiles;
select * from public.store_memberships;
select * from public.attendance;
select * from public.attendance_edit_requests;
select * from public.shifts;
select * from public.fixed_schedules;
select * from public.sales_reports;
select * from public.sales_report_photos;
select * from public.expense_entries;
select * from public.fixed_expenses;
select * from public.vendors;
select * from private.staff_link_requests;
select * from private.staff_access_events;
select * from private.store_staff_code_history;
select id,email,created_at,last_sign_in_at,banned_until,email_confirmed_at from auth.users order by id;   -- identity map ONLY: no password hash, no tokens, no metadata
