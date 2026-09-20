-- Self-managed profile, part 3 (re-review findings V2-01 and V2-C1).
-- Apply AFTER security/self-profile-management.sql (v1) and security/self-profile-management-v2.sql. Same function signatures as v2:
-- the two-argument call of manee_save_my_profile is protected exactly like the three-argument one.
-- Nothing in this file updates, deletes or reverts an existing crew row or an already saved personal value.
--   V2-01  "This record is managed by the employee" (crew.self_service_profile) used to stand for "every stored value was taken over".
--          It no longer does. Which stored value the person has taken over is now recorded per field (name / phone / bank text) in
--          private.profile_adoption. A stored value that differs from the person's profile is replaced only when
--            - that field was taken over before (a normal later edit keeps flowing to the store), or
--            - the store's value is empty (nothing is replaced), or
--            - the person just confirmed the values they saw (p_confirm, re-checked on the server), or
--            - the record was created empty by the approval (approve_new).
--          Saving an empty profile, saving the same values, or saving a partial bank bundle takes nothing over.
--          Rows that were already flagged before this version get all three fields recorded as taken over (the meaning the flag had), so
--          normal behaviour for them does not change. That backfill only INSERTS rows into the new private table.
--   V2-C1  approve_new and save now take the same per-person advisory lock, so a new store record is initialised from the profile that is
--          current when the approval commits, and a save that finishes later sees the new store record.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists private.profile_adoption(
  crew_id uuid not null references public.crew(id) on delete cascade,
  user_id uuid not null,
  field text not null check (field in ('name','phone','bank_account')),
  adopted_at timestamptz not null default now(),
  primary key (crew_id,user_id,field));
revoke all on private.profile_adoption from public,anon,authenticated;
alter table private.profile_adoption enable row level security;

-- records for rows the flag already covered (insert only)
insert into private.profile_adoption(crew_id,user_id,field)
  select c.id,m.user_id,f.field from public.crew c
    join public.store_memberships m on m.crew_id=c.id and m.status='active'
    cross join (values ('name'),('phone'),('bank_account')) f(field)
   where c.self_service_profile
  on conflict do nothing;

-- ---- one row: take over what may be taken over, report the rest ---------------------------------------------------------------
create or replace function private.sync_self_profile_to_crew(p_uid uuid,p_crew uuid,p_source text,p_mode text default 'self',p_confirmed boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prof private.staff_self_profiles%rowtype; c public.crew%rowtype; upd text[]:='{}'; held text[]:='{}'; need text[]:='{}'; mark text[]:='{}';
  newbank text; bank_complete boolean; bank_any boolean; d_name boolean; d_phone boolean; d_bank boolean;
  ad_name boolean; ad_phone boolean; ad_bank boolean; a_name boolean; a_phone boolean; a_bank boolean; free boolean;
begin
  select * into prof from private.staff_self_profiles where user_id=p_uid;
  if not found then return jsonb_build_object('updated','[]'::jsonb,'held','[]'::jsonb,'needs_confirmation','[]'::jsonb); end if;
  if not exists(select 1 from public.store_memberships m where m.user_id=p_uid and m.crew_id=p_crew and m.status='active') then
    return jsonb_build_object('updated','[]'::jsonb,'held','[]'::jsonb,'needs_confirmation','[]'::jsonb); end if;
  select * into c from public.crew where id=p_crew for update;
  if not found then return jsonb_build_object('updated','[]'::jsonb,'held','[]'::jsonb,'needs_confirmation','[]'::jsonb); end if;
  bank_complete:=prof.bank_name is not null and prof.bank_account is not null and prof.account_holder is not null;
  bank_any:=prof.bank_name is not null or prof.bank_account is not null or prof.account_holder is not null;
  newbank:=case when bank_complete then concat_ws(' / ',prof.bank_name,prof.bank_account,prof.account_holder) end;
  d_name:=prof.person_name is not null and prof.person_name is distinct from c.name;
  d_phone:=prof.phone is not null and prof.phone is distinct from nullif(c.phone,'');
  d_bank:=bank_complete and newbank is distinct from nullif(c.bank_account,'');
  if bank_any and not bank_complete then held:=array['bank_account']; end if;   -- incomplete bundle: never composed, never replaces the store's text
  select coalesce(bool_or(field='name'),false),coalesce(bool_or(field='phone'),false),coalesce(bool_or(field='bank_account'),false)
    into ad_name,ad_phone,ad_bank from private.profile_adoption where crew_id=p_crew and user_id=p_uid;
  free:=p_mode='init' or p_confirmed;   -- a brand-new record, or the person confirmed exactly what they saw
  a_name:=d_name and (ad_name or free);
  a_phone:=d_phone and (ad_phone or free or nullif(c.phone,'') is null);
  a_bank:=d_bank and (ad_bank or free or nullif(c.bank_account,'') is null);
  if d_name and not a_name then need:=array_append(need,'name'); end if;
  if d_phone and not a_phone then need:=array_append(need,'phone'); end if;
  if d_bank and not a_bank then need:=array_append(need,'bank_account'); end if;
  if a_name then upd:=array_append(upd,'name'); insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'name',c.name); end if;
  if a_phone then upd:=array_append(upd,'phone'); insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'phone',c.phone); end if;
  if a_bank then upd:=array_append(upd,'bank_account'); insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'bank_account',c.bank_account); end if;
  -- taken over now: what was replaced, and (only with an explicit confirmation / new record) every value the person has, so later edits flow
  if a_name or (free and prof.person_name is not null) then mark:=array_append(mark,'name'); end if;
  if a_phone or (free and prof.phone is not null) then mark:=array_append(mark,'phone'); end if;
  if a_bank or (free and bank_complete) then mark:=array_append(mark,'bank_account'); end if;
  if coalesce(array_length(mark,1),0)>0 then
    insert into private.profile_adoption(crew_id,user_id,field) select p_crew,p_uid,x from unnest(mark) x on conflict do nothing;
  end if;
  if coalesce(array_length(upd,1),0)>0 or (coalesce(array_length(mark,1),0)>0 and not c.self_service_profile) then
    update public.crew set name=case when a_name then prof.person_name else name end,phone=case when a_phone then prof.phone else phone end,
      bank_account=case when a_bank then newbank else bank_account end,self_service_profile=true where id=p_crew;
  end if;
  if coalesce(array_length(upd,1),0)>0 then
    insert into private.profile_change_events(user_id,store_id,crew_id,fields,source) values(p_uid,c.store_id,c.id,upd,p_source);
  end if;
  return jsonb_build_object('updated',to_jsonb(upd),'held',to_jsonb(held),'needs_confirmation',to_jsonb(need));
end;
$$;
revoke all on function private.sync_self_profile_to_crew(uuid,uuid,text,text,boolean) from public,anon,authenticated;

-- ---- state: adds which stored values the person has taken over ------------------------------------------------------------------
create or replace function private.my_profile_state(p_reveal boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); prof private.staff_self_profiles%rowtype; reg private.staff_registration_profiles%rowtype; res jsonb; stores jsonb; have_self boolean;
begin
  if uid is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  select * into prof from private.staff_self_profiles where user_id=uid;
  have_self:=found;
  if have_self then
    res:=jsonb_build_object('source','self','revision',prof.revision,'updated_at',prof.updated_at,'person_name',prof.person_name,'phone',prof.phone,
      'bank_name',prof.bank_name,'account_holder',prof.account_holder,
      'bank_account',case when p_reveal then prof.bank_account else private.mask_account(prof.bank_account) end);
  else
    select * into reg from private.staff_registration_profiles where user_id=uid;
    if found then
      res:=jsonb_build_object('source','signup','revision',0,'updated_at',reg.created_at,'person_name',null,'phone',reg.phone,'bank_name',reg.bank_name,'account_holder',reg.account_holder,
        'bank_account',case when p_reveal then reg.bank_account else private.mask_account(reg.bank_account) end);
    end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('store_id',s.id,'store_name',s.name,'crew_id',c.id,'role',m.role,'name',c.name,'phone',c.phone,
      'bank_text',case when p_reveal then c.bank_account else private.mask_bank_text(c.bank_account) end,'self_managed',c.self_service_profile,
      'adopted',jsonb_build_object(
        'name',exists(select 1 from private.profile_adoption a where a.crew_id=c.id and a.user_id=uid and a.field='name'),
        'phone',exists(select 1 from private.profile_adoption a where a.crew_id=c.id and a.user_id=uid and a.field='phone'),
        'bank_account',exists(select 1 from private.profile_adoption a where a.crew_id=c.id and a.user_id=uid and a.field='bank_account')),
      'pending',to_jsonb(array_remove(array[
        case when have_self and prof.person_name is not null and prof.person_name is distinct from c.name
             and not exists(select 1 from private.profile_adoption a where a.crew_id=c.id and a.user_id=uid and a.field='name') then 'name' end,
        case when have_self and prof.phone is not null and nullif(c.phone,'') is not null and prof.phone is distinct from c.phone
             and not exists(select 1 from private.profile_adoption a where a.crew_id=c.id and a.user_id=uid and a.field='phone') then 'phone' end,
        case when have_self and prof.bank_name is not null and prof.bank_account is not null and prof.account_holder is not null and nullif(c.bank_account,'') is not null
             and concat_ws(' / ',prof.bank_name,prof.bank_account,prof.account_holder) is distinct from c.bank_account
             and not exists(select 1 from private.profile_adoption a where a.crew_id=c.id and a.user_id=uid and a.field='bank_account') then 'bank_account' end],null)),
      'differs',(have_self and (
         (prof.person_name is not null and prof.person_name is distinct from c.name)
         or (prof.phone is not null and prof.phone is distinct from nullif(c.phone,''))
         or (prof.bank_name is not null and prof.bank_account is not null and prof.account_holder is not null
             and concat_ws(' / ',prof.bank_name,prof.bank_account,prof.account_holder) is distinct from nullif(c.bank_account,''))))) order by s.name),'[]'::jsonb)
    into stores
    from public.store_memberships m join public.crew c on c.id=m.crew_id join public.stores s on s.id=m.store_id
    where m.user_id=uid and m.status='active' and m.crew_id is not null and s.archived_at is null;
  return jsonb_build_object('ok',true,'profile',res,'stores',stores);
end;
$$;

-- ---- save: same signature as v2, plus the per-person lock (V2-C1) -------------------------------------------------------------------
create or replace function private.save_my_profile(p_profile jsonb,p_expected_revision integer,p_confirm jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); cur private.staff_self_profiles%rowtype; n_name text; n_phone text; n_bank text; n_acct text; n_holder text;
  c record; conf jsonb; seen jsonb; crow public.crew%rowtype; r jsonb; out jsonb:='[]'::jsonb; rev integer; confirmed boolean;
begin
  if uid is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_profile is null or jsonb_typeof(p_profile)<>'object' then raise exception 'Invalid profile' using errcode='22023'; end if;
  if p_confirm is not null and jsonb_typeof(p_confirm)<>'array' then raise exception 'Invalid confirmation' using errcode='22023'; end if;
  n_name:=nullif(btrim(coalesce(p_profile->>'person_name','')),''); n_phone:=nullif(btrim(coalesce(p_profile->>'phone','')),'');
  n_bank:=nullif(btrim(coalesce(p_profile->>'bank_name','')),''); n_acct:=nullif(btrim(coalesce(p_profile->>'bank_account','')),'');
  n_holder:=nullif(btrim(coalesce(p_profile->>'account_holder','')),'');
  perform pg_advisory_xact_lock(hashtextextended('self_profile:'||uid::text,0));   -- one save/approval per person at a time
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
    confirmed:=false;
    select e into conf from jsonb_array_elements(coalesce(p_confirm,'[]'::jsonb)) e where e->>'crew_id'=c.crew_id::text limit 1;
    if conf is not null then
      -- the person confirmed what they SAW; if the store changed it meanwhile, nothing is adopted silently
      seen:=conf->'seen';
      select * into crow from public.crew where id=c.crew_id for share;
      if crow.name is distinct from coalesce(seen->>'name','') or coalesce(crow.phone,'')<>coalesce(seen->>'phone','') or coalesce(crow.bank_account,'')<>coalesce(seen->>'bank_account','') then
        raise exception 'store_values_changed' using errcode='PT409'; end if;
      confirmed:=true;
    end if;
    r:=private.sync_self_profile_to_crew(uid,c.crew_id,'self','self',confirmed);
    out:=out||jsonb_build_array(jsonb_build_object('store_id',c.store_id,'store_name',c.store_name,'crew_id',c.crew_id,
      'updated_fields',r->'updated','held_fields',r->'held','needs_confirmation',r->'needs_confirmation'));
  end loop;
  return jsonb_build_object('ok',true,'revision',rev,'stores',out);
exception when check_violation then raise exception 'Invalid profile value' using errcode='22023';
end;
$$;

-- ---- portal wrapper: approve_new takes the same lock and records the new record as taken over (V2-C1) ---------------------------
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
    perform pg_advisory_xact_lock(hashtextextended('self_profile:'||requester::text,0));   -- read the profile that is current once we hold the lock
    select * into personal from private.staff_registration_profiles where user_id=requester;
    if found then
      update public.crew set phone=personal.phone,
        bank_account=concat_ws(' / ',personal.bank_name,personal.bank_account,personal.account_holder),
        self_service_profile=true,employment_setup_required=true
        where id=(result->>'crew_id')::uuid;
      result:=result||jsonb_build_object('employment_setup_required',true);
      insert into private.profile_adoption(crew_id,user_id,field)
        select (result->>'crew_id')::uuid,requester,f from unnest(array['name','phone','bank_account']) f on conflict do nothing;   -- brand-new record only
    end if;
    perform private.sync_self_profile_to_crew(requester,(result->>'crew_id')::uuid,'join','init',true);
  end if;
  return result;
end;
$$;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
commit;
