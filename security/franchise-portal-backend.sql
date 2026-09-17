-- Applied directly to production and staging on 2026-09-17, across several
-- apply_migration calls (consolidated here into one file). Backend support
-- for the manee-partner (PORTAL_MODE=franchise) portal's 문의/가맹점 편입/
-- 소식 tabs. See franchise-signup-code.sql for the earlier A-1/A-2 pieces
-- (signup_code, bootstrap_owner_account) this portal also reads from.

-- ===== 문의 tab: claims/claim_messages franchise support =====
alter table public.claims add column franchise_id uuid references public.franchises(id) on delete cascade;
alter table public.claims alter column store_id drop not null;
alter table public.claims add constraint claims_origin_check check (store_id is not null or franchise_id is not null);

create policy claims_franchise_read on public.claims
  for select to authenticated
  using (franchise_id is not null and exists(
    select 1 from public.franchise_memberships fm
    where fm.user_id=(select auth.uid()) and fm.franchise_id=claims.franchise_id and fm.status='active'
  ));

create policy claim_messages_franchise_read on public.claim_messages
  for select to authenticated
  using (exists(
    select 1 from public.claims c
    join public.franchise_memberships fm on fm.franchise_id=c.franchise_id
    where c.id=claim_messages.claim_id and fm.user_id=(select auth.uid()) and fm.status='active'
  ));

-- Franchise submits a new inquiry thread (claim + first message).
create or replace function private.franchise_submit_claim(p_title text, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid());
  fid uuid; fname text; cid uuid;
  title text := btrim(coalesce(p_title,'')); body text := btrim(coalesce(p_body,''));
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if length(title) not between 1 and 120 or length(body) not between 1 and 4000 then
    raise exception 'Invalid inquiry' using errcode='22023';
  end if;
  select fm.franchise_id, f.name into fid, fname
    from public.franchise_memberships fm join public.franchises f on f.id=fm.franchise_id
    where fm.user_id=actor and fm.status='active' limit 1;
  if fid is null then raise exception 'Franchise membership required' using errcode='42501'; end if;
  insert into public.claims(franchise_id, title, status) values(fid, title, 'open') returning id into cid;
  insert into public.claim_messages(claim_id, sender_type, sender_name, body) values(cid, 'franchise', fname, body);
  return cid;
end;
$$;

-- Franchise follow-up message on their own thread.
create or replace function private.franchise_reply_claim(p_claim_id uuid, p_body text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); fid uuid; fname text; body text := btrim(coalesce(p_body,''));
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if length(body) not between 1 and 4000 then raise exception 'Invalid message' using errcode='22023'; end if;
  select c.franchise_id into fid from public.claims c where c.id=p_claim_id;
  if fid is null or not exists(select 1 from public.franchise_memberships fm where fm.user_id=actor and fm.franchise_id=fid and fm.status='active') then
    raise exception 'Not authorized for this inquiry' using errcode='42501';
  end if;
  select f.name into fname from public.franchises f where f.id=fid;
  insert into public.claim_messages(claim_id, sender_type, sender_name, body) values(p_claim_id, 'franchise', fname, body);
  return true;
end;
$$;

-- HQ reply (previously the reply box was hardcoded-disabled client-side; this is what
-- makes it real). Optionally marks the claim resolved.
create or replace function private.hq_reply_claim(p_claim_id uuid, p_body text, p_resolve boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare body text := btrim(coalesce(p_body,''));
begin
  if not private.has_platform_role(array['super_admin','admin','support']::text[]) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  if length(body) not between 1 and 4000 then raise exception 'Invalid message' using errcode='22023'; end if;
  if not exists(select 1 from public.claims where id=p_claim_id) then raise exception 'Inquiry not found' using errcode='22023'; end if;
  insert into public.claim_messages(claim_id, sender_type, sender_name, body) values(p_claim_id, 'hq', '매니 본사', body);
  if p_resolve then update public.claims set status='resolved' where id=p_claim_id;
  else update public.claims set status='in_progress' where id=p_claim_id and status='open'; end if;
  return true;
end;
$$;

revoke all on function private.franchise_submit_claim(text,text) from public, anon;
revoke all on function private.franchise_reply_claim(uuid,text) from public, anon;
revoke all on function private.hq_reply_claim(uuid,text,boolean) from public, anon;
create or replace function public.franchise_submit_claim(p_title text, p_body text)
returns uuid language sql set search_path = '' as $$ select private.franchise_submit_claim(p_title,p_body); $$;
create or replace function public.franchise_reply_claim(p_claim_id uuid, p_body text)
returns boolean language sql set search_path = '' as $$ select private.franchise_reply_claim(p_claim_id,p_body); $$;
create or replace function public.hq_reply_claim(p_claim_id uuid, p_body text, p_resolve boolean default false)
returns boolean language sql set search_path = '' as $$ select private.hq_reply_claim(p_claim_id,p_body,p_resolve); $$;
revoke all on function public.franchise_submit_claim(text,text) from public, anon;
revoke all on function public.franchise_reply_claim(uuid,text) from public, anon;
revoke all on function public.hq_reply_claim(uuid,text,boolean) from public, anon;
grant execute on function public.franchise_submit_claim(text,text) to authenticated;
grant execute on function public.franchise_reply_claim(uuid,text) to authenticated;
grant execute on function public.hq_reply_claim(uuid,text,boolean) to authenticated;

-- ===== 가맹점 tab: 편입 요청 (franchise_join_requests) =====
create table public.franchise_join_requests (
  id uuid primary key default gen_random_uuid(),
  franchise_id uuid not null references public.franchises(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  store_name text,
  requested_by uuid not null references auth.users(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);
create unique index franchise_join_requests_pending_unique on public.franchise_join_requests(franchise_id, store_id) where status='pending';
alter table public.franchise_join_requests enable row level security;
revoke all on public.franchise_join_requests from public, anon;

create policy franchise_join_requests_read on public.franchise_join_requests
  for select to authenticated
  using (
    private.has_platform_role(array['super_admin','admin','support']::text[])
    or exists(select 1 from public.franchise_memberships fm where fm.user_id=(select auth.uid()) and fm.franchise_id=franchise_join_requests.franchise_id and fm.status='active')
  );

-- store_name is captured server-side at request time (this function is SECURITY DEFINER
-- and bypasses RLS, unlike a client embed of stores(name) which would come back null --
-- the requesting franchise can't see an unaffiliated store's row via normal RLS).
create or replace function private.request_franchise_join(p_store_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := (select auth.uid()); fid uuid; current_franchise uuid; sname text; rid uuid;
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  select fm.franchise_id into fid from public.franchise_memberships fm where fm.user_id=actor and fm.status='active' limit 1;
  if fid is null then raise exception 'Franchise membership required' using errcode='42501'; end if;
  select franchise_id, name into current_franchise, sname from public.stores where id=p_store_id and archived_at is null;
  if not found then raise exception 'Store not found' using errcode='22023'; end if;
  if current_franchise is not null then raise exception 'Store already affiliated' using errcode='22023'; end if;
  insert into public.franchise_join_requests(franchise_id, store_id, store_name, requested_by)
    values(fid, p_store_id, sname, actor)
    on conflict (franchise_id, store_id) where status='pending' do nothing
    returning id into rid;
  if rid is null then
    select id into rid from public.franchise_join_requests where franchise_id=fid and store_id=p_store_id and status='pending';
  end if;
  return rid;
end;
$$;

-- HQ approves/rejects; approval sets stores.franchise_id in the same transaction.
create or replace function private.review_franchise_join_request(p_request_id uuid, p_approve boolean)
returns boolean language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); req public.franchise_join_requests%rowtype;
begin
  if not private.has_platform_role(array['super_admin','admin','support']::text[]) then
    raise exception 'Not authorized' using errcode='42501';
  end if;
  select * into req from public.franchise_join_requests where id=p_request_id and status='pending' for update;
  if not found then raise exception 'Request unavailable' using errcode='22023'; end if;
  if p_approve then
    update public.stores set franchise_id=req.franchise_id where id=req.store_id and franchise_id is null;
    update public.franchise_join_requests set status='approved', reviewed_at=now(), reviewed_by=actor where id=p_request_id;
  else
    update public.franchise_join_requests set status='rejected', reviewed_at=now(), reviewed_by=actor where id=p_request_id;
  end if;
  return true;
end;
$$;

revoke all on function private.request_franchise_join(uuid) from public, anon;
revoke all on function private.review_franchise_join_request(uuid, boolean) from public, anon;
create or replace function public.request_franchise_join(p_store_id uuid)
returns uuid language sql set search_path = '' as $$ select private.request_franchise_join(p_store_id); $$;
create or replace function public.review_franchise_join_request(p_request_id uuid, p_approve boolean)
returns boolean language sql set search_path = '' as $$ select private.review_franchise_join_request(p_request_id, p_approve); $$;
revoke all on function public.request_franchise_join(uuid) from public, anon;
revoke all on function public.review_franchise_join_request(uuid, boolean) from public, anon;
grant execute on function public.request_franchise_join(uuid) to authenticated;
grant execute on function public.review_franchise_join_request(uuid, boolean) to authenticated;

-- Limited search (id+name only) so a franchise can find a store to request --
-- franchise has no general read access to stores it doesn't belong to.
create or replace function private.search_unaffiliated_stores(p_query text)
returns table(id uuid, name text)
language plpgsql security definer set search_path = '' as $$
declare actor uuid := (select auth.uid()); q text := btrim(coalesce(p_query,''));
begin
  if actor is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if not exists(select 1 from public.franchise_memberships fm where fm.user_id=actor and fm.status='active') then
    raise exception 'Franchise membership required' using errcode='42501';
  end if;
  if length(q) < 1 then return; end if;
  return query select s.id, s.name from public.stores s
    where s.archived_at is null and s.franchise_id is null and s.name ilike '%'||q||'%'
    order by s.name limit 20;
end;
$$;
revoke all on function private.search_unaffiliated_stores(text) from public, anon;
create or replace function public.search_unaffiliated_stores(p_query text)
returns table(id uuid, name text)
language sql set search_path = '' as $$ select * from private.search_unaffiliated_stores(p_query); $$;
revoke all on function public.search_unaffiliated_stores(text) from public, anon;
grant execute on function public.search_unaffiliated_stores(text) to authenticated;

-- ===== 소식 tab: franchise read access to announcements/update log =====
create policy hq_announcements_franchise_read on public.hq_announcements
  for select to authenticated
  using (
    target_type = 'all'
    or (target_type = 'franchise' and exists(
      select 1 from public.franchise_memberships fm
      where fm.user_id=(select auth.uid()) and fm.franchise_id=hq_announcements.target_id and fm.status='active'
    ))
  );
grant select on public.hq_announcements to authenticated;

grant select on public.update_log to authenticated;
create policy update_log_franchise_read on public.update_log
  for select to authenticated
  using (exists(select 1 from public.franchise_memberships fm where fm.user_id=(select auth.uid()) and fm.status='active'));
