-- HQ admin (manee-admin) tab restructure -- STAGING ONLY, do not apply to
-- production. Adds: store contact info, and bare schema for the new 소통
-- tab (announcements/claims/update log) -- UI ships as a skeleton this
-- round, no real send/save logic wired yet, but the tables are real so
-- wiring them up later doesn't need another migration.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.stores add column if not exists phone text;

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

commit;
