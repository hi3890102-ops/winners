import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz default clock_timestamp(),updated_at timestamptz,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
grant usage on schema auth to anon,authenticated,service_role;`);
for(const name of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql'])
  await db.exec(readFileSync(new URL(name,import.meta.url),'utf8'));
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=id(1),worker=id(2),worker2=id(3),otherOwner=id(4),store=id(101),otherStore=id(102),crew=id(201),crew2=id(202),foreignCrew=id(203),attendance=id(301);
await db.query('insert into auth.users(id) select x::uuid from unnest($1::text[]) x',[[owner,worker,worker2,otherOwner]]);
await db.exec('insert into auth.sessions(id,user_id) select id,id from auth.users');
await db.exec(`insert into public.profiles(user_id,username,display_name) values
('${owner}','owner_store','Store Owner'),('${worker}','worker_one','Worker One'),('${worker2}','worker_two','Worker Two'),('${otherOwner}','other_owner','Other Owner');
insert into public.stores(id,name,lat,lng) values('${store}','Store Code Test',37.5,127),('${otherStore}','Other Store',37.5,127);
insert into public.store_memberships(user_id,store_id,role,status) values('${owner}','${store}','owner','active'),('${otherOwner}','${otherStore}','owner','active');
insert into public.crew(id,store_id,name,wage,position,join_code) values
('${crew}','${store}','Existing Worker',15000,'홀','A2B3C4D5'),('${crew2}','${store}','Second Worker',16000,'주방','E6F7G8H9'),('${foreignCrew}','${otherStore}','Foreign Worker',17000,'홀',null);
insert into public.attendance(id,store_id,crew_id,date,check_in,check_out) values('${attendance}','${store}','${crew}','2026-01-15','10:00','18:00');`);
const migration=readFileSync(new URL('./store-staff-link-code.sql',import.meta.url),'utf8');
await db.exec(migration);
async function scalar(sql,args=[]){return Object.values((await db.query(sql,args)).rows[0])[0];}
async function postgres(){await db.exec('reset role');}
async function role(user,dbRole='authenticated'){
  await postgres();
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',dbRole]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user||'',role:dbRole,session_id:user||null})]);
  await db.exec('set local role '+dbRole);
}
async function portal(action,payload={}){return scalar('select public.manee_staff_portal($1,$2::jsonb)',[action,JSON.stringify(payload)]);}
async function denied(fn,code='42501'){
  await db.exec('savepoint denial');try{await assert.rejects(fn,e=>e.code===code);}finally{await db.exec('rollback to denial;release denial');}
}
function scenario(name,fn){test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback;reset role');}});}
const storeCode=await scalar('select staff_join_code from public.stores where id=$1',[store]);
const otherCode=await scalar('select staff_join_code from public.stores where id=$1',[otherStore]);
async function request(user=worker,code=storeCode){await role(user);return portal('request',{code});}
async function connect(user=worker,cid=crew){const r=await request(user);assert.equal(r.ok,true);await role(owner);const a=await portal('approve',{request_id:r.request_id,crew_id:cid});assert.equal(a.ok,true);return {r,a};}
after(async()=>db.close());

scenario('Existing stores are backfilled and new stores receive a unique server-generated code',async()=>{
  assert.match(storeCode,/^[A-HJ-NP-Z2-9]{8}$/);assert.notEqual(storeCode,otherCode);
  await db.query('insert into public.stores(id,name,staff_join_code) values($1,$2,$3)',[id(104),'New store',storeCode]);
  const code=await scalar('select staff_join_code from public.stores where id=$1',[id(104)]);
  assert.match(code,/^[A-HJ-NP-Z2-9]{8}$/);assert.notEqual(code,storeCode);
  assert.equal(await scalar('select count(*)::int from public.stores where staff_join_code is null'),0);
});
scenario('Preview returns only store name; arbitrary crew, user and role values cannot grant access',async()=>{
  await role(worker);const p=await portal('preview',{code:storeCode});assert.deepEqual(Object.keys(p).sort(),['ok','store_name']);
  const r=await portal('request',{code:storeCode,crew_id:crew,user_id:owner,store_id:otherStore,role:'owner'});assert.equal(r.ok,true);
  assert.equal((await portal('session')).memberships.length,0);
  assert.equal(await scalar('select count(*)::int from public.attendance'),0);
  await postgres();const row=(await db.query('select * from private.staff_link_requests where id=$1',[r.request_id])).rows[0];
  assert.equal(row.crew_id,null);assert.equal(row.requester_user_id,worker);assert.equal(row.store_id,store);
});
scenario('One reusable store code supports different staff accounts; repeated request is idempotent',async()=>{
  const a=await request();const retry=await portal('request',{code:storeCode});assert.equal(a.request_id,retry.request_id);
  const b=await request(worker2);assert.equal(b.ok,true);assert.notEqual(a.request_id,b.request_id);
  await postgres();assert.equal(await scalar('select staff_join_code from public.stores where id=$1',[store]),storeCode);
});
scenario('Lowercase, pasted whitespace and visual hyphens normalize without a store-name field',async()=>{
  await role(worker);assert.equal((await portal('preview',{code:' \t'+storeCode.slice(0,4).toLowerCase()+'-\n'+storeCode.slice(4).toLowerCase()})).ok,true);
  for(const code of ['123456','OOOOOOOO','IIIIIIII',"' OR 1=1",'X'.repeat(65)])assert.equal((await portal('preview',{code})).error,'invalid_code');
});
scenario('Invalid guesses retain the rate limit even when the response is an error',async()=>{
  await role(worker);for(let i=0;i<20;i++)assert.equal((await portal('preview',{code:'INVALID!'})).error,'invalid_code');
  assert.equal((await portal('preview',{code:storeCode})).error,'rate_limited');
  await postgres();assert.equal(await scalar("select attempt_count from public.auth_rate_limits where action='staff_store_link_preview'"),21);
});
scenario('Only the correct owner may list requests, rotate codes or approve a chosen employee',async()=>{
  const r=await request();
  for(const user of [worker,worker2,otherOwner]){
    await role(user);await denied(()=>portal('owner_list',{store_id:store}));await denied(()=>portal('regenerate_store_code',{store_id:store}));
    await denied(()=>portal('approve',{request_id:r.request_id,crew_id:crew}));
  }
  await role(owner);assert.equal((await portal('approve',{request_id:r.request_id})).error,'record_unavailable');
  assert.equal((await portal('approve',{request_id:r.request_id,crew_id:foreignCrew})).error,'record_unavailable');
  assert.equal((await portal('approve',{request_id:r.request_id,crew_id:crew})).ok,true);
});
scenario('Approval preserves original crew, payroll and attendance; repeat approval has one audit event',async()=>{
  const {r,a}=await connect();assert.equal((await portal('approve',{request_id:r.request_id,crew_id:crew})).membership_id,a.membership_id);
  await role(worker);const s=await portal('session');assert.equal(s.memberships[0].crew_id,crew);assert.equal(s.memberships[0].role,'staff');
  assert.equal((await portal('crew',{store_id:store})).crew.wage,15000);
  assert.equal(await scalar('select count(*)::int from public.attendance where id=$1',[attendance]),1);
  await postgres();assert.equal(await scalar('select count(*)::int from private.staff_access_events'),1);
});
scenario('Two accounts cannot share the same employee record; owner may choose another unlinked record',async()=>{
  await connect();const b=await request(worker2);await role(owner);
  assert.equal((await portal('approve',{request_id:b.request_id,crew_id:crew})).error,'record_already_linked');
  assert.equal((await portal('approve',{request_id:b.request_id,crew_id:crew2})).ok,true);
});
scenario('Rotation retires the old code without disconnecting members or deleting pending requests',async()=>{
  await connect();const b=await request(worker2);await role(owner);const rotated=await portal('regenerate_store_code',{store_id:store});
  assert.notEqual(rotated.store_join_code,storeCode);await role(worker2);
  assert.equal((await portal('preview',{code:storeCode})).error,'invalid_code');assert.equal((await portal('request',{code:storeCode})).error,'invalid_code');
  assert.equal((await portal('request',{code:rotated.store_join_code})).request_id,b.request_id);
  await role(worker);assert.equal((await portal('session')).memberships.length,1);
  await postgres();await denied(()=>db.query('update public.stores set staff_join_code=$1 where id=$2',[storeCode,store]));
});
scenario('Old per-employee code RPC, raw code history, anonymous requests and code editing are blocked',async()=>{
  for(const dbRole of ['anon','authenticated']){
    await role(dbRole==='anon'?null:worker,dbRole);
    await denied(()=>db.query("select private.manee_staff_portal_v1('request','{}')"));
    await denied(()=>db.query('select * from private.store_staff_code_history'));
    await denied(()=>db.query('select private.reserve_store_staff_code($1)',[store]));
  }
  await role(null,'anon');await denied(()=>portal('preview',{code:storeCode}));
  await role(worker);assert.equal((await portal('request',{code:'A2B3C4D5'})).error,'invalid_code');
  await role(owner);await denied(()=>db.query("update public.stores set staff_join_code='ABCDEFGH' where id=$1",[store]));
});
scenario('Revocation takes effect immediately and old approvals never reactivate a member',async()=>{
  const {r,a}=await connect();await portal('revoke',{membership_id:a.membership_id});
  await portal('approve',{request_id:r.request_id,crew_id:crew});await role(worker);assert.equal((await portal('session')).memberships.length,0);
  const next=await request();await role(owner);assert.equal((await portal('approve',{request_id:next.request_id,crew_id:crew2})).error,'store_account_conflict');
  assert.equal((await portal('approve',{request_id:next.request_id,crew_id:crew})).ok,true);
});
scenario('Cancel, rejection, expiry, resigned crew and suspended accounts do not create membership',async()=>{
  let r=await request();await portal('cancel',{request_id:r.request_id});await role(owner);
  assert.equal((await portal('approve',{request_id:r.request_id,crew_id:crew})).error,'request_unavailable');
  r=await request();await role(owner);assert.equal((await portal('reject',{request_id:r.request_id})).ok,true);
  r=await request();await postgres();await db.query("update private.staff_link_requests set expires_at=now()-interval '1 second' where id=$1",[r.request_id]);
  await role(owner);assert.equal((await portal('approve',{request_id:r.request_id,crew_id:crew})).error,'request_expired');
  r=await request();await postgres();await db.query("update public.crew set resign_date=(now() at time zone 'Asia/Seoul')::date where id=$1",[crew]);
  await role(owner);assert.equal((await portal('approve',{request_id:r.request_id,crew_id:crew})).error,'record_unavailable');
  await postgres();await db.query("update public.profiles set status='suspended' where user_id=$1",[worker]);
  await role(owner);assert.equal((await portal('approve',{request_id:r.request_id,crew_id:crew2})).error,'account_unavailable');
  await role(worker);await denied(()=>portal('session'));
});
scenario('Code collision retries use the global history rather than a racy pre-check',async()=>{
  await db.exec(`create sequence private.test_code_sequence;
create or replace function private.generate_store_staff_code() returns text language plpgsql volatile set search_path='' as $$
begin if nextval('private.test_code_sequence')=1 then return '${storeCode}'; else return 'ZZZZZZZ2'; end if; end; $$;`);
  await db.query('insert into public.stores(id,name) values($1,$2)',[id(105),'Collision retry']);
  assert.equal(await scalar('select staff_join_code from public.stores where id=$1',[id(105)]),'ZZZZZZZ2');
  assert.equal(await scalar('select count(*)::int from private.store_staff_code_history where code=$1',[storeCode]),1);
});
scenario('Invalid/missing sessions and archived stores are rejected by the new portal',async()=>{
  await db.query('delete from auth.sessions where user_id=$1',[worker]);await role(worker);await denied(()=>portal('preview',{code:storeCode}));
  await postgres();await db.query('update public.stores set archived_at=now() where id=$1',[store]);await role(worker2);
  assert.equal((await portal('request',{code:storeCode})).error,'invalid_code');
});

test('Reapplying the migration keeps assigned codes and does not expose the old RPC',async()=>{
  await postgres();await db.exec(migration);
  assert.equal(await scalar('select staff_join_code from public.stores where id=$1',[store]),storeCode);
  assert.equal(await scalar("select has_function_privilege('authenticated','private.manee_staff_portal_v1(text,jsonb)','EXECUTE')"),false);
});
