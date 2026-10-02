import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=n=>html.match(new RegExp('^  (?:async )?function '+n+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))[0];
const db=new PGlite();
await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,created_at timestamptz default clock_timestamp(),updated_at timestamptz,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
grant usage on schema auth to anon,authenticated,service_role;`);
for(const file of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql'])await db.exec(fs.readFileSync(new URL('../security/'+file,import.meta.url),'utf8'));
await db.exec(`create table public.hq_announcements(id uuid primary key default gen_random_uuid(),title text,body text,target_type text,target_id uuid,created_at timestamptz default now());alter table public.hq_announcements enable row level security;grant select on public.hq_announcements to authenticated;create policy hq_global on public.hq_announcements for select to authenticated using(target_type='all' and private.is_live_manee_session());`);
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002070643_store_calendar_and_owner_hq_notices.sql',import.meta.url),'utf8'));
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=id(1),worker=id(2),stranger=id(3),store=id(101),otherStore=id(102),crew=id(201),otherCrew=id(202);
await db.exec(`insert into auth.users(id) values('${owner}'),('${worker}'),('${stranger}');
insert into auth.sessions(id,user_id) select id,id from auth.users;
insert into public.profiles(user_id,username,display_name) values('${owner}','owner','Owner'),('${worker}','worker','Worker'),('${stranger}','stranger','Stranger');
insert into public.stores(id,name) values('${store}','Synthetic A'),('${otherStore}','Synthetic B');
insert into public.crew(id,store_id,name,join_code,wage) values('${crew}','${store}','Synthetic staff','A2B3C4D5',10000),('${otherCrew}','${otherStore}','Other staff','E6F7G8H9',10000);
insert into public.store_memberships(user_id,store_id,role,crew_id) values('${owner}','${store}','owner',null),('${worker}','${store}','staff','${crew}'),('${stranger}','${otherStore}','staff','${otherCrew}');`);
async function role(user){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claims',$2,false)",[user,JSON.stringify({sub:user,session_id:user,role:'authenticated'})]);await db.exec('set role authenticated');}
after(()=>db.close());


test('weekly closure and special open overrides do not invent closed-day sales',()=>{
 const c=vm.createContext({});vm.runInContext(fn('storeClosedOn'),c);
 const calendar={closed_weekdays:[0],closed_dates:['2026-10-02'],open_dates:['2026-10-04']};
 assert.equal(c.storeClosedOn('2026-10-02',calendar),true);assert.equal(c.storeClosedOn('2026-10-04',calendar),false);assert.equal(c.storeClosedOn('2026-10-11',calendar),true);assert.equal(c.storeClosedOn('2026-10-03',calendar),false);
});
test('calendar manager write, member read-only, foreign store isolation and constraints',async()=>{
 await role(owner);await db.query("insert into public.store_business_calendar(store_id,closed_weekdays) values($1,array[0,6])",[store]);
 await assert.rejects(()=>db.query("update public.store_business_calendar set closed_weekdays=array[7]"));
 await role(worker);assert.equal((await db.query('select * from public.store_business_calendar')).rows.length,1);assert.equal((await db.query("update public.store_business_calendar set closed_weekdays='{}' returning store_id")).rows.length,0);
 await role(stranger);assert.equal((await db.query('select * from public.store_business_calendar')).rows.length,0);
});
test('HQ notices reach target-store members but exclude unrelated members',async()=>{
 await db.exec('reset role');await db.query("insert into public.hq_announcements(title,target_type,target_id) values('target','store',$1),('other','store',$2)",[store,otherStore]);
 await role(owner);assert.deepEqual((await db.query('select title from public.hq_announcements')).rows.map(r=>r.title),['target']);
 await role(worker);assert.deepEqual((await db.query('select title from public.hq_announcements')).rows.map(r=>r.title),['target']);
 await role(stranger);assert.deepEqual((await db.query('select title from public.hq_announcements')).rows.map(r=>r.title),['other']);
});
