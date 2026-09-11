import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test, {after} from 'node:test';

const db=new PGlite();
await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz default clock_timestamp(),updated_at timestamptz,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
grant usage on schema auth to anon,authenticated,service_role;`);
await db.exec(readFileSync(new URL('./fixtures/staging-baseline.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('./staff-auth.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('./account-recovery.sql',import.meta.url),'utf8'));
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=id(1),otherOwner=id(2),worker=id(3),otherWorker=id(4),newWorker=id(5);
const store=id(101),otherStore=id(102),crew=id(201),otherCrew=id(202),secondCrew=id(203),historic=id(301),otherAttendance=id(302);
await db.query('insert into auth.users(id) select x::uuid from unnest($1::text[]) x',[[owner,otherOwner,worker,otherWorker,newWorker]]);
await db.exec('insert into auth.sessions(id,user_id) select id,id from auth.users');
await db.exec(`insert into public.profiles(user_id,username,display_name) values
('${owner}','owner_a','Owner A'),('${otherOwner}','owner_b','Owner B'),('${worker}','worker_a','Worker A'),('${otherWorker}','worker_b','Worker B');
insert into public.stores(id,name,lat,lng,owner_username) values('${store}','Synthetic A',37.5,127,'owner_a'),('${otherStore}','Synthetic B',37.6,127.1,'owner_b');
insert into public.store_memberships(user_id,store_id,role) values('${owner}','${store}','owner'),('${otherOwner}','${otherStore}','owner');
insert into public.crew(id,store_id,name,join_code,wage,is_manager,resident_number,bank_account,notes) values
('${crew}','${store}','Synthetic Crew A','120001',15000,true,'never-expose-resident','never-expose-bank','private-note'),
('${otherCrew}','${otherStore}','Synthetic Crew B','120002',25000,false,'other-resident','other-bank','other-note'),
('${secondCrew}','${store}','Synthetic Crew C','120003',35000,false,'other-resident','other-bank','other-note');
insert into public.attendance(id,store_id,crew_id,date,check_in,check_out) values
('${historic}','${store}','${crew}','2026-01-15','10:00','18:00'),('${otherAttendance}','${store}','${secondCrew}','2026-01-15','11:00','19:00');`);

async function role(user,dbRole='authenticated'){
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',dbRole]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user||'',role:dbRole,session_id:user||null})]);
  await db.exec('set local role '+dbRole);
}
async function postgres(){await db.exec('reset role');}
async function portal(action,payload={}){return (await db.query('select public.manee_staff_portal($1,$2::jsonb) result',[action,JSON.stringify(payload)])).rows[0].result;}
async function scalar(sql,args=[]){return Object.values((await db.query(sql,args)).rows[0])[0];}
async function denied(fn,code){
  await db.exec('savepoint expected_denial');
  try{await assert.rejects(fn,e=>code ? e.code===code : true);}
  finally{await db.exec('rollback to expected_denial');await db.exec('release expected_denial');}
}
function scenario(name,fn){test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback');await db.exec('reset role');}});}
async function request(user=worker,code='120001'){await role(user);const r=await portal('request',{code});assert.equal(r.ok,true);return r.request_id;}
async function connect(user=worker,code='120001',reviewer=owner){const r=await request(user,code);await role(reviewer);const approved=await portal('approve',{request_id:r});assert.equal(approved.ok,true);return {request:r,membership:approved.membership_id};}
after(async()=>{await db.close();});

scenario('Staff bootstrap creates one profile and no owner membership or store',async()=>{
  await role(null,'service_role');
  assert.equal(await scalar('select public.bootstrap_staff_account($1,$2,$3)',[newWorker,'  ＮＥＷ＿ＷＯＲＫＥＲ  ','Synthetic new worker']),newWorker);
  await postgres();
  assert.equal(await scalar('select username from public.profiles where user_id=$1',[newWorker]),'new_worker');
  assert.equal(await scalar('select count(*)::int from public.stores'),2);
  assert.equal(await scalar('select count(*)::int from public.store_memberships where user_id=$1',[newWorker]),0);
});
scenario('Reserved usernames and invalid display text reject bootstrap atomically',async()=>{
  await role(null,'service_role');
  await denied(()=>db.query('select public.bootstrap_staff_account($1,$2,$3)',[newWorker,'OWNER_A','Fake']),'23505');
  await denied(()=>db.query('select public.bootstrap_staff_account($1,$2,$3)',[newWorker,'safe_name','<script>']),'22023');
  await postgres();assert.equal(await scalar('select count(*)::int from public.profiles where user_id=$1',[newWorker]),0);
});
scenario('Anonymous and signed-in clients cannot bootstrap or write request/audit tables',async()=>{
  for(const dbRole of ['anon','authenticated']){
    await role(dbRole==='authenticated'?worker:null,dbRole);
    await denied(()=>db.query('select public.bootstrap_staff_account($1,$2,$3)',[newWorker,'fake_name','Fake']),'42501');
    await denied(()=>db.query('select * from private.staff_link_requests'),'42501');
    await denied(()=>db.query('insert into private.staff_access_events default values'),'42501');
  }
  await role(null,'anon');await denied(()=>portal('session'),'42501');
  await denied(()=>db.query('select * from public.crew'),'42501');
  await denied(()=>db.query('select * from public.attendance'),'42501');
});
scenario('Missing Auth identity or suspended profile cannot enter portal',async()=>{
  await role(null);await denied(()=>portal('session'),'42501');
  await postgres();await db.query("update public.profiles set status='suspended' where user_id=$1",[worker]);
  await role(worker);await denied(()=>portal('session'),'42501');
});
scenario('Code creates a pending request without revealing staff details or granting access',async()=>{
  await role(worker);
  const r=await portal('request',{code:'120001',user_id:owner,role:'owner',store_id:otherStore});
  assert.deepEqual(Object.keys(r).sort(),['ok','request_id']);
  assert.equal((await portal('session')).memberships.length,0);
  await postgres();assert.equal(await scalar('select requester_user_id from private.staff_link_requests where id=$1',[r.request_id]),worker);
});
scenario('Repeated requests are idempotent and failed guesses remain rate limited',async()=>{
  const r=await request();assert.equal((await portal('request',{code:'120001'})).request_id,r);
  for(let i=0;i<8;i++)assert.equal((await portal('request',{code:i%2?'12%':'999999'})).error,'invalid_code');
  assert.equal((await portal('request',{code:'120001'})).error,'rate_limited');
  await postgres();assert.equal(await scalar("select attempt_count from public.auth_rate_limits where action='staff_link_user'"),11);
});
scenario('Only requester may cancel their own pending request',async()=>{
  const r=await request();await role(otherWorker);
  assert.equal((await portal('cancel',{request_id:r})).ok,false);
  await role(worker);assert.equal((await portal('cancel',{request_id:r})).ok,true);
  await role(owner);assert.equal((await portal('approve',{request_id:r})).error,'request_unavailable');
});
scenario('Other owners and staff cannot list or approve another store requests',async()=>{
  const r=await request();
  for(const user of [worker,otherWorker,otherOwner]){
    await role(user);await denied(()=>portal('owner_list',{store_id:store}),'42501');
    await denied(()=>portal('approve',{request_id:r}),'42501');
  }
});
scenario('Owner approval links the original crew and history, defaults to staff, and is idempotent',async()=>{
  const linked=await connect();
  assert.equal((await portal('approve',{request_id:linked.request})).membership_id,linked.membership);
  await role(worker);const session=await portal('session');
  assert.equal(session.memberships[0].crew_id,crew);assert.equal(session.memberships[0].role,'staff');
  const self=await portal('crew',{store_id:store});assert.equal(self.crew.wage,15000);assert.equal(self.crew.is_manager,false);
  for(const key of ['resident_number','bank_account','notes','join_code'])assert.equal(Object.hasOwn(self.crew,key),false);
  await postgres();assert.equal(await scalar('select count(*)::int from private.staff_access_events'),1);
  assert.equal(await scalar('select check_in::text from public.attendance where id=$1',[historic]),'10:00:00');
});
scenario('Competing pending requests cannot claim the same crew after one approval',async()=>{
  const a=await request(worker),b=await request(otherWorker);await role(owner);
  assert.equal((await portal('approve',{request_id:a})).ok,true);
  assert.equal((await portal('approve',{request_id:b})).error,'record_already_linked');
  await postgres();assert.equal(await scalar('select count(*)::int from public.store_memberships where crew_id=$1',[crew]),1);
  assert.equal(await scalar('select status from private.staff_link_requests where id=$1',[b]),'pending');
});
scenario('Two crew records in one store cannot overwrite an existing user membership',async()=>{
  const a=await request(worker),b=await request(worker,'120003');await role(owner);
  assert.equal((await portal('approve',{request_id:a})).ok,true);
  assert.equal((await portal('approve',{request_id:b})).error,'store_account_conflict');
  await role(owner);assert.equal((await portal('request',{code:'120001'})).error,'store_account_conflict');
  assert.equal((await portal('session')).memberships[0].role,'owner');
});
scenario('A single employee account can connect to a second store with that owner approval',async()=>{
  await connect();await connect(worker,'120002',otherOwner);await role(worker);
  assert.equal((await portal('session')).memberships.length,2);
});
scenario('Expired, suspended, resigned, archived and moved records fail approval without membership',async()=>{
  const r=await request();
  for(const [sql,args,expected] of [
    ["update private.staff_link_requests set expires_at=now()-interval '1 second' where id=$1",[r],'request_expired'],
    ["update public.profiles set status='suspended' where user_id=$1",[worker],'account_unavailable'],
    ["update public.crew set resign_date=(now() at time zone 'Asia/Seoul')::date where id=$1",[crew],'record_unavailable'],
    ['update public.crew set store_id=$1 where id=$2',[otherStore,crew],'record_unavailable']
  ]){
    await postgres();await db.exec('savepoint invalid_state');await db.query(sql,args);await role(owner);
    assert.equal((await portal('approve',{request_id:r})).error,expected);
    await db.exec('rollback to invalid_state');await db.exec('release invalid_state');
  }
  await postgres();await db.query('update public.stores set archived_at=now() where id=$1',[store]);await role(owner);
  await denied(()=>portal('approve',{request_id:r}),'42501');
});
scenario('Resignation starts on the Seoul resignation date and a future date remains eligible',async()=>{
  await postgres();await db.query("update public.crew set resign_date=(now() at time zone 'Asia/Seoul')::date where id=$1",[crew]);
  await role(worker);assert.equal((await portal('request',{code:'120001'})).error,'invalid_code');
  await postgres();await db.query("update public.crew set resign_date=(now() at time zone 'Asia/Seoul')::date+1 where id=$1",[crew]);
  await connect();await role(worker);assert.equal((await portal('session')).memberships.length,1);
});
scenario('Owner revoke immediately removes staff access while preserving identity and payroll',async()=>{
  const linked=await connect();await portal('revoke',{membership_id:linked.membership});
  await role(worker);assert.equal((await portal('session')).memberships.length,0);
  await denied(()=>portal('crew',{store_id:store}),'42501');
  assert.equal(await scalar('select count(*)::int from public.attendance'),0);
  await denied(()=>db.query('select public.clock_in($1,37.5,127)',[store]),'42501');
  await postgres();assert.equal(await scalar('select count(*)::int from public.attendance where id=$1',[historic]),1);
  assert.equal(await scalar('select count(*)::int from public.crew where id=$1',[crew]),1);
  assert.equal(await scalar('select count(*)::int from private.staff_access_events'),2);
});
scenario('Old approval cannot undo revoke; a fresh request may reactivate only the same account',async()=>{
  const linked=await connect();await portal('revoke',{membership_id:linked.membership});
  await portal('approve',{request_id:linked.request});await role(worker);
  assert.equal((await portal('session')).memberships.length,0);
  await role(otherWorker);assert.equal((await portal('request',{code:'120001'})).error,'record_already_linked');
  const next=await connect();assert.equal(next.membership,linked.membership);
  await postgres();assert.equal(await scalar("select count(*)::int from private.staff_access_events where action='reactivated'"),1);
});
scenario('Staff cannot select raw coworker payroll, forge membership, or update attendance directly',async()=>{
  await connect();await role(worker);
  assert.equal(await scalar('select count(*)::int from public.crew'),0);
  assert.equal(await scalar('select count(*)::int from public.attendance'),1);
  assert.equal((await db.query('update public.attendance set confirmed=true returning id')).rows.length,0);
  await denied(()=>db.query("insert into public.attendance(store_id,crew_id,date,check_in) values($1,$2,current_date,'08:00')",[store,crew]),'42501');
  await denied(()=>db.query("insert into public.store_memberships(user_id,store_id,role) values($1,$2,'owner')",[worker,otherStore]),'42501');
  const directory=(await db.query('select * from public.get_store_crew_directory($1)',[store])).rows;
  assert.equal(directory.length,2);assert.equal(Object.hasOwn(directory[0],'wage'),false);
  await denied(()=>db.query('select * from public.get_store_crew_directory($1)',[otherStore]),'42501');
});
scenario('Owner crew management stays in their own store and does not see another store',async()=>{
  await role(owner);assert.equal(await scalar('select count(*)::int from public.crew'),2);
  assert.equal((await db.query('update public.crew set wage=17000 where id=$1 returning id',[crew])).rows.length,1);
  assert.equal((await db.query('update public.crew set wage=1 where id=$1 returning id',[otherCrew])).rows.length,0);
  await denied(()=>db.query('update public.crew set store_id=$1 where id=$2',[otherStore,crew]),'42501');
});
scenario('Server attendance requires location and rejects invalid coordinates and duplicate clock-ins',async()=>{
  await connect();await role(worker);
  for(const coordinates of [[null,null],[0,0],['NaN','NaN'],[91,127]]) await denied(()=>db.query('select public.clock_in($1,$2,$3)',[store,...coordinates]));
  const a=await scalar('select to_jsonb(public.clock_in($1,37.5,127))',[store]);
  assert.equal(a.crew_id,crew);assert.equal(a.confirmed,false);
  await denied(()=>db.query('select public.clock_in($1,37.5,127)',[store]));
  await denied(()=>db.query('select public.clock_out($1,37.5,127)',[otherAttendance]),'42501');
  const out=await scalar('select to_jsonb(public.clock_out($1,37.5,127))',[a.id]);assert.ok(out.check_out);
  await denied(()=>db.query('select public.clock_out($1,37.5,127)',[a.id]));
  const confirm=await scalar('select to_jsonb(public.confirm_my_attendance($1))',[a.id]);assert.equal(confirm.staff_confirmed,true);
});
scenario('Membership revoke cannot be undone by clearing resignation or changing legacy manager flags',async()=>{
  const linked=await connect();await portal('revoke',{membership_id:linked.membership});await postgres();
  await db.query('update public.crew set resign_date=null,is_manager=true,sales_access=true where id=$1',[crew]);
  await role(worker);assert.equal(await scalar('select private.has_sales_access($1)',[store]),false);
  assert.equal(await scalar('select private.current_crew_id($1)',[store]),null);
});
scenario('A suspended linked account loses directory, clock and store access',async()=>{
  await connect();await postgres();await db.query("update public.profiles set status='suspended' where user_id=$1",[worker]);await role(worker);
  await denied(()=>db.query('select * from public.get_store_crew_directory($1)',[store]),'42501');
  await denied(()=>db.query('select public.clock_in($1,37.5,127)',[store]),'42501');
  assert.equal(await scalar('select count(*)::int from public.stores'),0);
});
scenario('Employee time corrections remain requests until an authorized manager approves',async()=>{
  await connect();await role(worker);
  const change=await scalar("select to_jsonb(public.request_attendance_edit($1,'09:30','18:30','Synthetic time correction'))",[historic]);
  assert.equal(change.status,'pending');
  await denied(()=>db.query("select public.approve_attendance_edit_request($1,'forged')",[change.id]),'42501');
  await role(owner);await db.query("select public.approve_attendance_edit_request($1,'Owner checked')",[change.id]);
  assert.equal(await scalar('select check_in::text from public.attendance where id=$1',[historic]),'09:30:00');
});

async function recovery(action,payload={}){return scalar('select public.manee_recovery_service($1,$2::jsonb)',[action,JSON.stringify(payload)]);}
const keyHash='a'.repeat(64),replacementHash='b'.repeat(64);
async function issue(user=worker,hash=keyHash){await role(null,'service_role');return recovery('issue',{user_id:user,session_id:user,key_hash:hash});}
scenario('Recovery secrets and service RPC are inaccessible to anonymous and authenticated callers',async()=>{
  await issue();
  for(const [who,dbRole] of [[null,'anon'],[worker,'authenticated'],[owner,'authenticated']]){
    await role(who,dbRole);
    await denied(()=>db.query('select * from private.account_recovery_keys'),'42501');
    await denied(()=>recovery('issue',{user_id:worker,session_id:worker,key_hash:replacementHash}),'42501');
    await denied(()=>recovery('consume',{username:'worker_a',key_hash:keyHash}),'42501');
  }
});
scenario('Recovery issue requires an active profile and a fresh session owned by that user',async()=>{
  await role(null,'service_role');
  assert.equal((await recovery('issue',{user_id:worker,session_id:owner,key_hash:keyHash})).ok,false);
  await postgres();await db.query("update auth.sessions set created_at=now()-interval '10 minutes' where user_id=$1",[worker]);
  assert.equal((await issue()).ok,false);
  await postgres();await db.query("update public.profiles set status='suspended' where user_id=$1",[owner]);
  assert.equal((await issue(owner)).ok,false);
});
scenario('Recovery reissue replaces the old hash and atomic consume prevents replay',async()=>{
  assert.equal((await issue()).ok,true);assert.equal((await issue(worker,replacementHash)).ok,true);
  assert.equal((await recovery('consume',{username:'worker_a',key_hash:keyHash})).error,'invalid_recovery');
  const r=await recovery('consume',{username:'  ＷＯＲＫＥＲ＿Ａ  ',key_hash:replacementHash});
  assert.equal(r.user_id,worker);assert.ok(r.operation_id);
  assert.equal((await recovery('consume',{username:'worker_a',key_hash:replacementHash})).error,'invalid_recovery');
  await postgres();assert.equal(await scalar('select key_hash from private.account_recovery_keys where user_id=$1',[worker]),null);
  assert.equal(await scalar("select count(*) from private.account_recovery_events where action='reset_started'"),1);
});
scenario('Recovery unknown username, wrong key, missing key and suspended account fail uniformly',async()=>{
  await issue();
  for(const payload of [{username:'worker_a',key_hash:replacementHash},{username:'missing',key_hash:keyHash},{username:'worker_a'}])assert.equal((await recovery('consume',payload)).error,'invalid_recovery');
  await postgres();await db.query("update public.profiles set status='suspended' where user_id=$1",[worker]);
  await role(null,'service_role');assert.equal((await recovery('consume',{username:'worker_a',key_hash:keyHash})).error,'invalid_recovery');
});
scenario('Recovery preserves original profile, memberships and attendance, including revoked links',async()=>{
  const c=await connect();await role(owner);await portal('revoke',{membership_id:c.membership});
  await issue();const r=await recovery('consume',{username:'worker_a',key_hash:keyHash});
  assert.equal((await recovery('complete',r)).ok,true);
  await postgres();
  assert.equal(await scalar('select status from public.store_memberships where id=$1',[c.membership]),'revoked');
  assert.equal(await scalar('select count(*) from public.profiles where user_id=$1',[worker]),1);
  assert.equal(await scalar('select count(*) from public.attendance where id=$1',[historic]),1);
  assert.equal(await scalar('select count(*) from public.crew where id=$1',[crew]),1);
});
scenario('Recovery uncertain result never restores a key or permits immediate reissuance',async()=>{
  await issue();const r=await recovery('consume',{username:'worker_a',key_hash:keyHash});
  assert.equal((await recovery('uncertain',r)).ok,true);
  assert.equal((await recovery('consume',{username:'worker_a',key_hash:keyHash})).ok,false);
  assert.equal((await issue(worker,replacementHash)).error,'recovery_in_progress');
  await postgres();await db.query("update private.account_recovery_keys set consumed_at=now()-interval '11 minutes' where user_id=$1",[worker]);
  assert.equal((await issue(worker,replacementHash)).ok,true);
});
scenario('Signed JWT with a missing, expired or foreign session cannot restore, read or clock',async()=>{
  await connect();await postgres();await db.query('delete from auth.sessions where user_id=$1',[worker]);
  await role(worker);await denied(()=>portal('session'),'42501');
  assert.equal(await scalar('select count(*) from public.attendance'),0);
  await denied(()=>db.query('select public.clock_in($1,37.5,127)',[store]),'42501');
  await postgres();await db.query("insert into auth.sessions(id,user_id,not_after) values($1,$1,now()-interval '1 second')",[worker]);
  await role(worker);await denied(()=>portal('session'),'42501');
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({session_id:owner})]);
  await denied(()=>portal('session'),'42501');
});
scenario('A new valid session restores the same employee after global session removal',async()=>{
  const c=await connect();await postgres();await db.query('delete from auth.sessions where user_id=$1',[worker]);
  await role(worker);await denied(()=>portal('session'),'42501');
  await postgres();await db.query('insert into auth.sessions(id,user_id) values($1,$2)',[id(999),worker]);
  await role(worker);await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({session_id:id(999)})]);
  const s=await portal('session');assert.equal(s.profile.user_id,worker);assert.equal(s.memberships[0].id,c.membership);
});

test('The exact live SQL-role recovery and clock/revoke rehearsal rolls back all fixtures',async()=>{
  const before=await scalar('select count(*) from auth.users');
  const result=await db.exec(readFileSync(new URL('./account-recovery-live-rollback.sql',import.meta.url),'utf8'));
  assert.equal(result.find(r=>r.rows?.[0]?.validation)?.rows[0].validation.passed,true);
  assert.equal(await scalar('select count(*) from auth.users'),before);
});
