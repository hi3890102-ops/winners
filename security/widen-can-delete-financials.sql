-- Applied directly to production and staging on 2026-09-17.
--
-- Request: delete permission on financial records (expense_entries,
-- sales_reports) should match whoever already has sales-view access,
-- not just owner/manager -- a store may deliberately hand sales access
-- to a trusted staff member without making them a manager, and that
-- person should be able to correct their own mis-entries.
--
-- Fix: private.can_delete_financials(target_store_id) now widens to
-- match private.can_write_financials's has_sales_access-based check,
-- instead of being owner/manager (can_manage_store) only.
create or replace function private.can_delete_financials(target_store_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select
    private.has_platform_role(array['super_admin','admin']::text[])
    or private.has_sales_access(target_store_id);
$$;
