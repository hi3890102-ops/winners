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
for(const name of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql','store-staff-link-code.sql','store-staff-new-hire.sql'])
  await db.exec(readFileSync(new URL(name,import.meta.url),'utf8'));
const id=n=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=id(1),worker=id(2),worker2=id(3),otherOwner=id(4),store=id(101),otherStore=id(102),existingCrew=id(201);
await db.query('insert into auth.users(id) select x::uuid from unnest($1::text[]) x',[[owner,worker,worker2,otherOwner]]);
await db.exec('insert into auth.sessions(id,user_id) select id,id from auth.users');
await db.exec(`insert into public.profiles(user_id,username,display_name) values
('${owner}','new_owner','Owner'),('${worker}','fresh_worker','신규 직원'),('${worker2}','old_worker','기존 직원'),('${otherOwner}','other_owner2','Other');
insert into public.stores(id,name,lat,lng) values('${store}','New Hire Store',37.5,127),('${otherStore}','Other',37.5,127);
insert into public.store_memberships(user_id,store_id,role,status) values('${owner}','${store}','owner','active'),('${otherOwner}','${otherStore}','owner','active');
insert into public.crew(id,store_id,name,wage,position) values('${existingCrew}','${store}','기존 직원',18000,'주방');`);
async function scalar(sql,args=[]){return Object.values((await db.query(sql,args)).rows[0])[0];}
async function role(user,dbRole='authenticated'){
  await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',dbRole]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user||'',role:dbRole,session_id:user||null})]);await db.exec('set local role '+dbRole);
}
async function portal(action,payload={}){return scalar('select public.manee_staff_portal($1,$2::jsonb)',[action,JSON.stringify(payload)]);}
function scenario(name,fn){test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback;reset role');}});}
const code=await scalar('select staff_join_code from public.stores where id=$1',[store]);
async function request(user){await role(user);return portal('request',{code});}
after(async()=>db.close());

scenario('New employee can be approved without selecting an existing crew record',async()=>{
  const r=await request(worker);await role(owner);const before=await scalar('select count(*)::int from public.crew where store_id=$1',[store]);
  const approved=await portal('approve_new',{request_id:r.request_id});assert.equal(approved.ok,true);assert.equal(approved.created_new,true);
  assert.equal(await scalar('select count(*)::int from public.crew where store_id=$1',[store]),before+1);
  const crew=(await db.query('select * from public.crew where id=$1',[approved.crew_id])).rows[0];
  assert.equal(crew.name,'신규 직원');assert.equal(crew.wage,0);assert.equal(crew.wage_type,'hourly');assert.equal(crew.position,'홀');assert.equal(crew.join_code,null);
  await role(worker);const session=await portal('session');assert.equal(session.memberships[0].crew_id,approved.crew_id);assert.equal(session.memberships[0].role,'staff');
});
scenario('New-hire approval is idempotent and never creates duplicate crew rows',async()=>{
  const r=await request(worker);await role(owner);const first=await portal('approve_new',{request_id:r.request_id});const second=await portal('approve_new',{request_id:r.request_id});
  assert.equal(second.membership_id,first.membership_id);assert.equal(second.crew_id,first.crew_id);
  assert.equal(await scalar('select count(*)::int from public.crew where id=$1',[first.crew_id]),1);
  assert.equal(await scalar('select count(*)::int from private.staff_access_events where crew_id=$1',[first.crew_id]),1);
});
scenario('Existing employee migration path still links the selected old record and preserves payroll',async()=>{
  const r=await request(worker2);await role(owner);const approved=await portal('approve',{request_id:r.request_id,crew_id:existingCrew});assert.equal(approved.ok,true);
  await role(worker2);const self=await portal('crew',{store_id:store});assert.equal(self.crew.id,existingCrew);assert.equal(self.crew.wage,18000);assert.equal(self.crew.position,'주방');
});
scenario('New-hire approval cannot duplicate a previously linked or revoked employee account',async()=>{
  const r=await request(worker2);await role(owner);const linked=await portal('approve',{request_id:r.request_id,crew_id:existingCrew});assert.equal(linked.ok,true);
  await portal('revoke',{membership_id:linked.membership_id});
  const next=await request(worker2);await role(owner);assert.equal((await portal('approve_new',{request_id:next.request_id})).error,'existing_record_required');
  assert.equal(await scalar('select count(*)::int from public.crew where store_id=$1',[store]),1);
});
scenario('Only that store owner can approve a new employee',async()=>{
  const r=await request(worker);await role(otherOwner);await assert.rejects(()=>portal('approve_new',{request_id:r.request_id}),e=>e.code==='42501');
  await role(worker);await assert.rejects(()=>portal('approve_new',{request_id:r.request_id}),e=>e.code==='42501');
  await db.exec('reset role');assert.equal(await scalar('select count(*)::int from public.store_memberships where user_id=$1',[worker]),0);
});
scenario('Expired request and suspended profile never create a new employee record',async()=>{
  let r=await request(worker);await db.exec('reset role');await db.query("update private.staff_link_requests set expires_at=now()-interval '1 second' where id=$1",[r.request_id]);
  await role(owner);assert.equal((await portal('approve_new',{request_id:r.request_id})).error,'request_expired');
  await db.exec('reset role');await db.query("update public.profiles set status='suspended' where user_id=$1",[worker]);
  r=(await db.query("insert into private.staff_link_requests(requester_user_id,store_id,crew_id) values($1,$2,null) returning id",[worker,store])).rows[0];
  await role(owner);assert.equal((await portal('approve_new',{request_id:r.id})).error,'account_unavailable');
});
