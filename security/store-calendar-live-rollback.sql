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
  values(current_setting('manee_test.worker')::uuid,'qa_'||left(replace(current_setting('manee_test.worker'),'-',''),20),'Synthetic payroll QA','active');
insert into public.stores(id,name) values(current_setting('manee_test.store')::uuid,'Synthetic payroll QA'),(current_setting('manee_test.other_store')::uuid,'Synthetic other-store QA');
insert into public.crew(id,store_id,name,wage,wage_type,is_manager) values
  (current_setting('manee_test.crew')::uuid,current_setting('manee_test.store')::uuid,'Synthetic employee',10000,'hourly',false),
  (current_setting('manee_test.colleague')::uuid,current_setting('manee_test.store')::uuid,'Synthetic colleague',10000,'hourly',false);
insert into public.store_memberships(user_id,store_id,crew_id,role,status)
  values(current_setting('manee_test.worker')::uuid,current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'owner','active');
select set_config('request.jwt.claim.sub',current_setting('manee_test.worker'),true),set_config('request.jwt.claim.role','authenticated',true),
  set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('manee_test.worker'),'session_id',current_setting('manee_test.worker'),'role','authenticated')::text,true);
insert into public.hq_announcements(title,target_type,target_id) values('Synthetic target notice','store',current_setting('manee_test.store')::uuid),('Synthetic other notice','store',current_setting('manee_test.other_store')::uuid);
set local role authenticated;
insert into public.store_business_calendar(store_id,closed_weekdays,closed_dates,open_dates) values(current_setting('manee_test.store')::uuid,array[0],array['2026-10-02'::date],array['2026-10-04'::date]);
do $$ begin
if not exists(select 1 from public.hq_announcements where title='Synthetic target notice') then raise exception 'Target notice missing';end if;
if exists(select 1 from public.hq_announcements where title='Synthetic other notice') then raise exception 'Foreign notice exposed';end if;
end $$;
insert into public.monthly_net_payroll(store_id,crew_id,month_key,net_pay) values(current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-10',2000000);
insert into public.crew_pay_adjustments(store_id,crew_id,month_key,type,amount,unpaid_date) values(current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-10','무급휴가',-999999,'2026-10-01');
do $$ begin
if (select amount from public.crew_pay_adjustments where store_id=current_setting('manee_test.store')::uuid)<>0 then raise exception 'Hourly double deduction';end if;
begin
insert into public.crew_pay_adjustments(store_id,crew_id,month_key,type,amount) values(current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-10','가불',1000);
raise exception 'Positive advance allowed';exception when invalid_parameter_value then null;end;
end $$;
update public.monthly_net_payroll set net_pay=2000001 where store_id=current_setting('manee_test.store')::uuid;
reset role;
update public.store_memberships set role='staff' where user_id=current_setting('manee_test.worker')::uuid;
set local role authenticated;
do $$ declare n integer;begin
if not exists(select 1 from public.store_business_calendar where store_id=current_setting('manee_test.store')::uuid) then raise exception 'Member calendar unreadable';end if;
update public.store_business_calendar set closed_weekdays='{}';get diagnostics n=row_count;if n<>0 then raise exception 'Staff changed calendar';end if;
if (select count(*) from public.monthly_net_payroll)<>1 then raise exception 'Own net payroll unreadable';end if;
update public.monthly_net_payroll set net_pay=1;get diagnostics n=row_count;if n<>0 then raise exception 'Staff wrote payroll';end if;
if exists(select 1 from public.payroll_change_log) then raise exception 'Staff saw audit';end if;
end $$;
reset role;
delete from auth.sessions where user_id=current_setting('manee_test.worker')::uuid;
set local role authenticated;
do $$ begin if exists(select 1 from public.monthly_net_payroll) then raise exception 'Expired session read payroll';end if;end $$;
reset role;
rollback;
