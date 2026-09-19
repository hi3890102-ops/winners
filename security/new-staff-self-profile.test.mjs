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
for(const name of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql','store-staff-link-code.sql','store-staff-new-employee-approval.sql','new-staff-self-profile.sql'])
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


const personal={phone:'010-0000-0000',bank_name:'테스트은행',bank_account:'000-123-4567',account_holder:'신규 직원'};
async function addSelfProfile(user=newWorker){await postgres();await db.query('insert into private.staff_registration_profiles(user_id,phone,bank_name,bank_account,account_holder) values($1,$2,$3,$4,$5)',[user,personal.phone,personal.bank_name,personal.bank_account,personal.account_holder]);}
scenario('New-only profile is copied on approval, sets setup marker and preserves crew identity on retries',async()=>{
  await addSelfProfile();const rid=await request(newWorker);await role(owner);
  const first=await portal('approve_new',{request_id:rid});assert.equal(first.ok,true);assert.equal(first.employment_setup_required,true);
  await postgres();let c=(await db.query('select * from public.crew where id=$1',[first.crew_id])).rows[0];
  assert.equal(c.phone,personal.phone);assert.equal(c.bank_account,'테스트은행 / 000-123-4567 / 신규 직원');assert.equal(c.self_service_profile,true);assert.equal(c.employment_setup_required,true);
  await db.query('update public.crew set wage=14000,employment_setup_required=false where id=$1',[c.id]);await role(owner);
  const retry=await portal('approve_new',{request_id:rid});assert.equal(retry.crew_id,first.crew_id);
  await postgres();c=(await db.query('select * from public.crew where id=$1',[c.id])).rows[0];assert.equal(c.wage,14000);assert.equal(c.employment_setup_required,false);
});
scenario('Legacy employee approval and linking do not acquire new-cohort flags or overwrite original fields',async()=>{
  const rid=await request(legacyWorker);await addSelfProfile(legacyWorker);await postgres();
  await db.query("update public.crew set phone='old-phone',bank_account='old-bank' where id=$1",[legacyCrew]);
  await role(owner);assert.equal((await portal('approve',{request_id:rid,crew_id:legacyCrew})).ok,true);await postgres();
  const c=(await db.query('select * from public.crew where id=$1',[legacyCrew])).rows[0];
  assert.equal(c.phone,'old-phone');assert.equal(c.bank_account,'old-bank');assert.equal(c.wage,18000);assert.equal(c.self_service_profile,false);assert.equal(c.employment_setup_required,false);
});
scenario('Profile-less account keeps previous new approval behavior',async()=>{
  const rid=await request(newWorker);await role(owner);const r=await portal('approve_new',{request_id:rid});await postgres();
  assert.equal(await scalar('select self_service_profile from public.crew where id=$1',[r.crew_id]),false);
});
scenario('Owner receives personal data only for authorized pending store requests',async()=>{
  await addSelfProfile();await request(newWorker);await role(owner);const own=await portal('owner_list',{store_id:store});
  const req=own.requests.find(r=>r.requester_user_id===newWorker);assert.equal(req.personal_profile.bank_account,personal.bank_account);
  await role(otherOwner);await denied(()=>portal('owner_list',{store_id:store}));
  const other=await portal('owner_list',{store_id:otherStore});assert.equal(JSON.stringify(other).includes(personal.bank_account),false);
});
scenario('Staff session exposes only own personal profile; arbitrary IDs cannot read another bank account',async()=>{
  await addSelfProfile();await role(newWorker);const own=await portal('session');assert.equal(own.personal_profile.phone,personal.phone);
  await role(legacyWorker);const other=await portal('session',{user_id:newWorker});assert.equal(other.personal_profile,undefined);
  await denied(()=>db.query('select * from private.staff_registration_profiles'));
  await denied(()=>scalar('select public.bootstrap_staff_account_with_profile($1,$2,$3,$4::jsonb)',[legacyWorker,'hijack','Hijack',JSON.stringify(personal)]));
});
scenario('Anonymous and revoked sessions cannot fetch personal data',async()=>{
  await addSelfProfile();await role(null,'anon');await denied(()=>portal('session'));
  await postgres();await db.query('delete from auth.sessions where user_id=$1',[newWorker]);await role(newWorker);await denied(()=>portal('session'));
});
scenario('Service signup creates account and personal record atomically and cannot enroll an existing account',async()=>{
  const user=id(700);await postgres();await db.query('insert into auth.users(id) values($1)',[user]);await role(null,'service_role');
  const made=await scalar('select public.bootstrap_staff_account_with_profile($1,$2,$3,$4::jsonb)',[user,'new_profile_staff','New Profile',JSON.stringify(personal)]);assert.equal(made,user);
  await denied(()=>scalar('select public.bootstrap_staff_account_with_profile($1,$2,$3,$4::jsonb)',[user,'new_profile_staff','New Profile',JSON.stringify(personal)]),'23505');
  await postgres();assert.equal(await scalar('select count(*)::int from private.staff_registration_profiles where user_id=$1',[user]),1);
});
scenario('Invalid bank profile leaves no partially created public profile',async()=>{
  const user=id(701);await postgres();await db.query('insert into auth.users(id) values($1)',[user]);await role(null,'service_role');
  await denied(()=>scalar('select public.bootstrap_staff_account_with_profile($1,$2,$3,$4::jsonb)',[user,'bad_profile_staff','Bad Profile',JSON.stringify({...personal,bank_account:'<invalid>'})]),'22023');
  await postgres();assert.equal(await scalar('select count(*)::int from public.profiles where user_id=$1',[user]),0);
});
scenario('New profile patch can be applied twice without recursive delegation or record changes',async()=>{
  await postgres();await db.exec(readFileSync(new URL('new-staff-self-profile.sql',import.meta.url),'utf8').replace(/^begin;$/m,'').replace(/^commit;$/m,''));
  await role(owner);assert.equal((await portal('session')).ok,true);
});
