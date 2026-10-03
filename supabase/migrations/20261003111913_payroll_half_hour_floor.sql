-- User-approved calculation change: completed confirmed shifts, floor each to 30 minutes.
-- Attendance, employee data, actual net payroll and immutable closing snapshots are preserved.
create or replace function private.net_payroll_totals(p_store uuid,p_month text,p_today date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.crew%rowtype; r public.monthly_net_payroll%rowtype; start_day date:=to_date(p_month||'-01','YYYY-MM-DD'); end_day date; employed integer; hours numeric; confirmed_shifts integer; gross bigint; net bigint; rate numeric; snapshot jsonb; adjustments bigint; total bigint:=0; unknown integer:=0; estimated integer:=0; v_confirmed integer:=0;
begin
 end_day:=(start_day+interval '1 month - 1 day')::date;
 for c in select * from public.crew where store_id=p_store loop
  employed:=0; hours:=0; confirmed_shifts:=0;
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
   select coalesce(sum(floor(extract(epoch from case when check_out<check_in then check_out-check_in+interval '24 hours' else check_out-check_in end)/1800)/2),0),count(*)
     into hours,confirmed_shifts from public.attendance where store_id=p_store and crew_id=c.id and date between start_day and end_day and confirmed and check_out is not null;
   gross:=round(hours*c.wage);
  end if;
  if c.probation then gross:=round(gross*0.9);end if;
  rate:=case when c.insurance4 then 0.097 when c.insurance2 then 0.009 when c.tax33 then 0.033 else 0 end;
  net:=gross-round(gross*rate)+adjustments;
  if net<0 or c.wage<=0 and ((c.wage_type='monthly' and employed>0) or (c.wage_type<>'monthly' and confirmed_shifts>0)) then unknown:=unknown+1;else total:=total+net;estimated:=estimated+1;end if;
 end loop;
 return jsonb_build_object('net_pay',case when unknown>0 then null else total end,'unknown_count',unknown,'estimated_count',estimated,'confirmed_count',v_confirmed);
end $$;
revoke all on function private.net_payroll_totals(uuid,text,date) from public,anon,authenticated;

