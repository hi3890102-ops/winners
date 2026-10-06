-- Synthetic users/stores only. Roll back all fixtures and session claims.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select set_config('manee_test.owner',gen_random_uuid()::text,true),
       set_config('manee_test.other_owner',gen_random_uuid()::text,true),
       set_config('manee_test.store',gen_random_uuid()::text,true),
       set_config('manee_test.second_store',gen_random_uuid()::text,true);
insert into auth.users(id) values(current_setting('manee_test.owner')::uuid),(current_setting('manee_test.other_owner')::uuid);
insert into auth.sessions(id,user_id) values(current_setting('manee_test.owner')::uuid,current_setting('manee_test.owner')::uuid),(current_setting('manee_test.other_owner')::uuid,current_setting('manee_test.other_owner')::uuid);
insert into public.profiles(user_id,username,display_name,status)
select id,'qa_'||left(replace(id::text,'-',''),20),'Synthetic home notice QA','active'
from auth.users where id in (current_setting('manee_test.owner')::uuid,current_setting('manee_test.other_owner')::uuid);
insert into public.stores(id,name) values(current_setting('manee_test.store')::uuid,'Synthetic home notice QA'),(current_setting('manee_test.second_store')::uuid,'Synthetic second-store notice QA');
insert into public.store_memberships(user_id,store_id,role,status)
values(current_setting('manee_test.owner')::uuid,current_setting('manee_test.store')::uuid,'owner','active'),
      (current_setting('manee_test.other_owner')::uuid,current_setting('manee_test.store')::uuid,'owner','active'),
      (current_setting('manee_test.owner')::uuid,current_setting('manee_test.second_store')::uuid,'owner','active');
insert into public.owner_report_home_notices(user_id,store_id,month_key)
values(current_setting('manee_test.owner')::uuid,current_setting('manee_test.store')::uuid,'2026-09'),
      (current_setting('manee_test.owner')::uuid,current_setting('manee_test.second_store')::uuid,'2026-09');
select set_config('request.jwt.claim.sub',current_setting('manee_test.owner'),true),
       set_config('request.jwt.claim.role','authenticated',true),
       set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('manee_test.owner'),'session_id',current_setting('manee_test.owner'),'role','authenticated')::text,true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.owner_report_home_notices)<>2 then raise exception 'Target owner multi-store notices missing';end if;
  begin
    delete from public.owner_report_home_notices;
    raise exception 'Client notice deletion allowed';
  exception when insufficient_privilege then null;end;
end $$;
reset role;
select set_config('request.jwt.claim.sub',current_setting('manee_test.other_owner'),true),
       set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('manee_test.other_owner'),'session_id',current_setting('manee_test.other_owner'),'role','authenticated')::text,true);
set local role authenticated;
do $$ begin if exists(select 1 from public.owner_report_home_notices) then raise exception 'Notice exposed to another owner';end if;end $$;
reset role;
insert into public.monthly_cost_reviews(store_id,month_key,completed_at)
values(current_setting('manee_test.store')::uuid,'2026-09',now());
select set_config('request.jwt.claim.sub',current_setting('manee_test.owner'),true),
       set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('manee_test.owner'),'session_id',current_setting('manee_test.owner'),'role','authenticated')::text,true);
set local role authenticated;
do $$ begin
  if (select count(*) from public.owner_report_home_notices)<>1 then raise exception 'Completion affected another store';end if;
  if not exists(select 1 from public.owner_report_home_notices where store_id=current_setting('manee_test.second_store')::uuid) then raise exception 'Wrong store notice hidden';end if;
end $$;
reset role;
update public.monthly_cost_reviews set completed_at=null where store_id=current_setting('manee_test.store')::uuid;
update auth.sessions set not_after=now()-interval '1 minute' where user_id=current_setting('manee_test.owner')::uuid;
set local role authenticated;
do $$ begin if exists(select 1 from public.owner_report_home_notices) then raise exception 'Expired session could read notice';end if;end $$;
reset role;
rollback;
select 'PASS: exact owner, multiple stores, per-store completion, client-write denial, expired session; all fixtures rolled back' as verification;
