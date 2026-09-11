-- READ ONLY. Production security-v2 preflight.
-- This file must not mutate production data.

select jsonb_build_object(
  'profiles', (select count(*) from public.profiles),
  'stores', (select count(*) from public.stores),
  'active_stores', (select count(*) from public.stores where archived_at is null),
  'crew', (select count(*) from public.crew),
  'attendance', (select count(*) from public.attendance),
  'reservations', (select count(*) from public.reservations),
  'owner_requests', (select count(*) from public.owner_requests),
  'auth_users', (select count(*) from auth.users),
  'active_owner_memberships', (select count(*) from public.store_memberships where role='owner' and status='active'),
  'active_staff_memberships', (select count(*) from public.store_memberships where role in ('staff','manager') and status='active'),
  'platform_admins', (select count(*) from public.platform_admins where status='active'),
  'approved_owner_rows_without_auth', (select count(*) from public.owner_requests where status='approved' and auth_user_id is null),
  'approved_owner_rows_with_auth', (select count(*) from public.owner_requests where status='approved' and auth_user_id is not null)
) as production_baseline;

with required(name) as (values
 ('public.profiles'),('public.store_memberships'),('public.franchise_memberships'),('public.platform_admins'),
 ('public.attendance_edit_requests'),('public.stores'),('public.checklist_templates'),('public.checklist_checks'),('public.checklist_log'),
 ('public.crew'),('public.attendance'),('public.shifts'),('public.fixed_schedules'),('public.sales_reports'),('public.expense_entries'),
 ('public.vendors'),('public.fixed_expenses'),('public.reservations'),('public.announcements'),('public.announcement_reads'),
 ('public.sales_report_photos'),('public.franchises')
), missing as (
 select name from required where to_regclass(name) is null
), dup_open as (
 select crew_id,count(*) c from public.attendance where crew_id is not null and check_out is null group by crew_id having count(*)>1
), dup_codes as (
 select join_code,count(*) c from public.crew where join_code is not null group by join_code having count(*)>1
)
select jsonb_build_object(
 'missing_required_relations',coalesce((select jsonb_agg(name) from missing),'[]'::jsonb),
 'duplicate_open_attendance_crews',(select count(*) from dup_open),
 'duplicate_join_codes',(select count(*) from dup_codes),
 'invalid_join_codes',(select count(*) from public.crew where join_code is null or join_code !~ '^[0-9]{6}$'),
 'crew_store_mismatch_memberships',(select count(*) from public.store_memberships sm join public.crew c on c.id=sm.crew_id where sm.crew_id is not null and c.store_id<>sm.store_id),
 'reservations_sequence_exists',to_regclass('public.reservations_id_seq') is not null,
 'staff_portal_exists',to_regprocedure('public.manee_staff_portal(text,jsonb)') is not null,
 'recovery_portal_exists',to_regprocedure('public.manee_recovery_portal()') is not null,
 'password_reset_requests_exists',to_regclass('private.password_reset_requests') is not null
) as production_compatibility;

select tablename,policyname,cmd,roles
from pg_policies
where schemaname='public' and (policyname like 'allow all - %' or policyname='hide archived stores')
order by tablename,policyname;
