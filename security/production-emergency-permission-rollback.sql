-- EMERGENCY ONLY.
-- Restores the pre-security-v2 legacy browser access model captured from production
-- before permission lockdown. This is intentionally permissive and should only be
-- used together with an application rollback to the recorded pre-cutover deploy.
-- It does NOT delete Auth users, profiles, memberships, staff links, recovery logs,
-- crew, attendance or business records.

begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Remove restrictive live-session gates so the legacy browser app can function.
do $drop_live_session$
declare t text;
begin
  foreach t in array array[
    'announcement_reads','announcements','attendance','checklist_checks','checklist_log','checklist_templates',
    'crew','expense_entries','fixed_expenses','fixed_schedules','reservations','sales_report_photos',
    'sales_reports','shifts','store_memberships','stores','vendors'
  ] loop
    if exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='manee_live_session_required') then
      execute format('drop policy %I on public.%I','manee_live_session_required',t);
    end if;
  end loop;
end;
$drop_live_session$;

-- Restore the observed legacy unconditional RLS policies.
do $legacy_policies$
declare t text;
begin
  foreach t in array array[
    'announcement_reads','announcements','app_settings','attendance','checklist_checks','checklist_log','checklist_templates',
    'crew','expense_entries','fixed_expenses','fixed_schedules','owner_requests','reservations','sales_report_photos',
    'sales_reports','shifts','stores','vendors'
  ] loop
    if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='allow all - '||t) then
      execute format('create policy %I on public.%I for all to public using (true) with check (true)','allow all - '||t,t);
    end if;
  end loop;
end;
$legacy_policies$;

-- Recreate the archived-store read filter if it was removed.
do $archived_store_policy$
begin
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='stores' and policyname='hide archived stores') then
    execute 'create policy "hide archived stores" on public.stores for select to public using (archived_at is null)';
  end if;
end;
$archived_store_policy$;

-- Restore the exact broad grants used by the legacy app for its public tables.
grant all privileges on table
  public.announcement_reads,public.announcements,public.app_settings,public.attendance,
  public.checklist_checks,public.checklist_log,public.checklist_templates,public.crew,
  public.fixed_expenses,public.fixed_schedules,public.franchises,public.owner_requests,
  public.push_subscriptions,public.reservations,public.sales_report_photos,public.shifts,
  public.stores,public.vendors
  to anon,authenticated;

grant select,insert,update,delete on table public.expense_entries,public.sales_reports to anon,authenticated;

grant select on table
  public.attendance_edit_requests,public.franchise_memberships,public.platform_admins,
  public.profiles,public.store_memberships
  to authenticated;

grant usage,select on all sequences in schema public to anon,authenticated;

commit;
