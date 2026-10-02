import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=name=>html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))[0];
function ui(){
 const row={id:'r1',date:'2026-10-01',crewId:'c1',start:'10:00',end:'18:00'};
 const state={shifts:[row],crew:[{id:'c1'}],selectedDate:'2026-10-01',editShiftId:'r1',authProfile:{user_id:'u1'}};
 let sid='s1',reply={data:[{id:'r1',date:'2026-10-01',crew_id:'c1',start_time:'11:00',end_time:'19:00'}]},pending;
 const calls=[],messages=[];
 const q={update:p=>{calls.push(['update',p]);return q;},insert:p=>{calls.push(['insert',p]);return q;},delete:()=>{calls.push(['delete']);return q;},eq:(...a)=>{calls.push(['eq',...a]);return q;},select:()=>pending?new Promise(r=>pending.resolve=r):Promise.resolve(reply)};
 const c=vm.createContext({state,maneeViewEpoch:1,currentStoreId:()=>sid,canEditStoreSchedule:()=>true,isCrewActive:()=>true,
   document:{getElementById:()=>({value:'c1'})},readTimeSelect:n=>n.endsWith('start')?'11:00':'19:00',db:{from:()=>q},
   checkedBusinessMutation:async promise=>{const r=await promise;if(r.error)throw r.error;if(r.data?.length!==1)throw Error('no row');return r.data[0];},render(){},showToast:m=>messages.push(m),askConfirm:(_,cb)=>cb()});
 vm.runInContext(['scheduleMutationGuard','addShift','deleteShift'].map(fn).join('\n'),c);
 return {c,state,row,calls,messages,reply:r=>reply=r,defer:()=>pending={},resolve:r=>pending.resolve(r),switch:()=>sid='s2'};
}
test('schedule update keeps employee identity and scopes record to current store',async()=>{
 const h=ui();await h.c.addShift();assert.equal(h.row.start,'11:00');assert.equal(h.state.shifts.length,1);
 assert.equal(Object.hasOwn(h.calls.find(c=>c[0]==='update')[1],'crew_id'),false);
 assert.ok(h.calls.some(c=>c[0]==='eq'&&c[1]==='store_id'&&c[2]==='s1'));
});
test('failed/zero-row schedule saves retain original data and editing state',async()=>{
 for(const reply of [{error:Error('offline')},{data:[]}]){const h=ui();h.reply(reply);await h.c.addShift();assert.equal(h.row.start,'10:00');assert.equal(h.state.editShiftId,'r1');assert.ok(h.messages.length);}
});
test('duplicate schedule submissions and stale replies cannot change next store UI',async()=>{
 const h=ui();h.defer();const p=h.c.addShift();await h.c.addShift();assert.equal(h.calls.filter(c=>c[0]==='update').length,1);h.switch();
 h.resolve({data:[{id:'r1',date:'2026-10-01',crew_id:'c1',start_time:'11:00',end_time:'19:00'}]});await p;assert.equal(h.row.start,'10:00');
});
test('failed schedule deletion never removes existing row',async()=>{
 const h=ui();h.reply({data:[]});h.c.deleteShift('r1');await new Promise(r=>setImmediate(r));assert.equal(h.state.shifts.length,1);assert.ok(h.messages.length);
});
test('ordinary employee shared schedule UI contains colleagues and editing but no attendance controls',()=>{
 const state={role:'staff',monthYear:2026,monthNum:10,selectedDate:'2026-10-01',shifts:[],crew:[{id:'c1',name:'동료',position:'홀'}],attendance:[],sharedScheduleView:true};
 const c=vm.createContext({state,canManageBusinessData:()=>false,daysInMonth:()=>31,firstWeekdayMon0:()=>3,bizToday:()=> '2026-10-01',pad:n=>String(n).padStart(2,'0'),
 shiftsOnDate:()=>[],renderShiftsGrouped:()=>'',isCrewActive:()=>true,escapeHtml:s=>s,timeSelectHtml:id=>'<input id="'+id+'">'});
 vm.runInContext(fn('renderCalendar')+'\n'+fn('renderStaffSchedule'),c);const view=c.renderStaffSchedule(null,true);
 assert.ok(view.includes('shift-crew-select'));assert.ok(view.includes('동료'));assert.ok(view.includes('add-shift-btn'));
 assert.equal(/manual-att|confirmatt|출퇴근 기록|open-fixed-btn/.test(view),false);
});

const db=new PGlite();
await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
create schema auth;create table auth.users(id uuid primary key,email text,banned_until timestamptz);
create table auth.sessions(id uuid primary key,user_id uuid,created_at timestamptz default clock_timestamp(),updated_at timestamptz,not_after timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
grant usage on schema auth to anon,authenticated,service_role;`);
for(const file of ['fixtures/staging-baseline.sql','staff-auth.sql','account-recovery.sql','store-permissions.sql'])await db.exec(fs.readFileSync(new URL('../security/'+file,import.meta.url),'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261002034541_shared_store_schedules.sql',import.meta.url),'utf8'));
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
test('ordinary employee can create/edit own-store schedule; audit is manager-only and append-only',async()=>{
 await role(worker);const row=(await db.query(`insert into public.shifts(store_id,crew_id,date,start_time,end_time) values($1,$2,'2026-10-01','10:00','18:00') returning id`,[store,crew])).rows[0];
 await db.query("update public.shifts set end_time='19:00' where id=$1",[row.id]);
 assert.equal((await db.query('select * from public.schedule_change_log')).rows.length,0);
 await assert.rejects(()=>db.query("insert into public.schedule_change_log(store_id,shift_id,action) values($1,$2,'DELETE')",[store,row.id]));
 await role(owner);const logs=(await db.query('select action from public.schedule_change_log order by id')).rows;
 assert.deepEqual(logs.map(l=>l.action),['INSERT','UPDATE']);
 await assert.rejects(()=>db.query('delete from public.schedule_change_log'));
 await db.exec('reset role');
});
test('other-store employees cannot insert or update foreign schedules',async()=>{
 await role(stranger);await assert.rejects(()=>db.query("insert into public.shifts(store_id,crew_id,date,start_time,end_time) values($1,$2,'2026-10-02','10:00','18:00')",[store,crew]));
 assert.equal((await db.query("update public.shifts set start_time='12:00' where store_id=$1 returning id",[store])).rows.length,0);
 await role(worker);await assert.rejects(()=>db.query("insert into public.shifts(store_id,crew_id,date,start_time,end_time) values($1,$2,'2026-10-02','10:00','18:00')",[store,otherCrew]));
 await db.exec('reset role');
});
test('expired sessions cannot write schedules and schedule permission does not grant attendance confirmation',async()=>{
 await role(worker);await assert.rejects(()=>db.query("insert into public.attendance(store_id,crew_id,date,check_in,confirmed) values($1,$2,'2026-10-03','10:00',true)",[store,crew]));
 await db.exec('reset role');await db.query('delete from auth.sessions where user_id=$1',[worker]);await role(worker);
 await assert.rejects(()=>db.query("insert into public.shifts(store_id,crew_id,date,start_time,end_time) values($1,$2,'2026-10-03','10:00','18:00')",[store,crew]));await db.exec('reset role');
});
test('exact SQL role rehearsal validates real migration and rolls back synthetic rows',async()=>{
 const before=(await db.query('select count(*)::int n from public.schedule_change_log')).rows[0].n;
 await db.exec(fs.readFileSync(new URL('../security/shared-schedules-live-rollback.sql',import.meta.url),'utf8'));
 assert.equal((await db.query('select count(*)::int n from public.schedule_change_log')).rows[0].n,before);
 assert.equal((await db.query("select count(*)::int n from public.stores where name='Synthetic schedule QA'")).rows[0].n,0);
});
