// Disposable local PostgreSQL only; never connects to Supabase or sends notifications.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const base=process.env.MANEE_TEST_DATABASE_URL;
test('Real PostgreSQL: twelve phones record exactly one clock-in and clock-out; owner and staff share the result',{skip:!base},async()=>{
  assert.match(base,/^postgresql:\/\/postgres:[^@]+@(?:127\.0\.0\.1|localhost):5432\/manee_code_test$/);
  const database='manee_attendance_test',admin=base.replace(/\/manee_code_test$/,'/postgres'),url=base.replace(/\/manee_code_test$/,'/'+database);
  function run(target,sql){return new Promise((resolve,reject)=>{
    const child=spawn('psql',[target,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(new Error(err));});child.stdin.end(sql);
  });}
  await run(admin,`drop database if exists ${database} with (force)`);await run(admin,`create database ${database}`);
  try{
    const fixture=readFileSync(new URL('./staff-auth-database.test.mjs',import.meta.url),'utf8').match(/await db\.exec\(`([\s\S]*?)`\);/)[1];
    const roles=`do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
    end $$;`;
    await run(url,roles+fixture.replace(/^create role anon[^\n]*\n/,''));
    for(const name of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql'])await run(url,readFileSync(new URL(name,import.meta.url),'utf8'));
    // Exercise the production clock implementation, including the live-session check.
    const production=readFileSync(new URL('./staff-auth-production-foundation.sql',import.meta.url),'utf8');
    const clock=production.match(/create function private\.staff_clock\([\s\S]*?\n\$\$;/)[0].replace('create function','create or replace function');await run(url,clock);
    const id=n=>'70000000-0000-4000-8000-'+String(n).padStart(12,'0'),owner=id(1),worker=id(2),store=id(101),crew=id(201);
    await run(url,`insert into auth.users(id) values('${owner}'),('${worker}');insert into auth.sessions(id,user_id) select id,id from auth.users;
      insert into public.profiles(user_id,username,display_name) values('${owner}','attendance_owner','Synthetic owner'),('${worker}','attendance_worker','Synthetic worker');
      insert into public.stores(id,name,lat,lng) values('${store}','Synthetic clock store',37.5,127);
      insert into public.crew(id,store_id,name,wage) values('${crew}','${store}','Synthetic employee',12000);
      insert into public.store_memberships(user_id,store_id,role,crew_id) values('${owner}','${store}','owner',null),('${worker}','${store}','staff','${crew}');`);
    async function as(user,sql){const output=await run(url,`begin;set local statement_timeout='10s';select set_config('request.jwt.claim.sub','${user}',true);select set_config('request.jwt.claim.role','authenticated',true);select set_config('request.jwt.claims','${JSON.stringify({sub:user,role:'authenticated',session_id:user})}',true);set local role authenticated;${sql};commit;`);return JSON.parse(output.split('\n').filter(x=>x.startsWith('{')).at(-1));}
    const ins=await Promise.allSettled(Array.from({length:12},()=>as(worker,`select to_jsonb(public.clock_in('${store}',37.5,127))`)));
    assert.equal(ins.filter(r=>r.status==='fulfilled').length,1);for(const r of ins.filter(r=>r.status==='rejected'))assert.match(r.reason.message,/Already clocked in/);
    const record=ins.find(r=>r.status==='fulfilled').value;assert.equal(record.crew_id,crew);assert.equal(await run(url,'select count(*) from public.attendance'),'1');
    const outs=await Promise.allSettled(Array.from({length:12},()=>as(worker,`select to_jsonb(public.clock_out('${record.id}',37.5,127))`)));
    assert.equal(outs.filter(r=>r.status==='fulfilled').length,1);for(const r of outs.filter(r=>r.status==='rejected'))assert.match(r.reason.message,/Already clocked out/);
    const reviewed=await as(owner,`with changed as (update public.attendance set check_in='09:00',check_out='18:30',confirmed=true,time_edited=true,staff_ack_edit=false where id='${record.id}' returning *) select to_jsonb(changed) from changed`);
    assert.equal(reviewed.confirmed,true);const acknowledged=await as(worker,`select to_jsonb(public.confirm_my_attendance('${record.id}'))`);assert.equal(acknowledged.check_out,'18:30:00');assert.equal(acknowledged.staff_ack_edit,true);
    const visible=await as(owner,`select to_jsonb(a) from public.attendance a where id='${record.id}'`);assert.equal(visible.staff_ack_edit,true);assert.equal(await run(url,'select count(*) from public.attendance'),'1');
  }finally{await run(admin,`drop database if exists ${database} with (force)`);}
});
