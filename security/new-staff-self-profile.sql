-- Additive patch. Apply AFTER the currently deployed staff portal patches,
-- including store-staff-new-employee-approval.sql. No existing employee conversion.
-- New clients opt in at signup; old clients continue using bootstrap_staff_account.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists private.staff_registration_profiles (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  phone text not null check(length(phone) between 7 and 24 and phone ~ '^[+0-9 ()-]+$' and length(regexp_replace(phone,'[^0-9]','','g')) between 7 and 15),
  bank_name text not null check(length(bank_name) between 1 and 50 and bank_name !~ '[<>[:cntrl:]]'),
  bank_account text not null check(length(bank_account) between 5 and 40 and bank_account ~ '^[0-9 -]+$' and length(regexp_replace(bank_account,'[^0-9]','','g')) between 5 and 30),
  account_holder text not null check(length(account_holder) between 1 and 50 and account_holder !~ '[<>[:cntrl:]]'),
  created_at timestamptz not null default now()
);
alter table private.staff_registration_profiles enable row level security;
revoke all on private.staff_registration_profiles from public,anon,authenticated;
-- No direct client policies: service signup and the authenticated portal below only.

alter table public.crew add column if not exists self_service_profile boolean not null default false;
alter table public.crew add column if not exists employment_setup_required boolean not null default false;

create or replace function private.bootstrap_staff_account_with_profile(
  p_user_id uuid,p_username text,p_display_name text,p_personal jsonb
) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;
begin
  if p_personal is null or jsonb_typeof(p_personal)<>'object'
    or length(btrim(coalesce(p_personal->>'phone',''))) not between 7 and 24
    or btrim(p_personal->>'phone') !~ '^[+0-9 ()-]+$'
    or length(regexp_replace(p_personal->>'phone','[^0-9]','','g')) not between 7 and 15
    or length(btrim(coalesce(p_personal->>'bank_name',''))) not between 1 and 50
    or (p_personal->>'bank_name') ~ '[<>[:cntrl:]]'
    or length(btrim(coalesce(p_personal->>'bank_account',''))) not between 5 and 40
    or btrim(p_personal->>'bank_account') !~ '^[0-9 -]+$'
    or length(regexp_replace(p_personal->>'bank_account','[^0-9]','','g')) not between 5 and 30
    or length(btrim(coalesce(p_personal->>'account_holder',''))) not between 1 and 50
    or (p_personal->>'account_holder') ~ '[<>[:cntrl:]]'
  then raise exception 'Invalid personal profile' using errcode='22023'; end if;
  -- Both inserts commit together. Existing accounts cannot enroll themselves
  -- in the new cohort, overwrite employment terms or adopt another user id.
  result:=private.bootstrap_staff_account(p_user_id,p_username,p_display_name);
  insert into private.staff_registration_profiles(user_id,phone,bank_name,bank_account,account_holder)
    values(result,btrim(p_personal->>'phone'),btrim(p_personal->>'bank_name'),
      btrim(p_personal->>'bank_account'),btrim(p_personal->>'account_holder'));
  return result;
end;
$$;
create or replace function public.bootstrap_staff_account_with_profile(
  p_user_id uuid,p_username text,p_display_name text,p_personal jsonb
) returns uuid language sql security invoker set search_path='' as $$
  select private.bootstrap_staff_account_with_profile(p_user_id,p_username,p_display_name,p_personal);
$$;
revoke all on function private.bootstrap_staff_account_with_profile(uuid,text,text,jsonb),public.bootstrap_staff_account_with_profile(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function private.bootstrap_staff_account_with_profile(uuid,text,text,jsonb),public.bootstrap_staff_account_with_profile(uuid,text,text,jsonb) to service_role;

do $wrap$
begin
  if to_regprocedure('private.manee_staff_portal_before_self_profile(text,jsonb)') is null then
    alter function private.manee_staff_portal(text,jsonb) rename to manee_staff_portal_before_self_profile;
  end if;
end;
$wrap$;
revoke all on function private.manee_staff_portal_before_self_profile(text,jsonb) from public,anon,authenticated;

create or replace function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  result jsonb;
  personal private.staff_registration_profiles%rowtype;
  requester uuid;
  reqs jsonb;
begin
  if auth.uid() is null or not private.is_live_manee_session() then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  -- Delegate first: the established implementation checks store membership,
  -- owner authority, expiry, conflicts, and serializes double approvals.
  result:=private.manee_staff_portal_before_self_profile(p_action,p_payload);
  if coalesce((result->>'ok')::boolean,false) is not true then return result; end if;

  if p_action='session' then
    select * into personal from private.staff_registration_profiles where user_id=auth.uid();
    if found then result:=result||jsonb_build_object('personal_profile',
      jsonb_build_object('phone',personal.phone,'bank_name',personal.bank_name,
        'bank_account',personal.bank_account,'account_holder',personal.account_holder)); end if;
  elsif p_action='owner_list' then
    -- Join only requests returned by the authorized owner_list. Never query
    -- arbitrary user IDs supplied by the caller for personal data.
    select coalesce(jsonb_agg(e.value || case when p.user_id is null then '{}'::jsonb else
      jsonb_build_object('personal_profile',jsonb_build_object('phone',p.phone,'bank_name',p.bank_name,
        'bank_account',p.bank_account,'account_holder',p.account_holder)) end order by e.ordinality),'[]'::jsonb)
      into reqs
      from jsonb_array_elements(coalesce(result->'requests','[]'::jsonb)) with ordinality e(value,ordinality)
      left join private.staff_registration_profiles p on p.user_id=(e.value->>'requester_user_id')::uuid;
    result:=result||jsonb_build_object('requests',reqs);
  elsif p_action='approve_new' and coalesce((result->>'created_new')::boolean,false) then
    select requester_user_id into requester from private.staff_link_requests where id=(p_payload->>'request_id')::uuid;
    select * into personal from private.staff_registration_profiles where user_id=requester;
    if found then
      update public.crew set phone=personal.phone,
        bank_account=concat_ws(' / ',personal.bank_name,personal.bank_account,personal.account_holder),
        self_service_profile=true,employment_setup_required=true
        where id=(result->>'crew_id')::uuid;
      result:=result||jsonb_build_object('employment_setup_required',true);
    end if;
  end if;
  -- approve (existing-record link) intentionally never updates crew fields.
  return result;
end;
$$;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
create or replace function public.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.manee_staff_portal(p_action,p_payload);
$$;
revoke all on function public.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function public.manee_staff_portal(text,jsonb) to authenticated;
commit;
