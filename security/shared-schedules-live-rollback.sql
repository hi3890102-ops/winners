-- Synthetic role rehearsal. All fixtures, schedules and logs roll back.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select set_config('manee_test.worker',gen_random_uuid()::text,true),
  set_config('manee_test.store',gen_random_uuid()::text,true),
  set_config('manee_test.other_store',gen_random_uuid()::text,true),
  set_config('manee_test.crew',gen_random_uuid()::text,true),
  set_config('manee_test.colleague',gen_random_uuid()::text,true);
insert into auth.users(id) values(current_setting('manee_test.worker')::uuid);
insert into auth.sessions(id,user_id) values(current_setting('manee_test.worker')::uuid,current_setting('manee_test.worker')::uuid);
insert into public.profiles(user_id,username,display_name,status)
  values(current_setting('manee_test.worker')::uuid,'qa_'||left(replace(current_setting('manee_test.worker'),'-',''),20),'Synthetic schedule QA','active');
insert into public.stores(id,name) values(current_setting('manee_test.store')::uuid,'Synthetic schedule QA'),(current_setting('manee_test.other_store')::uuid,'Synthetic other-store QA');
insert into public.crew(id,store_id,name,wage,wage_type,is_manager) values
  (current_setting('manee_test.crew')::uuid,current_setting('manee_test.store')::uuid,'Synthetic employee',10000,'hourly',false),
  (current_setting('manee_test.colleague')::uuid,current_setting('manee_test.store')::uuid,'Synthetic colleague',10000,'hourly',false);
insert into public.store_memberships(user_id,store_id,crew_id,role,status)
  values(current_setting('manee_test.worker')::uuid,current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'staff','active');
select set_config('request.jwt.claim.sub',current_setting('manee_test.worker'),true),set_config('request.jwt.claim.role','authenticated',true),
  set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('manee_test.worker'),'session_id',current_setting('manee_test.worker'),'role','authenticated')::text,true);
set local role authenticated;
do $$
declare sid uuid; affected integer;
begin
  -- An ordinary employee may edit a colleague's schedule within the same store.
  insert into public.shifts(store_id,crew_id,date,start_time,end_time)
    values(current_setting('manee_test.store')::uuid,current_setting('manee_test.colleague')::uuid,'2026-10-01','10:00','18:00') returning id into sid;
  update public.shifts set end_time='19:00' where id=sid;
  get diagnostics affected=row_count;
  if affected<>1 then raise exception 'Own-store schedule update failed'; end if;
  if exists(select 1 from public.schedule_change_log where shift_id=sid) then raise exception 'Staff must not read manager audit history'; end if;
  begin
    insert into public.shifts(store_id,crew_id,date,start_time,end_time)
      values(current_setting('manee_test.other_store')::uuid,current_setting('manee_test.crew')::uuid,'2026-10-01','10:00','18:00');
    raise exception 'Foreign-store schedule insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.schedule_change_log(store_id,shift_id,action)
      values(current_setting('manee_test.store')::uuid,sid,'DELETE');
    raise exception 'Audit log tampering unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
do $$
begin
  if (select count(*) from public.schedule_change_log where store_id=current_setting('manee_test.store')::uuid)<>2 then
    raise exception 'Expected exactly INSERT and UPDATE audit rows';
  end if;
end;
$$;
delete from auth.sessions where user_id=current_setting('manee_test.worker')::uuid;
set local role authenticated;
do $$
begin
  begin
    insert into public.shifts(store_id,crew_id,date,start_time,end_time)
      values(current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-10-02','10:00','18:00');
    raise exception 'Expired session write unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
rollback;
