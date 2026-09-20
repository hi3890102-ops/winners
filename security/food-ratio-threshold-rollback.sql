-- NON-DESTRUCTIVE rollback of food-ratio-threshold.sql. LOCAL PREPARATION ONLY: not applied anywhere.
--
-- What it does: switches the FEATURE off at the database (nobody can save a new threshold any more). It KEEPS the column
-- stores.food_ratio_threshold, its range check and every value owners already saved. Store data, including these settings, is
-- never deleted or reset by a rollback.
--
-- Why the column stays: a saved threshold is store data. Older app versions never select the column, so leaving it is harmless
-- to them; a newer app keeps reading it (and treats a missing/unreadable value as "not set" / "판정 불가", never as green).
-- To go back to the previous app version, deploy the previous app; nothing else has to be undone in the database.
--
-- Re-enabling later: run food-ratio-threshold.sql again. It is idempotent, changes no existing value, and restores the RPC grant.
--
-- Dropping the column (destroying saved settings) is deliberately NOT part of any automatic rollback or recovery procedure. It needs
-- an explicit, separate approval, and the values must be exported first (read-only):
--   select id, food_ratio_threshold from public.stores where food_ratio_threshold is not null;
-- Backups: the read-only backup queries export public.stores with "select *" and digest whole rows, so the column and its values are
-- included automatically once it exists (see security/new-staff-self-profile-backup-queries.sql).
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
revoke all on function public.manee_set_store_food_ratio(uuid, numeric) from public, anon, authenticated;
commit;
