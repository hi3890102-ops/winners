-- Applied directly to production and staging on 2026-09-17.
-- Part of the 가맹점 자동배정 feature: a per-franchise signup code that
-- new store owners can optionally enter on the existing signup form to
-- get auto-assigned to that franchise (instead of HQ manually assigning
-- stores.franchise_id after the fact from the franchise tab).

-- A-1: franchises.signup_code -- issued once at franchise creation,
-- never editable afterward. Immutability is enforced by omission: only
-- SELECT is granted to authenticated, never UPDATE (same pattern as the
-- other admin-managed-only columns added this session -- a column with
-- no UPDATE grant just can't be written by PostgREST regardless of RLS).
alter table public.franchises add column signup_code text;
create unique index franchises_signup_code_key on public.franchises(signup_code) where signup_code is not null;
grant select (signup_code) on public.franchises to authenticated;

-- 8-char code, same alphabet/derivation as private.generate_store_staff_code()
-- (excludes I/O/0/1 for readability).
create or replace function private.generate_franchise_signup_code()
returns text language plpgsql set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := decode(replace(gen_random_uuid()::text,'-',''),'hex');
  value bigint:=0; candidate text:=''; i integer;
begin
  for i in 0..4 loop value:=(value<<8) | get_byte(bytes,i)::bigint; end loop;
  for i in 1..8 loop
    candidate:=substr(alphabet,(value & 31)::int+1,1)||candidate;
    value:=value>>5;
  end loop;
  return candidate;
end;
$$;

-- private.bootstrap_franchise_account now generates and stores a signup_code
-- when a franchise is created (retries on signup_code collision, identified
-- via GET STACKED DIAGNOSTICS constraint_name so a genuine username race
-- isn't mistaken for a code collision).
create or replace function private.bootstrap_franchise_account(p_actor uuid, p_user_id uuid, p_username text, p_display_name text, p_franchise_name text)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  uname text := lower(btrim(normalize(coalesce(p_username,''),NFKC)));
  fname text := btrim(coalesce(p_franchise_name,''));
  fid uuid;
  code text;
  v_constraint text;
  i integer;
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

  fid := null;
  for i in 1..50 loop
    code := private.generate_franchise_signup_code();
    begin
      insert into public.franchises(name,username,password_hash,signup_code)
        values(fname,uname,'auth_managed:'||encode(extensions.gen_random_bytes(16),'hex'),code)
        returning id into fid;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint <> 'franchises_signup_code_key' then raise; end if;
    end;
  end loop;
  if fid is null then raise exception 'signup_code allocation busy; retry' using errcode='40001'; end if;

  insert into public.franchise_memberships(user_id,franchise_id,role,status) values(p_user_id,fid,'admin','active');
  return fid;
end;
$function$;

-- A-2: bootstrap_owner_account gets an optional p_franchise_code. Blank ->
-- unchanged behavior (no franchise, default pricing). Non-blank -> must
-- match an existing franchises.signup_code or the whole signup fails
-- (rolled back by the manee-signup edge function, same as any other
-- bootstrap error) -- never silently creates an unaffiliated account when
-- the owner typed a code expecting franchise pricing.
create or replace function public.bootstrap_owner_account(p_user_id uuid, p_username text, p_display_name text, p_store_name text, p_franchise_code text default null)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  new_store_id uuid;
  normalized_username text := lower(btrim(normalize(coalesce(p_username, ''), NFKC)));
  clean_store_name text := trim(p_store_name);
  clean_code text := upper(btrim(coalesce(p_franchise_code,'')));
  matched_franchise_id uuid;
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'auth user not found';
  end if;
  if normalized_username = '' then
    raise exception 'username is required';
  end if;
  if clean_store_name is null or clean_store_name = '' or char_length(clean_store_name) > 80 then
    raise exception 'invalid store name';
  end if;

  if public.is_manee_username_reserved(normalized_username) then
    raise exception using errcode = '23505', message = 'username_taken';
  end if;

  if clean_code <> '' then
    select id into matched_franchise_id from public.franchises where signup_code = clean_code;
    if matched_franchise_id is null then
      raise exception using errcode = '22023', message = 'invalid_franchise_code';
    end if;
  end if;

  insert into public.profiles(user_id, username, display_name, status)
  values(p_user_id, normalized_username, nullif(trim(p_display_name), ''), 'active');

  insert into public.stores(name, owner_username, onboarding_done, franchise_id)
  values(clean_store_name, normalized_username, false, matched_franchise_id)
  returning id into new_store_id;

  insert into public.store_memberships(user_id, store_id, role, status)
  values(p_user_id, new_store_id, 'owner', 'active');
  return new_store_id;
end;
$function$;

-- manee-signup edge function (deployed separately, not SQL) now reads
-- body.franchise_code, validates the shape (4-16 chars, [A-Z0-9]) before
-- calling the RPC, and maps errcode 22023/message invalid_franchise_code
-- to a 400 response { error: 'invalid_franchise_code' }.
