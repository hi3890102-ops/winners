create table public.store_business_calendar(
 store_id uuid primary key references public.stores(id),
 closed_weekdays integer[] not null default '{}',
 closed_dates date[] not null default '{}',
 open_dates date[] not null default '{}',
 updated_at timestamptz not null default clock_timestamp(),
 check(closed_weekdays <@ array[0,1,2,3,4,5,6]),
 check(cardinality(closed_dates)<=366 and cardinality(open_dates)<=366)
);
alter table public.store_business_calendar enable row level security;
revoke all on public.store_business_calendar from public,anon,authenticated;
grant select,insert,update,delete on public.store_business_calendar to authenticated;
create policy calendar_read on public.store_business_calendar for select to authenticated
 using(private.is_live_manee_session() and private.can_view_store(store_id));
create policy calendar_manager on public.store_business_calendar for all to authenticated
 using(private.is_live_manee_session() and private.can_manage_store(store_id))
 with check(private.is_live_manee_session() and private.can_manage_store(store_id));

create policy hq_notices_store_audience on public.hq_announcements for select to authenticated
 using(private.is_live_manee_session() and (
 (target_type='store' and private.has_store_membership(target_id,null)) or
 (target_type='franchise' and exists(select 1 from public.stores s where s.franchise_id=target_id and private.has_store_membership(s.id,null)))
 ));
