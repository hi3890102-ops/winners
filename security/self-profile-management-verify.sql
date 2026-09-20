-- READ-ONLY check of security/self-profile-management.sql (catalog only). problems must be 0 after applying.
with checks(name,ok) as (
  select 'self profile table exists, RLS on, no client privileges', (to_regclass('private.staff_self_profiles') is not null
     and (select relrowsecurity from pg_class where oid='private.staff_self_profiles'::regclass)
     and not has_table_privilege('authenticated','private.staff_self_profiles','SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('anon','private.staff_self_profiles','SELECT'))
  union all select 'change events table exists, RLS on, no client privileges', (to_regclass('private.profile_change_events') is not null
     and (select relrowsecurity from pg_class where oid='private.profile_change_events'::regclass)
     and not has_table_privilege('authenticated','private.profile_change_events','SELECT,INSERT,UPDATE,DELETE'))
  union all select 'prior values table exists, RLS on, no client privileges', (to_regclass('private.profile_prior_values') is not null and (select relrowsecurity from pg_class where oid='private.profile_prior_values'::regclass) and not has_table_privilege('authenticated','private.profile_prior_values','SELECT,INSERT,UPDATE,DELETE'))
  union all select 'guard trigger on crew', exists(select 1 from pg_trigger where tgrelid='public.crew'::regclass and tgname='manee_guard_self_managed_crew' and not tgisinternal)
  union all select 'public RPCs: authenticated yes, anon no', (has_function_privilege('authenticated','public.manee_my_profile_state(boolean)','execute') and has_function_privilege('authenticated','public.manee_save_my_profile(jsonb,integer,jsonb)','execute') and has_function_privilege('authenticated','public.manee_owner_profile_changes(uuid,integer)','execute')
     and not has_function_privilege('anon','public.manee_my_profile_state(boolean)','execute') and not has_function_privilege('anon','public.manee_save_my_profile(jsonb,integer,jsonb)','execute') and not has_function_privilege('anon','public.manee_owner_profile_changes(uuid,integer)','execute'))
  union all select 'sync helper not callable by clients', (not has_function_privilege('authenticated','private.sync_self_profile_to_crew(uuid,uuid,text,text,boolean)','execute') and not has_function_privilege('anon','private.sync_self_profile_to_crew(uuid,uuid,text,text,boolean)','execute'))
  union all select 'portal wrapper adopts the profile on approve', position('sync_self_profile_to_crew' in pg_get_functiondef('private.manee_staff_portal(text,jsonb)'::regprocedure))>0
  union all select 'portal wrapper still executable by authenticated only', (has_function_privilege('authenticated','private.manee_staff_portal(text,jsonb)','execute') and not has_function_privilege('anon','private.manee_staff_portal(text,jsonb)','execute'))
)
select name,ok,count(*) filter (where not ok) over () problems from checks order by name;
