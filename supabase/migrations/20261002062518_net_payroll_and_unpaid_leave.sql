-- Actual net wage is month-attributed and INCLUDES salary advances already paid.
-- Insurance and payroll withholding remittances remain separately paid expenses.
create table public.monthly_net_payroll (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  crew_id uuid not null references public.crew(id),
  month_key text not null check(month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  net_pay integer not null check(net_pay>=0),
  paid_on date,
  adjustment_snapshot jsonb not null default '[]'::jsonb,
  confirmed_by uuid,
  updated_at timestamptz not null default clock_timestamp(),
  unique(store_id,crew_id,month_key)
);
alter table public.monthly_net_payroll enable row level security;
revoke all on public.monthly_net_payroll from public,anon,authenticated;
grant select,insert,update,delete on public.monthly_net_payroll to authenticated;
create policy monthly_net_payroll_manager on public.monthly_net_payroll for all to authenticated
  using(private.can_manage_store(store_id) and private.is_live_manee_session())
  with check(private.can_manage_store(store_id) and private.is_live_manee_session()
    and private.crew_belongs_to_store(crew_id,store_id));
create policy monthly_net_payroll_self_read on public.monthly_net_payroll for select to authenticated
  using(private.has_store_membership(store_id,null) and private.is_live_manee_session()
    and crew_id=private.current_crew_id(store_id));

alter table public.crew_pay_adjustments add column adjustment_date date;
alter table public.crew_pay_adjustments add column unpaid_date date;
alter table public.crew_pay_adjustments add constraint unpaid_adjustment_month_check
  check(unpaid_date is null or (type='무급휴가' and to_char(unpaid_date,'YYYY-MM')=month_key));
create unique index crew_unpaid_date_unique on public.crew_pay_adjustments(crew_id,unpaid_date)
  where unpaid_date is not null;
create policy crew_pay_adjustments_self_read on public.crew_pay_adjustments for select to authenticated
  using(private.has_store_membership(store_id,null) and private.is_live_manee_session()
    and crew_id=private.current_crew_id(store_id));
create policy crew_pay_adjustments_live_session on public.crew_pay_adjustments as restrictive for all to authenticated
  using(private.is_live_manee_session()) with check(private.is_live_manee_session());

create function private.guard_pay_adjustment()
returns trigger language plpgsql security invoker set search_path='' as $$
declare c public.crew%rowtype; gross_daily integer; rate numeric; last_day integer;
begin
  if tg_op='UPDATE' and (old.id<>new.id or old.store_id<>new.store_id or old.crew_id<>new.crew_id or old.month_key<>new.month_key) then
    raise exception 'Payroll adjustment identity cannot change' using errcode='42501';
  end if;
  select * into c from public.crew where id=new.crew_id and store_id=new.store_id;
  if not found then raise exception 'Employee does not belong to store' using errcode='42501'; end if;
  if tg_op='INSERT' and new.type not in ('가불','무급휴가','기타') then
    raise exception 'Unsupported new payroll adjustment type' using errcode='22023'; end if;
  if new.type='가불' then
    if new.amount>=0 then raise exception 'Advance must reduce remaining payment' using errcode='22023'; end if;
    if new.adjustment_date is null then new.adjustment_date:=(now() at time zone 'Asia/Seoul')::date; end if;
  end if;
  if new.unpaid_date is not null then
    if c.hire_date is not null and new.unpaid_date<c.hire_date or c.resign_date is not null and new.unpaid_date>c.resign_date then
      raise exception 'Unpaid day is outside employment period' using errcode='22023'; end if;
    if exists(select 1 from public.attendance a where a.crew_id=c.id and a.store_id=new.store_id and a.date=new.unpaid_date and a.confirmed and a.check_out is not null) then
      raise exception 'Confirmed worked day cannot also be unpaid leave' using errcode='22023'; end if;
    if c.wage_type='monthly' then
      if coalesce(c.wage,0)<=0 then raise exception 'Monthly wage setup required' using errcode='22023'; end if;
      last_day:=extract(day from (date_trunc('month',new.unpaid_date::timestamp)+interval '1 month - 1 day'));
      gross_daily:=round(c.wage::numeric/last_day*case when c.probation then 0.9 else 1 end);
      -- These are existing app reference rates, not authoritative statutory deductions.
      rate:=case when c.insurance4 then 0.097 when c.insurance2 then 0.009 when c.tax33 then 0.033 else 0 end;
      new.amount:=-(gross_daily-round(gross_daily*rate));
    else
      new.amount:=0; -- Hourly staff are already paid only for confirmed worked hours.
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.guard_pay_adjustment() from public,anon,authenticated;
create trigger manee_guard_pay_adjustment before insert or update on public.crew_pay_adjustments
  for each row execute function private.guard_pay_adjustment();

create function private.guard_monthly_net_payroll()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if tg_op='UPDATE' and (old.id<>new.id or old.store_id<>new.store_id or old.crew_id<>new.crew_id or old.month_key<>new.month_key) then
    raise exception 'Payroll identity cannot change' using errcode='42501'; end if;
  if not exists(select 1 from public.crew where id=new.crew_id and store_id=new.store_id) then
    raise exception 'Employee does not belong to store' using errcode='42501'; end if;
  if new.paid_on>(now() at time zone 'Asia/Seoul')::date then raise exception 'Payment date must already have occurred' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_array(a.id::text,a.type,a.amount,a.unpaid_date::text) order by a.id::text),'[]'::jsonb)
    into new.adjustment_snapshot from public.crew_pay_adjustments a
    where a.store_id=new.store_id and a.crew_id=new.crew_id and a.month_key=new.month_key and a.type<>'가불';
  new.updated_at:=clock_timestamp();new.confirmed_by:=auth.uid();
  return new;
end;
$$;
revoke all on function private.guard_monthly_net_payroll() from public,anon,authenticated;
create trigger manee_guard_monthly_net_payroll before insert or update on public.monthly_net_payroll
  for each row execute function private.guard_monthly_net_payroll();

create table public.payroll_change_log (
  id bigint generated always as identity primary key,
  store_id uuid not null, crew_id uuid not null, month_key text not null,
  actor_user_id uuid, action text not null, before_record jsonb, after_record jsonb,
  changed_at timestamptz not null default clock_timestamp()
);
create index payroll_change_log_store_month on public.payroll_change_log(store_id,month_key,changed_at desc);
alter table public.payroll_change_log enable row level security;
revoke all on public.payroll_change_log from public,anon,authenticated;
grant select on public.payroll_change_log to authenticated;
create policy payroll_log_manager_read on public.payroll_change_log for select to authenticated
  using(private.can_manage_store(store_id) and private.is_live_manee_session());
create function private.record_payroll_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.payroll_change_log(store_id,crew_id,month_key,actor_user_id,action,before_record,after_record)
  values(case when tg_op='DELETE' then old.store_id else new.store_id end,
    case when tg_op='DELETE' then old.crew_id else new.crew_id end,
    case when tg_op='DELETE' then old.month_key else new.month_key end,auth.uid(),tg_table_name||':'||tg_op,
    case when tg_op='INSERT' then null else to_jsonb(old) end,
    case when tg_op='DELETE' then null else to_jsonb(new) end);
  if tg_op='DELETE' then return old; end if;return new;
end;
$$;
revoke all on function private.record_payroll_change() from public,anon,authenticated;
create trigger manee_net_payroll_log after insert or update or delete on public.monthly_net_payroll
  for each row execute function private.record_payroll_change();
create trigger manee_pay_adjustment_log after insert or update or delete on public.crew_pay_adjustments
  for each row execute function private.record_payroll_change();

-- Explicit payment categories; never reclassify historical transactions by name.
alter table public.expense_entries drop constraint if exists expense_entries_category_check;
alter table public.expense_entries add constraint expense_entries_category_check
  check(category is null or category in ('food','beverage','supplies','insurance','payroll_tax','utilities','fees','tax','other'));
alter table public.vendors drop constraint if exists vendors_default_category_allowed;
alter table public.vendors add constraint vendors_default_category_allowed
  check(default_category is null or default_category in ('food','beverage','supplies','insurance','payroll_tax','utilities','fees','tax','other','per_entry'));
