-- Per-store labor-ratio warning threshold (owner-set; the app applies the default 22% while the value is NULL).
-- Mirrors security/food-ratio-threshold.sql. Decision 2026-09-21: the earlier fixed 22% is replaced by a per-store setting (default 22%).
--
-- ADDITIVE: one nullable column, one range check, one owner-only RPC. It performs NO UPDATE/DELETE on any existing row: every store keeps
-- NULL = "not set" = the app default (22%). Pay, wage, deductions, hours, sales, expenses, food threshold, personal data and store<->staff
-- links are not touched. Running this file again changes no saved value.
--
-- Reading: every member of a store can already select public.stores rows they may view (private.can_view_store), so the owner and manager
-- screens of one store read the same value. It is a number, not personal data. No new access to sales or other people's pay is added.
-- Writing: only through public.manee_set_store_labor_ratio(), which requires an ACTIVE OWNER membership of THAT store. The column is NOT in
-- the column-level UPDATE grant of public.stores, so a direct update by any client role (owner, manager, staff, anon) is refused.
--
-- Compatibility: the app treats a missing column (error 42703) as "not set", so the front end may be deployed before or after this file.
-- Rollback: labor-ratio-threshold-rollback.sql only revokes the RPC; the column and every saved value stay. Re-run THIS file to re-enable.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.stores add column if not exists labor_ratio_threshold numeric(5,2);

do $constraint$
begin
  if not exists (select 1 from pg_constraint where conname='stores_labor_ratio_threshold_range' and conrelid='public.stores'::regclass) then
    alter table public.stores add constraint stores_labor_ratio_threshold_range
      check (labor_ratio_threshold is null or (labor_ratio_threshold>=1 and labor_ratio_threshold<=100));
  end if;
end;
$constraint$;

grant select (labor_ratio_threshold) on public.stores to authenticated;

create or replace function public.manee_set_store_labor_ratio(p_store_id uuid, p_threshold numeric)
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
  update public.stores set labor_ratio_threshold = v where id = p_store_id;
  return jsonb_build_object('ok', true, 'labor_ratio_threshold', v);
end;
$$;
revoke all on function public.manee_set_store_labor_ratio(uuid, numeric) from public, anon;
grant execute on function public.manee_set_store_labor_ratio(uuid, numeric) to authenticated;

commit;
