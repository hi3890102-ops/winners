do $$ declare t text;begin
 foreach t in array array['stores','crew','sales_reports','attendance','shifts','crew_pay_adjustments'] loop
 execute format('create policy franchise_personal_data_boundary on public.%I as restrictive for all to authenticated using (private.has_store_membership(%s,null) or private.has_platform_role(array[''super_admin'',''admin'',''support'',''read_only''])) with check (private.has_store_membership(%s,null) or private.has_platform_role(array[''super_admin'',''admin'',''support'',''read_only'']))',t,case when t='stores' then 'id' else 'store_id' end,case when t='stores' then 'id' else 'store_id' end);
 end loop;
end $$;
