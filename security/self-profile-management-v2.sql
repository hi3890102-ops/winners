-- Self-managed profile, part 2 (review findings SP-01, SP-03, SP-04, SP-06 on the server side).
-- Apply AFTER security/self-profile-management.sql. Compatible with the app that is already open: the save function keeps its two-argument
-- call shape (the new third argument has a default) and simply becomes stricter.
-- Nothing in this file updates, deletes or reverts an existing crew row or an already saved personal value.
--   SP-01  Linking an EXISTING employee record (approve) no longer overwrites name/phone/bank. A stored value is replaced only after the
--          person confirmed exactly what they saw (p_confirm carries the seen values; the server re-checks them). Only a freshly created
--          empty record (approve_new) is initialised from the person's own profile.
--   SP-03  Bank / account / holder are one bundle: the store's bank text is replaced only when all three are present. A partial bundle is
--          reported as "held" and the store's value is kept.
--   SP-04  Every default (masked) read hides digits: full masking for short numbers, no raw pass-through of unparsable text.
--   SP-06  A bank text is split only when it has exactly three " / " parts, non-empty, with a numeric middle part.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- ---- masking (SP-04) ----------------------------------------------------------------------------------------------------------
create or replace function private.mask_account(a text) returns text language sql immutable set search_path='' as $$
  select case
    when a is null then null
    when length(regexp_replace(a,'[^0-9]','','g'))>=12 then left(regexp_replace(a,'[^0-9]','','g'),3)||'-***-'||right(regexp_replace(a,'[^0-9]','','g'),4)
    when length(regexp_replace(a,'[^0-9]','','g'))>=8 then '***-'||right(regexp_replace(a,'[^0-9]','','g'),3)
    else '*****' end
$$;
-- crew.bank_account is free text: mask the middle of a clean "bank / account / holder"; hide EVERY digit of anything else.
create or replace function private.mask_bank_text(t text) returns text language sql immutable set search_path='' as $$
  select case
    when t is null then null
    when t ~ '^[^/]+ / [0-9 -]{5,40} / [^/]+$' and length(regexp_replace(split_part(t,' / ',2),'[^0-9]','','g')) between 5 and 30
      then split_part(t,' / ',1)||' / '||private.mask_account(split_part(t,' / ',2))||' / '||split_part(t,' / ',3)
    else regexp_replace(t,'[0-9]','*','g') end
$$;

-- ---- one row: adopt the person's profile into a crew row they are actively linked to (SP-01, SP-03) ----------------------------
drop function if exists private.sync_self_profile_to_crew(uuid,uuid,text);
create or replace function private.sync_self_profile_to_crew(p_uid uuid,p_crew uuid,p_source text,p_mode text default 'self',p_confirmed boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prof private.staff_self_profiles%rowtype; c public.crew%rowtype; upd text[]:='{}'; held text[]:='{}'; need text[]:='{}';
  newbank text; bank_complete boolean; bank_any boolean; d_name boolean; d_phone boolean; d_bank boolean; adopt boolean;
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
  if c.self_service_profile or p_mode='init' or p_confirmed then adopt:=true;
  else
    -- an existing, not yet adopted record: adopt silently only when nothing stored would be replaced
    adopt:=not (d_name or (d_phone and nullif(c.phone,'') is not null) or (d_bank and nullif(c.bank_account,'') is not null));
  end if;
  if not adopt then
    if d_name then need:=array_append(need,'name'); end if;
    if d_phone and nullif(c.phone,'') is not null then need:=array_append(need,'phone'); end if;
    if d_bank and nullif(c.bank_account,'') is not null then need:=array_append(need,'bank_account'); end if;
    return jsonb_build_object('updated','[]'::jsonb,'held',to_jsonb(held),'needs_confirmation',to_jsonb(need));
  end if;
  if d_name then upd:=array_append(upd,'name'); insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'name',c.name); end if;
  if d_phone then upd:=array_append(upd,'phone'); insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'phone',c.phone); end if;
  if d_bank then upd:=array_append(upd,'bank_account'); insert into private.profile_prior_values(crew_id,user_id,field,old_value) values(c.id,p_uid,'bank_account',c.bank_account); end if;
  if coalesce(array_length(upd,1),0)>0 or not c.self_service_profile then
    update public.crew set name=case when d_name then prof.person_name else name end,phone=case when d_phone then prof.phone else phone end,
      bank_account=case when d_bank then newbank else bank_account end,self_service_profile=true where id=p_crew;
  end if;
  if coalesce(array_length(upd,1),0)>0 then
    insert into private.profile_change_events(user_id,store_id,crew_id,fields,source) values(p_uid,c.store_id,c.id,upd,p_source);
  end if;
  return jsonb_build_object('updated',to_jsonb(upd),'held',to_jsonb(held),'needs_confirmation','[]'::jsonb);
end;
$$;
revoke all on function private.sync_self_profile_to_crew(uuid,uuid,text,text,boolean) from public,anon,authenticated;

-- ---- state: masked by default, per-store "differs" flag ---------------------------------------------------------------------------
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

-- ---- save: explicit per-store confirmation, re-checked on the server (SP-01) ---------------------------------------------------------
drop function if exists public.manee_save_my_profile(jsonb,integer);
drop function if exists private.save_my_profile(jsonb,integer);
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
revoke all on function private.my_profile_state(boolean),private.save_my_profile(jsonb,integer,jsonb) from public,anon,authenticated;
grant execute on function private.my_profile_state(boolean),private.save_my_profile(jsonb,integer,jsonb) to authenticated;
create or replace function public.manee_save_my_profile(p_profile jsonb,p_expected_revision integer,p_confirm jsonb default null) returns jsonb language sql security invoker set search_path='' as $$
  select private.save_my_profile(p_profile,p_expected_revision,p_confirm);
$$;
revoke all on function public.manee_save_my_profile(jsonb,integer,jsonb) from public,anon;
grant execute on function public.manee_save_my_profile(jsonb,integer,jsonb) to authenticated;

-- ---- portal wrapper: only a NEW empty employee record is initialised on approval; linking an existing record changes nothing (SP-01) ----
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
    select * into personal from private.staff_registration_profiles where user_id=requester;
    if found then
      update public.crew set phone=personal.phone,
        bank_account=concat_ws(' / ',personal.bank_name,personal.bank_account,personal.account_holder),
        self_service_profile=true,employment_setup_required=true
        where id=(result->>'crew_id')::uuid;
      result:=result||jsonb_build_object('employment_setup_required',true);
    end if;
    perform private.sync_self_profile_to_crew(requester,(result->>'crew_id')::uuid,'join','init',true);   -- brand-new record only
  end if;
  return result;
end;
$$;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
commit;
