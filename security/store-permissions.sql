-- Isolated staging: remove legacy public access; retain service-only enrollment.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function private.is_live_manee_session()
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from auth.sessions s join public.profiles p on p.user_id=s.user_id and p.status='active'
    where s.id=(select case when auth.jwt()->>'session_id' ~ '^[0-9a-fA-F-]{36}$' then (auth.jwt()->>'session_id')::uuid else null end)
      and s.user_id=(select auth.uid()) and (s.not_after is null or s.not_after>now()));
$$;

-- Existing service APIs keep their privileges. No direct browser access to
-- legacy password hashes, shared PIN settings or push subscription credentials.
revoke all on all tables in schema public from public,anon,authenticated;
revoke all on all sequences in schema public from public,anon,authenticated;
grant select on public.profiles,public.store_memberships,public.franchise_memberships,public.platform_admins,
  public.attendance_edit_requests,public.stores,public.checklist_templates,public.checklist_checks,public.checklist_log to authenticated;
grant update(name,lat,lng,onboarding_done,manager_dashboard_enabled,business_day_cutoff_hour) on public.stores to authenticated;
grant select,insert,update,delete on public.crew,public.attendance,public.shifts,public.fixed_schedules,
  public.sales_reports,public.expense_entries,public.vendors,public.fixed_expenses,public.reservations,
  public.announcements,public.announcement_reads,public.sales_report_photos to authenticated;
grant usage on sequence public.reservations_id_seq to authenticated;
revoke delete on public.announcement_reads from authenticated;
grant select(id,name,created_at) on public.franchises to authenticated;

-- Drop only the observed unconditional policies and the archived-only store
-- filter that OR-ed with member checks. Keep restrictive live-session policies.
do $drop_legacy$
declare p record;
begin
  for p in select schemaname,tablename,policyname from pg_policies where schemaname='public'
    and (policyname like 'allow all - %' or policyname='staging_legacy_compatibility' or (tablename='stores' and policyname='hide archived stores')) loop
    execute format('drop policy %I on %I.%I',p.policyname,p.schemaname,p.tablename);
  end loop;
end;
$drop_legacy$;

create policy franchises_metadata_read on public.franchises for select to authenticated
  using(private.has_platform_role(array['super_admin','admin','support','read_only']) or private.has_franchise_membership(id,null));

-- Same-store relationship checks are evaluated privately so staff cannot read
-- payroll merely to verify that a foreign key belongs to the intended store.
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
create policy announcements_manage on public.announcements for all to authenticated
  using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id));
-- Reservations are a shared operational record for currently linked employees.
create policy reservations_member_work on public.reservations for all to authenticated
  using(private.has_store_membership(store_id,null)) with check(private.has_store_membership(store_id,null));
create policy reservations_oversight_read on public.reservations for select to authenticated
  using(private.can_view_store(store_id));
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

-- Validating both old and new store access is not enough when a manager owns
-- two stores: moving an existing employee/record would detach its history.
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

-- Checklist writes share a store lock. A single checkbox never replaces another
-- employee's whole checklist; close totals and timestamps come from the server.
create function private.manee_checklist(p_action text,p_store_id uuid,p_date date,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  st public.stores%rowtype; manager boolean; business_date date; item text;
  total_count int; done_count int; result jsonb; tab_entry record; category jsonb; entry jsonb;
begin
  if auth.uid() is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into st from public.stores where id=p_store_id and archived_at is null for update;
  if not found or not private.has_store_membership(p_store_id,null) then raise exception 'Membership required' using errcode='42501'; end if;
  manager:=private.can_manage_store(p_store_id);
  business_date:=((now() at time zone 'Asia/Seoul')-make_interval(hours=>coalesce(st.business_day_cutoff_hour,6)))::date;
  if p_date is null or (not manager and p_date<>business_date) then raise exception 'Only today can be changed' using errcode='42501'; end if;
  if p_action in ('templates','initialize') then
    if not manager then raise exception 'Manager required' using errcode='42501'; end if;
    if p_action='initialize' and exists(select 1 from public.checklist_templates where store_id=p_store_id) then
      return jsonb_build_object('ok',true); end if;
    if jsonb_typeof(p_payload->'items') is distinct from 'object' or octet_length(p_payload::text)>200000 then raise exception 'Invalid checklist' using errcode='22023'; end if;
    for tab_entry in select key,value from jsonb_each(p_payload->'items') loop
      if tab_entry.key not in ('morning','afternoon','routine') or jsonb_typeof(tab_entry.value)<>'array' then raise exception 'Invalid checklist' using errcode='22023'; end if;
      for category in select value from jsonb_array_elements(tab_entry.value) loop
        if jsonb_typeof(category->'items') is distinct from 'array' or jsonb_typeof(category->'id') is distinct from 'string'
          or jsonb_typeof(category->'name') is distinct from 'string' then raise exception 'Invalid category' using errcode='22023'; end if;
        for entry in select value from jsonb_array_elements(category->'items') loop
          if jsonb_typeof(entry->'id') is distinct from 'string' or length(entry->>'id') not between 1 and 120
            or jsonb_typeof(entry->'label') is distinct from 'string' or length(entry->>'label')>1000 then raise exception 'Invalid item' using errcode='22023'; end if;
        end loop;
      end loop;
      insert into public.checklist_templates(store_id,tab,data) values(p_store_id,tab_entry.key,tab_entry.value)
        on conflict(store_id,tab) do update set data=excluded.data;
    end loop;
  elsif p_action='reopen' then
    if not manager then raise exception 'Manager required' using errcode='42501'; end if;
    delete from public.checklist_log where store_id=p_store_id and date=p_date;
  elsif p_action in ('check','reset','close') then
    if exists(select 1 from public.checklist_log where store_id=p_store_id and date=p_date) then
      if p_action<>'close' then raise exception 'Checklist already closed' using errcode='55000'; end if;
    elsif p_action='reset' then
      if not manager then raise exception 'Manager required' using errcode='42501'; end if;
      delete from public.checklist_checks where store_id=p_store_id and date=p_date;
    elsif p_action='check' then
      item:=p_payload->>'item_id';
      if item is null or not exists(select 1 from public.checklist_templates t,
        lateral jsonb_array_elements(t.data) cat,lateral jsonb_array_elements(cat->'items') it
        where t.store_id=p_store_id and it->>'id'=item) then raise exception 'Unknown checklist item' using errcode='22023'; end if;
      if jsonb_typeof(p_payload->'checked') is distinct from 'boolean' then raise exception 'Invalid checkbox' using errcode='22023'; end if;
      if (p_payload->>'checked')::boolean then
        insert into public.checklist_checks(store_id,date,item_id,checked) values(p_store_id,p_date,item,true)
          on conflict(store_id,date,item_id) do update set checked=true;
      else delete from public.checklist_checks where store_id=p_store_id and date=p_date and item_id=item; end if;
    else
      select count(distinct it->>'id'),count(distinct it->>'id') filter(where exists(select 1 from public.checklist_checks c
        where c.store_id=p_store_id and c.date=p_date and c.item_id=it->>'id' and c.checked))
        into total_count,done_count from public.checklist_templates t,lateral jsonb_array_elements(t.data) cat,
        lateral jsonb_array_elements(cat->'items') it where t.store_id=p_store_id;
      insert into public.checklist_log(store_id,date,done,total,closed_at) values(p_store_id,p_date,done_count,total_count,clock_timestamp());
    end if;
  else raise exception 'Unknown action' using errcode='22023'; end if;
  return jsonb_build_object('ok',true,'checks',coalesce((select jsonb_object_agg(item_id,true) from public.checklist_checks where store_id=p_store_id and date=p_date and checked),'{}'::jsonb),
    'log',(select jsonb_build_object('done',done,'total',total,'closedAt',extract(epoch from closed_at)*1000) from public.checklist_log where store_id=p_store_id and date=p_date));
end;
$$;
create function public.manee_checklist(p_action text,p_store_id uuid,p_date date,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.manee_checklist(p_action,p_store_id,p_date,p_payload); $$;
revoke all on function private.manee_checklist(text,uuid,date,jsonb),public.manee_checklist(text,uuid,date,jsonb) from public,anon;
grant execute on function private.manee_checklist(text,uuid,date,jsonb),public.manee_checklist(text,uuid,date,jsonb) to authenticated;

-- Preserve the seven established RPC signatures while keeping privileged bodies
-- in the unexposed schema. Their existing identity/role checks stay in place.
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
commit;
