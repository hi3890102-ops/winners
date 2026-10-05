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
await db.exec(`alter table public.crew add column if not exists employment_setup_required boolean default false not null;alter table public.sales_reports add column if not exists emoney_sales integer default 0;alter table public.expense_entries add column if not exists memo text;create table public.store_business_calendar(store_id uuid primary key,closed_weekdays integer[] default '{}',closed_dates date[] default '{}',open_dates date[] default '{}');`);
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002105522_financial_reports_and_franchise_privacy.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002110504_franchise_personal_data_boundary.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002112742_monthly_report_closing_revisions.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002132537_financial_report_safe_labels.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002134950_private_financial_rpc_cores.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261003111913_payroll_half_hour_floor.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261003114744_payroll_optional_hire_date.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261005113245_monthly_cost_reminders_report_details.sql',import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261005115540_monthly_costs_compatibility.sql',import.meta.url),'utf8'));
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


const cost=async(action,payload={},s=store,month='2026-09')=>(await db.query('select public.manee_cost_review($1,$2,$3,$4) r',[s,month,action,payload])).rows[0].r;
test('cost review rejects anonymous, staff, foreign stores and direct writes',async()=>{
 await role(worker);await assert.rejects(()=>cost('read'));
 await role(owner);await assert.rejects(()=>cost('read',{},otherStore));await assert.rejects(()=>cost('read',{},store,null));
 await assert.rejects(()=>db.query("insert into public.monthly_cost_reviews(store_id,month_key) values($1,'2026-09')",[store]));
 await db.exec('reset role');await db.exec('set role anon');await assert.rejects(()=>cost('read'));await role(owner);
});
test('new expense is atomic and idempotent; existing links never add money; signed and uncategorized amounts retained',async()=>{
 await role(owner);const payload={request_id:id(701),key:'water',date:'2026-09-15',name:'수리업체',memo:'수도꼭지 수리',amount:120000,category:null,recurrence:'none'};
 await cost('add',payload);await cost('add',payload);
 await assert.rejects(()=>cost('add',{...payload,amount:120001}));
 let rows=(await db.query('select * from public.expense_entries where store_id=$1',[store])).rows;assert.equal(rows.length,1);assert.equal(rows[0].amount,120000);
 await cost('link',{key:'electricity',expense_id:rows[0].id});assert.equal((await db.query('select count(*) n from public.expense_entries where store_id=$1',[store])).rows[0].n,1);
 await assert.rejects(()=>cost('add',{...payload,request_id:id(702),date:'2026-10-01'}));
 await assert.rejects(()=>cost('add',{...payload,request_id:id(703),key:'made-up'}));
 await cost('add',{request_id:id(704),date:'2026-09-16',name:'환입',amount:-10000,category:null});
 const preview=(await db.query("select public.manee_report_preview($1,'2026-09') r",[store])).rows[0].r;
 assert.equal(preview.status,'provisional');assert.equal(preview.snapshot.expenses_total,110000);assert.equal(preview.snapshot.expenses[0].memo,'수도꼭지 수리');assert.equal(preview.snapshot.expenses[0].category,null);
 await cost('skip',{key:'gas'});await cost('complete');assert.ok((await cost('read')).review.completed_at);
 await db.query('update public.expense_entries set amount=125000 where id=$1',[rows[0].id]);assert.equal((await cost('read')).review.completed_at,null);
});
test('link scope enforced; deleted entries become pending and cannot complete',async()=>{
 await db.exec('reset role');const e=(await db.query("insert into public.expense_entries(store_id,date,description,amount) values($1,'2026-09-01','other',999) returning id",[otherStore])).rows[0].id;
 await role(owner);await assert.rejects(()=>cost('link',{key:'gas',expense_id:e}));
 const mine=(await db.query('select id from public.expense_entries where store_id=$1 and amount=125000',[store])).rows[0].id;
 await db.query('delete from public.expense_entries where id=$1',[mine]);const r=await cost('read');assert.equal(r.checks.find(c=>c.key==='water').status,'pending');await assert.rejects(()=>cost('complete'));
});
test('fixed registration counts current month once and next month once across repeated preparation',async()=>{
 await role(owner);await cost('add',{request_id:id(710),date:'2026-09-20',name:'인터넷 요금',amount:35000,category:'utilities',recurrence:'fixed'});
 const r=await cost('read'),t=r.templates.find(t=>t.name==='인터넷 요금');assert.equal(t.start_month,'2026-10');
 await db.query("select public.manee_prepare_fixed_costs($1,'2026-09')",[store]);assert.equal((await db.query("select count(*) n from public.fixed_expenses where store_id=$1 and month_key='2026-09'",[store])).rows[0].n,0);
 await db.query("select public.manee_prepare_fixed_costs($1,'2026-10')",[store]);await db.query("select public.manee_prepare_fixed_costs($1,'2026-10')",[store]);
 const f=(await db.query("select * from public.fixed_expenses where store_id=$1 and month_key='2026-10'",[store])).rows;assert.equal(f.length,1);assert.equal(f[0].amount,35000);
 await assert.rejects(()=>cost('add',{request_id:id(711),date:'2026-09-21',name:'인터넷 요금',amount:35000,recurrence:'fixed'}));
 assert.equal((await db.query("select count(*) n from public.expense_entries where store_id=$1 and description='인터넷 요금'",[store])).rows[0].n,1);
 await cost('stop_template',{template_id:t.id});assert.equal((await cost('read')).templates.length,0);
});
test('variable recurring costs create a reminder without silently charging a prior amount',async()=>{
 await role(owner);await cost('add',{request_id:id(720),date:'2026-09-25',name:'청소비',amount:60000,recurrence:'variable'});
 const t=(await cost('read')).templates[0];assert.equal(t.mode,'variable');assert.equal(t.amount,null);await db.query("select public.manee_prepare_fixed_costs($1,'2026-10')",[store]);
 assert.equal((await db.query("select count(*) n from public.fixed_expenses where cost_template_id=$1",[t.id])).rows[0].n,0);
 for(const key of ['electricity','water','gas'])await cost('skip',{key},store,'2026-10');await assert.rejects(()=>cost('complete',{},store,'2026-10'));
 await cost('skip',{key:t.id},store,'2026-10');await cost('complete',{},store,'2026-10');
});
test('only a verified active owner device can be claimed and a repeated scheduled run cannot duplicate it',async()=>{
 await db.exec('reset role');
 const sub=(await db.query("insert into public.push_subscriptions(store_id,role,endpoint,p256dh,auth) values($1,'storeOwner','https://push.example.test/one','fake','fake') returning id",[store])).rows[0].id;
 await db.query("insert into public.sales_reports(store_id,date,total_sales) values($1,'2026-09-30',1000000)",[store]);
 // Explicit snooze for an older month is eligible even before the current month's D-7.
 await db.query("update public.monthly_cost_reviews set completed_at=null,remind_after=(now() at time zone 'Asia/Seoul')::date where store_id=$1 and month_key='2026-09'",[store]);
 await role(owner);await assert.rejects(()=>db.query('select public.manee_claim_cost_reminders()'));
 await db.exec('reset role');await db.query("select set_config('request.jwt.claim.role','service_role',false)");await db.exec('set role service_role');
 assert.equal((await db.query('select public.manee_claim_cost_reminders() r')).rows[0].r.length,0);
 await role(owner);await db.query("select public.manee_bind_owner_push('https://push.example.test/one',$1)",[store]);
 await db.exec('reset role');await db.query("select set_config('request.jwt.claim.role','service_role',false)");await db.exec('set role service_role');
 const first=(await db.query('select public.manee_claim_cost_reminders() r')).rows[0].r;assert.equal(first.length,1);assert.equal(first[0].month_key,'2026-09');assert.equal(first[0].subscription_id,sub);
 assert.equal((await db.query('select public.manee_claim_cost_reminders() r')).rows[0].r.length,0);
 await db.query('select public.manee_finish_cost_reminder($1,$2,$3,$4,$5)',[store,'2026-09',sub,first[0].send_date,'sent']);
});
