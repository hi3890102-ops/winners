-- Self-managed basic profile (name, phone, bank, account, holder) that connected stores read.
-- ADDITIVE. Apply AFTER security/new-staff-self-profile.sql. No existing row is updated, deleted or backfilled by this file:
--   * two new private tables (no client grants), one BEFORE UPDATE trigger, three private functions + three public wrappers,
--   * the staff-portal wrapper is re-created with one extra step (adopt the person's own profile when a store approves them).
-- Data moves only when a signed-in person saves their own profile (public.manee_save_my_profile) or is approved into a store.
-- Rollback: security/self-profile-management-rollback.sql (revokes the RPCs, drops the guard trigger, restores the previous wrapper; data is kept).
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists private.staff_self_profiles (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  person_name text check(person_name is null or (length(person_name) between 1 and 50 and person_name !~ '[<>[:cntrl:]]')),
  phone text check(phone is null or (length(phone) between 7 and 24 and phone ~ '^[+0-9 ()-]+$' and length(regexp_replace(phone,'[^0-9]','','g')) between 7 and 15)),
  bank_name text check(bank_name is null or (length(bank_name) between 1 and 50 and bank_name !~ '[<>[:cntrl:]]')),
  bank_account text check(bank_account is null or (length(bank_account) between 5 and 40 and bank_account ~ '^[0-9 -]+$' and length(regexp_replace(bank_account,'[^0-9]','','g')) between 5 and 30)),
  account_holder text check(account_holder is null or (length(account_holder) between 1 and 50 and account_holder !~ '[<>[:cntrl:]]')),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table private.staff_self_profiles enable row level security;
revoke all on private.staff_self_profiles from public,anon,authenticated;

-- Change notices for the owner: which fields changed and when. Never the values.
create table if not exists private.profile_change_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  crew_id uuid not null references public.crew(id) on delete cascade,
  fields text[] not null,
  source text not null default 'self',
  changed_at timestamptz not null default now()
);
create index if not exists profile_change_events_store_idx on private.profile_change_events(store_id,changed_at desc);
alter table private.profile_change_events enable row level security;
revoke all on private.profile_change_events from public,anon,authenticated;

-- The value a store had before the person's own value replaced it (kept so nothing is lost; never readable by clients).
create table if not exists private.profile_prior_values (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.crew(id) on delete cascade,
  user_id uuid not null,
  field text not null,
  old_value text,
  replaced_at timestamptz not null default now()
);
alter table private.profile_prior_values enable row level security;
revoke all on private.profile_prior_values from public,anon,authenticated;

-- Stores (and old app versions) can no longer overwrite the basic fields of a self-managed employee through the API.
-- Owners/managers keep every other crew field (wage, conditions, position, role, memo ...). Server-side jobs and SECURITY DEFINER
-- functions run as another role and are not affected (same pattern as private.guard_business_record).
create or replace function private.guard_self_managed_crew() returns trigger language plpgsql set search_path='' as $$
begin
  if current_user<>'authenticated' then return new; end if;
  if old.self_service_profile then
    if new.name is distinct from old.name or new.phone is distinct from old.phone or new.bank_account is distinct from old.bank_account then
      raise exception 'Name, phone and bank details of this employee are managed by the employee' using errcode='42501';
    end if;
    new.self_service_profile:=true;
  end if;
  return new;
end;
$$;
drop trigger if exists manee_guard_self_managed_crew on public.crew;
create trigger manee_guard_self_managed_crew before update on public.crew for each row execute function private.guard_self_managed_crew();

create or replace function private.mask_bank_text(t text) returns text language sql immutable set search_path='' as $$
  select case when t is null then null else regexp_replace(t,'([0-9]{3})[0-9 -]*([0-9]{4})','\1-***-\2','g') end
$$;

-- Conflicts use SQLSTATE PT409 (PostgREST answers HTTP 409). Do NOT use 40001: the API gateway retries serialization failures until it times out (504).
-- Copies the person's OWN profile into ONE crew row they are actively linked to. Empty profile fields never clear store values.
create or replace function private.sync_self_profile_to_crew(p_uid uuid,p_crew uuid,p_source text default 'self') returns text[]
language plpgsql security definer set search_path='' as $$
declare prof private.staff_self_profiles%rowtype; c public.crew%rowtype; f text[]:='{}'; newbank text;
begin
  select * into prof from private.staff_self_profiles where user_id=p_uid;
  if not found then return f; end if;
  if not exists(select 1 from public.store_memberships m where m.user_id=p_uid and m.crew_id=p_crew and m.status='active') then return f; end if;
  select * into c from public.crew where id=p_crew for update;
  if not found then return f; end if;
  if prof.person_name is not null and prof.person_name is distinct from c.name then f:=array_append(f,'name'); end if;
  if prof.phone is not null and prof.phone is distinct from c.phone then f:=array_append(f,'phone'); end if;
  if prof.bank_account is not null then
    newbank:=concat_ws(' / ',prof.bank_name,prof.bank_account,prof.account_holder);
    if newbank is distinct from c.bank_account then f:=array_append(f,'bank_account'); end if;
  end if;
  if 'name' = any(f) then insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'name',c.name); end if;
  if 'phone' = any(f) then insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'phone',c.phone); end if;
  if 'bank_account' = any(f) then insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'bank_account',c.bank_account); end if;
  if coalesce(array_length(f,1),0)>0 or not c.self_service_profile then
    update public.crew set name=coalesce(prof.person_name,name),phone=coalesce(prof.phone,phone),
      bank_account=case when prof.bank_account is not null then newbank else bank_account end,self_service_profile=true where id=p_crew;
  end if;
  if coalesce(array_length(f,1),0)>0 then
    insert into private.profile_change_events(user_id,store_id,crew_id,fields,source) values(p_uid,c.store_id,c.id,f,p_source);
  end if;
  return f;
end;
$$;
revoke all on function private.sync_self_profile_to_crew(uuid,uuid,text) from public,anon,authenticated;

create or replace function private.my_profile_state(p_reveal boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); prof private.staff_self_profiles%rowtype; reg private.staff_registration_profiles%rowtype; res jsonb; stores jsonb;
begin
  if uid is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into prof from private.staff_self_profiles where user_id=uid;
  if found then
    res:=jsonb_build_object('source','self','revision',prof.revision,'updated_at',prof.updated_at,'person_name',prof.person_name,'phone',prof.phone,
      'bank_name',prof.bank_name,'account_holder',prof.account_holder,
      'bank_account',case when p_reveal then prof.bank_account else case when prof.bank_account is null then null else private.mask_bank_text(prof.bank_account) end end);
  else
    select * into reg from private.staff_registration_profiles where user_id=uid;
    if found then
      res:=jsonb_build_object('source','signup','revision',0,'updated_at',reg.created_at,'person_name',null,'phone',reg.phone,'bank_name',reg.bank_name,'account_holder',reg.account_holder,
        'bank_account',case when p_reveal then reg.bank_account else private.mask_bank_text(reg.bank_account) end);
    end if;
  end if;
  -- ONLY the crew rows this account is actively linked to (by membership), never by name or phone.
  select coalesce(jsonb_agg(jsonb_build_object('store_id',s.id,'store_name',s.name,'crew_id',c.id,'role',m.role,'name',c.name,'phone',c.phone,
      'bank_text',case when p_reveal then c.bank_account else private.mask_bank_text(c.bank_account) end,'self_managed',c.self_service_profile) order by s.name),'[]'::jsonb)
    into stores
    from public.store_memberships m join public.crew c on c.id=m.crew_id join public.stores s on s.id=m.store_id
    where m.user_id=uid and m.status='active' and m.crew_id is not null and s.archived_at is null;
  return jsonb_build_object('ok',true,'profile',res,'stores',stores);
end;
$$;

create or replace function private.save_my_profile(p_profile jsonb,p_expected_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); cur private.staff_self_profiles%rowtype; n_name text; n_phone text; n_bank text; n_acct text; n_holder text;
  c record; f text[]; out jsonb:='[]'::jsonb; rev integer;
begin
  if uid is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_profile is null or jsonb_typeof(p_profile)<>'object' then raise exception 'Invalid profile' using errcode='22023'; end if;
  n_name:=nullif(btrim(coalesce(p_profile->>'person_name','')),''); n_phone:=nullif(btrim(coalesce(p_profile->>'phone','')),'');
  n_bank:=nullif(btrim(coalesce(p_profile->>'bank_name','')),''); n_acct:=nullif(btrim(coalesce(p_profile->>'bank_account','')),'');
  n_holder:=nullif(btrim(coalesce(p_profile->>'account_holder','')),'');
  perform 1 from public.profiles where user_id=uid and status='active' for share;
  if not found then raise exception 'Account unavailable' using errcode='42501'; end if;
  select * into cur from private.staff_self_profiles where user_id=uid for update;
  if found then
    if cur.revision is distinct from p_expected_revision then raise exception 'profile_revision_conflict' using errcode='PT409'; end if;
    update private.staff_self_profiles set person_name=n_name,phone=n_phone,bank_name=n_bank,bank_account=n_acct,account_holder=n_holder,revision=revision+1,updated_at=now()
      where user_id=uid returning revision into rev;
  else
    if coalesce(p_expected_revision,0)<>0 then raise exception 'profile_revision_conflict' using errcode='PT409'; end if;
    begin
      insert into private.staff_self_profiles(user_id,person_name,phone,bank_name,bank_account,account_holder) values(uid,n_name,n_phone,n_bank,n_acct,n_holder) returning revision into rev;
    exception when unique_violation then raise exception 'profile_revision_conflict' using errcode='PT409'; end;
  end if;
  for c in select m.crew_id,m.store_id,s.name store_name from public.store_memberships m join public.stores s on s.id=m.store_id
           where m.user_id=uid and m.status='active' and m.crew_id is not null and s.archived_at is null order by s.name loop
    f:=private.sync_self_profile_to_crew(uid,c.crew_id,'self');
    out:=out||jsonb_build_array(jsonb_build_object('store_id',c.store_id,'store_name',c.store_name,'crew_id',c.crew_id,'updated_fields',to_jsonb(f)));
  end loop;
  return jsonb_build_object('ok',true,'revision',rev,'stores',out);
exception when check_violation then raise exception 'Invalid profile value' using errcode='22023';
end;
$$;

create or replace function private.owner_profile_changes(p_store_id uuid,p_days integer default 30) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_store_id is null or not private.has_store_membership(p_store_id,array['owner']::text[]) then raise exception 'only an owner of this store can read these notices' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('crew_id',e.crew_id,'crew_name',c.name,'fields',to_jsonb(e.fields),'changed_at',e.changed_at) order by e.changed_at desc)
    from private.profile_change_events e join public.crew c on c.id=e.crew_id
    where e.store_id=p_store_id and e.changed_at>now()-make_interval(days=>least(greatest(coalesce(p_days,30),1),90))),'[]'::jsonb);
end;
$$;

revoke all on function private.my_profile_state(boolean),private.save_my_profile(jsonb,integer),private.owner_profile_changes(uuid,integer) from public,anon,authenticated;
grant execute on function private.my_profile_state(boolean),private.save_my_profile(jsonb,integer),private.owner_profile_changes(uuid,integer) to authenticated;

create or replace function public.manee_my_profile_state(p_reveal boolean default false) returns jsonb language sql security invoker set search_path='' as $$
  select private.my_profile_state(p_reveal);
$$;
create or replace function public.manee_save_my_profile(p_profile jsonb,p_expected_revision integer) returns jsonb language sql security invoker set search_path='' as $$
  select private.save_my_profile(p_profile,p_expected_revision);
$$;
create or replace function public.manee_owner_profile_changes(p_store_id uuid,p_days integer default 30) returns jsonb language sql security invoker set search_path='' as $$
  select private.owner_profile_changes(p_store_id,p_days);
$$;
revoke all on function public.manee_my_profile_state(boolean),public.manee_save_my_profile(jsonb,integer),public.manee_owner_profile_changes(uuid,integer) from public,anon;
grant execute on function public.manee_my_profile_state(boolean),public.manee_save_my_profile(jsonb,integer),public.manee_owner_profile_changes(uuid,integer) to authenticated;

-- Staff portal wrapper (same as new-staff-self-profile.sql) + one step: a person who already manages their own profile has it adopted by
-- the store that approves them (new employee record or link to an existing one).
create or replace function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  result jsonb;
  personal private.staff_registration_profiles%rowtype;
  requester uuid;
  link_crew uuid;
  reqs jsonb;
begin
  if auth.uid() is null or not private.is_live_manee_session() then
    raise exception 'Authentication required' using errcode='42501';
  end if;
  result:=private.manee_staff_portal_before_self_profile(p_action,p_payload);
  if coalesce((result->>'ok')::boolean,false) is not true then return result; end if;

  if p_action='session' then
    select * into personal from private.staff_registration_profiles where user_id=auth.uid();
    if found then result:=result||jsonb_build_object('personal_profile',
      jsonb_build_object('phone',personal.phone,'bank_name',personal.bank_name,
        'bank_account',personal.bank_account,'account_holder',personal.account_holder)); end if;
  elsif p_action='owner_list' then
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
    perform private.sync_self_profile_to_crew(requester,(result->>'crew_id')::uuid,'join');
  elsif p_action='approve' then
    select requester_user_id,crew_id into requester,link_crew from private.staff_link_requests where id=(p_payload->>'request_id')::uuid;
    if requester is not null and link_crew is not null then perform private.sync_self_profile_to_crew(requester,link_crew,'join'); end if;
  end if;
  return result;
end;
$$;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
commit;
