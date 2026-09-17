-- URGENT hotfix, applied directly to production and staging on 2026-09-17
-- (same day as the Phase C permission lockdown that caused this).
--
-- Bug report: a manager couldn't save a manual attendance entry ("저장
-- 실패") and couldn't edit or delete a past expense_entries row.
--
-- Root cause: every store_memberships row for a non-owner has role='staff'
-- -- there has never been a row with role='manager'. "Manager" is tracked
-- separately via crew.is_manager. private.has_store_membership(...,
-- ['owner','manager']) -- which private.can_manage_store and (indirectly,
-- via has_sales_access) private.can_write_financials/can_view_financials
-- all depend on -- checked sm.role = any(allowed_roles) directly, so the
-- 'manager' branch could never match anyone. Before today's Phase C
-- lockdown this was invisible because the legacy "allow all" RLS policies
-- let every authenticated request through regardless of role; Phase C
-- started actually enforcing it and broke every manager's manager-only
-- actions store-wide (attendance, crew, shifts, fixed_schedules, vendors,
-- fixed_expenses, announcements, store updates, expense_entries writes) --
-- not just the two symptoms reported.
--
-- Fix: has_store_membership also accepts a role='staff' membership as a
-- 'manager' match when the linked crew row has is_manager=true. No data
-- migration needed since crew.is_manager was already the correct signal.
create or replace function private.has_store_membership(target_store_id uuid, allowed_roles text[] default null::text[])
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from public.store_memberships sm
    join public.profiles p on p.user_id=sm.user_id and p.status='active'
    join public.stores s on s.id=sm.store_id and s.archived_at is null
    left join public.crew c on c.id=sm.crew_id and c.store_id=sm.store_id
    where sm.user_id=(select auth.uid()) and sm.store_id=target_store_id and sm.status='active'
      and (
        allowed_roles is null
        or sm.role = any(allowed_roles)
        or (sm.role='staff' and c.is_manager and 'manager' = any(allowed_roles))
      )
      and (sm.role='owner' or (sm.role in ('staff','manager') and c.id is not null
        and (c.resign_date is null or c.resign_date > (now() at time zone 'Asia/Seoul')::date)))
  );
$$;
