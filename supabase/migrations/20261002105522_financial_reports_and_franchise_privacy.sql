-- One stable statement snapshot supplies owner reports, franchise totals and closing revisions.
create function private.net_payroll_totals(p_store uuid,p_month text,p_today date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.crew%rowtype; r public.monthly_net_payroll%rowtype; start_day date:=to_date(p_month||'-01','YYYY-MM-DD'); end_day date; employed integer; hours numeric; gross bigint; net bigint; rate numeric; snapshot jsonb; adjustments bigint; total bigint:=0; unknown integer:=0; estimated integer:=0; v_confirmed integer:=0;
begin
 end_day:=(start_day+interval '1 month - 1 day')::date;
 for c in select * from public.crew where store_id=p_store loop
  select * into r from public.monthly_net_payroll where store_id=p_store and crew_id=c.id and month_key=p_month;
  select coalesce(jsonb_agg(jsonb_build_array(a.id::text,a.type,a.amount,a.unpaid_date::text) order by a.id::text),'[]'::jsonb),coalesce(sum(a.amount) filter(where a.unpaid_date is null or a.unpaid_date<=p_today),0)
   into snapshot,adjustments from public.crew_pay_adjustments a where a.store_id=p_store and a.crew_id=c.id and a.month_key=p_month and a.type<>'가불';
  if r.id is not null then
   if r.adjustment_snapshot=snapshot then total:=total+r.net_pay;v_confirmed:=v_confirmed+1;else unknown:=unknown+1;end if;
   continue;
  end if;
  if c.employment_setup_required or c.wage_type='monthly' and c.hire_date is null and p_month<>to_char(p_today,'YYYY-MM') then unknown:=unknown+1;continue;end if;
  if c.wage_type='monthly' then
   employed:=greatest(0,least(end_day,p_today,coalesce(c.resign_date,end_day))-greatest(start_day,coalesce(c.hire_date,start_day))+1);
   gross:=round(c.wage::numeric/extract(day from end_day)*employed);
  else
   select coalesce(sum(extract(epoch from case when check_out<check_in then check_out-check_in+interval '24 hours' else check_out-check_in end)/3600),0)
     into hours from public.attendance where store_id=p_store and crew_id=c.id and date between start_day and end_day and confirmed and check_out is not null;
   gross:=round(hours*c.wage);
  end if;
  if c.probation then gross:=round(gross*0.9);end if;
  rate:=case when c.insurance4 then 0.097 when c.insurance2 then 0.009 when c.tax33 then 0.033 else 0 end;
  net:=gross-round(gross*rate)+adjustments;
  if net<0 or c.wage<=0 and ((c.wage_type='monthly' and employed>0) or (c.wage_type<>'monthly' and hours>0)) then unknown:=unknown+1;else total:=total+net;estimated:=estimated+1;end if;
 end loop;
 return jsonb_build_object('net_pay',case when unknown>0 then null else total end,'unknown_count',unknown,'estimated_count',estimated,'confirmed_count',v_confirmed);
end $$;
revoke all on function private.net_payroll_totals(uuid,text,date) from public,anon,authenticated;

create function public.manee_financial_report(p_store_id uuid,p_month_key text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.stores%rowtype; cal public.store_business_calendar%rowtype; first_day date; last_day date; today date:=(now() at time zone 'Asia/Seoul')::date;
 sales jsonb; expenses jsonb; fixed jsonb; payroll jsonb; missing integer; operating integer; invalid integer; expense_total bigint;fixed_total bigint;gross bigint;v_discount bigint;v_refund bigint;net bigint;labor bigint;profit bigint;
begin
 if not private.is_live_manee_session() or not private.can_view_financials(p_store_id) then raise exception 'Financial access denied' using errcode='42501';end if;
 if p_month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Invalid report month' using errcode='22023';end if;
 first_day:=to_date(p_month_key||'-01','YYYY-MM-DD');last_day:=(first_day+interval '1 month - 1 day')::date;
 select * into s from public.stores where id=p_store_id and archived_at is null;if not found then raise exception 'Store unavailable' using errcode='22023';end if;
 select * into cal from public.store_business_calendar where store_id=p_store_id;
 select coalesce(sum(total_sales),0),coalesce(sum(discount),0),coalesce(sum(refund),0),count(*) filter(where total_sales<0 or discount<0 or refund<0),
 coalesce(jsonb_agg(jsonb_build_object('date',date,'gross',total_sales,'discount',discount,'refund',refund,'net',total_sales-discount-refund,'card',card_sales,'cash',cash_sales,'emoney',emoney_sales,'delivery_baemin',delivery_baemin,'delivery_coupang',delivery_coupang,'delivery_yogiyo',delivery_yogiyo) order by date),'[]'::jsonb)
 into gross,v_discount,v_refund,invalid,sales from public.sales_reports where store_id=p_store_id and date between first_day and last_day;
 net:=gross-v_discount-v_refund;
 select coalesce(sum(amount),0),coalesce(jsonb_agg(jsonb_build_object('date',date,'category',category,'amount',amount) order by date,id),'[]'::jsonb) into expense_total,expenses from public.expense_entries where store_id=p_store_id and date between first_day and last_day;
 select coalesce(sum(amount),0),coalesce(jsonb_agg(jsonb_build_object('name',name,'amount',amount) order by name,id),'[]'::jsonb) into fixed_total,fixed from public.fixed_expenses where store_id=p_store_id and month_key=p_month_key;
 payroll:=private.net_payroll_totals(p_store_id,p_month_key,today);labor:=(payroll->>'net_pay')::bigint;
 select count(*) into missing from generate_series(first_day::timestamp,least(last_day,today-1)::timestamp,interval '1 day') d
 where not exists(select 1 from public.sales_reports sr where sr.store_id=p_store_id and sr.date=d::date)
 and (d::date=any(coalesce(cal.open_dates,'{}'::date[])) or not(d::date=any(coalesce(cal.closed_dates,'{}'::date[])) or extract(dow from d)::integer=any(coalesce(cal.closed_weekdays,'{}'::integer[]))));
 select count(distinct date) into operating from public.sales_reports where store_id=p_store_id and date between first_day and last_day;
 if invalid=0 and labor is not null then profit:=net-expense_total-fixed_total-labor;end if;
 return jsonb_build_object('store_id',s.id,'store_name',s.name,'month_key',p_month_key,'gross_sales',gross,'discount',v_discount,'refund',v_refund,'net_sales',net,'net_payroll',labor,'expenses_total',expense_total,'fixed_total',fixed_total,'profit',profit,
 'labor_ratio',case when gross>0 and invalid=0 then labor::numeric/gross*100 else null end,
 'food_unclassified_count',(select count(*) from public.expense_entries where store_id=p_store_id and date between first_day and last_day and category is null),
 'food_ratio',case when gross>0 and invalid=0 and not exists(select 1 from public.expense_entries where store_id=p_store_id and date between first_day and last_day and category is null) then (select coalesce(sum(amount),0)::numeric/gross*100 from public.expense_entries where store_id=p_store_id and date between first_day and last_day and category='food') else null end,
 'expense_ratio',case when gross>0 and invalid=0 then expense_total::numeric/gross*100 else null end,'profit_ratio',case when gross>0 and invalid=0 then profit::numeric/gross*100 else null end,
 'operating_days',operating,'missing_sales_days',missing,'invalid_sales_count',invalid,'payroll_status',payroll,'sales',sales,'expenses',expenses,'fixed',fixed,'basis','net-wage-v1','calendar_configured',cal.store_id is not null,'generated_at',clock_timestamp());
end $$;
revoke all on function public.manee_financial_report(uuid,text) from public,anon;
grant execute on function public.manee_financial_report(uuid,text) to authenticated;

create table public.franchise_financial_targets(
 franchise_id uuid primary key references public.franchises(id),
 labor_max numeric not null default 23 check(labor_max between 1 and 100),
 food_max numeric not null default 43 check(food_max between 1 and 100),
 profit_min numeric check(profit_min between -100 and 100)
);
alter table public.franchise_financial_targets enable row level security;
revoke all on public.franchise_financial_targets from public,anon,authenticated;
grant select,insert,update on public.franchise_financial_targets to authenticated;
create policy franchise_targets_read on public.franchise_financial_targets for select to authenticated
 using(private.is_live_manee_session() and private.has_franchise_membership(franchise_id,null));
create policy franchise_targets_write on public.franchise_financial_targets for all to authenticated
 using(private.is_live_manee_session() and private.has_franchise_membership(franchise_id,array['admin','operator']))
 with check(private.is_live_manee_session() and private.has_franchise_membership(franchise_id,array['admin','operator']));

create function public.manee_franchise_financials(p_franchise_id uuid,p_month_key text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb:='[]'::jsonb; targets jsonb; r record; report jsonb;
begin
 if not private.is_live_manee_session() or not private.has_franchise_membership(p_franchise_id,null) then raise exception 'Franchise access denied' using errcode='42501';end if;
 if p_month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then raise exception 'Invalid report month' using errcode='22023';end if;
 select jsonb_build_object('labor_max',labor_max,'food_max',food_max,'profit_min',profit_min) into targets from public.franchise_financial_targets where franchise_id=p_franchise_id;
 for r in select id,name from public.stores where franchise_id=p_franchise_id and archived_at is null order by name,id loop
 report:=public.manee_financial_report(r.id,p_month_key);
 result:=result||jsonb_build_array(report||jsonb_build_object('joined',exists(select 1 from public.store_memberships where store_id=r.id and role='owner' and status='active'),
 'days_since_last_sales',(now() at time zone 'Asia/Seoul')::date-(select max(date) from public.sales_reports where store_id=r.id)));
 end loop;
 return jsonb_build_object('stores',result,'targets',coalesce(targets,jsonb_build_object('labor_max',23,'food_max',43,'profit_min',null)),'month_key',p_month_key);
end $$;
revoke all on function public.manee_franchise_financials(uuid,text) from public,anon;
grant execute on function public.manee_franchise_financials(uuid,text) to authenticated;

-- Financial APIs expose aggregate amounts, never personnel rows or owner identifiers.
create function public.manee_franchise_directory(p_franchise_id uuid)
returns table(id uuid,name text) language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_live_manee_session() or not private.has_franchise_membership(p_franchise_id,null) then raise exception 'Franchise access denied' using errcode='42501';end if;
 return query select s.id,s.name from public.stores s where s.franchise_id=p_franchise_id and s.archived_at is null order by s.name,s.id;
end $$;
revoke all on function public.manee_franchise_directory(uuid) from public,anon;
grant execute on function public.manee_franchise_directory(uuid) to authenticated;

