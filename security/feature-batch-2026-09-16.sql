-- Additive schema changes for the 2026-09-16 feature/bugfix batch.
-- Matches the current production security posture (RLS enabled + permissive
-- "allow all" policy) since Phase C lockdown hasn't happened yet; nothing here
-- is more or less exposed than the rest of the schema today.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- #7: tax filing reminder dismissal was silently failing because this table
-- never existed. Same shape the app already expects (see ackTaxReminderForStore).
create table if not exists public.tax_reminder_ack (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  month_key text not null,
  created_at timestamptz not null default now(),
  unique(store_id, month_key)
);
alter table public.tax_reminder_ack enable row level security;
drop policy if exists "allow all - tax_reminder_ack" on public.tax_reminder_ack;
create policy "allow all - tax_reminder_ack" on public.tax_reminder_ack for all using (true) with check (true);

-- #3: weekly contracted hours alongside the existing 근무조건 label.
alter table public.crew add column if not exists weekly_hours numeric;

-- #4: free-form additional info fields per crew member (유니폼보증금, 비자종류 등).
alter table public.crew add column if not exists custom_fields jsonb not null default '[]'::jsonb;

-- #9: 30-minutes-before reservation reminder needs its own sent-flag,
-- separate from the existing same-day digest's `notified` column.
alter table public.reservations add column if not exists reminder_sent boolean not null default false;

-- #5: 반차/가불/무급휴가 등 급여 조정 내역.
create table if not exists public.crew_pay_adjustments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  crew_id uuid not null references public.crew(id) on delete cascade,
  month_key text not null,
  type text not null,
  amount integer not null,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists crew_pay_adjustments_crew_month_idx on public.crew_pay_adjustments(crew_id, month_key);
alter table public.crew_pay_adjustments enable row level security;
drop policy if exists "allow all - crew_pay_adjustments" on public.crew_pay_adjustments;
create policy "allow all - crew_pay_adjustments" on public.crew_pay_adjustments for all using (true) with check (true);

commit;
