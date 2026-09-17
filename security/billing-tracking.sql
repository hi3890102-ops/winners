-- Trial-to-paid billing tracking. No actual payment/charging yet (deferred
-- until after 법인 registration, before launch) -- this just gives HQ the
-- data to see who's on trial, how long, and what they'd be charged.
--
-- Design: each owner's *effective* price is snapshotted directly onto their
-- profile (monthly_price), not computed live from a global rate. That way
-- changing the system default later never silently repriced existing
-- customers -- HQ sets monthly_price explicitly (individually, per
-- franchise-affiliated batch, or backfilled by hand using each owner's
-- signup date) whenever real billing actually starts. Until then it's
-- fine for it to stay null; the dashboard falls back to showing the
-- current system default for display purposes only.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.profiles add column if not exists monthly_price numeric;
alter table public.profiles add column if not exists billing_status text not null default 'trial'
  check (billing_status in ('trial','active','overdue','cancelled'));

alter table public.franchises add column if not exists monthly_price numeric;

create table if not exists public.billing_settings (
  key text primary key,
  value numeric not null,
  updated_at timestamptz not null default now()
);
insert into public.billing_settings(key, value) values
  ('default_price', 9900),
  ('default_franchise_price', 4900)
on conflict (key) do nothing;
alter table public.billing_settings enable row level security;
drop policy if exists "allow all - billing_settings" on public.billing_settings;
create policy "allow all - billing_settings" on public.billing_settings for all using (true) with check (true);

commit;
