-- Applied directly to production and staging on 2026-09-17.
-- Prerequisite for manee-admin's "구독료 매출 현황" weekly trend chart --
-- there was previously no table recording subscription/payment history,
-- only a live computed snapshot (profiles.monthly_price/billing_status +
-- franchises.monthly_price), so no past week could ever be shown.
--
-- This does NOT trigger any real billing/payment -- it only reads current
-- state once a day and appends one row per active owner. subsidy_amount
-- is hardcoded 0 here; mou-franchise-fields.sql (applied later the same
-- day) adds franchises.subsidy_amount and a follow-up migration updates
-- this function to read it.
create table public.subscription_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  franchise_id uuid references public.franchises(id) on delete set null,
  billing_status text not null,
  effective_price numeric not null default 0,
  subsidy_amount numeric not null default 0,
  unlimited_trial boolean not null default false,
  created_at timestamptz not null default now(),
  unique(snapshot_date, user_id)
);

alter table public.subscription_snapshots enable row level security;
revoke all on public.subscription_snapshots from public, anon;

create policy subscription_snapshots_admin_read on public.subscription_snapshots
  for select to authenticated
  using (private.has_platform_role(array['super_admin','admin','support','read_only']::text[]));

-- Mirrors loadHqDashboardStats()'s effectivePrice computation in manee-admin/index.html:
-- monthly_price override, else franchise price (or default_franchise_price) / default_price,
-- plus additional_store_price per extra store. One row per owner (by profiles.user_id),
-- upserted per target_date so a re-run same day is idempotent.
--
-- IMPORTANT: the private function has no auth.has_platform_role check -- it's unreachable
-- from PostgREST (private schema) and pg_cron calls it directly with no auth.uid() session,
-- so that check must live only in the public wrapper.
create or replace function private.record_subscription_snapshot(target_date date default (now() at time zone 'Asia/Seoul')::date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_default_price numeric;
  v_default_franchise_price numeric;
  v_additional_store_price numeric;
  v_count integer;
begin
  select coalesce(max(value) filter (where key='default_price'), 9900),
         coalesce(max(value) filter (where key='default_franchise_price'), 4900),
         coalesce(max(value) filter (where key='additional_store_price'), 0)
    into v_default_price, v_default_franchise_price, v_additional_store_price
    from public.billing_settings;

  with owner_stores as (
    select owner_username, count(*) as store_count,
      (array_agg(franchise_id) filter (where franchise_id is not null))[1] as franchise_id
    from public.stores
    where archived_at is null and owner_username is not null
    group by owner_username
  ),
  computed as (
    select
      p.user_id,
      os.franchise_id,
      coalesce(p.billing_status,'trial') as billing_status,
      coalesce(p.unlimited_trial,false) as unlimited_trial,
      coalesce(p.monthly_price,
        (case when os.franchise_id is not null then coalesce(f.monthly_price, v_default_franchise_price) else v_default_price end)
        + greatest(0, os.store_count - 1) * v_additional_store_price
      ) as effective_price
    from owner_stores os
    join public.profiles p on p.username = os.owner_username and p.status = 'active'
    left join public.franchises f on f.id = os.franchise_id
  )
  insert into public.subscription_snapshots(snapshot_date, user_id, franchise_id, billing_status, effective_price, subsidy_amount, unlimited_trial)
  select target_date, c.user_id, c.franchise_id, c.billing_status, c.effective_price, 0, c.unlimited_trial
  from computed c
  on conflict (snapshot_date, user_id) do update set
    franchise_id = excluded.franchise_id,
    billing_status = excluded.billing_status,
    effective_price = excluded.effective_price,
    unlimited_trial = excluded.unlimited_trial;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function private.record_subscription_snapshot(date) from public, anon;

create or replace function public.record_subscription_snapshot(target_date date default (now() at time zone 'Asia/Seoul')::date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_platform_role(array['super_admin','admin']::text[]) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  return private.record_subscription_snapshot(target_date);
end;
$$;

revoke all on function public.record_subscription_snapshot(date) from public, anon;
grant execute on function public.record_subscription_snapshot(date) to authenticated;

-- Daily at 01:05 Asia/Seoul (16:05 UTC).
create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'daily-subscription-snapshot',
  '5 16 * * *',
  $$select private.record_subscription_snapshot();$$
);
