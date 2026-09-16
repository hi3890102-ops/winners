-- Franchise account creation for the Auth-based admin system.
-- The old createFranchise() wrote a legacy password_hash row directly from
-- the client and is incompatible with Supabase Auth login. This adds a
-- server-side bootstrap RPC (mirrors bootstrap_staff_account's shape) that
-- an edge function calls, using the service role, right after creating the
-- auth.users row. Only an active platform_admin (본사) may successfully
-- call this -- p_actor is checked inside, so even a stray authenticated
-- call (not just the intended service-role edge function path) can't
-- create a franchise account without HQ privileges.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create function private.bootstrap_franchise_account(p_actor uuid, p_user_id uuid, p_username text, p_display_name text, p_franchise_name text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
  uname text := lower(btrim(normalize(coalesce(p_username,''),NFKC)));
  fname text := btrim(coalesce(p_franchise_name,''));
  fid uuid;
begin
  perform 1 from public.platform_admins where user_id=p_actor and status='active';
  if not found then raise exception 'Owner permission required' using errcode='42501'; end if;

  if p_user_id is null or uname !~ '^[a-z0-9가-힣._-]{4,30}$'
     or length(btrim(coalesce(p_display_name,''))) not between 1 and 50
     or p_display_name ~ '[<>[:cntrl:]]'
     or length(fname) not between 1 and 50
     or fname ~ '[<>[:cntrl:]]' then raise exception 'Invalid franchise account' using errcode='22023'; end if;

  if public.is_manee_username_reserved(uname) then raise exception 'username_taken' using errcode='23505'; end if;

  insert into public.profiles(user_id,username,display_name,status) values(p_user_id,uname,btrim(p_display_name),'active');
  insert into public.franchises(name,username,password_hash) values(fname,uname,'auth_managed:'||encode(gen_random_bytes(16),'hex')) returning id into fid;
  insert into public.franchise_memberships(user_id,franchise_id,role,status) values(p_user_id,fid,'admin','active');
  return fid;
end;
$$;

create function public.bootstrap_franchise_account(p_actor uuid, p_user_id uuid, p_username text, p_display_name text, p_franchise_name text)
returns uuid language sql set search_path='' as $$
  select private.bootstrap_franchise_account(p_actor,p_user_id,p_username,p_display_name,p_franchise_name);
$$;

-- Postgres grants EXECUTE to PUBLIC by default on a newly created function;
-- bootstrap_staff_account was created without that default (matches
-- postgres/service_role only), so mirror it explicitly here.
revoke all on function private.bootstrap_franchise_account(uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.bootstrap_franchise_account(uuid,uuid,text,text,text) from public, anon, authenticated;

commit;
