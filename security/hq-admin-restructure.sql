-- HQ admin (manee-admin) tab restructure -- STAGING ONLY, do not apply to
-- production. Adds: store contact info, and bare schema for the new 소통
-- tab (announcements/claims/update log) -- UI ships as a skeleton this
-- round, no real send/save logic wired yet, but the tables are real so
-- wiring them up later doesn't need another migration.
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
drop policy if exists "allow all - hq_announcements" on public.hq_announcements;
create policy "allow all - hq_announcements" on public.hq_announcements for all using (true) with check (true);

create table if not exists public.claims (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  created_at timestamptz not null default now()
);
alter table public.claims enable row level security;
drop policy if exists "allow all - claims" on public.claims;
create policy "allow all - claims" on public.claims for all using (true) with check (true);

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
drop policy if exists "allow all - claim_messages" on public.claim_messages;
create policy "allow all - claim_messages" on public.claim_messages for all using (true) with check (true);

create table if not exists public.update_log (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  released_at date not null default current_date,
  notes text not null
);
alter table public.update_log enable row level security;
drop policy if exists "allow all - update_log" on public.update_log;
create policy "allow all - update_log" on public.update_log for all using (true) with check (true);

-- Pre-existing gap found while verifying the 프랜차이즈 탭: authenticated had
-- no grants at all on public.franchises, so the client-side franchise list
-- query 403'd for every HQ admin even though RLS already allowed it. The
-- edge-function-based create/delete flows never hit this since they run as
-- service_role. NOT yet ported to production -- do that separately once
-- this is verified, since franchise-account-creation.sql (which this table
-- belongs to) is already live in prod.
grant select on public.franchises to authenticated;

-- Same discovery for the new 정지/재개 (suspend/resume) action: franchise_memberships
-- had no permissive UPDATE policy at all (only a self-scoped SELECT policy plus
-- the restrictive liveness gate), so no authenticated role could ever update it
-- through PostgREST. Scoped narrowly to platform admins, matching can_manage_store's
-- role check. NOT yet ported to production.
create policy franchise_memberships_admin_manage on public.franchise_memberships
  for update to authenticated
  using (private.has_platform_role(array['super_admin','admin']::text[]))
  with check (private.has_platform_role(array['super_admin','admin']::text[]));
grant update(status, revoked_at) on public.franchise_memberships to authenticated;

commit;
