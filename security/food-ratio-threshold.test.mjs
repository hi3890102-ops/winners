import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test, {after} from 'node:test';
// Local PGlite (in-process PostgreSQL) check of the per-store food-ratio threshold SQL. Not the real Supabase/PostgreSQL.
const db=new PGlite();
await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz default clock_timestamp(),updated_at timestamptz,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
grant usage on schema auth to anon,authenticated,service_role;`);
for(const f of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql'])
  await db.exec(readFileSync(new URL('./'+f,import.meta.url),'utf8'));
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=id(1),otherOwner=id(2),manager=id(3),staff=id(4);
const store=id(101),otherStore=id(102),mgrCrew=id(201),staffCrew=id(202);
await db.query('insert into auth.users(id) select x::uuid from unnest($1::text[]) x',[[owner,otherOwner,manager,staff]]);
await db.exec('insert into auth.sessions(id,user_id) select id,id from auth.users');
await db.exec(`insert into public.profiles(user_id,username,display_name) values
('${owner}','owner_a','Owner A'),('${otherOwner}','owner_b','Owner B'),('${manager}','mgr_a','Manager A'),('${staff}','staff_a','Staff A');
insert into public.stores(id,name,lat,lng,owner_username) values('${store}','Synthetic A',37.5,127,'owner_a'),('${otherStore}','Synthetic B',37.6,127.1,'owner_b');
insert into public.crew(id,store_id,name,join_code,wage,is_manager) values('${mgrCrew}','${store}','Mgr','A2B3C4D5',15000,true),('${staffCrew}','${store}','Staff','E6F7G8H9',15000,false);
insert into public.store_memberships(user_id,store_id,role,crew_id) values('${owner}','${store}','owner',null),('${otherOwner}','${otherStore}','owner',null),
('${manager}','${store}','manager','${mgrCrew}'),('${staff}','${store}','staff','${staffCrew}');`);
// Existing data snapshot: applying the migration must not change a single existing row.
const snapshot=async()=>JSON.stringify((await db.query('select id,name,lat,lng,owner_username from public.stores order by id')).rows)+JSON.stringify((await db.query('select id,store_id,name,wage from public.crew order by id')).rows);
const before=await snapshot();
await db.exec(readFileSync(new URL('./food-ratio-threshold.sql',import.meta.url),'utf8'));

async function role(user,dbRole='authenticated'){
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',dbRole]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user||'',role:dbRole,session_id:user||null})]);
  await db.exec('set local role '+dbRole);
}
async function scalar(sql,args=[]){return Object.values((await db.query(sql,args)).rows[0])[0];}
async function denied(fn,code){
  await db.exec('savepoint expected_denial');
  try{await assert.rejects(fn,e=>code?e.code===code:true);}
  finally{await db.exec('rollback to expected_denial');await db.exec('release expected_denial');}
}
function scenario(name,fn){test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback');await db.exec('reset role');}});}
const setLimit=(s,v)=>db.query('select public.manee_set_store_food_ratio($1,$2) r',[s,v]);
const readLimit=async s=>{await db.exec('reset role');return await scalar('select food_ratio_threshold from public.stores where id=$1',[s]);};
after(async()=>{await db.close();});

test('Applying the migration changes no existing store or crew row; every store starts unset',async()=>{
  await db.exec('reset role');
  assert.equal(await snapshot(),before);
  assert.equal(await scalar('select count(*)::int from public.stores where food_ratio_threshold is not null'),0);
});
scenario('The owner can save, replace and reset the threshold of their own store (rounded to one decimal)',async()=>{
  await role(owner);
  assert.equal((await setLimit(store,38)).rows[0].r.food_ratio_threshold,38);
  assert.equal(Number(await readLimit(store)),38);
  await role(owner);await setLimit(store,42.46);
  assert.equal(Number(await readLimit(store)),42.5);
  await role(owner);await setLimit(store,null);
  assert.equal(await readLimit(store),null);
});
scenario('Another store\'s owner, a manager and a staff member cannot change it',async()=>{
  for(const who of [otherOwner,manager,staff]){
    await role(who);await denied(()=>setLimit(store,30),'42501');
  }
  assert.equal(await readLimit(store),null);
});
scenario('Anonymous and signed-out callers are rejected',async()=>{
  await role(null,'anon');await denied(()=>setLimit(store,30),'42501');
  await role(null,'authenticated');await denied(()=>setLimit(store,30),'42501');
});
scenario('Out-of-range values are rejected and nothing is saved',async()=>{
  for(const bad of [0,0.9,100.1,-5,1000]){await role(owner);await denied(()=>setLimit(store,bad),'22023');}
  assert.equal(await readLimit(store),null);
});
scenario('The database itself also refuses an out-of-range value written around the function',async()=>{
  await db.exec('reset role');
  await denied(()=>db.query('update public.stores set food_ratio_threshold=150 where id=$1',[store]),'23514');
});
scenario('Stores are separate: saving one store leaves the other untouched',async()=>{
  await role(owner);await setLimit(store,35);
  await role(otherOwner);await setLimit(otherStore,45);
  assert.equal(Number(await readLimit(store)),35);assert.equal(Number(await readLimit(otherStore)),45);
});
scenario('Owner, manager and staff of a store read the same saved value; other stores\' members cannot read it',async()=>{
  await role(owner);await setLimit(store,36);
  for(const who of [owner,manager,staff]){
    await role(who);
    assert.equal(Number((await db.query('select food_ratio_threshold t from public.stores where id=$1',[store])).rows[0].t),36,'member '+who);
  }
  await role(otherOwner);
  assert.equal((await db.query('select food_ratio_threshold t from public.stores where id=$1',[store])).rows.length,0,'not visible to a non-member');
});
scenario('A manager cannot change the column directly (it is not in the UPDATE grant)',async()=>{
  await role(manager);
  await denied(()=>db.query('update public.stores set food_ratio_threshold=10 where id=$1',[store]),'42501');
  await role(owner);
  await denied(()=>db.query('update public.stores set food_ratio_threshold=10 where id=$1',[store]),'42501');
});
const apply=async()=>{await db.exec('reset role');await db.exec(readFileSync(new URL('./food-ratio-threshold.sql',import.meta.url),'utf8'));};
const rollback=async()=>{await db.exec('reset role');await db.exec(readFileSync(new URL('./food-ratio-threshold-rollback.sql',import.meta.url),'utf8'));};
const thresholds=async()=>{await db.exec('reset role');return JSON.stringify((await db.query('select id, food_ratio_threshold t from public.stores order by id')).rows);};
// Session-level role switch: the non-destructive rollback test COMMITS its data (no surrounding transaction).
async function roleCommit(user){
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)",[user]);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,role:'authenticated',session_id:user})]);
  await db.exec('set role authenticated');
}
test('Non-destructive rollback: saved thresholds (37.5 and NULL) survive rollback and re-apply; the feature is switched off in between',async()=>{
  await apply();                                                          // idempotent re-apply on top of the already applied migration
  await roleCommit(owner);await setLimit(store,37.5);                           // committed, outside a rolled-back scenario
  await db.exec('reset role');
  const saved=await thresholds();
  assert.equal(Number(await scalar('select food_ratio_threshold from public.stores where id=$1',[store])),37.5);
  assert.equal(await scalar('select food_ratio_threshold from public.stores where id=$1',[otherStore]),null,'a store that never set one stays NULL');
  await rollback();
  assert.equal(await thresholds(),saved,'rollback changed no stored value');
  assert.equal(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='stores' and column_name='food_ratio_threshold'"),1,'the column is kept');
  assert.equal(await scalar("select count(*)::int from pg_constraint where conname='stores_food_ratio_threshold_range'"),1,'and its range check');
  assert.equal(await snapshot(),before,'existing store and crew rows are unchanged');
  await roleCommit(owner);await db.exec('begin');await denied(()=>setLimit(store,10),'42501');await db.exec('rollback');         // the feature is off: even the owner cannot save
  await db.exec('reset role');
  assert.equal(await thresholds(),saved,'a refused save changed nothing');
  await roleCommit(manager);                                                     // members still READ the value (the app may keep showing it)
  assert.equal(Number((await db.query('select food_ratio_threshold t from public.stores where id=$1',[store])).rows[0].t),37.5);
  await apply();                                                          // re-enable
  assert.equal(await thresholds(),saved,'re-applying kept the value');
  await roleCommit(owner);await setLimit(store,40);
  assert.equal(Number(await readLimit(store)),40);
  await roleCommit(owner);await setLimit(store,37.5);                            // leave the fixture as it was for later tests
  assert.equal(await thresholds(),saved);
});
test('Rollback is repeatable and never drops anything; the rollback file contains no DROP COLUMN / UPDATE / DELETE / TRUNCATE statement',async()=>{
  const sql=readFileSync(new URL('./food-ratio-threshold-rollback.sql',import.meta.url),'utf8').split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
  assert.equal(/drop\s+(column|table|constraint)|\bupdate\b|\bdelete\b|truncate/i.test(sql),false);
  await rollback();await rollback();
  assert.equal(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='stores' and column_name='food_ratio_threshold'"),1);
  await apply();
});
test('Backups include the new column: the read-only export selects whole stores rows and the digest hashes whole rows',()=>{
  const sql=readFileSync(new URL('./new-staff-self-profile-backup-queries.sql',import.meta.url),'utf8');
  assert.ok(/select \* from public\.stores;/.test(sql));
  assert.ok(/from public\.stores x/.test(sql)&&/string_agg\(x::text/.test(sql));
});
