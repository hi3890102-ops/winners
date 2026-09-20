-- READ-ONLY catalog check of labor-ratio-threshold.sql. problems must be 0 after applying.
with checks(name,ok) as (
  select 'column exists, numeric(5,2), nullable', exists(select 1 from information_schema.columns where table_schema='public' and table_name='stores' and column_name='labor_ratio_threshold' and is_nullable='YES' and numeric_precision=5 and numeric_scale=2)
  union all select 'range check 1..100 present', exists(select 1 from pg_constraint where conname='stores_labor_ratio_threshold_range' and conrelid='public.stores'::regclass)
  union all select 'no client role can UPDATE the column directly', (not has_column_privilege('authenticated','public.stores','labor_ratio_threshold','UPDATE') and not has_column_privilege('anon','public.stores','labor_ratio_threshold','UPDATE'))
  union all select 'authenticated can read the column, anon cannot', (has_column_privilege('authenticated','public.stores','labor_ratio_threshold','SELECT') and not has_column_privilege('anon','public.stores','labor_ratio_threshold','SELECT'))
  union all select 'RPC: authenticated yes, anon no', (has_function_privilege('authenticated','public.manee_set_store_labor_ratio(uuid,numeric)','execute') and not has_function_privilege('anon','public.manee_set_store_labor_ratio(uuid,numeric)','execute'))
  union all select 'RPC checks an active owner of the store', position('has_store_membership(p_store_id, array[''owner'']' in pg_get_functiondef('public.manee_set_store_labor_ratio(uuid,numeric)'::regprocedure))>0
  union all select 'food threshold column untouched', exists(select 1 from information_schema.columns where table_schema='public' and table_name='stores' and column_name='food_ratio_threshold')
)
select name,ok,count(*) filter (where not ok) over () problems from checks order by name;
