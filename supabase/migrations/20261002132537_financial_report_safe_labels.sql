-- Preserve business descriptions while suppressing known staff/owner personal identifiers.
create function private.financial_label(p_store uuid,p_label text)
returns text language plpgsql stable security definer set search_path='' as $$
declare source_value text; key_name text; numbers text; label_numbers text:=regexp_replace(coalesce(p_label,''),'[^0-9]','','g');
begin
 for source_value,key_name in
  select c.name,'name' from public.crew c where c.store_id=p_store
  union all select c.phone,'phone' from public.crew c where c.store_id=p_store
  union all select c.bank_account,'account' from public.crew c where c.store_id=p_store
  union all select c.resident_number,'resident' from public.crew c where c.store_id=p_store
  union all select e.value,e.key from public.stores s join public.profiles p on p.username=s.owner_username cross join lateral jsonb_each_text(to_jsonb(p)) e
   where s.id=p_store and e.key in ('display_name','phone','bank_account','bank_account_number','bank_account_holder','resident_number')
 loop
  if source_value is null or length(trim(source_value))=0 then continue;end if;
  if key_name in ('name','display_name','bank_account_holder') and position(source_value in coalesce(p_label,''))>0 then return '[개인정보 포함 항목]';end if;
  if key_name not in ('name','display_name','bank_account_holder') then
   numbers:=regexp_replace(source_value,'[^0-9]','','g');
   if length(numbers)>=7 and position(numbers in label_numbers)>0 then return '[개인정보 포함 항목]';end if;
  end if;
 end loop;
 return p_label;
end $$;
revoke all on function private.financial_label(uuid,text) from public,anon,authenticated;

create or replace function public.manee_financial_report(p_store_id uuid,p_month_key text)
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
 select coalesce(sum(amount),0),coalesce(jsonb_agg(jsonb_build_object('date',date,'description',private.financial_label(p_store_id,description),'category',category,'amount',amount) order by date,id),'[]'::jsonb) into expense_total,expenses from public.expense_entries where store_id=p_store_id and date between first_day and last_day;
 select coalesce(sum(amount),0),coalesce(jsonb_agg(jsonb_build_object('name',private.financial_label(p_store_id,name),'amount',amount) order by name,id),'[]'::jsonb) into fixed_total,fixed from public.fixed_expenses where store_id=p_store_id and month_key=p_month_key;
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

