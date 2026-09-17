-- Applied directly to production and staging on 2026-09-17.
-- Adds MOU tracking to franchises (manee-admin dashboard "MOU 관리" +
-- franchise tab rebuild) and updates the daily subscription snapshot RPC
-- (see subscription-snapshots.sql) to read the real subsidy amount
-- instead of the hardcoded 0 placeholder it shipped with.
--
-- Also grants authenticated admins UPDATE on franchises: the table
-- previously had zero grants for authenticated at all (only a SELECT
-- policy), so there was no working save path for MOU fields (or, it
-- turns out, for the legacy name/username edit form either -- that form
-- is dead code today since MANEE_ADMIN_AUTH_ENABLED is force-true in
-- every deployed build, per manee-admin/scripts/build-environment.mjs).
alter table public.franchises
  add column mou_start_date date,
  add column mou_end_date date,
  add column subsidy_amount numeric not null default 0;

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
      ) as effective_price,
      coalesce(f.subsidy_amount, 0) as subsidy_amount
    from owner_stores os
    join public.profiles p on p.username = os.owner_username and p.status = 'active'
    left join public.franchises f on f.id = os.franchise_id
  )
  insert into public.subscription_snapshots(snapshot_date, user_id, franchise_id, billing_status, effective_price, subsidy_amount, unlimited_trial)
  select target_date, c.user_id, c.franchise_id, c.billing_status, c.effective_price, c.subsidy_amount, c.unlimited_trial
  from computed c
  on conflict (snapshot_date, user_id) do update set
    franchise_id = excluded.franchise_id,
    billing_status = excluded.billing_status,
    effective_price = excluded.effective_price,
    subsidy_amount = excluded.subsidy_amount,
    unlimited_trial = excluded.unlimited_trial;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant update on public.franchises to authenticated;

create policy franchises_admin_write on public.franchises
  for update to authenticated
  using (private.has_platform_role(array['super_admin','admin']::text[]))
  with check (private.has_platform_role(array['super_admin','admin']::text[]));

-- Follow-up fix, same day: the original franchises SELECT grant (from
-- franchises-rls-lockdown.sql) is column-level, not table-wide -- it only
-- covers id/name/username/monthly_price/created_at and does NOT
-- automatically extend to new columns. Once index.html started selecting
-- mou_start_date/mou_end_date/subsidy_amount, every loadFranchises() call
-- got a 403 and silently emptied state.franchises (reported by the user
-- as "등록된 프랜차이즈가 없어요" despite the row still existing).
grant select (mou_start_date, mou_end_date, subsidy_amount) on public.franchises to authenticated;
