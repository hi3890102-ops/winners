-- Emergency fix, applied directly to production (bhwuuxcrzxespkjlmqxr) on
-- 2026-09-17. public.franchises had RLS disabled entirely and full
-- INSERT/SELECT/UPDATE/DELETE grants open to anon -- anyone with just the
-- public anon key could read, modify, or delete any franchise record with
-- no login at all. authenticated had the same broad grants, including
-- SELECT on password_hash (a real credential hash for legacy PIN-mode
-- franchise accounts).
--
-- This mirrors the policy shape store-permissions.sql already applies to
-- staging (franchises_metadata_read + the restrictive live-session gate),
-- scoped down to the columns the client actually needs.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.franchises enable row level security;

revoke all on public.franchises from anon;
revoke all on public.franchises from authenticated;

grant select(id,name,username,created_at,monthly_price) on public.franchises to authenticated;

create policy franchises_metadata_read on public.franchises for select to authenticated
  using (private.has_platform_role(array['super_admin','admin','support','read_only']::text[]) or private.has_franchise_membership(id, null::text[]));

create policy manee_live_session_required on public.franchises
  as restrictive for all to authenticated
  using ((select private.is_live_manee_session()))
  with check ((select private.is_live_manee_session()));

-- Separately: franchise_memberships had no permissive UPDATE policy at all,
-- so the HQ 정지/재개 (suspend/resume) action in the admin app silently
-- no-op'd for every platform admin. Scoped narrowly, matching can_manage_store.
create policy franchise_memberships_admin_manage on public.franchise_memberships
  for update to authenticated
  using (private.has_platform_role(array['super_admin','admin']::text[]))
  with check (private.has_platform_role(array['super_admin','admin']::text[]));
grant update(status, revoked_at) on public.franchise_memberships to authenticated;

commit;
