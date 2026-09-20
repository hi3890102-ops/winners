-- Per-store food-ratio warning threshold (owner-set; default 40% is applied by the app when the value is NULL).
--
-- LOCAL PREPARATION ONLY. Not applied to any database. Apply to STAGING first, never straight to production.
-- ADDITIVE: one nullable column, one range check, one owner-only RPC. It performs NO UPDATE/DELETE on any existing row:
-- every store keeps NULL = "not set" = the app default (40%). Attendance, sales, expenses, payroll, personal data,
-- store<->staff links are not touched.
--
-- Reading: every member of a store can already select public.stores rows they may view (private.can_view_store), so the
-- owner, manager and staff screens of one store read the same value. The value is a number, not personal data.
-- Writing: only through public.manee_set_store_food_ratio(), which requires an ACTIVE OWNER membership of that store.
-- The column is NOT added to the column-level UPDATE grant of public.stores, so a manager cannot change it directly.
--
-- Compatibility: the app treats a missing column (error 42703) as "not set", so the front end may be deployed before or
-- after this file. Older app versions never select the column. Rollback: food-ratio-threshold-rollback.sql is NON-DESTRUCTIVE
-- (it only revokes the RPC; the column and every saved threshold are kept). Re-running this file re-enables the feature.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.stores add column if not exists food_ratio_threshold numeric(5,2);

do $constraint$
begin
  if not exists (select 1 from pg_constraint where conname='stores_food_ratio_threshold_range' and conrelid='public.stores'::regclass) then
    alter table public.stores add constraint stores_food_ratio_threshold_range
      check (food_ratio_threshold is null or (food_ratio_threshold>=1 and food_ratio_threshold<=100));
  end if;
end;
$constraint$;

-- Harmless when the table-level SELECT grant already exists; keeps the column readable if only column grants are used.
grant select (food_ratio_threshold) on public.stores to authenticated;

create or replace function public.manee_set_store_food_ratio(p_store_id uuid, p_threshold numeric)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v numeric(5,2);
begin
  if (select auth.uid()) is null or not private.is_live_manee_session() then
    raise exception 'authentication required' using errcode='42501';
  end if;
  if p_store_id is null or not private.has_store_membership(p_store_id, array['owner']::text[]) then
    raise exception 'only an owner of this store can change the threshold' using errcode='42501';
  end if;
  if p_threshold is not null and (p_threshold < 1 or p_threshold > 100) then
    raise exception 'threshold must be between 1 and 100' using errcode='22023';
  end if;
  v := case when p_threshold is null then null else round(p_threshold, 1) end;
  update public.stores set food_ratio_threshold = v where id = p_store_id;
  return jsonb_build_object('ok', true, 'food_ratio_threshold', v);
end;
$$;
revoke all on function public.manee_set_store_food_ratio(uuid, numeric) from public, anon;
grant execute on function public.manee_set_store_food_ratio(uuid, numeric) to authenticated;

commit;
