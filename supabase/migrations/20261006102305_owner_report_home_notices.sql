-- A targeted home notice is independent of browser push subscriptions.
-- Campaign recipients are inserted separately; no production identities live in code.
create table public.owner_report_home_notices (
  user_id uuid not null references auth.users(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  month_key text not null check (month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz not null default now(),
  primary key (user_id, store_id, month_key)
);
alter table public.owner_report_home_notices enable row level security;
revoke all on public.owner_report_home_notices from public, anon, authenticated;
grant select on public.owner_report_home_notices to authenticated;
create policy owner_report_home_notice_read on public.owner_report_home_notices
for select to authenticated using (
  user_id = (select auth.uid())
  and (select private.is_live_manee_session())
  and private.has_store_membership(store_id, array['owner'])
  and exists (select 1 from public.stores s where s.id = owner_report_home_notices.store_id and s.archived_at is null)
  and not exists (
    select 1 from public.monthly_cost_reviews r
    where r.store_id = owner_report_home_notices.store_id
      and r.month_key = owner_report_home_notices.month_key
      and r.completed_at is not null
  )
);
notify pgrst, 'reload schema';
