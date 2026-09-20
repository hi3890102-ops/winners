// Runs only against a throwaway PostgreSQL (the GitHub Actions service, or a disposable
// local PostgreSQL 17 on 127.0.0.1:5432). Never point it at Supabase: the URL is pinned
// below and the test creates and drops its own database (manee_self_profile_test).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const base=process.env.MANEE_TEST_DATABASE_URL;
test('Real PostgreSQL: competing approve_new calls create one crew row, copy the profile once and keep the salary', {skip:!base}, async()=>{
  assert.match(base,/^postgresql:\/\/postgres:[^@]+@(?:127\.0\.0\.1|localhost):5432\/manee_code_test$/);
  const dbName='manee_self_profile_test';
  const adminUrl=base.replace(/\/manee_code_test$/,'/postgres'),url=base.replace(/\/manee_code_test$/,'/'+dbName);
  function run(target,sql){return new Promise((resolve,reject)=>{
    const child=spawn('psql',[target,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
    let out='',err='';const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
    child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(new Error(err));});child.stdin.end(sql);
  });}
  await run(adminUrl,`drop database if exists ${dbName} with (force)`);
  await run(adminUrl,`create database ${dbName}`);
  try{
    // Roles are cluster-wide and may already exist from the store-code test.
    await run(url,`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    create schema auth;create table auth.users(id uuid primary key,email text,banned_until timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),created_at timestamptz default clock_timestamp(),updated_at timestamptz,not_after timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    grant usage on schema auth to anon,authenticated,service_role;`);
    const files=['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql','store-staff-link-code.sql','store-staff-new-employee-approval.sql','new-staff-self-profile.sql'];
    await run(url,files.map(x=>readFileSync(new URL(x,import.meta.url),'utf8')).join('\n'));
    const id=n=>'50000000-0000-4000-8000-'+String(n).padStart(12,'0');
    const owner=id(1),worker=id(2),sid=id(101);
    await run(url,`insert into auth.users(id) values('${owner}'),('${worker}');
      insert into auth.sessions(id,user_id) select id,id from auth.users;
      insert into public.profiles(user_id,username,display_name) values('${owner}','sp_owner','Owner'),('${worker}','sp_worker','New Worker');
      insert into public.stores(id,name) values('${sid}','Self profile concurrency store');
      insert into public.store_memberships(user_id,store_id,role) values('${owner}','${sid}','owner');
      insert into private.staff_registration_profiles(user_id,phone,bank_name,bank_account,account_holder)
        values('${worker}','010-0000-0000','테스트은행','000-123-4567','New Worker');`);
    const code=await run(url,`select staff_join_code from public.stores where id='${sid}'`);
    async function call(user,action,payload){
      const result=await run(url,`begin;set local statement_timeout='10s';
        select set_config('request.jwt.claim.sub','${user}',true);
        select set_config('request.jwt.claims','${JSON.stringify({sub:user,role:'authenticated',session_id:user})}',true);
        set local role authenticated;
        select public.manee_staff_portal('${action}','${JSON.stringify(payload)}'::jsonb);
        commit;`);
      return JSON.parse(result.split('\n').filter(x=>x.startsWith('{')).at(-1));
    }
    const requested=await call(worker,'request',{code});assert.equal(requested.ok,true);
    const approvals=await Promise.all(Array.from({length:8},()=>call(owner,'approve_new',{request_id:requested.request_id})));
    assert.ok(approvals.every(x=>x.ok===true),JSON.stringify(approvals));
    assert.equal(approvals.filter(x=>x.created_new===true).length,1);
    assert.equal(new Set(approvals.map(x=>x.crew_id)).size,1);
    assert.equal(await run(url,`select count(*) from public.crew where store_id='${sid}'`),'1');
    assert.equal(await run(url,`select phone||'|'||self_service_profile||'|'||employment_setup_required||'|'||bank_account from public.crew where store_id='${sid}'`),
      '010-0000-0000|true|true|테스트은행 / 000-123-4567 / New Worker');
    // Owner sets the wage; repeated or competing approvals must not reset it.
    await run(url,`update public.crew set wage=14000,employment_setup_required=false where store_id='${sid}'`);
    const retries=await Promise.all(Array.from({length:4},()=>call(owner,'approve_new',{request_id:requested.request_id})));
    assert.ok(retries.every(x=>x.ok===true&&x.created_new===false));
    assert.equal(await run(url,`select wage||'|'||employment_setup_required from public.crew where store_id='${sid}'`),'14000|false');
    assert.equal(await run(url,`select count(*) from public.store_memberships where user_id='${worker}'`),'1');
  }finally{
    await run(adminUrl,`drop database if exists ${dbName} with (force)`).catch(()=>{});
  }
});
