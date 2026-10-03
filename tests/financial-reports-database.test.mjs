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


test('financial report nets discounts/refunds, net wage, expenses and fixed costs exactly once',async()=>{
 await db.exec('reset role');await db.query("insert into public.sales_reports(store_id,date,total_sales,discount,refund) values($1,'2026-09-01',1000000,100000,50000)",[store]);
 await db.query("insert into public.expense_entries(store_id,date,description,amount,category,memo) values($1,'2026-09-01','보험료',100000,'insurance','Private memo excluded')",[store]);
 await db.query("insert into public.fixed_expenses(store_id,month_key,name,amount) values($1,'2026-09','임대료',200000)",[store]);
 await role(owner);await db.query("insert into public.monthly_net_payroll(store_id,crew_id,month_key,net_pay) values($1,$2,'2026-09',300000)",[store,crew]);
 const r=(await db.query("select public.manee_financial_report($1,'2026-09') as r",[store])).rows[0].r;
 assert.equal(r.gross_sales,1000000);assert.equal(r.net_sales,850000);assert.equal(r.net_payroll,300000);assert.equal(r.profit,250000);assert.equal(r.labor_ratio,30);
 await db.exec('reset role');await db.query("insert into public.crew(id,store_id,name,join_code,wage,wage_type,hire_date) values($1,$2,'Second hourly worker','SECOND01',10000,'hourly','2026-01-01')",[id(203),store]);await role(owner);
 assert.equal((await db.query("select public.manee_financial_report($1,'2026-09') as r",[store])).rows[0].r.payroll_status.estimated_count,1);
 assert.equal(JSON.stringify(r).includes('Synthetic staff'),false);assert.equal(JSON.stringify(r).includes('Private memo'),false);assert.equal(r.expenses[0].description,'보험료');
 await db.exec('reset role');assert.equal((await db.query("select private.financial_label($1,'Synthetic staff 급여') as label",[store])).rows[0].label,'[개인정보 포함 항목]');await role(owner);
 await role(stranger);await assert.rejects(()=>db.query("select public.manee_financial_report($1,'2026-09')",[store]));
});
test('franchise RPC is brand scoped and never returns employee/owner fields',async()=>{
 await db.exec('reset role');const brand=id(301),foreign=id(302);
 await db.query("insert into public.franchises(id,name,username,password_hash) values($1,'Test Brand','brand','unused'),($2,'Other Brand','otherbrand','unused')",[brand,foreign]);
 await db.query('update public.stores set franchise_id=$1 where id=$2',[brand,store]);
 await db.query("insert into public.franchise_memberships(user_id,franchise_id,role,status) values($1,$2,'admin','active')",[stranger,brand]);
 await role(stranger);const r=(await db.query("select public.manee_franchise_financials($1,'2026-09') as r",[brand])).rows[0].r;
 assert.equal(r.stores.length,1);assert.equal(r.stores[0].store_id,store);assert.equal(r.stores[0].profit,250000);
 assert.equal((await db.query('select * from public.crew where store_id=$1',[store])).rows.length,0);
 assert.equal((await db.query('select * from public.stores where id=$1',[store])).rows.length,0);
 assert.equal((await db.query('select * from public.sales_reports where store_id=$1',[store])).rows.length,0);
 for(const key of ['owner_username','ownerDisplayName','phone','bank_account','crew_id','resident_number'])assert.equal(JSON.stringify(r).includes(key),false,key);
 await assert.rejects(()=>db.query("select public.manee_franchise_financials($1,'2026-09')",[foreign]));
});

test('closing requires confirmed actual payroll and full open-day reports; revisions are immutable and retry idempotent',async()=>{
 await role(owner);const request=id(401);
 await assert.rejects(()=>db.query("select public.manee_close_month($1,'2026-09',$2,null)",[store,request]));
 await db.query("insert into public.monthly_net_payroll(store_id,crew_id,month_key,net_pay) values($1,$2,'2026-09',0)",[store,id(203)]);
 await assert.rejects(()=>db.query("select public.manee_close_month($1,'2026-09',$2,null)",[store,request]));
 await db.exec('reset role');await db.query("insert into public.store_business_calendar(store_id,closed_weekdays) values($1,array[0,1,2,3,4,5,6])",[store]);await role(owner);
 const first=(await db.query("select public.manee_close_month($1,'2026-09',$2,null) as r",[store,request])).rows[0].r;assert.equal(first.revision,1);assert.equal(first.snapshot.profit,250000);
 await db.query("insert into public.expense_entries(store_id,date,description,amount,category) values($1,'2026-09-02','insurance',100000,'insurance')",[store]);
 const retry=(await db.query("select public.manee_close_month($1,'2026-09',$2,null) as r",[store,request])).rows[0].r;assert.equal(retry.id,first.id);assert.equal(retry.snapshot.profit,250000);
 await assert.rejects(()=>db.query("select public.manee_close_month($1,'2026-09',$2,null)",[store,id(402)]));
 const amended=(await db.query("select public.manee_close_month($1,'2026-09',$2,'보험료 누락 정정') as r",[store,id(403)])).rows[0].r;assert.equal(amended.revision,2);assert.equal(amended.snapshot.profit,150000);
 await assert.rejects(()=>db.query('update public.monthly_report_closings set snapshot=$1',[{}]));await assert.rejects(()=>db.query('delete from public.monthly_report_closings'));
 const restored=(await db.query('select public.manee_closed_report($1) as r',[first.id])).rows[0].r;assert.equal(restored.snapshot.profit,250000);assert.equal(Object.hasOwn(restored,'closed_by'),false);
 assert.equal((await db.query('select public.manee_report_history($1) as r',[store])).rows[0].r.length,2);
 await role(worker);await assert.rejects(()=>db.query("select public.manee_close_month($1,'2026-09',$2,'staff denied')",[store,id(404)]));
});

test('financial RPC endpoints are invoker wrappers; private cores preserve explicit identity checks and deny anon',async()=>{
 await db.exec('reset role');const rows=(await db.query("select n.nspname,p.proname,p.prosecdef,pg_get_functiondef(p.oid) definition,has_function_privilege('anon',p.oid,'EXECUTE') anon_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('manee_financial_report','manee_franchise_financials','manee_franchise_directory','manee_close_month','manee_report_history','manee_closed_report')")).rows;
 assert.equal(rows.length,12);for(const r of rows){assert.equal(r.prosecdef,r.nspname==='private');assert.equal(r.anon_execute,false);if(r.nspname==='private')assert.ok(r.definition.includes('auth.uid() is null'));}
});

test('SQL floors each shift including seconds and overnight, matching JS in owner/franchise reports',async()=>{
 await db.exec('reset role');
 const s=id(501),c=id(502);
 await db.query("insert into public.stores(id,name,franchise_id) values($1,'Half-hour test',$2)",[s,id(301)]);
 await db.query("insert into public.crew(id,store_id,name,join_code,wage,wage_type,hire_date) values($1,$2,'Synthetic hourly','HALFHOUR',10000,'hourly','2026-01-01')",[c,s]);
 await db.query("insert into public.store_memberships(user_id,store_id,role) values($1,$2,'owner')",[owner,s]);
 const cases=[['09:00:50','09:30:00',0],['09:00','09:29:59.999999',0],['09:00','09:30',5000],['09:00','09:59:59',5000],['23:45','01:14:59',10000]];
 for(const [cin,cout,pay] of cases){
  await db.query('delete from public.attendance where store_id=$1',[s]);
  await db.query("insert into public.attendance(store_id,crew_id,date,check_in,check_out,confirmed) values($1,$2,'2026-09-01',$3,$4,true)",[s,c,cin,cout]);
  const r=(await db.query("select private.net_payroll_totals($1,'2026-09','2026-10-03') r",[s])).rows[0].r;
  assert.equal(r.net_pay,pay,cin+'–'+cout);assert.equal(r.unknown_count,0);
 }
 await db.query('delete from public.attendance where store_id=$1',[s]);
 for(let day=1;day<=2;day++)await db.query("insert into public.attendance(store_id,crew_id,date,check_in,check_out,confirmed) values($1,$2,$3,'09:00','09:29',true)",[s,c,`2026-09-0${day}`]);
 assert.equal((await db.query("select private.net_payroll_totals($1,'2026-09','2026-10-03') r",[s])).rows[0].r.net_pay,0);
 await db.query("insert into public.attendance(store_id,crew_id,date,check_in,check_out,confirmed) values($1,$2,'2026-09-03','09:00','09:59:59',true),($1,$2,'2026-09-04','09:00','19:00',false),($1,$2,'2026-08-31','09:00','19:00',true)",[s,c]);
 await role(owner);
 assert.equal((await db.query("select public.manee_financial_report($1,'2026-09') r",[s])).rows[0].r.net_payroll,5000);
 await role(stranger);
 const franchise=(await db.query("select public.manee_franchise_financials($1,'2026-09') r",[id(301)])).rows[0].r;
 assert.equal(franchise.stores.find(x=>x.store_id===s).net_payroll,5000);
 await role(owner);await db.query("insert into public.monthly_net_payroll(store_id,crew_id,month_key,net_pay) values($1,$2,'2026-09',12345)",[s,c]);
 assert.equal((await db.query("select public.manee_financial_report($1,'2026-09') r",[s])).rows[0].r.net_payroll,12345);
 await db.exec('reset role');await db.query('delete from public.monthly_net_payroll where store_id=$1',[s]);await db.query('update public.crew set wage=0 where id=$1',[c]);
 await db.query('delete from public.attendance where store_id=$1',[s]);
 await db.query("insert into public.attendance(store_id,crew_id,date,check_in,check_out,confirmed) values($1,$2,'2026-09-01','09:00','09:10',true)",[s,c]);
 const unknown=(await db.query("select private.net_payroll_totals($1,'2026-09','2026-10-03') r",[s])).rows[0].r;
 assert.equal(unknown.unknown_count,1);assert.equal(unknown.net_pay,null);
 for(const role of ['anon','authenticated'])assert.equal((await db.query("select has_function_privilege($1,'private.net_payroll_totals(uuid,text,date)','EXECUTE') allowed",[role])).rows[0].allowed,false);
});
