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
await db.exec(readFileSync(new URL('./fixtures/staging-baseline.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('./staff-auth.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('./account-recovery.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('./store-permissions.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('./support-password-recovery.sql',import.meta.url),'utf8'));
await db.exec(readFileSync(new URL('./store-staff-link-code.sql',import.meta.url),'utf8'));

const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=id(1),worker=id(2),worker2=id(3),store=id(101),crew=id(201),crew2=id(202),attendance=id(301);
await db.query('insert into auth.users(id) select x::uuid from unnest($1::text[]) x',[[owner,worker,worker2]]);
await db.exec('insert into auth.sessions(id,user_id) select id,id from auth.users');
await db.exec(`insert into public.profiles(user_id,username,display_name) values
('${owner}','owner_store','Store Owner'),('${worker}','worker_one','Worker One'),('${worker2}','worker_two','Worker Two');
insert into public.stores(id,name,lat,lng) values('${store}','Store Code Test',37.5,127);
insert into public.store_memberships(user_id,store_id,role,status) values('${owner}','${store}','owner','active');
insert into public.crew(id,store_id,name,wage,position) values
('${crew}','${store}','Existing Worker',15000,'홀'),('${crew2}','${store}','Second Worker',16000,'주방');
insert into public.attendance(id,store_id,crew_id,date,check_in,check_out) values('${attendance}','${store}','${crew}','2026-01-15','10:00','18:00');`);

async function postgres(){await db.exec('reset role');}
async function role(user,dbRole='authenticated'){
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',dbRole]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user||'',role:dbRole,session_id:user||null})]);
  await db.exec('set local role '+dbRole);
}
async function portal(action,payload={}){return (await db.query('select public.manee_staff_portal($1,$2::jsonb) result',[action,JSON.stringify(payload)])).rows[0].result;}
async function scalar(sql,args=[]){return Object.values((await db.query(sql,args)).rows[0])[0];}
after(async()=>db.close());

let storeCode;
test('every store receives one unique eight-character code automatically',async()=>{
  await postgres();
  storeCode=await scalar('select staff_join_code from public.stores where id=$1',[store]);
  assert.match(storeCode,/^[A-HJ-NP-Z2-9]{8}$/);
  const extra=id(102);await db.query('insert into public.stores(id,name) values($1,$2)',[extra,'Second Store']);
  const extraCode=await scalar('select staff_join_code from public.stores where id=$1',[extra]);
  assert.match(extraCode,/^[A-HJ-NP-Z2-9]{8}$/);assert.notEqual(extraCode,storeCode);
});

test('employee previews only the store and requests without selecting a crew record',async()=>{
  await role(worker);
  const preview=await portal('preview',{code:storeCode});
  assert.deepEqual(Object.keys(preview).sort(),['ok','store_name']);
  assert.equal(preview.store_name,'Store Code Test');
  const requested=await portal('request',{code:storeCode});assert.equal(requested.ok,true);
  await postgres();
  assert.equal(await scalar('select crew_id is null from private.staff_link_requests where id=$1',[requested.request_id]),true);
});

test('the same store code can be used by another employee account',async()=>{
  await role(worker2);const preview=await portal('preview',{code:storeCode});assert.equal(preview.ok,true);
  const requested=await portal('request',{code:storeCode});assert.equal(requested.ok,true);
});

test('owner sees store code and chooses the existing crew record at approval',async()=>{
  await role(owner);const list=await portal('owner_list',{store_id:store});
  assert.equal(list.store_join_code,storeCode);assert.equal(list.requests.length,2);assert.equal(list.available_crew.length,2);
  const first=list.requests.find(r=>r.username==='worker_one');assert.ok(first);
  const missing=await portal('approve',{request_id:first.id});assert.equal(missing.error,'record_unavailable');
  const approved=await portal('approve',{request_id:first.id,crew_id:crew});assert.equal(approved.ok,true);
  await postgres();
  assert.equal(await scalar('select crew_id=$2 from public.store_memberships where id=$1',[approved.membership_id,crew]),true);
  assert.equal(await scalar('select count(*)::int from public.attendance where id=$1',[attendance]),1);
});

test('a second account cannot claim an already linked crew record',async()=>{
  await role(owner);const list=await portal('owner_list',{store_id:store});
  const second=list.requests.find(r=>r.username==='worker_two');assert.ok(second);
  const duplicate=await portal('approve',{request_id:second.id,crew_id:crew});assert.equal(duplicate.error,'record_already_linked');
  const approved=await portal('approve',{request_id:second.id,crew_id:crew2});assert.equal(approved.ok,true);
});

test('regenerating the store code invalidates only future code entry, not existing memberships',async()=>{
  await role(owner);const regenerated=await portal('regenerate_store_code',{store_id:store});
  assert.match(regenerated.store_join_code,/^[A-HJ-NP-Z2-9]{8}$/);assert.notEqual(regenerated.store_join_code,storeCode);
  await role(worker);assert.equal((await portal('preview',{code:storeCode})).error,'invalid_code');
  assert.equal((await portal('preview',{code:regenerated.store_join_code})).ok,true);
  const session=await portal('session');assert.equal(session.memberships.length,1);assert.equal(session.memberships[0].crew_id,crew);
});
