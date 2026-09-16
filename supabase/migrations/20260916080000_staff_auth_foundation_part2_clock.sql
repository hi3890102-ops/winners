-- Production staff Auth foundation — PART 2 (time-sensitive: apply only when
-- `select count(*) from public.attendance where check_out is null` is 0, or as close to it
-- as the business realistically gets — e.g. well after closing, before the next open).
-- This wires the live public.clock_in / public.clock_out functions to the new
-- private.staff_clock implementation created in part 1. Anyone with an open attendance
-- row at the moment this runs is calling clock_out against brand-new logic for the
-- first time, so keep this window as empty as possible before applying.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function public.clock_in(target_store_id uuid,current_lat double precision,current_lng double precision)
returns public.attendance language sql security invoker set search_path='' as $$ select private.staff_clock(target_store_id,null,current_lat,current_lng); $$;
create or replace function public.clock_out(target_attendance_id uuid,current_lat double precision,current_lng double precision)
returns public.attendance language sql security invoker set search_path='' as $$ select private.staff_clock(null,target_attendance_id,current_lat,current_lng); $$;
revoke all on function public.clock_in(uuid,double precision,double precision),public.clock_out(uuid,double precision,double precision) from public,anon;
grant execute on function public.clock_in(uuid,double precision,double precision),public.clock_out(uuid,double precision,double precision) to authenticated;

commit;
