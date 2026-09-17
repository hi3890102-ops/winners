-- Closes the last three of the five tables store-permissions.sql never
-- covered (see production-rollout.md's Phase C status note). Applied to
-- both staging and production on 2026-09-17.
--
-- billing_settings: read only by the HQ dashboard stats loader
-- (isHq-gated), so scope to platform admins.
-- crew_pay_adjustments: store payroll adjustments, same shape as
-- crew/attendance -- manager-only full CRUD via can_manage_store.
-- tax_reminder_ack: read across every store a role can see (owner/HQ/
-- franchise dashboard tax-reminder banner), written only when dismissing
-- your own store's reminder -- can_view_store for read, can_manage_store
-- for insert.
--
-- Still open: app_settings and owner_requests, both read/written
-- pre-authentication by legacy login flows (client fetches password_hash
-- directly to verify credentials before any Supabase Auth session
-- exists). These need an RPC-based redesign, not a grant/policy swap --
-- tracked separately, not part of this pass.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

revoke all on public.billing_settings from anon, authenticated;
revoke all on public.crew_pay_adjustments from anon, authenticated;
revoke all on public.tax_reminder_ack from anon, authenticated;

drop policy if exists "allow all - billing_settings" on public.billing_settings;
drop policy if exists "allow all - crew_pay_adjustments" on public.crew_pay_adjustments;
drop policy if exists "allow all - tax_reminder_ack" on public.tax_reminder_ack;

grant select on public.billing_settings to authenticated;
create policy billing_settings_admin_read on public.billing_settings for select to authenticated
  using (private.has_platform_role(array['super_admin','admin','support','read_only']::text[]));

grant select,insert,update,delete on public.crew_pay_adjustments to authenticated;
create policy crew_pay_adjustments_manage on public.crew_pay_adjustments for all to authenticated
  using (private.can_manage_store(store_id)) with check (private.can_manage_store(store_id));

grant select,insert on public.tax_reminder_ack to authenticated;
create policy tax_reminder_ack_read on public.tax_reminder_ack for select to authenticated
  using (private.can_view_store(store_id));
create policy tax_reminder_ack_write on public.tax_reminder_ack for insert to authenticated
  with check (private.can_manage_store(store_id));

commit;
