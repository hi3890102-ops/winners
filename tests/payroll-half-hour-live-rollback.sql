-- Synthetic role rehearsal. Never commits fixtures or edits any existing row.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select set_config('manee_test.user',gen_random_uuid()::text,true),
 set_config('manee_test.store',gen_random_uuid()::text,true),
 set_config('manee_test.crew',gen_random_uuid()::text,true);
insert into auth.users(id) values(current_setting('manee_test.user')::uuid);
insert into auth.sessions(id,user_id) values(current_setting('manee_test.user')::uuid,current_setting('manee_test.user')::uuid);
insert into public.profiles(user_id,username,display_name,status) values(current_setting('manee_test.user')::uuid,'qa_'||left(replace(current_setting('manee_test.user'),'-',''),20),'Synthetic half-hour QA','active');
insert into public.stores(id,name) values(current_setting('manee_test.store')::uuid,'Synthetic half-hour QA');
insert into public.crew(id,store_id,name,wage,wage_type,is_manager,hire_date) values(current_setting('manee_test.crew')::uuid,current_setting('manee_test.store')::uuid,'Synthetic half-hour employee',10000,'hourly',false,'2026-01-01');
insert into public.store_memberships(user_id,store_id,crew_id,role,status) values(current_setting('manee_test.user')::uuid,current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'owner','active');
insert into public.attendance(store_id,crew_id,date,check_in,check_out,confirmed) values
 (current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-09-01','09:00:50','09:30:00',true),
 (current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-09-02','09:00','09:29:59',true),
 (current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-09-03','09:00','09:30:00',true),
 (current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-09-04','09:00','09:59:59',true),
 (current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-09-05','23:45','01:14:59',true),
 (current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-09-06','09:00','19:00',false);
do $$ declare r jsonb;begin
 r:=private.net_payroll_totals(current_setting('manee_test.store')::uuid,'2026-09','2026-10-03');
 if (r->>'net_pay')::bigint<>20000 or (r->>'unknown_count')::integer<>0 then raise exception 'Shift flooring failed: %',r;end if;
 if has_function_privilege('anon','private.net_payroll_totals(uuid,text,date)','execute') or has_function_privilege('authenticated','private.net_payroll_totals(uuid,text,date)','execute') then raise exception 'Internal payroll helper exposed';end if;
end $$;
select set_config('request.jwt.claim.sub',current_setting('manee_test.user'),true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('manee_test.user'),'session_id',current_setting('manee_test.user'),'role','authenticated')::text,true);
set local role authenticated;
do $$ declare r jsonb;begin
 r:=public.manee_financial_report(current_setting('manee_test.store')::uuid,'2026-09');
 if (r->>'net_payroll')::bigint<>20000 then raise exception 'Owner report differs';end if;
end $$;
insert into public.monthly_net_payroll(store_id,crew_id,month_key,net_pay) values(current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-09',22222);
do $$ begin
 if (public.manee_financial_report(current_setting('manee_test.store')::uuid,'2026-09')->>'net_payroll')::bigint<>22222 then raise exception 'Actual pay overwritten';end if;
end $$;
reset role;
update public.store_memberships set role='staff' where user_id=current_setting('manee_test.user')::uuid;
set local role authenticated;
do $$ begin
 begin perform public.manee_financial_report(current_setting('manee_test.store')::uuid,'2026-09');raise exception 'Staff accessed store financial report';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
