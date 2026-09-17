-- HQ admin (manee-admin) tab restructure -- STAGING ONLY, do not apply to
-- production as-is (the stores.phone / new-table pieces below still need to
-- be ported; the franchises/franchise_memberships grant fixes near the
-- bottom have ALREADY been ported to production separately, see
-- franchises-rls-lockdown.sql -- don't reapply them from here).
--
-- Adds: store contact info, and bare schema for the new 소통 tab
-- (announcements/claims/update log) -- UI ships as a skeleton this round,
-- no real send/save logic wired yet, so client access is read-only and
-- scoped to platform admins for now; widen it when the real feature lands.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.stores add column if not exists phone text;
grant update(phone) on public.stores to authenticated;

create table if not exists public.hq_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  target_type text not null default 'all' check (target_type in ('all','franchise','store')),
  target_id uuid,
  created_at timestamptz not null default now()
);
alter table public.hq_announcements enable row level security;
-- Nothing reads or writes this table from the client yet (the 공지작성 form
-- doesn't actually submit) -- no grants at all until that's built for real.

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  created_at timestamptz not null default now()
);
alter table public.claims enable row level security;
grant select on public.claims to authenticated;
create policy hq_communication_admin_read on public.claims for select to authenticated
  using (private.has_platform_role(array['super_admin','admin','support','read_only']::text[]));

create table if not exists public.claim_messages (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims(id) on delete cascade,
  sender_type text not null check (sender_type in ('store','hq')),
  sender_name text,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists claim_messages_claim_idx on public.claim_messages(claim_id, created_at);
alter table public.claim_messages enable row level security;
grant select on public.claim_messages to authenticated;
create policy hq_communication_admin_read on public.claim_messages for select to authenticated
  using (private.has_platform_role(array['super_admin','admin','support','read_only']::text[]));

create table if not exists public.update_log (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  released_at date not null default current_date,
  notes text not null
);
alter table public.update_log enable row level security;
grant select on public.update_log to authenticated;
create policy hq_communication_admin_read on public.update_log for select to authenticated
  using (private.has_platform_role(array['super_admin','admin','support','read_only']::text[]));

commit;

-- ALREADY PORTED TO PRODUCTION separately (see franchises-rls-lockdown.sql,
-- applied 2026-09-17) -- kept here only as the staging-side record of the
-- same two fixes, do not reapply:
--   1. franchises had no grant at all to authenticated -> the client-side
--      franchise list query 403'd for every HQ admin even though RLS
--      already allowed it.
--   2. franchise_memberships had no permissive UPDATE policy at all, so
--      정지/재개 (suspend/resume) silently no-op'd for every platform admin.
