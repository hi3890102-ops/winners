-- Shared daily schedules: active members edit only their own store.
-- Payroll/attendance confirmation and recurring-pattern permissions stay separate.
create policy shifts_shared_member_write on public.shifts for all to authenticated
  using (private.has_store_membership(store_id,null) and private.is_live_manee_session())
  with check (private.has_store_membership(store_id,null) and private.is_live_manee_session()
    and private.crew_belongs_to_store(crew_id,store_id));

create policy shifts_live_session_required on public.shifts as restrictive for all to authenticated
  using (private.is_live_manee_session()) with check (private.is_live_manee_session());

create table public.schedule_change_log (
  id bigint generated always as identity primary key,
  store_id uuid not null,
  shift_id uuid not null,
  actor_user_id uuid,
  action text not null check(action in ('INSERT','UPDATE','DELETE')),
  before_record jsonb,
  after_record jsonb,
  changed_at timestamptz not null default clock_timestamp()
);
create index schedule_change_log_store_time on public.schedule_change_log(store_id,changed_at desc);
alter table public.schedule_change_log enable row level security;
revoke all on public.schedule_change_log from public,anon,authenticated;
grant select on public.schedule_change_log to authenticated;
create policy schedule_log_manager_read on public.schedule_change_log for select to authenticated
  using(private.can_manage_store(store_id) and private.is_live_manee_session());

create function private.record_schedule_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.schedule_change_log(store_id,shift_id,actor_user_id,action,before_record,after_record)
  values(case when tg_op='DELETE' then old.store_id else new.store_id end,
    case when tg_op='DELETE' then old.id else new.id end,auth.uid(),tg_op,
    case when tg_op='INSERT' then null else to_jsonb(old) end,
    case when tg_op='DELETE' then null else to_jsonb(new) end);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.record_schedule_change() from public,anon,authenticated;
create trigger manee_schedule_change_log after insert or update or delete on public.shifts
  for each row execute function private.record_schedule_change();
