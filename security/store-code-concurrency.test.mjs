// Runs only against the throwaway PostgreSQL service created by GitHub Actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const url=process.env.MANEE_TEST_DATABASE_URL;
test('Real PostgreSQL: concurrent store allocation, duplicate requests, competing approvals and rollback', {skip:!url}, async()=>{
  assert.match(url,/^postgresql:\/\/postgres:[^@]+@(?:127\.0\.0\.1|localhost):5432\/manee_code_test$/);
  async function run(sql){return new Promise((resolve,reject)=>{
    const child=spawn('psql',[url,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
    let out='',err='';const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
    child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(out.trim()):reject(new Error(err));});child.stdin.end(sql);
  });}
  const source=readFileSync(new URL('./store-staff-link-code-database.test.mjs',import.meta.url),'utf8');
  const bootstrap=source.match(/await db\.exec\(`([\s\S]*?)`\);/)[1];
  const files=['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql','support-password-recovery.sql','store-staff-link-code.sql'];
  await run(bootstrap+files.map(x=>readFileSync(new URL(x,import.meta.url),'utf8')).join('\n'));
  const id=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
  const owner=id(1),a=id(2),b=id(3),sid=id(101),cid=id(201);
  await run(`insert into auth.users(id) values('${owner}'),('${a}'),('${b}');
    insert into auth.sessions(id,user_id) select id,id from auth.users;
    insert into public.profiles(user_id,username,display_name) values('${owner}','concurrent_owner','Owner'),('${a}','concurrent_a','A'),('${b}','concurrent_b','B');
    insert into public.stores(id,name) values('${sid}','Concurrent test store');
    insert into public.store_memberships(user_id,store_id,role) values('${owner}','${sid}','owner');
    insert into public.crew(id,store_id,name,wage) values('${cid}','${sid}','Original employee',15000);`);
  const code=await run(`select staff_join_code from public.stores where id='${sid}'`);
  const allocated=await Promise.all(Array.from({length:12},(_,i)=>run(`insert into public.stores(name) values('Parallel ${i}') returning staff_join_code`)));
  assert.equal(new Set([...allocated,code]).size,13);
  for(const value of allocated)assert.match(value,/^[A-HJ-NP-Z2-9]{8}$/);
  async function call(user,action,payload){
    const result=await run(`begin;set local statement_timeout='10s';
      select set_config('request.jwt.claim.sub','${user}',true);
      select set_config('request.jwt.claims','${JSON.stringify({sub:user,role:'authenticated',session_id:user})}',true);
      set local role authenticated;
      select public.manee_staff_portal('${action}','${JSON.stringify(payload)}'::jsonb);
      commit;`);
    return JSON.parse(result.split('\n').filter(x=>x.startsWith('{')).at(-1));
  }
  const requests=await Promise.all(Array.from({length:6},()=>call(a,'request',{code})));
  assert.ok(requests.every(x=>x.ok));assert.equal(new Set(requests.map(x=>x.request_id)).size,1);
  const second=await call(b,'request',{code});assert.equal(second.ok,true);
  const competing=await Promise.all([call(owner,'approve',{request_id:requests[0].request_id,crew_id:cid}),call(owner,'approve',{request_id:second.request_id,crew_id:cid})]);
  assert.equal(competing.filter(x=>x.ok).length,1);assert.equal(competing.find(x=>!x.ok).error,'record_already_linked');
  assert.equal(await run(`select count(*) from public.store_memberships where crew_id='${cid}'`),'1');
  const rotation=await call(owner,'regenerate_store_code',{store_id:sid});assert.notEqual(rotation.store_join_code,code);
  assert.equal((await call(b,'preview',{code})).error,'invalid_code');
  const before=await run('select count(*) from public.store_memberships');
  await run(readFileSync(new URL('./store-staff-link-code-rollback.sql',import.meta.url),'utf8'));
  assert.equal(await run('select count(*) from public.store_memberships'),before);
  await run(readFileSync(new URL('./store-staff-link-code.sql',import.meta.url),'utf8'));
  assert.equal(await run(`select staff_join_code from public.stores where id='${sid}'`),rotation.store_join_code);
  assert.equal((await call(b,'preview',{code})).error,'invalid_code');
});
