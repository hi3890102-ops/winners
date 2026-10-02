create table public.monthly_report_closings(
 id uuid primary key default gen_random_uuid(),store_id uuid not null references public.stores(id),
 month_key text not null check(month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),revision integer not null check(revision>0),
 request_id uuid not null,snapshot jsonb not null,amendment_reason text,closed_by uuid,
 closed_at timestamptz not null default clock_timestamp(),unique(store_id,month_key,revision),unique(store_id,request_id)
);
alter table public.monthly_report_closings enable row level security;
revoke all on public.monthly_report_closings from public,anon,authenticated;
grant select on public.monthly_report_closings to authenticated;
create policy closing_financial_read on public.monthly_report_closings for select to authenticated
 using(private.is_live_manee_session() and (private.has_store_membership(store_id,null) or private.has_platform_role(array['super_admin','admin','support','read_only'])));

create function public.manee_close_month(p_store_id uuid,p_month_key text,p_request_id uuid,p_amendment_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb; existing public.monthly_report_closings%rowtype; first_day date;last_day date; today date:=(now() at time zone 'Asia/Seoul')::date;cal public.store_business_calendar%rowtype;missing integer;next_revision integer;
begin
 if not private.is_live_manee_session() or not private.can_manage_store(p_store_id) then raise exception 'Closing access denied' using errcode='42501';end if;
 if p_month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' or p_request_id is null then raise exception 'Invalid close request' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_store_id::text||':'||p_month_key,0));
 select * into existing from public.monthly_report_closings where store_id=p_store_id and request_id=p_request_id;
 if found then
  if existing.month_key<>p_month_key then raise exception 'Request month mismatch' using errcode='22023';end if;
  return to_jsonb(existing)-'closed_by'-'request_id';
 end if;
 first_day:=to_date(p_month_key||'-01','YYYY-MM-DD');last_day:=(first_day+interval '1 month - 1 day')::date;
 if today<last_day then raise exception 'Month has not ended' using errcode='22023';end if;
 r:=public.manee_financial_report(p_store_id,p_month_key);
 if (r->>'invalid_sales_count')::integer>0 or r->>'profit' is null or (r->'payroll_status'->>'estimated_count')::integer>0 then raise exception 'Resolve sales and confirm actual net payroll before closing' using errcode='22023';end if;
 select * into cal from public.store_business_calendar where store_id=p_store_id;
 select count(*) into missing from generate_series(first_day::timestamp,last_day::timestamp,interval '1 day') d
 where not exists(select 1 from public.sales_reports sr where sr.store_id=p_store_id and sr.date=d::date)
 and (d::date=any(coalesce(cal.open_dates,'{}'::date[])) or not(d::date=any(coalesce(cal.closed_dates,'{}'::date[])) or extract(dow from d)::integer=any(coalesce(cal.closed_weekdays,'{}'::integer[]))));
 if missing>0 then raise exception 'Missing open-day sales reports: %',missing using errcode='22023';end if;
 select coalesce(max(revision),0)+1 into next_revision from public.monthly_report_closings where store_id=p_store_id and month_key=p_month_key;
 if next_revision>1 and length(trim(coalesce(p_amendment_reason,'')))<5 then raise exception 'An amendment reason is required' using errcode='22023';end if;
 if length(coalesce(p_amendment_reason,''))>1000 then raise exception 'Amendment reason too long' using errcode='22023';end if;
 insert into public.monthly_report_closings(store_id,month_key,revision,request_id,snapshot,amendment_reason,closed_by)
 values(p_store_id,p_month_key,next_revision,p_request_id,r||jsonb_build_object('missing_sales_days',0),nullif(trim(p_amendment_reason),''),auth.uid()) returning * into existing;
 return to_jsonb(existing)-'closed_by'-'request_id';
end $$;
revoke all on function public.manee_close_month(uuid,text,uuid,text) from public,anon;
grant execute on function public.manee_close_month(uuid,text,uuid,text) to authenticated;

create function public.manee_report_history(p_store_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not private.is_live_manee_session() or not private.can_view_financials(p_store_id) then raise exception 'Report access denied' using errcode='42501';end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'month_key',month_key,'revision',revision,'closed_at',closed_at) order by month_key desc,revision desc),'[]'::jsonb) from public.monthly_report_closings where store_id=p_store_id);
end $$;
revoke all on function public.manee_report_history(uuid) from public,anon;
grant execute on function public.manee_report_history(uuid) to authenticated;
create function public.manee_closed_report(p_closing_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r public.monthly_report_closings%rowtype;
begin
 select * into r from public.monthly_report_closings where id=p_closing_id;
 if not found or not private.is_live_manee_session() or not private.can_view_financials(r.store_id) then raise exception 'Report access denied' using errcode='42501';end if;
 return jsonb_build_object('id',r.id,'store_id',r.store_id,'month_key',r.month_key,'revision',r.revision,'closed_at',r.closed_at,'snapshot',r.snapshot);
end $$;
revoke all on function public.manee_closed_report(uuid) from public,anon;
grant execute on function public.manee_closed_report(uuid) to authenticated;
