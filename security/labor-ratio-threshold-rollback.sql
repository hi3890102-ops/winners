-- NON-DESTRUCTIVE rollback of labor-ratio-threshold.sql.
-- Switches the FEATURE off at the database (nobody can save a new labor threshold). KEEPS stores.labor_ratio_threshold, its range check and every
-- value owners already saved. Nothing is deleted or reset. While rolled back, the screens keep reading the saved values (they are read-only data).
-- Re-enable later: run labor-ratio-threshold.sql ONLY. It is repeatable, changes no saved value and restores the grant.
-- Dropping the column (destroying saved settings) is deliberately NOT part of any rollback or recovery; it would need a separate approval and a
-- prior read-only export:  select id, labor_ratio_threshold from public.stores where labor_ratio_threshold is not null;
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
revoke all on function public.manee_set_store_labor_ratio(uuid, numeric) from public, anon, authenticated;
commit;
