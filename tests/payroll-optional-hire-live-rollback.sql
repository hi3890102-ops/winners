-- Synthetic fixture only. All inserts and updates are rolled back.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select set_config('manee_test.store',gen_random_uuid()::text,true),
 set_config('manee_test.crew',gen_random_uuid()::text,true);
insert into public.stores(id,name) values(current_setting('manee_test.store')::uuid,'Synthetic optional hire QA');
insert into public.crew(id,store_id,name,wage,wage_type,is_manager,hire_date,insurance4,insurance2,tax33,probation)
 values(current_setting('manee_test.crew')::uuid,current_setting('manee_test.store')::uuid,'Synthetic monthly employee',3100000,'monthly',false,null,false,false,false,false);
do $$ declare r jsonb; s uuid:=current_setting('manee_test.store')::uuid; begin
 r:=private.net_payroll_totals(s,'2026-09','2026-10-03');
 if (r->>'net_pay')::bigint<>3100000 or (r->>'unknown_count')::integer<>0 or (r->>'estimated_count')::integer<>1 then raise exception 'Past month estimate failed: %',r;end if;
 if (private.net_payroll_totals(s,'2026-10','2026-10-03')->>'net_pay')::bigint<>300000 then raise exception 'Current month cap failed';end if;
 if (private.net_payroll_totals(s,'2026-11','2026-10-03')->>'net_pay')::bigint<>0 then raise exception 'Future month cap failed';end if;
 if exists(select 1 from public.crew where id=current_setting('manee_test.crew')::uuid and hire_date is not null) then raise exception 'Hire date changed';end if;
 if has_function_privilege('anon','private.net_payroll_totals(uuid,text,date)','execute') or has_function_privilege('authenticated','private.net_payroll_totals(uuid,text,date)','execute') then raise exception 'Internal payroll helper exposed';end if;
end $$;
update public.crew set resign_date='2026-09-10' where id=current_setting('manee_test.crew')::uuid;
do $$ declare s uuid:=current_setting('manee_test.store')::uuid;begin
 if (private.net_payroll_totals(s,'2026-09','2026-10-03')->>'net_pay')::bigint<>1033333 then raise exception 'Resignation cap failed';end if;
 if (private.net_payroll_totals(s,'2026-10','2026-10-03')->>'net_pay')::bigint<>0 then raise exception 'After resignation cap failed';end if;
end $$;
update public.crew set hire_date='2026-09-20',resign_date='2026-09-23' where id=current_setting('manee_test.crew')::uuid;
do $$ begin
 if (private.net_payroll_totals(current_setting('manee_test.store')::uuid,'2026-09','2026-10-03')->>'net_pay')::bigint<>413333 then raise exception 'Known dates proration failed';end if;
end $$;
update public.crew set hire_date=null where id=current_setting('manee_test.crew')::uuid;
insert into public.monthly_net_payroll(store_id,crew_id,month_key,net_pay) values(current_setting('manee_test.store')::uuid,current_setting('manee_test.crew')::uuid,'2026-09',450000);
do $$ declare r jsonb;begin
 r:=private.net_payroll_totals(current_setting('manee_test.store')::uuid,'2026-09','2026-10-03');
 if (r->>'net_pay')::bigint<>450000 or (r->>'confirmed_count')::integer<>1 or (r->>'estimated_count')::integer<>0 then raise exception 'Actual pay override failed: %',r;end if;
end $$;
rollback;
