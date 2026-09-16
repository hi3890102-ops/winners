-- DRAFT ONLY - DO NOT APPLY TO PRODUCTION YET
-- Manee SaaS RLS v1
-- Roles: platform HQ > franchise HQ > owner/manager > staff
-- Requires private helper functions already installed in Supabase.

-- ============================================================
-- 1) SALES REPORTS
-- Franchise HQ: affiliated stores SELECT only
-- Owner/manager: own store read/write
-- Staff: only when crew.sales_access=true; read/write own store closing data
-- ============================================================

-- helper for sales-enabled staff
create or replace function private.has_sales_access(target_store_id uuid)
returns boolean
language sql stable security definer set search_path=''
as $$
  select private.has_store_membership(target_store_id, array['owner','manager']::text[])
  or exists (
    select 1
    from public.store_memberships sm
    join public.crew c on c.id = sm.crew_id
    where sm.user_id = (select auth.uid())
      and sm.store_id = target_store_id
      and sm.status = 'active'
      and sm.role = 'staff'
      and c.sales_access = true
  );
$$;

-- sales_reports SELECT: HQ, franchise, owner/manager, sales-enabled staff
-- USING: private.has_platform_role(array['super_admin','admin','support','read_only'])
--        OR private.has_sales_access(store_id)
--        OR affiliated franchise membership via stores.franchise_id
-- INSERT/UPDATE: super_admin/admin OR private.has_sales_access(store_id)
-- DELETE: super_admin/admin OR owner only

-- ============================================================
-- 2) EXPENSE ENTRIES
-- Franchise HQ: affiliated stores SELECT only
-- Owner/manager: own store read/write
-- Staff: sales-enabled staff may insert/read closing expenses; delete restricted
-- ============================================================

-- SELECT: HQ + affiliated franchise + private.has_sales_access(store_id)
-- INSERT: super_admin/admin + private.has_sales_access(store_id)
-- UPDATE: super_admin/admin + owner/manager
-- DELETE: super_admin/admin + owner

-- ============================================================
-- 3) ATTENDANCE
-- Franchise HQ MUST NOT get raw employee attendance rows.
-- Franchise receives aggregated store-level summary through a safe RPC later.
-- Owner/manager: full own-store attendance management
-- Staff: own attendance only
-- IMPORTANT: staff direct UPDATE is intentionally not allowed because RLS cannot
-- safely stop a malicious client from setting manager-only columns such as confirmed.
-- Staff changes must move to RPCs (clock in/out, confirm, edit request).
-- ============================================================

-- SELECT:
--   HQ all
--   owner/manager own store
--   staff only where crew_id = private.current_crew_id(store_id)
-- INSERT:
--   owner/manager may insert manual rows
--   staff may insert only their own crew_id with confirmed=false
-- UPDATE:
--   HQ admin + owner/manager only
--   staff uses dedicated RPC
-- DELETE:
--   HQ admin + owner/manager only

-- Planned staff attendance RPCs:
--   public.clock_in(target_store_id uuid)
--   public.clock_out(target_attendance_id uuid)
--   public.confirm_my_attendance(target_attendance_id uuid)
--   public.edit_my_attendance_time(target_attendance_id uuid, check_in time, check_out time)

-- ============================================================
-- 4) CREW / PERSONAL INFORMATION
-- Raw crew row contains wage, phone, resident_number, bank_account, notes, etc.
-- Franchise HQ must NEVER SELECT raw crew rows.
-- Staff must NEVER SELECT coworkers' raw rows.
-- ============================================================

-- RAW crew SELECT:
--   HQ authorized roles
--   owner own store
--   staff self row only
-- Manager does NOT receive raw crew because wage/resident/bank are in same row.
-- INSERT/UPDATE/DELETE raw crew:
--   super_admin/admin + owner only
-- Manager operational actions should use safe RPCs / limited views.

-- Safe directory RPC (planned):
-- public.get_store_crew_directory(target_store_id uuid)
-- returns only: id, store_id, name, position, is_manager, resign_date
-- allowed: HQ, franchise HQ for affiliated stores, owner/manager, staff same store

-- Franchise store overview RPC (planned):
-- public.get_franchise_store_overview()
-- returns store-level aggregates only; no resident_number, bank_account,
-- individual wage, or raw employee attendance rows.

-- ============================================================
-- 5) HQ INTERNAL ROLE SPLIT
-- super_admin: platform configuration + all management
-- admin: normal platform management
-- support: read/support only, no destructive writes
-- read_only: analytics/status read only
-- Never use generic is_platform_admin() for write policies.
-- Write policies must use private.has_platform_role(array['super_admin','admin']).

-- ============================================================
-- 6) CUTOVER ORDER (MANDATORY)
-- A. create safe RPCs/views and app code paths first
-- B. migrate existing users to Supabase Auth + memberships
-- C. test with 4 test users: HQ / franchise / owner / staff
-- D. only then replace current allow-all policies table-by-table
-- E. verify legacy app fallback is no longer used
-- F. deploy production only after explicit approval

-- NOTE: crew hard delete currently cascades into attendance and other records.
-- Before SaaS production, replace crew hard-delete with resignation/archive policy.
