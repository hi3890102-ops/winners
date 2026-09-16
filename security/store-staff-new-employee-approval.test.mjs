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
for(const name of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql','store-staff-link-code.sql','store-staff-new-employee-approval.sql'])
  await db.exec(readFileSync(new URL(name,import.meta.url),'utf8'));
const id=n=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=id(1),newWorker=id(2),legacyWorker=id(3),otherOwner=id(4),store=id(101),otherStore=id(102),legacyCrew=id(201);
await db.query('insert into auth.users(id) select x::uuid from unnest($1::text[]) x',[[owner,newWorker,legacyWorker,otherOwner]]);
await db.exec('insert into auth.sessions(id,user_id) select id,id from auth.users');
await db.exec(`insert into public.profiles(user_id,username,display_name) values
('${owner}','new_owner','Owner'),('${newWorker}','brand_new','신규 직원'),('${legacyWorker}','legacy_staff','기존 직원'),('${otherOwner}','other_owner_new','Other');
insert into public.stores(id,name) values('${store}','New Approval Store'),('${otherStore}','Other Approval Store');
insert into public.store_memberships(user_id,store_id,role,status) values('${owner}','${store}','owner','active'),('${otherOwner}','${otherStore}','owner','active');
insert into public.crew(id,store_id,name,wage,wage_type,position,hire_date) values('${legacyCrew}','${store}','기존 직원',18000,'hourly','주방','2025-01-01');`);
async function scalar(sql,args=[]){return Object.values((await db.query(sql,args)).rows[0])[0];}
async function postgres(){await db.exec('reset role');}
async function role(user,dbRole='authenticated'){
  await postgres();await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',dbRole]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user||'',role:dbRole,session_id:user||null})]);await db.exec('set local role '+dbRole);
}
async function portal(action,payload={}){return scalar('select public.manee_staff_portal($1,$2::jsonb)',[action,JSON.stringify(payload)]);}
async function denied(fn,code='42501'){
  await db.exec('savepoint expected_denial');
  try{await assert.rejects(fn,e=>e.code===code);}finally{await db.exec('rollback to expected_denial;release expected_denial');}
}
function scenario(name,fn){test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback;reset role');}});}
const code=await scalar('select staff_join_code from public.stores where id=$1',[store]);
async function request(user){await role(user);const r=await portal('request',{code});assert.equal(r.ok,true);return r.request_id;}
after(async()=>db.close());

scenario('New employee can be approved without choosing an existing crew record',async()=>{
  const rid=await request(newWorker);await role(owner);const before=await scalar('select count(*)::int from public.crew where store_id=$1',[store]);
  const r=await portal('approve_new',{request_id:rid});assert.equal(r.ok,true);assert.equal(r.created_new,true);
  await postgres();assert.equal(await scalar('select count(*)::int from public.crew where store_id=$1',[store]),before+1);
  assert.equal(await scalar('select name from public.crew where id=$1',[r.crew_id]),'신규 직원');
  assert.equal(await scalar('select wage from public.crew where id=$1',[r.crew_id]),0);
  assert.equal(await scalar('select role from public.store_memberships where id=$1',[r.membership_id]),'staff');
});
scenario('New employee approval preserves the created crew on retry and never duplicates it',async()=>{
  const rid=await request(newWorker);await role(owner);const first=await portal('approve_new',{request_id:rid});const second=await portal('approve_new',{request_id:rid});
  assert.equal(second.membership_id,first.membership_id);assert.equal(second.crew_id,first.crew_id);
  await postgres();assert.equal(await scalar('select count(*)::int from public.store_memberships where user_id=$1 and store_id=$2',[newWorker,store]),1);
  assert.equal(await scalar('select count(*)::int from private.staff_access_events where target_user_id=$1',[newWorker]),1);
});
scenario('Existing employee conversion path still connects the original crew and preserves history fields',async()=>{
  const rid=await request(legacyWorker);await role(owner);const r=await portal('approve',{request_id:rid,crew_id:legacyCrew});assert.equal(r.ok,true);
  await postgres();assert.equal(await scalar('select crew_id from public.store_memberships where id=$1',[r.membership_id]),legacyCrew);
  assert.equal(await scalar('select wage from public.crew where id=$1',[legacyCrew]),18000);assert.equal(await scalar('select position from public.crew where id=$1',[legacyCrew]),'주방');
});
scenario('Foreign owner cannot approve a new employee into another store',async()=>{
  const rid=await request(newWorker);await role(otherOwner);await denied(()=>portal('approve_new',{request_id:rid}));
  await postgres();assert.equal(await scalar('select count(*)::int from public.store_memberships where user_id=$1',[newWorker]),0);
});
scenario('Revoked or previously linked account cannot create a duplicate new crew record',async()=>{
  const rid=await request(newWorker);await role(owner);const first=await portal('approve_new',{request_id:rid});await portal('revoke',{membership_id:first.membership_id});
  await role(newWorker);const again=await portal('request',{code});assert.equal(again.ok,true);await role(owner);
  assert.equal((await portal('approve_new',{request_id:again.request_id})).error,'existing_record_required');
  assert.equal((await portal('approve',{request_id:again.request_id,crew_id:first.crew_id})).ok,true);
});
scenario('Suspended account, expired request and rejected request never create a new crew',async()=>{
  let rid=await request(newWorker);await postgres();await db.query("update private.staff_link_requests set expires_at=now()-interval '1 second' where id=$1",[rid]);await role(owner);
  assert.equal((await portal('approve_new',{request_id:rid})).error,'request_expired');
  rid=await request(newWorker);await role(owner);assert.equal((await portal('reject',{request_id:rid})).ok,true);assert.equal((await portal('approve_new',{request_id:rid})).error,'request_unavailable');
  rid=await request(newWorker);await postgres();await db.query("update public.profiles set status='suspended' where user_id=$1",[newWorker]);await role(owner);
  assert.equal((await portal('approve_new',{request_id:rid})).error,'account_unavailable');
});
