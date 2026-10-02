-- Keep privilege-bearing calculation cores outside the exposed Data API schema.
alter function public.manee_financial_report(uuid,text) set schema private;
revoke all on function private.manee_financial_report(uuid,text) from public,anon;
grant execute on function private.manee_financial_report(uuid,text) to authenticated;
create function public.manee_financial_report(p_store_id uuid,p_month_key text) returns jsonb
language sql stable security invoker set search_path='' as $$select private.manee_financial_report(p_store_id,p_month_key)$$;
revoke all on function public.manee_financial_report(uuid,text) from public,anon;
grant execute on function public.manee_financial_report(uuid,text) to authenticated;
alter function public.manee_franchise_financials(uuid,text) set schema private;
revoke all on function private.manee_franchise_financials(uuid,text) from public,anon;
grant execute on function private.manee_franchise_financials(uuid,text) to authenticated;
create function public.manee_franchise_financials(p_franchise_id uuid,p_month_key text) returns jsonb
language sql stable security invoker set search_path='' as $$select private.manee_franchise_financials(p_franchise_id,p_month_key)$$;
revoke all on function public.manee_franchise_financials(uuid,text) from public,anon;
grant execute on function public.manee_franchise_financials(uuid,text) to authenticated;
alter function public.manee_franchise_directory(uuid) set schema private;
revoke all on function private.manee_franchise_directory(uuid) from public,anon;
grant execute on function private.manee_franchise_directory(uuid) to authenticated;
create function public.manee_franchise_directory(p_franchise_id uuid) returns table(id uuid,name text)
language sql stable security invoker set search_path='' as $$select * from private.manee_franchise_directory(p_franchise_id)$$;
revoke all on function public.manee_franchise_directory(uuid) from public,anon;
grant execute on function public.manee_franchise_directory(uuid) to authenticated;
alter function public.manee_close_month(uuid,text,uuid,text) set schema private;
revoke all on function private.manee_close_month(uuid,text,uuid,text) from public,anon;
grant execute on function private.manee_close_month(uuid,text,uuid,text) to authenticated;
create function public.manee_close_month(p_store_id uuid,p_month_key text,p_request_id uuid,p_amendment_reason text default null) returns jsonb
language sql volatile security invoker set search_path='' as $$select private.manee_close_month(p_store_id,p_month_key,p_request_id,p_amendment_reason)$$;
revoke all on function public.manee_close_month(uuid,text,uuid,text) from public,anon;
grant execute on function public.manee_close_month(uuid,text,uuid,text) to authenticated;
alter function public.manee_report_history(uuid) set schema private;
revoke all on function private.manee_report_history(uuid) from public,anon;
grant execute on function private.manee_report_history(uuid) to authenticated;
create function public.manee_report_history(p_store_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$select private.manee_report_history(p_store_id)$$;
revoke all on function public.manee_report_history(uuid) from public,anon;
grant execute on function public.manee_report_history(uuid) to authenticated;
alter function public.manee_closed_report(uuid) set schema private;
revoke all on function private.manee_closed_report(uuid) from public,anon;
grant execute on function private.manee_closed_report(uuid) to authenticated;
create function public.manee_closed_report(p_closing_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$select private.manee_closed_report(p_closing_id)$$;
revoke all on function public.manee_closed_report(uuid) from public,anon;
grant execute on function public.manee_closed_report(uuid) to authenticated;
-- Explicit identity checks are retained alongside fresh-session and scope checks.
do $$ declare f record;definition text;begin
 for f in select oid from pg_proc where pronamespace='private'::regnamespace and proname in ('manee_financial_report','manee_franchise_financials','manee_franchise_directory','manee_close_month','manee_report_history','manee_closed_report') loop
  definition:=pg_get_functiondef(f.oid);
  definition:=replace(definition,'if not private.is_live_manee_session()','if auth.uid() is null or not private.is_live_manee_session()');
  definition:=replace(definition,'if not found or not private.is_live_manee_session()','if auth.uid() is null or not found or not private.is_live_manee_session()');
  execute definition;
 end loop;
end $$;
notify pgrst,'reload schema';
