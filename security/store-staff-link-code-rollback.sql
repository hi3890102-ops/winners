-- Emergency rollback to the previous employee-code portal; pair with its matching UI.
-- This is NOT a rollback to production main and must not restore consumed employee codes.
-- Store codes/history remain allocated. Memberships and all business records are preserved.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
update private.staff_link_requests set status='expired',reviewed_at=now()
where status='pending' and crew_id is null;
create or replace function private.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin return private.manee_staff_portal_v1(p_action,p_payload); end;
$$;
revoke all on function private.manee_staff_portal_v1(text,jsonb) from public,anon,authenticated;
revoke all on function private.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function private.manee_staff_portal(text,jsonb) to authenticated;
create or replace function public.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.manee_staff_portal(p_action,p_payload); $$;
revoke all on function public.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function public.manee_staff_portal(text,jsonb) to authenticated;
-- Reapply store-staff-link-code.sql to roll forward. Retired store codes remain retired.
commit;
