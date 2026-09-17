-- Phase C (permission lockdown) core batch, applied directly to production
-- (bhwuuxcrzxespkjlmqxr) on 2026-09-17 via the SQL editor, per the process
-- documented in production-rollout.md. Owner/staff Auth migration (Phase B)
-- was confirmed complete at the time (12/12 active stores had an active
-- owner store_membership) before this ran.
--
-- This is store-permissions.sql's content for exactly the 15 tables it
-- fully covers (announcement_reads, announcements, attendance,
-- checklist_checks/log/templates, crew, expense_entries, fixed_expenses,
-- fixed_schedules, sales_report_photos, sales_reports, shifts, stores,
-- vendors), with three pieces already-applied-elsewhere-today removed to
-- avoid "already exists" conflicts:
--   - is_live_manee_session() (unchanged, no need to recreate)
--   - franchises_metadata_read policy (already added via franchises-rls-lockdown.sql)
--   - reservations_member_work / reservations_oversight_read policies (same file)
--   - manee_checklist RPC (already deployed via checklist-rpc-hotfix.sql)
--
-- Deliberately NOT included (store-permissions.sql doesn't cover these
-- either, and they need their own design, not a copy-paste): app_settings,
-- billing_settings, owner_requests, tax_reminder_ack, crew_pay_adjustments.
-- All five still have their legacy "allow all" (anon-inclusive) policy on
-- both staging and production -- owner_requests and app_settings are used
-- pre-authentication by legacy login flows and need an RPC-based redesign,
-- not a simple grant/policy swap; the other three are just unaudited and
-- need a real per-table policy design before locking them down. Follow-up
-- work, tracked separately.
--
-- Verified after applying: no anon grants remain on any of the 15 tables,
-- all 11 manee_guard_business_record triggers created, all 7 RPCs moved to
-- private with invoker wrappers in public, Supabase security advisor shows
-- zero ERROR-level findings (down from the "RLS Disabled in Public" /
-- legacy-policy exposure found while verifying the HQ admin restructure).
begin;

revoke all on public.announcement_reads, public.announcements, public.attendance,
  public.checklist_checks, public.checklist_log, public.checklist_templates,
  public.crew, public.expense_entries, public.fixed_expenses, public.fixed_schedules,
  public.sales_report_photos, public.sales_reports, public.shifts, public.stores, public.vendors
  from anon, authenticated;

grant select on public.stores, public.checklist_templates, public.checklist_checks, public.checklist_log to authenticated;
grant update(name,lat,lng,onboarding_done,manager_dashboard_enabled,business_day_cutoff_hour) on public.stores to authenticated;
grant select,insert,update,delete on public.crew,public.attendance,public.shifts,public.fixed_schedules,
  public.sales_reports,public.expense_entries,public.vendors,public.fixed_expenses,
  public.announcements,public.announcement_reads,public.sales_report_photos to authenticated;
revoke delete on public.announcement_reads from authenticated;

create function private.crew_belongs_to_store(cid uuid,sid uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.can_view_store(sid) and exists(select 1 from public.crew c where c.id=cid and c.store_id=sid);
$$;
revoke all on function private.crew_belongs_to_store(uuid,uuid) from public,anon;
grant execute on function private.crew_belongs_to_store(uuid,uuid) to authenticated;

do $scoped$
declare t text;
begin
  foreach t in array array['shifts','fixed_schedules'] loop
    execute format('create policy member_read on public.%I for select to authenticated using(private.can_view_store(store_id))',t);
    execute format('create policy manager_write on public.%I for all to authenticated using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id) and private.crew_belongs_to_store(crew_id,store_id))',t);
  end loop;
  foreach t in array array['vendors','fixed_expenses'] loop
    execute format('create policy financial_read on public.%I for select to authenticated using(private.can_view_financials(store_id))',t);
    execute format('create policy manager_write on public.%I for all to authenticated using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id))',t);
  end loop;
  foreach t in array array['announcements','checklist_templates','checklist_checks','checklist_log'] loop
    execute format('create policy member_read on public.%I for select to authenticated using(private.can_view_store(store_id))',t);
  end loop;
end;
$scoped$;

create policy stores_member_read on public.stores for select to authenticated using(private.can_view_store(id));
create policy stores_manage_update on public.stores for update to authenticated using(private.can_manage_store(id)) with check(private.can_manage_store(id));
create policy crew_manage on public.crew for all to authenticated using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id));
create policy attendance_manage on public.attendance for all to authenticated
  using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id) and exists(select 1 from public.crew c where c.id=attendance.crew_id and c.store_id=attendance.store_id));
create policy attendance_self_read on public.attendance for select to authenticated using(crew_id=private.current_crew_id(store_id));

create policy announcements_manage on public.announcements for all to authenticated
  using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id));
create policy announcement_reads_read on public.announcement_reads for select to authenticated using(exists(
  select 1 from public.announcements a where a.id=announcement_id and
    (private.can_manage_store(a.store_id) or crew_id=private.current_crew_id(a.store_id))));
create policy announcement_reads_self_write on public.announcement_reads for all to authenticated using(exists(
  select 1 from public.announcements a where a.id=announcement_id and crew_id=private.current_crew_id(a.store_id))) with check(exists(
  select 1 from public.announcements a where a.id=announcement_id and crew_id=private.current_crew_id(a.store_id)));
create policy sales_photos_read on public.sales_report_photos for select to authenticated using(exists(
  select 1 from public.sales_reports r where r.id=sales_report_id and private.can_view_financials(r.store_id)));
create policy sales_photos_update on public.sales_report_photos for update to authenticated using(exists(
  select 1 from public.sales_reports r where r.id=sales_report_id and private.can_write_financials(r.store_id))) with check(exists(
  select 1 from public.sales_reports r where r.id=sales_report_id and private.can_write_financials(r.store_id)));
create policy sales_photos_insert on public.sales_report_photos for insert to authenticated with check(exists(
  select 1 from public.sales_reports r where r.id=sales_report_id and private.can_write_financials(r.store_id)));
create policy sales_photos_delete on public.sales_report_photos for delete to authenticated using(exists(
  select 1 from public.sales_reports r where r.id=sales_report_id and private.can_delete_financials(r.store_id)));

create function private.guard_business_record()
returns trigger language plpgsql security invoker set search_path='' as $$
declare label text;
begin
  if current_user<>'authenticated' then return new; end if;
  if tg_op='UPDATE' then
    if to_jsonb(old)->'store_id' is distinct from to_jsonb(new)->'store_id'
      or to_jsonb(old)->'id' is distinct from to_jsonb(new)->'id' then
      raise exception 'Record identity and store cannot be changed' using errcode='42501'; end if;
    if tg_table_name in ('shifts','fixed_schedules','attendance') and to_jsonb(old)->'crew_id' is distinct from to_jsonb(new)->'crew_id' then
      raise exception 'Employee record cannot be reassigned' using errcode='42501'; end if;
  end if;
  if tg_table_name='sales_reports' then
    if new.crew_id is not null and not private.crew_belongs_to_store(new.crew_id,new.store_id) then
      raise exception 'Employee does not belong to store' using errcode='42501'; end if;
    new.crew_id:=private.current_crew_id(new.store_id);
    new.submitted_at:=clock_timestamp();
  end if;
  if tg_table_name='announcement_reads' then new.read_at:=clock_timestamp(); end if;
  if tg_table_name in ('announcements','reservations','sales_reports') then
    select coalesce(nullif(display_name,''),username)||' ('||username||')' into label from public.profiles where user_id=auth.uid();
    if label is null then raise exception 'Active account required' using errcode='42501'; end if;
    if tg_table_name='announcements' then new.author_name:=label;
    elsif tg_table_name='reservations' then new.created_by:=label;
    else new.manager_name:=label; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_business_record() from public,anon,authenticated;
do $triggers$
declare t text;
begin
  foreach t in array array['crew','attendance','shifts','fixed_schedules','sales_reports','expense_entries','vendors','fixed_expenses','reservations','announcements','announcement_reads'] loop
    execute format('create trigger manee_guard_business_record before insert or update on public.%I for each row execute function private.guard_business_record()',t);
  end loop;
end;
$triggers$;

do $rpc_wrappers$
declare f record; args text; call_args text; result_type text;
begin
  for f in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any(array[
    'get_store_crew_directory','get_franchise_store_overview','confirm_my_attendance','request_attendance_edit',
    'approve_attendance_edit_request','reject_attendance_edit_request','cancel_my_attendance_edit_request']) loop
    args:=pg_get_function_arguments(f.oid);result_type:=pg_get_function_result(f.oid);
    select string_agg(quote_ident(a),',' order by ord) into call_args from pg_proc p,
      unnest(p.proargnames) with ordinality as names(a,ord) where p.oid=f.oid and ord<=p.pronargs;
    execute format('alter function %s set schema private',f.oid::regprocedure);
    execute format('create function public.%I(%s) returns %s language sql security invoker set search_path='''' as %L',
      f.proname,args,result_type,format('select * from private.%I(%s);',f.proname,call_args));
    execute format('revoke all on function public.%I(%s) from public,anon',f.proname,pg_get_function_identity_arguments(f.oid));
    execute format('grant execute on function public.%I(%s) to authenticated',f.proname,pg_get_function_identity_arguments(f.oid));
  end loop;
end;
$rpc_wrappers$;

do $drop_legacy$
declare p record;
begin
  for p in select schemaname,tablename,policyname from pg_policies where schemaname='public'
    and tablename in ('announcement_reads','announcements','attendance','checklist_checks','checklist_log','checklist_templates',
      'crew','expense_entries','fixed_expenses','fixed_schedules','sales_report_photos','sales_reports','shifts','stores','vendors')
    and (policyname like 'allow all - %' or (tablename='stores' and policyname='hide archived stores')) loop
    execute format('drop policy %I on %I.%I',p.policyname,p.schemaname,p.tablename);
  end loop;
end;
$drop_legacy$;

commit;
