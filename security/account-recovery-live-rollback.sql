-- STAGING ONLY. Synthetic SQL-role integration test; NOT an Auth HTTP/JWT test.
-- All test identities, requests, stores, events and attendance are rolled back.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $validation$
declare
  owner_id uuid:=gen_random_uuid(); worker_id uuid:=gen_random_uuid(); other_id uuid:=gen_random_uuid();
  sid uuid; cid uuid:=gen_random_uuid(); original_att uuid:=gen_random_uuid(); rid uuid; second_rid uuid; mid uuid;
  suffix text:=substr(replace(gen_random_uuid()::text,'-',''),1,12);
  code text; result jsonb; blocked boolean; clocked public.attendance%rowtype; op jsonb; fresh_session uuid:=gen_random_uuid();
begin
  insert into auth.users(id) values(owner_id),(worker_id),(other_id);
  insert into auth.sessions(id,user_id,created_at,updated_at) values(owner_id,owner_id,now(),now()),(worker_id,worker_id,now(),now()),(other_id,other_id,now(),now());
  sid:=public.bootstrap_owner_account(owner_id,'testowner_'||suffix,'Synthetic validation owner','Validation store '||suffix);
  perform public.bootstrap_staff_account(worker_id,'teststaff_'||suffix,'Synthetic validation worker');
  perform public.bootstrap_staff_account(other_id,'testother_'||suffix,'Synthetic competing worker');
  loop
    code:=lpad(floor(random()*1000000)::int::text,6,'0');
    exit when not exists(select 1 from public.crew where join_code=code);
  end loop;
  insert into public.crew(id,store_id,name,join_code,wage,is_manager) values(cid,sid,'Synthetic existing employee',code,15000,true);
  insert into public.attendance(id,store_id,crew_id,date,check_in,check_out) values(original_att,sid,cid,'2026-01-15','10:00','18:00');

  perform set_config('request.jwt.claim.sub',worker_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('session_id',worker_id)::text,true);
  execute 'set local role authenticated';
  result:=public.manee_staff_portal('request',jsonb_build_object('code',code,'user_id',owner_id,'role','owner'));
  assert (result->>'ok')::boolean,'request failed';
  rid:=(result->>'request_id')::uuid;
  assert jsonb_array_length(public.manee_staff_portal('session')->'memberships')=0,'pending request granted access';
  assert not result ? 'crew','code leaked employee data';
  blocked:=false;
  begin perform public.manee_staff_portal('approve',jsonb_build_object('request_id',rid));
  exception when insufficient_privilege then blocked:=true; end;
  assert blocked,'staff self-approval was allowed';
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',other_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('session_id',other_id)::text,true);
  execute 'set local role authenticated';
  second_rid:=(public.manee_staff_portal('request',jsonb_build_object('code',code))->>'request_id')::uuid;
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('session_id',owner_id)::text,true);
  execute 'set local role authenticated';
  result:=public.manee_staff_portal('approve',jsonb_build_object('request_id',rid));
  assert (result->>'ok')::boolean,'owner approval failed';
  mid:=(result->>'membership_id')::uuid;
  assert public.manee_staff_portal('approve',jsonb_build_object('request_id',second_rid))->>'error'='record_already_linked','duplicate ownership allowed';
  execute 'reset role';

  perform set_config('request.jwt.claim.sub',worker_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('session_id',worker_id)::text,true);
  execute 'set local role authenticated';
  result:=public.manee_staff_portal('crew',jsonb_build_object('store_id',sid));
  assert (result->'crew'->>'id')::uuid=cid,'crew identity changed';
  assert not (result->'crew'->>'is_manager')::boolean,'legacy manager flag escalated privileges';
  assert (select count(*) from public.crew)=0,'raw crew payroll exposed';
  assert (select count(*) from public.attendance where id=original_att)=1,'original history missing';
  update public.attendance set confirmed=true where id=original_att;
  assert not found,'staff directly changed attendance';
  blocked:=false;
  begin perform public.clock_in(sid,37.5,127);
  exception when others then blocked:=true; end;
  assert blocked,'unconfigured location allowed attendance';
  execute 'reset role';
  update public.stores set lat=37.5,lng=127 where id=sid;
  execute 'set local role authenticated';
  clocked:=public.clock_in(sid,37.5,127);
  assert clocked.crew_id=cid and clocked.check_out is null,'clock-in failed';
  blocked:=false;
  begin perform public.clock_in(sid,37.5,127); exception when others then blocked:=true; end;
  assert blocked,'duplicate clock-in succeeded';
  clocked:=public.clock_out(clocked.id,37.5,127);
  assert clocked.check_out is not null,'clock-out failed';
  execute 'reset role';

  execute 'set local role service_role';
  assert (public.manee_recovery_service('issue',jsonb_build_object('user_id',worker_id,'session_id',worker_id,'key_hash',repeat('a',64)))->>'ok')::boolean,'key issue failed';
  op:=public.manee_recovery_service('consume',jsonb_build_object('username','teststaff_'||suffix,'key_hash',repeat('a',64)));
  assert (op->>'user_id')::uuid=worker_id,'recovery selected a different identity';
  assert public.manee_recovery_service('consume',jsonb_build_object('username','teststaff_'||suffix,'key_hash',repeat('a',64)))->>'error'='invalid_recovery','key replay succeeded';
  assert (public.manee_recovery_service('complete',op)->>'ok')::boolean,'completion audit failed';
  execute 'reset role';
  -- Simulate the session deletion performed by Auth's admin password update.
  -- This is not a test of the HTTP Auth password endpoint.
  delete from auth.sessions where user_id=worker_id;
  execute 'set local role authenticated';
  blocked:=false;
  begin perform public.manee_staff_portal('session'); exception when insufficient_privilege then blocked:=true; end;
  assert blocked,'logged-out session restored employee';
  assert (select count(*) from public.attendance where crew_id=cid)=0,'old JWT retained attendance access';
  execute 'reset role';
  insert into auth.sessions(id,user_id,created_at,updated_at) values(fresh_session,worker_id,now(),now());
  perform set_config('request.jwt.claims',jsonb_build_object('session_id',fresh_session)::text,true);
  execute 'set local role authenticated';
  result:=public.manee_staff_portal('session');
  assert (result->'memberships'->0->>'crew_id')::uuid=cid,'new session lost original crew';
  execute 'reset role';


  perform set_config('request.jwt.claim.sub',owner_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('session_id',owner_id)::text,true);
  execute 'set local role authenticated';
  assert (public.manee_staff_portal('revoke',jsonb_build_object('membership_id',mid))->>'ok')::boolean,'revoke failed';
  execute 'reset role';
  perform set_config('request.jwt.claim.sub',worker_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('session_id',fresh_session)::text,true);
  execute 'set local role authenticated';
  assert jsonb_array_length(public.manee_staff_portal('session')->'memberships')=0,'revoked membership restored';
  assert (select count(*) from public.attendance where id=original_att)=0,'revoked worker retained history access';
  execute 'reset role';
  assert (select count(*) from public.crew where id=cid)=1,'crew deleted on revoke';
  assert (select count(*) from public.attendance where id=original_att)=1,'attendance deleted on revoke';
  assert (select count(*) from public.attendance where crew_id=cid)=2,'clock history lost';
  assert (select count(*) from private.staff_access_events where store_id=sid)=2,'approval/revoke audit missing';
end;
$validation$;
select jsonb_build_object('passed',true,'synthetic_sql_role_flow',true,'self_approval_blocked',true,
  'duplicate_connection_blocked',true,'original_crew_and_history_preserved',true,'legacy_role_escalation_blocked',true,
  'direct_staff_writes_blocked',true,'revocation_enforced',true,'audit_recorded',true,'test_data_rolled_back',true,'clock_in_out',true,'recovery_replay_blocked',true,'expired_session_blocked',true,'new_session_restores_same_crew',true) as validation;
rollback;
