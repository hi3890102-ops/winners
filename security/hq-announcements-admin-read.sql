-- Applied directly to PRODUCTION only on 2026-09-17 (not mirrored to
-- staging -- feature was scoped to manee-admin's dashboard, which per
-- explicit instruction was built main-branch-direct against production).
--
-- Needed for manee-admin's 소통 > 공지작성 tab to show a "지난 공지"
-- (past announcements) list. hq_announcements had no SELECT access for
-- authenticated HQ admins at all.
grant select on public.hq_announcements to authenticated;

create policy hq_communication_admin_read on public.hq_announcements
  for select to authenticated
  using (private.has_platform_role(array['super_admin','admin','support','read_only']::text[]));
