-- Emergency fix, applied directly to production (bhwuuxcrzxespkjlmqxr) on
-- 2026-09-17, same class of issue as franchises-rls-lockdown.sql: both
-- tables had RLS disabled entirely and full INSERT/SELECT/UPDATE/DELETE
-- grants open to anon -- anyone with just the public anon key could read,
-- modify, or delete any reservation or push subscription record with no
-- login at all. Found via Supabase's security advisor while investigating
-- the franchises issue.
--
-- Mirrors the policy shape already live on staging.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- reservations: store members manage their own store's reservations;
-- oversight roles (HQ/franchise) get read-only visibility via can_view_store.
alter table public.reservations enable row level security;
revoke all on public.reservations from anon;
revoke all on public.reservations from authenticated;
grant select,insert,update,delete on public.reservations to authenticated;

create policy reservations_member_work on public.reservations for all to authenticated
  using (private.has_store_membership(store_id, null::text[]))
  with check (private.has_store_membership(store_id, null::text[]));
create policy reservations_oversight_read on public.reservations for select to authenticated
  using (private.can_view_store(store_id));
create policy manee_live_session_required on public.reservations
  as restrictive for all to authenticated
  using ((select private.is_live_manee_session()))
  with check ((select private.is_live_manee_session()));

-- push_subscriptions: fully server-managed (service_role only, via an edge
-- function) -- no client grants at all, matching staging.
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
revoke all on public.push_subscriptions from authenticated;

create policy manee_live_session_required on public.push_subscriptions
  as restrictive for all to authenticated
  using ((select private.is_live_manee_session()))
  with check ((select private.is_live_manee_session()));

commit;
