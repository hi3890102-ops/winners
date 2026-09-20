-- READ-ONLY verification for security/new-staff-self-profile.sql. Catalog queries
-- only; no personal data is read and nothing is written. Safe on any project.
-- Edit the phase on the first line of cfg, run, and look for rows where ok = false
-- (problems > 0 means stop):
--   'preflight'   before the patch is applied
--   'applied'     right after security/new-staff-self-profile.sql
--   'rolled_back' right after security/new-staff-self-profile-rollback.sql
-- baseline_md5 is the md5 of pg_get_functiondef(private.manee_staff_portal) that
-- staging and production shared on 2026-09-19. If preflight reports a mismatch,
-- the live function changed since the review: stop and re-review before applying.
--
-- WARNING: re-running an OLDER patch (store-staff-new-employee-approval.sql,
-- store-staff-link-code.sql, staff-auth*.sql ...) after the wrapper exists can
-- replace private.manee_staff_portal with the old body. The wrapper then silently
-- disappears (phase 'applied' fails on "portal is the self-profile wrapper"). Do
-- not just re-run the new patch afterwards: it would keep delegating to a stale
-- *_before_self_profile copy. Compare that copy with the baseline, then use the
-- rollback file and re-apply in order.
with cfg as (
  select 'preflight'::text as phase,
         '11ee9e05c5ea48a4f7db7df219cba9d0'::text as baseline_md5
), f as (
  select to_regprocedure('private.manee_staff_portal(text,jsonb)') portal,
         to_regprocedure('private.manee_staff_portal_before_self_profile(text,jsonb)') before_fn,
         to_regprocedure('private.manee_staff_portal_self_profile_disabled(text,jsonb)') disabled_fn,
         to_regprocedure('private.manee_staff_portal_store_v2(text,jsonb)') v2,
         to_regprocedure('public.manee_staff_portal(text,jsonb)') pub,
         to_regprocedure('private.bootstrap_staff_account(uuid,text,text)') boot_old,
         to_regprocedure('public.bootstrap_staff_account(uuid,text,text)') boot_old_pub,
         to_regprocedure('private.bootstrap_staff_account_with_profile(uuid,text,text,jsonb)') boot_priv,
         to_regprocedure('public.bootstrap_staff_account_with_profile(uuid,text,text,jsonb)') boot_pub,
         to_regclass('private.staff_registration_profiles') prof
), checks(seq,name,exp_pre,exp_app,exp_rb,actual) as (
  select 1,'base layer private.manee_staff_portal_store_v2 exists','true','true','true',(v2 is not null)::text from f
  union all select 2,'original portal body identical to baseline (byte-for-byte)','true','true','true',
    coalesce((md5(case when cfg.phase='applied'
      then replace(pg_get_functiondef(f.before_fn),'manee_staff_portal_before_self_profile','manee_staff_portal')
      else pg_get_functiondef(f.portal) end)=cfg.baseline_md5)::text,'false') from f,cfg
  union all select 3,'private.manee_staff_portal is the self-profile wrapper','false','true','false',
    coalesce((position('staff_registration_profiles' in pg_get_functiondef(portal))>0)::text,'false') from f
  union all select 4,'*_before_self_profile (original) exists','false','true','false',(before_fn is not null)::text from f
  -- After rollback -> re-apply the superseded copy may remain (uncallable); not a problem.
  union all select 5,'*_self_profile_disabled (kept wrapper) exists','false','n/a','true',(disabled_fn is not null)::text from f
  union all select 6,'private portal: authenticated can execute, anon cannot','true','true','true',
    coalesce((has_function_privilege('authenticated',portal,'EXECUTE') and not has_function_privilege('anon',portal,'EXECUTE'))::text,'false') from f
  union all select 7,'*_before_self_profile not callable by clients','n/a','true','n/a',
    case when before_fn is null then 'n/a' else (not has_function_privilege('anon',before_fn,'EXECUTE') and not has_function_privilege('authenticated',before_fn,'EXECUTE'))::text end from f
  union all select 8,'*_disabled not callable by clients','n/a','n/a','true',
    case when disabled_fn is null then 'n/a' else (not has_function_privilege('anon',disabled_fn,'EXECUTE') and not has_function_privilege('authenticated',disabled_fn,'EXECUTE'))::text end from f
  union all select 9,'public portal: authenticated can execute, anon cannot','true','true','true',
    coalesce((has_function_privilege('authenticated',pub,'EXECUTE') and not has_function_privilege('anon',pub,'EXECUTE'))::text,'false') from f
  union all select 10,'private portal is security definer with empty search_path','true','true','true',
    coalesce((select (p.prosecdef and p.proconfig @> array['search_path=""'])::text from pg_proc p where p.oid=f.portal),'false') from f
  union all select 11,'private.staff_registration_profiles exists (never dropped)','false','true','true',(prof is not null)::text from f
  union all select 12,'profiles table: RLS on, zero policies','n/a','true','true',
    case when prof is null then 'n/a' else (select (c.relrowsecurity and not exists(select 1 from pg_policy where polrelid=c.oid))::text from pg_class c where c.oid=f.prof) end from f
  union all select 13,'profiles table: no anon/authenticated privileges','n/a','true','true',
    case when prof is null then 'n/a' else (not has_table_privilege('anon',prof,'SELECT,INSERT,UPDATE,DELETE') and not has_table_privilege('authenticated',prof,'SELECT,INSERT,UPDATE,DELETE'))::text end from f
  union all select 14,'crew.self_service_profile and employment_setup_required exist (default false)','false','true','true',
    ((select count(*) from information_schema.columns where table_schema='public' and table_name='crew'
       and column_name in ('self_service_profile','employment_setup_required') and column_default='false')=2)::text
  union all select 15,'bootstrap_staff_account_with_profile (private+public) exists','false','true','true',(boot_priv is not null and boot_pub is not null)::text from f
  union all select 16,'public bootstrap_with_profile: service_role only','n/a','true','true',
    case when boot_pub is null then 'n/a' else (has_function_privilege('service_role',boot_pub,'EXECUTE') and not has_function_privilege('anon',boot_pub,'EXECUTE') and not has_function_privilege('authenticated',boot_pub,'EXECUTE'))::text end from f
  union all select 17,'legacy bootstrap_staff_account still service_role only','true','true','true',
    coalesce((has_function_privilege('service_role',boot_old_pub,'EXECUTE') and not has_function_privilege('anon',boot_old_pub,'EXECUTE') and not has_function_privilege('authenticated',boot_old_pub,'EXECUTE'))::text,'false') from f
)
-- expected 'n/a' means "not evaluated in this phase" (always ok).
select x.seq,x."check",x.expected,x.actual,
       coalesce(x.expected='n/a' or x.actual=x.expected,false) as ok,
       count(*) filter (where not coalesce(x.expected='n/a' or x.actual=x.expected,false)) over () as problems
from (
  select c.seq,c.name as "check",c.actual,
         case cfg.phase when 'preflight' then c.exp_pre when 'applied' then c.exp_app when 'rolled_back' then c.exp_rb end as expected
  from checks c cross join cfg
) x
order by x.seq;
