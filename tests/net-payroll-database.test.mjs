import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,created_at timestamptz default clock_timestamp(),updated_at timestamptz,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
grant usage on schema auth to anon,authenticated,service_role;`);
for(const file of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql'])await db.exec(fs.readFileSync(new URL('../security/'+file,import.meta.url),'utf8'));
await db.exec(`create table public.crew_pay_adjustments(id uuid primary key default gen_random_uuid(),store_id uuid not null references public.stores(id),crew_id uuid not null references public.crew(id),month_key text not null,type text not null,amount integer not null,memo text);
alter table public.crew_pay_adjustments enable row level security;
grant select,insert,update,delete on public.crew_pay_adjustments to authenticated;
create policy adjustments_manager on public.crew_pay_adjustments for all to authenticated using(private.can_manage_store(store_id)) with check(private.can_manage_store(store_id));
alter table public.vendors add column default_category text;
alter table public.expense_entries add column category text;`);
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002062518_net_payroll_and_unpaid_leave.sql',import.meta.url),'utf8'));
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

test('manager confirms actual net wage; server stamps identity and own staff has read-only access',async()=>{
 await role(owner);
 const r=(await db.query("insert into public.monthly_net_payroll(store_id,crew_id,month_key,net_pay,adjustment_snapshot) values($1,$2,'2026-10',2000000,'[[\"forged\"]]') returning *",[store,crew])).rows[0];
 assert.equal(r.confirmed_by,owner);assert.deepEqual(r.adjustment_snapshot,[]);
 await role(worker);assert.equal((await db.query('select * from public.monthly_net_payroll')).rows.length,1);
 assert.equal((await db.query("update public.monthly_net_payroll set net_pay=1 returning id")).rows.length,0);
 await assert.rejects(()=>db.query("insert into public.monthly_net_payroll(store_id,crew_id,month_key,net_pay) values($1,$2,'2026-09',1)",[store,crew]));
 await role(stranger);assert.equal((await db.query('select * from public.monthly_net_payroll')).rows.length,0);
});
test('positive advance and new half-day are rejected; hourly unpaid does not deduct wage again',async()=>{
 await role(owner);
 for(const [type,amount] of [['가불',1000],['반차',-1000]])await assert.rejects(()=>db.query("insert into public.crew_pay_adjustments(store_id,crew_id,month_key,type,amount) values($1,$2,'2026-10',$3,$4)",[store,crew,type,amount]));
 const r=(await db.query("insert into public.crew_pay_adjustments(store_id,crew_id,month_key,type,amount,unpaid_date) values($1,$2,'2026-10','무급휴가',-999999,'2026-10-01') returning amount",[store,crew])).rows[0];assert.equal(r.amount,0);
 await assert.rejects(()=>db.query("insert into public.crew_pay_adjustments(store_id,crew_id,month_key,type,amount,unpaid_date) values($1,$2,'2026-10','무급휴가',0,'2026-10-01')",[store,crew]));
});
test('server captures non-advance adjustments; audit cannot be edited or read by staff',async()=>{
 await role(owner);await db.query("update public.monthly_net_payroll set net_pay=2000001 where store_id=$1",[store]);
 const r=(await db.query('select * from public.monthly_net_payroll')).rows[0];assert.equal(r.adjustment_snapshot.length,1);
 assert.ok((await db.query('select * from public.payroll_change_log')).rows.length>=3);
 await assert.rejects(()=>db.query('delete from public.payroll_change_log'));
 await role(worker);assert.equal((await db.query('select * from public.payroll_change_log')).rows.length,0);
 await role(owner);await assert.rejects(()=>db.query("update public.monthly_net_payroll set paid_on='2099-01-01'"));
 await assert.rejects(()=>db.query("update public.monthly_net_payroll set crew_id=$1",[otherCrew]));
});
