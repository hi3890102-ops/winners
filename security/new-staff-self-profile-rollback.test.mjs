import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const inTx=sql=>sql.replace(/^begin;$/m,'').replace(/^commit;$/m,'');
await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz default clock_timestamp(),updated_at timestamptz,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
grant usage on schema auth to anon,authenticated,service_role;`);
// Everything the live project has BEFORE new-staff-self-profile.sql.
for(const name of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql','store-staff-link-code.sql','store-staff-new-employee-approval.sql'])
  await db.exec(read(name));
const id=n=>'40000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=id(1),newWorker=id(2),legacyWorker=id(3),store=id(101),legacyCrew=id(201);
await db.query('insert into auth.users(id) select x::uuid from unnest($1::text[]) x',[[owner,newWorker,legacyWorker]]);
await db.exec('insert into auth.sessions(id,user_id) select id,id from auth.users');
await db.exec(`insert into public.profiles(user_id,username,display_name) values
('${owner}','rb_owner','Owner'),('${newWorker}','rb_new_staff','신규 직원'),('${legacyWorker}','rb_legacy_staff','기존 직원');
insert into public.stores(id,name) values('${store}','Rollback Store');
insert into public.store_memberships(user_id,store_id,role,status) values('${owner}','${store}','owner','active');
insert into public.crew(id,store_id,name,wage,wage_type,position,hire_date) values('${legacyCrew}','${store}','기존 직원',18000,'hourly','주방','2025-01-01');`);
async function scalar(sql,args=[]){return Object.values((await db.query(sql,args)).rows[0])[0];}
async function postgres(){await db.exec('reset role');}
async function role(user,dbRole='authenticated'){
  await postgres();await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',dbRole]);
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user||'',role:dbRole,session_id:user||null})]);await db.exec('set local role '+dbRole);
}
async function portal(action,payload={}){return scalar('select public.manee_staff_portal($1,$2::jsonb)',[action,JSON.stringify(payload)]);}
async function attempt(fn,pattern){
  await db.exec('savepoint expected_failure');
  try{await assert.rejects(fn,e=>pattern.test(String(e.message)));}finally{await db.exec('rollback to expected_failure;release expected_failure');}
}
function scenario(name,fn){test(name,async()=>{await db.exec('begin');try{await fn();}finally{await db.exec('rollback;reset role');}});}
after(async()=>db.close());

const baseline=await scalar("select md5(pg_get_functiondef('private.manee_staff_portal(text,jsonb)'::regprocedure))");
const applyPatch=()=>db.exec(inTx(read('new-staff-self-profile.sql')));
const rollBack=()=>db.exec(inTx(read('new-staff-self-profile-rollback.sql')));
async function verify(phase){
  const original=read('new-staff-self-profile-verify.sql');
  const sql=original.replace("'preflight'::text as phase",`'${phase}'::text as phase`).replace("'11ee9e05c5ea48a4f7db7df219cba9d0'::text",`'${baseline}'::text`);
  assert.notEqual(sql,original);
  return (await db.query(sql)).rows;
}
async function assertClean(phase){
  const rows=await verify(phase);assert.equal(rows.length,17);
  assert.deepEqual(rows.filter(r=>r.ok!==true).map(r=>r.check+' => '+r.actual),[]);
}
const personal={phone:'010-0000-0000',bank_name:'테스트은행',bank_account:'000-123-4567',account_holder:'신규 직원'};
async function addProfile(user){await postgres();await db.query('insert into private.staff_registration_profiles(user_id,phone,bank_name,bank_account,account_holder) values($1,$2,$3,$4,$5)',[user,personal.phone,personal.bank_name,personal.bank_account,personal.account_holder]);}
const code=await scalar('select staff_join_code from public.stores where id=$1',[store]);
async function request(user){await role(user);const r=await portal('request',{code});assert.equal(r.ok,true);return r.request_id;}

test('Recorded live baseline fingerprint is reported for comparison',t=>{
  t.diagnostic('local repo-built portal md5='+baseline+' ; live staging/production md5=11ee9e05c5ea48a4f7db7df219cba9d0 ; equal='+(baseline==='11ee9e05c5ea48a4f7db7df219cba9d0'));
});
scenario('Verify SQL passes before the patch (preflight) and after it (applied)',async()=>{
  await assertClean('preflight');await applyPatch();await postgres();await assertClean('applied');
  // Old signup Edge Function (v1) keeps working against the patched database.
  const user=id(800);await db.query('insert into auth.users(id) values($1)',[user]);await role(null,'service_role');
  assert.equal(await scalar('select public.bootstrap_staff_account($1,$2,$3)',[user,'old_edge_signup','Old Edge']),user);
  await postgres();assert.equal(await scalar('select count(*)::int from private.staff_registration_profiles where user_id=$1',[user]),0);
});
scenario('Verify SQL flags a wrapper overwritten by re-running the older approval patch',async()=>{
  await applyPatch();await db.exec(inTx(read('store-staff-new-employee-approval.sql')));await postgres();
  const bad=(await verify('applied')).filter(r=>r.ok!==true).map(r=>r.check);
  assert.ok(bad.includes('private.manee_staff_portal is the self-profile wrapper'),JSON.stringify(bad));
  await attempt(()=>rollBack(),/not the self-profile wrapper/);
});
scenario('Rollback restores the original portal byte-for-byte and keeps every new record',async()=>{
  await applyPatch();await addProfile(newWorker);const rid=await request(newWorker);await role(owner);
  const first=await portal('approve_new',{request_id:rid});assert.equal(first.employment_setup_required,true);
  await postgres();await rollBack();await assertClean('rolled_back');
  assert.equal(await scalar("select md5(pg_get_functiondef('private.manee_staff_portal(text,jsonb)'::regprocedure))"),baseline);
  // Nothing was deleted: profile row, crew row, flags, membership.
  assert.equal(await scalar('select count(*)::int from private.staff_registration_profiles where user_id=$1',[newWorker]),1);
  const c=(await db.query('select * from public.crew where id=$1',[first.crew_id])).rows[0];
  assert.equal(c.phone,personal.phone);assert.equal(c.self_service_profile,true);assert.equal(c.employment_setup_required,true);
  assert.equal(await scalar("select count(*)::int from public.store_memberships where user_id=$1 and crew_id=$2 and status='active'",[newWorker,first.crew_id]),1);
  assert.equal(await scalar('select count(*)::int from public.crew where id=$1',[legacyCrew]),1);
  // Client-visible behavior is the pre-patch one: works, but no personal_profile.
  await role(owner);const list=await portal('owner_list',{store_id:store});assert.equal(list.ok,true);
  assert.equal(JSON.stringify(list).includes(personal.bank_account),false);
  await role(newWorker);const session=await portal('session');assert.equal(session.ok,true);assert.equal(session.personal_profile,undefined);
  await postgres();await attempt(()=>rollBack(),/before_self_profile is missing/);
});
scenario('After rollback a newer signup Edge Function still stores data and the patch re-applies cleanly',async()=>{
  await applyPatch();await postgres();await rollBack();
  const user=id(801);await db.query('insert into auth.users(id) values($1)',[user]);await role(null,'service_role');
  assert.equal(await scalar('select public.bootstrap_staff_account_with_profile($1,$2,$3,$4::jsonb)',[user,'new_edge_signup','New Edge',JSON.stringify(personal)]),user);
  await postgres();assert.equal(await scalar('select count(*)::int from private.staff_registration_profiles where user_id=$1',[user]),1);
  await applyPatch();await postgres();await assertClean('applied');
  await role(owner);assert.equal((await portal('owner_list',{store_id:store})).ok,true);
  // A second rollback cycle works and still keeps the staff data saved in between.
  await postgres();await rollBack();await assertClean('rolled_back');
  assert.equal(await scalar('select count(*)::int from private.staff_registration_profiles where user_id=$1',[user]),1);
  assert.equal(await scalar("select md5(pg_get_functiondef('private.manee_staff_portal(text,jsonb)'::regprocedure))"),baseline);
});
scenario('Catch-up is preview-only by default, fills only new-cohort blanks and never touches linked existing employees',async()=>{
  await applyPatch();await postgres();await rollBack();
  await addProfile(newWorker);await addProfile(legacyWorker);
  const newRid=await request(newWorker);await role(owner);const made=await portal('approve_new',{request_id:newRid});
  const linkRid=await request(legacyWorker);await role(owner);assert.equal((await portal('approve',{request_id:linkRid,crew_id:legacyCrew})).ok,true);
  await postgres();
  assert.equal(await scalar('select coalesce(phone,\'\') from public.crew where id=$1',[made.crew_id]),'');
  const catchup=read('new-staff-self-profile-catchup.sql');
  let out=await db.exec(catchup);assert.deepEqual(out.at(-1).rows.map(r=>r.crew_id),[made.crew_id]);
  assert.equal(await scalar('select coalesce(phone,\'\') from public.crew where id=$1',[made.crew_id]),'','preview must not write');
  await db.query("select set_config('manee.catchup_confirm','yes',true)");
  out=await db.exec(catchup);assert.deepEqual(out.at(-1).rows,[]);
  const c=(await db.query('select * from public.crew where id=$1',[made.crew_id])).rows[0];
  assert.equal(c.phone,personal.phone);assert.equal(c.bank_account,'테스트은행 / 000-123-4567 / 신규 직원');
  assert.equal(c.self_service_profile,true);assert.equal(c.employment_setup_required,true);assert.equal(c.wage,0);
  const legacy=(await db.query('select * from public.crew where id=$1',[legacyCrew])).rows[0];
  assert.equal(legacy.self_service_profile,false);assert.equal(legacy.wage,18000);assert.ok(!legacy.phone);assert.ok(!legacy.bank_account);
});
// 2026-09-22: this scenario needs a captured "before" snapshot of private.manee_staff_portal (definition + grants)
// to restore from once the normal rollback's backup function is gone. Two separate concerns were tangled into one
// test here before: (a) does the EMERGENCY RESTORE MECHANISM actually work, and (b) does a real point-in-time
// snapshot of the LIVE staging project exist. (a) is a pure regression and must be reproducible with synthetic
// data with no real personal information or project secrets - so it now captures its own "before" snapshot from
// this test's own synthetic fixtures, the same way a real backup would (pg_get_functiondef + grants), instead of
// reading a file. (b) is a genuine, separate ops requirement - a real backup of the live staging project - which
// must NEVER be committed to this repository, so it cannot be satisfied by test code at all; see the skip below.
scenario('Emergency path (synthetic, reproducible): a captured pre-patch definition+grants snapshot restores the original portal even when the rename swap is impossible',async()=>{
  const snapshotDef=await scalar("select pg_get_functiondef('private.manee_staff_portal(text,jsonb)'::regprocedure)");
  const grantedTo=(await db.query("select rolname from pg_roles where rolname in ('anon','authenticated','service_role') and has_function_privilege(rolname,'private.manee_staff_portal(text,jsonb)','EXECUTE')")).rows.map(r=>r.rolname);
  const snapshotSql=snapshotDef+';\nrevoke all on function private.manee_staff_portal(text,jsonb) from public;\n'
    +grantedTo.map(r=>'grant execute on function private.manee_staff_portal(text,jsonb) to '+r+';').join('\n');
  await applyPatch();await db.exec('drop function private.manee_staff_portal_before_self_profile(text,jsonb)');
  await attempt(()=>rollBack(),/before_self_profile is missing/);
  await db.exec(snapshotSql);
  await role(owner);assert.equal((await portal('session')).ok,true);
  await postgres();assert.equal(await scalar("select has_function_privilege('authenticated','private.manee_staff_portal(text,jsonb)','EXECUTE')"),true);
  assert.equal(await scalar("select has_function_privilege('anon','private.manee_staff_portal(text,jsonb)','EXECUTE')"),false);
});
{
  const realBackupPath=fileURLToPath(new URL('backups/staging-obpkzecgswnfuyhwvncd-2026-09-19-before-self-profile.sql',import.meta.url));
  const realBackupExists=existsSync(realBackupPath);
  test('Emergency path (real ops verification): a genuine pre-migration snapshot of the LIVE staging project restores the portal',
    {skip: realBackupExists ? false : 'No real backup file exists at security/backups/staging-obpkzecgswnfuyhwvncd-2026-09-19-before-self-profile.sql. By standing rule, a real production/staging backup must never be committed to this repository, so this check cannot be satisfied from inside the repo. This is a tracked, unresolved ops gap (see RESULT.md): capture pg_get_functiondef+grants for private.manee_staff_portal from the ACTUAL staging project into a file kept OUTSIDE version control at that path, then re-run to verify it restores cleanly. The regression logic for the restore mechanism itself is covered separately by the synthetic test above.'},
    async()=>{
      await db.exec('begin');
      try{
        await applyPatch();await db.exec('drop function private.manee_staff_portal_before_self_profile(text,jsonb)');
        await attempt(()=>rollBack(),/before_self_profile is missing/);
        await db.exec(inTx(readFileSync(realBackupPath,'utf8')));
        await role(owner);assert.equal((await portal('session')).ok,true);
        await postgres();assert.equal(await scalar("select has_function_privilege('authenticated','private.manee_staff_portal(text,jsonb)','EXECUTE')"),true);
        assert.equal(await scalar("select has_function_privilege('anon','private.manee_staff_portal(text,jsonb)','EXECUTE')"),false);
      }finally{await db.exec('rollback;reset role');}
    });
}
