-- Emergency rollback for store-level employee connection codes.
-- Keeps generated store codes and business data. Pending store-only requests are expired.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

update private.staff_link_requests
set status='expired',reviewed_at=now()
where status='pending' and crew_id is null;

drop function if exists private.manee_staff_portal(text,jsonb);
do $restore$
begin
  if to_regprocedure('private.manee_staff_portal_v1(text,jsonb)') is not null then
    alter function private.manee_staff_portal_v1(text,jsonb) rename to manee_staff_portal;
  end if;
end
$restore$;

create or replace function public.manee_staff_portal(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.manee_staff_portal(p_action,p_payload);
$$;
revoke all on function public.manee_staff_portal(text,jsonb) from public,anon;
grant execute on function public.manee_staff_portal(text,jsonb) to authenticated;

commit;
