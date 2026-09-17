-- Adds: additional-store price, default trial length, and a per-owner
-- unlimited-trial flag. Backfills every current store owner as
-- unlimited_trial=true so today's rollout doesn't retroactively start a
-- 40-day countdown for people who already joined under no such rule --
-- only owners signing up from now on get the real 40-day trial.
insert into public.billing_settings(key, value) values
  ('additional_store_price', 4900),
  ('default_trial_days', 40)
on conflict (key) do nothing;

alter table public.profiles add column if not exists unlimited_trial boolean not null default false;

update public.profiles set unlimited_trial = true
where username in (select distinct owner_username from public.stores where owner_username is not null)
and unlimited_trial = false;
