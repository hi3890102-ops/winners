-- Retire resident IDs, payroll banking details and custom employee fields.
-- Keep empty compatibility columns so old clients and payroll functions keep working.
-- This irreversibly erases the selected personal fields, not employee/business rows.
ALTER TABLE private.staff_registration_profiles
  ALTER COLUMN phone DROP NOT NULL,
  ALTER COLUMN bank_name DROP NOT NULL,
  ALTER COLUMN bank_account DROP NOT NULL,
  ALTER COLUMN account_holder DROP NOT NULL;
ALTER TABLE public.crew ALTER COLUMN resident_number SET DEFAULT NULL,
  ALTER COLUMN bank_account SET DEFAULT NULL;

CREATE OR REPLACE FUNCTION private.discard_retired_employee_fields()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_TABLE_SCHEMA='public' AND TG_TABLE_NAME='crew' THEN
    NEW.resident_number:=NULL; NEW.bank_account:=NULL; NEW.custom_fields:='[]'::jsonb;
  ELSE
    NEW.bank_name:=NULL; NEW.bank_account:=NULL; NEW.account_holder:=NULL;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.discard_retired_employee_fields() FROM PUBLIC;
CREATE TRIGGER a_discard_retired_employee_fields BEFORE INSERT OR UPDATE ON public.crew
FOR EACH ROW EXECUTE FUNCTION private.discard_retired_employee_fields();
CREATE TRIGGER discard_retired_employee_fields BEFORE INSERT OR UPDATE ON private.staff_registration_profiles
FOR EACH ROW EXECUTE FUNCTION private.discard_retired_employee_fields();
CREATE TRIGGER discard_retired_employee_fields BEFORE INSERT OR UPDATE ON private.staff_self_profiles
FOR EACH ROW EXECUTE FUNCTION private.discard_retired_employee_fields();

CREATE OR REPLACE FUNCTION private.bootstrap_staff_account_with_profile(p_user_id uuid, p_username text, p_display_name text, p_personal jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result uuid;
begin
  if p_personal is null or jsonb_typeof(p_personal)<>'object' then
    raise exception 'Invalid personal profile' using errcode='22023';
  end if;
  if nullif(btrim(coalesce(p_personal->>'phone','')),'') is not null and (
    length(btrim(p_personal->>'phone')) not between 7 and 24
    or btrim(p_personal->>'phone') !~ '^[+0-9 ()-]+$'
    or length(regexp_replace(p_personal->>'phone','[^0-9]','','g')) not between 7 and 15
  ) then raise exception 'Invalid phone' using errcode='22023'; end if;
  result:=private.bootstrap_staff_account(p_user_id,p_username,p_display_name);
  insert into private.staff_registration_profiles(user_id,phone)
    values(result,nullif(btrim(p_personal->>'phone'),''));
  return result;
end;
$function$

;
CREATE OR REPLACE FUNCTION private.save_my_profile(p_profile jsonb, p_expected_revision integer, p_confirm jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare uid uuid:=auth.uid(); cur private.staff_self_profiles%rowtype; n_name text; n_phone text; n_bank text; n_acct text; n_holder text;
  c record; conf jsonb; seen jsonb; crow public.crew%rowtype; r jsonb; out jsonb:='[]'::jsonb; rev integer; confirmed boolean;
begin
  if uid is null or not private.is_live_manee_session() then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_profile is null or jsonb_typeof(p_profile)<>'object' then raise exception 'Invalid profile' using errcode='22023'; end if;
  if p_confirm is not null and jsonb_typeof(p_confirm)<>'array' then raise exception 'Invalid confirmation' using errcode='22023'; end if;
  n_name:=nullif(btrim(coalesce(p_profile->>'person_name','')),''); n_phone:=nullif(btrim(coalesce(p_profile->>'phone','')),'');
  n_bank:=NULL; n_acct:=NULL; n_holder:=NULL;
  perform pg_advisory_xact_lock(hashtextextended('self_profile:'||uid::text,0));
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
      seen:=conf->'seen';
      select * into crow from public.crew where id=c.crew_id for share;
      if crow.name is distinct from coalesce(seen->>'name','') or coalesce(crow.phone,'')<>coalesce(seen->>'phone','') then
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
$function$

;
CREATE OR REPLACE FUNCTION private.guard_self_managed_crew()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if current_user<>'authenticated' then return new; end if;
  if old.self_service_profile then
    if new.name is distinct from old.name or new.phone is distinct from old.phone then
      raise exception 'Name and phone of this employee are managed by the employee' using errcode='42501';
    end if;
    new.self_service_profile:=true;
  end if;
  return new;
end;
$function$

;
CREATE OR REPLACE FUNCTION private.manee_staff_portal(p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      jsonb_build_object('phone',personal.phone)); end if;
  elsif p_action='owner_list' then
    select coalesce(jsonb_agg(e.value || case when p.user_id is null then '{}'::jsonb else
      jsonb_build_object('personal_profile',jsonb_build_object('phone',p.phone)) end order by e.ordinality),'[]'::jsonb)
      into reqs
      from jsonb_array_elements(coalesce(result->'requests','[]'::jsonb)) with ordinality e(value,ordinality)
      left join private.staff_registration_profiles p on p.user_id=(e.value->>'requester_user_id')::uuid;
    result:=result||jsonb_build_object('requests',reqs);
  elsif p_action='approve_new' and coalesce((result->>'created_new')::boolean,false) then
    select requester_user_id into requester from private.staff_link_requests where id=(p_payload->>'request_id')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('self_profile:'||requester::text,0));
    select * into personal from private.staff_registration_profiles where user_id=requester;
    if found then
      update public.crew set phone=personal.phone,
        self_service_profile=true,employment_setup_required=true
        where id=(result->>'crew_id')::uuid;
      result:=result||jsonb_build_object('employment_setup_required',true);
      insert into private.profile_adoption(crew_id,user_id,field)
        select (result->>'crew_id')::uuid,requester,f from unnest(array['name','phone']) f on conflict do nothing;
    end if;
    perform private.sync_self_profile_to_crew(requester,(result->>'crew_id')::uuid,'join','init',true);
  end if;
  return result;
end;
$function$

;

-- Scrub saved JSON snapshots recursively, preserving every unrelated key/value.
CREATE OR REPLACE FUNCTION private.remove_retired_employee_json(value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
  IF jsonb_typeof(value)='object' THEN
    SELECT coalesce(jsonb_object_agg(key,private.remove_retired_employee_json(val)),'{}'::jsonb)
      INTO result FROM jsonb_each(value) x(key,val)
      WHERE key NOT IN ('resident_number','residentNumber','bank_account','bankAccount',
        'bank_name','bankName','account_holder','accountHolder','bank_text','custom_fields','customFields');
    RETURN result;
  ELSIF jsonb_typeof(value)='array' THEN
    SELECT coalesce(jsonb_agg(private.remove_retired_employee_json(val) ORDER BY ord),'[]'::jsonb)
      INTO result FROM jsonb_array_elements(value) WITH ORDINALITY x(val,ord);
    RETURN result;
  END IF;
  RETURN value;
END;
$$;
REVOKE ALL ON FUNCTION private.remove_retired_employee_json(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.remove_retired_employee_json(jsonb) TO authenticated,service_role;
CREATE OR REPLACE FUNCTION private.scrub_employee_history()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_TABLE_NAME IN ('payroll_change_log','schedule_change_log') THEN
    NEW.before_record:=private.remove_retired_employee_json(NEW.before_record);
    NEW.after_record:=private.remove_retired_employee_json(NEW.after_record);
  ELSIF TG_TABLE_NAME='monthly_report_closings' THEN
    NEW.snapshot:=private.remove_retired_employee_json(NEW.snapshot);
  ELSIF TG_TABLE_NAME='monthly_net_payroll' THEN
    NEW.adjustment_snapshot:=private.remove_retired_employee_json(NEW.adjustment_snapshot);
  ELSIF TG_TABLE_NAME='profile_prior_values' THEN
    IF NEW.field IN ('resident_number','bank_account','bank_name','account_holder','custom_fields') THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.scrub_employee_history() FROM PUBLIC;
CREATE TRIGGER scrub_employee_history BEFORE INSERT OR UPDATE ON public.payroll_change_log
FOR EACH ROW EXECUTE FUNCTION private.scrub_employee_history();
CREATE TRIGGER scrub_employee_history BEFORE INSERT OR UPDATE ON public.schedule_change_log
FOR EACH ROW EXECUTE FUNCTION private.scrub_employee_history();
CREATE TRIGGER scrub_employee_history BEFORE INSERT OR UPDATE ON public.monthly_report_closings
FOR EACH ROW EXECUTE FUNCTION private.scrub_employee_history();
CREATE TRIGGER scrub_employee_history BEFORE INSERT OR UPDATE ON public.monthly_net_payroll
FOR EACH ROW EXECUTE FUNCTION private.scrub_employee_history();
CREATE TRIGGER scrub_employee_history BEFORE INSERT OR UPDATE ON private.profile_prior_values
FOR EACH ROW EXECUTE FUNCTION private.scrub_employee_history();

UPDATE public.crew SET resident_number=NULL,bank_account=NULL,custom_fields='[]'::jsonb
WHERE resident_number IS NOT NULL OR bank_account IS NOT NULL OR custom_fields<>'[]'::jsonb;
UPDATE private.staff_registration_profiles SET bank_name=NULL,bank_account=NULL,account_holder=NULL
WHERE bank_name IS NOT NULL OR bank_account IS NOT NULL OR account_holder IS NOT NULL;
UPDATE private.staff_self_profiles SET bank_name=NULL,bank_account=NULL,account_holder=NULL,revision=revision+1,updated_at=now()
WHERE bank_name IS NOT NULL OR bank_account IS NOT NULL OR account_holder IS NOT NULL;
DELETE FROM private.profile_prior_values WHERE field IN ('resident_number','bank_account','bank_name','account_holder','custom_fields');
DELETE FROM private.profile_adoption WHERE field='bank_account';
UPDATE private.profile_change_events SET fields=array_remove(fields,'bank_account') WHERE 'bank_account'=ANY(fields);
DELETE FROM private.profile_change_events WHERE cardinality(fields)=0;
UPDATE public.payroll_change_log SET before_record=private.remove_retired_employee_json(before_record),after_record=private.remove_retired_employee_json(after_record)
WHERE before_record IS DISTINCT FROM private.remove_retired_employee_json(before_record) OR after_record IS DISTINCT FROM private.remove_retired_employee_json(after_record);
UPDATE public.schedule_change_log SET before_record=private.remove_retired_employee_json(before_record),after_record=private.remove_retired_employee_json(after_record)
WHERE before_record IS DISTINCT FROM private.remove_retired_employee_json(before_record) OR after_record IS DISTINCT FROM private.remove_retired_employee_json(after_record);
UPDATE public.monthly_report_closings SET snapshot=private.remove_retired_employee_json(snapshot)
WHERE snapshot IS DISTINCT FROM private.remove_retired_employee_json(snapshot);
UPDATE public.monthly_net_payroll SET adjustment_snapshot=private.remove_retired_employee_json(adjustment_snapshot)
WHERE adjustment_snapshot IS DISTINCT FROM private.remove_retired_employee_json(adjustment_snapshot);

ALTER TABLE public.crew ADD CONSTRAINT retired_employee_fields_empty CHECK (resident_number IS NULL AND bank_account IS NULL AND custom_fields='[]'::jsonb);
ALTER TABLE private.staff_registration_profiles ADD CONSTRAINT retired_bank_fields_empty CHECK (bank_name IS NULL AND bank_account IS NULL AND account_holder IS NULL);
ALTER TABLE private.staff_self_profiles ADD CONSTRAINT retired_bank_fields_empty CHECK (bank_name IS NULL AND bank_account IS NULL AND account_holder IS NULL);
