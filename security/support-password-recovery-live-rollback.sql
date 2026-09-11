-- STAGING ONLY. Synthetic SQL-role integration test; all rows roll back.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $validation$
declare
  owner_id uuid:=gen_random_uuid(); worker_id uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid();
  v_store_id uuid; crew_id uuid:=gen_random_uuid(); attendance_id uuid:=gen_random_uuid(); request_id uuid;
  suffix text:=substr(replace(gen_random_uuid()::text,'-',''),1,12); code text; result jsonb; op jsonb; blocked boolean;
begin
  insert into auth.users(id) values(owner_id),(worker_id),(other_id);
  insert into auth.sessions(id,user_id,created_at,updated_at) values(owner_id,owner_id,now(),now()),(worker_id,worker_id,now(),now()),(other_id,other_id,now(),now());
  v_store_id:=public.bootstrap_owner_account(owner_id,'supportowner_'||suffix,'Synthetic owner','Support store '||suffix);
  perform public.bootstrap_staff_account(worker_id,'supportstaff_'||suffix,'Synthetic worker');
  perform public.bootstrap_staff_account(other_id,'supportother_'||suffix,'Synthetic other');
  loop code:=lpad(floor(random()*1000000)::int::text,6,'0');exit when not exists(select 1 from public.crew where join_code=code);end loop;
  insert into public.crew(id,store_id,name,join_code,wage) values(crew_id,v_store_id,'Synthetic worker',code,15000);
  insert into public.attendance(id,store_id,crew_id,date,check_in,check_out) values(attendance_id,v_store_id,crew_id,'2026-01-15','10:00','18:00');
  perform set_config('request.jwt.claim.sub',worker_id::text,true);perform set_config('request.jwt.claims',jsonb_build_object('session_id',worker_id)::text,true);execute 'set local role authenticated';
  result:=public.manee_staff_portal('request',jsonb_build_object('code',code));execute 'reset role';
  perform set_config('request.jwt.claim.sub',owner_id::text,true);perform set_config('request.jwt.claims',jsonb_build_object('session_id',owner_id)::text,true);execute 'set local role authenticated';
  perform public.manee_staff_portal('approve',jsonb_build_object('request_id',result->>'request_id'));execute 'reset role';
  execute 'set local role service_role';
  assert (public.manee_support_recovery_service('request',jsonb_build_object('username','supportstaff_'||suffix,'affiliation','Support store '||suffix))->>'ok')::boolean,'request failed';
  execute 'reset role';select id into request_id from private.password_reset_requests where target_user_id=worker_id and status='pending';assert request_id is not null,'request not stored';
  perform set_config('request.jwt.claim.sub',other_id::text,true);perform set_config('request.jwt.claims',jsonb_build_object('session_id',other_id)::text,true);execute 'set local role authenticated';
  blocked:=false;begin perform public.manee_recovery_portal();exception when insufficient_privilege then blocked:=true;end;
  assert not blocked and jsonb_array_length(public.manee_recovery_portal()->'requests')=0,'unrelated account saw request';execute 'reset role';
  execute 'set local role service_role';
  result:=public.manee_support_recovery_service('issue',jsonb_build_object('actor_user_id',other_id,'session_id',other_id,'request_id',request_id,'code_hash',repeat('a',64)));
  assert result->>'error'='permission_denied','unrelated account issued code';
  result:=public.manee_support_recovery_service('issue',jsonb_build_object('actor_user_id',owner_id,'session_id',owner_id,'request_id',request_id,'code_hash',repeat('a',64)));
  assert (result->>'ok')::boolean,'owner code issue failed';
  assert public.manee_support_recovery_service('consume',jsonb_build_object('username','supportstaff_'||suffix,'code_hash',repeat('b',64)))->>'error'='invalid_recovery','wrong code accepted';
  op:=public.manee_support_recovery_service('consume',jsonb_build_object('username','supportstaff_'||suffix,'code_hash',repeat('a',64)));
  assert (op->>'user_id')::uuid=worker_id,'code selected another identity';
  assert public.manee_support_recovery_service('consume',jsonb_build_object('username','supportstaff_'||suffix,'code_hash',repeat('a',64)))->>'error'='invalid_recovery','code replay succeeded';
  assert (public.manee_support_recovery_service('complete',op)->>'ok')::boolean,'completion failed';execute 'reset role';
  assert (select count(*) from public.store_memberships sm where sm.user_id=worker_id and sm.store_id=v_store_id and sm.status='active')=1,'membership changed';
  assert (select count(*) from public.crew c where c.id=crew_id)=1,'crew changed';
  assert (select count(*) from public.attendance a where a.id=attendance_id)=1,'attendance changed';
end;
$validation$;
select jsonb_build_object('passed',true,'generic_request',true,'cross_store_hidden',true,'unauthorized_issue_blocked',true,'owner_staff_review',true,'one_time_code',true,'wrong_code_blocked',true,'identity_and_history_preserved',true,'test_data_rolled_back',true) validation;
rollback;
