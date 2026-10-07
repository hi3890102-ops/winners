import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fn(name){return html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))?.[0]||'';}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const saved={id:'att',store_id:'s1',crew_id:'c1',date:'2026-10-06',check_in:'09:00:59',check_out:'17:30:01',confirmed:false,staff_confirmed:false};
function setup(options={}){
  const state={role:'storeOwner',store:'A',storeIdMap:{A:'s1',B:'s2'},authProfile:{user_id:'u1'},myCrewId:'c1',crew:[{id:'c1'}],attendance:[{id:'att',crewId:'c1',date:saved.date,checkIn:'09:00',checkOut:'17:30',checkInExact:saved.check_in,checkOutExact:saved.check_out,confirmed:false}],selectedDate:saved.date,monthYear:2026,monthNum:10,...options.state};
  const calls=[],messages=[],controls={},pending=[];
  const context={state,MANEE_STAFF_AUTH_ENABLED:true,console,Date,Set,Map,
    currentStoreId:()=>state.storeIdMap[state.store],monthKey:()=>`${state.monthYear}-${String(state.monthNum).padStart(2,'0')}`,
    canManageBusinessData:()=>state.role==='storeOwner',render:()=>calls.push({render:true}),showToast:t=>messages.push(t),businessError:e=>messages.push(e.message||'권한 오류'),
    staffErrorMessage:e=>e.message||'권한 오류',clearStaffAuthView:()=>{calls.push({cleared:true});state.role='landing';state.attendance=[];},
    readTimeSelect:id=>options.times?.[id]??(id.endsWith('-in')?'09:00':'18:00'),
    askConfirm:(_,cb)=>{const p=cb();pending.push(p);return p;},
    document:{getElementById:id=>controls[id]??(id==='manual-att-crew-select'?{value:'c1'}:null)},
    navigator:{geolocation:{getCurrentPosition:resolve=>resolve({coords:{latitude:37.5,longitude:127}})}},
    db:{from(table){const call={table,filters:[]};const q={update(payload){call.payload=payload;call.action='update';calls.push(call);return q;},insert(payload){call.payload=payload;call.action='insert';calls.push(call);return q;},delete(){call.action='delete';calls.push(call);return q;},eq(...args){call.filters.push(args);return q;},select(){return q;},single(){return q;},then(resolve,reject){const result=options.result??{data:[{...saved,...call.payload}],error:null};return Promise.resolve(typeof result==='function'?result(call):result).then(resolve,reject);}};return q;},
      rpc(name,args){calls.push({rpc:name,args});return Promise.resolve(options.rpcResult??{data:saved,error:null});}}
  };
  vm.createContext(context);
  const names=['businessContextGuard','checkedBusinessMutation','applyStaffAttendance','staffCoordinates','staffAttendanceGuard','setStaffClockBusy','clockAuthStaff','confirmAuthAttendance','requestAuthAttendanceEdit','findOpenAttendance','attendanceMutationGuard','invalidateFinancialViews','mutateAttendance','isValidTimeStr','isAttendanceDate','addManualAttendance','updateAttendanceField','toggleAttendanceConfirm','deleteAttendanceRecord','confirmMyAttendance','bindAttConfirmPrompt'];
  vm.runInContext('let maneeViewEpoch=0; const attendanceMutationLocks=new Set();\n'+names.map(fn).join('\n'),context);
  return {context,state,calls,messages,controls,pending};
}
for(const action of ['confirm','time','delete'])for(const failure of ['error','zero rows'])test(`${action}: ${failure} leaves attendance unchanged`,async()=>{
  const h=setup({result:failure==='error'?{error:{message:'offline'},data:null}:{data:[],error:null}}),before=JSON.stringify(h.state.attendance);
  if(action==='confirm')await h.context.toggleAttendanceConfirm('att');
  if(action==='time')await h.context.updateAttendanceField('att','checkIn','10:00');
  if(action==='delete'){h.context.deleteAttendanceRecord('att');await Promise.all(h.pending);}
  await new Promise(r=>setImmediate(r));
  assert.equal(JSON.stringify(h.state.attendance),before);assert.ok(h.messages.length);
});
test('saved time updates exact payroll time and invalidates financial summaries',async()=>{
  const h=setup({state:{dashboardData:{old:true},vatData:{old:true}},result:{data:[{...saved,check_in:'10:00:00',time_edited:true,staff_ack_edit:false}],error:null}});
  await h.context.updateAttendanceField('att','checkIn','10:00');
  const row=h.state.attendance[0];assert.equal(row.checkIn,'10:00');assert.equal(row.checkInExact,'10:00:00');assert.equal(row.timeEdited,true);assert.equal(h.state.dashboardData,null);
  const call=h.calls.find(c=>c.action);assert.ok(call.filters.some(([k,v])=>k==='store_id'&&v==='s1'));
});
test('manual attendance refuses empty, malformed and equal times and impossible dates',async()=>{
  for(const [start,end,date] of [['','18:00',saved.date],['25:00','18:00',saved.date],['09:00','09:00',saved.date],['09:00','18:00','2026-02-30']]){
    const h=setup({times:{'manual-att-in':start,'manual-att-out':end},state:{selectedDate:date}});await h.context.addManualAttendance();assert.equal(h.calls.some(c=>c.action),false);assert.ok(h.messages.length);
  }
});
test('manual attendance ignores double taps while the insert is pending',async()=>{
  const d=deferred(),h=setup({result:d.promise});const first=h.context.addManualAttendance();const second=h.context.addManualAttendance();
  assert.equal(h.calls.filter(c=>c.action==='insert').length,1);d.resolve({data:[{...saved,id:'manual',confirmed:true}],error:null});await Promise.all([first,second]);assert.equal(h.state.attendance.length,2);
});
test('confirmation ignores double taps and changes state only after server success',async()=>{
  const d=deferred(),h=setup({result:d.promise});const first=h.context.toggleAttendanceConfirm('att'),second=h.context.toggleAttendanceConfirm('att');
  assert.equal(h.calls.filter(c=>c.action).length,1);assert.equal(h.state.attendance[0].confirmed,false);
  d.resolve({data:[{...saved,confirmed:true}],error:null});await Promise.all([first,second]);assert.equal(h.state.attendance[0].confirmed,true);
});
test('late attendance save cannot replace the next account or store data',async()=>{
  const d=deferred(),h=setup({result:d.promise});const task=h.context.updateAttendanceField('att','checkIn','10:00');
  h.state.store='B';h.state.authProfile={user_id:'u2'};h.state.attendance=[{id:'new'}];d.resolve({data:[{...saved,check_in:'10:00:00'}],error:null});await task;
  assert.deepEqual(h.state.attendance,[{id:'new'}]);assert.equal(h.messages.length,0);
});
test('location arriving after account switch never starts a clock RPC',async()=>{
  const d=deferred(),h=setup({state:{role:'staff'}});h.context.staffCoordinates=()=>d.promise;const task=h.context.clockAuthStaff('in');
  h.state.authProfile={user_id:'u2'};h.state.store='B';h.state.myCrewId='c2';d.resolve({current_lat:37.5,current_lng:127});await task;assert.equal(h.calls.some(c=>c.rpc),false);
});
test('late permission error from old clock request cannot log out the new account',async()=>{
  const d=deferred(),h=setup({state:{role:'staff'},rpcResult:d.promise});const task=h.context.clockAuthStaff('in');await new Promise(r=>setImmediate(r));
  h.state.authProfile={user_id:'u2'};h.state.myCrewId='c2';d.resolve({error:{code:'42501'}});await task;assert.equal(h.state.role,'staff');assert.equal(h.calls.some(c=>c.cleared),false);
});
test('failed employee confirmation keeps its dialog open for retry',async()=>{
  const h=setup({state:{role:'staff',attConfirmPrompt:{attId:'att',editing:false}},rpcResult:{error:{message:'offline'}}});
  let click;h.controls['att-confirm-overlay']={};h.controls['att-confirm-right']={addEventListener:(_,cb)=>click=cb};h.context.bindAttConfirmPrompt();await click();await new Promise(r=>setImmediate(r));
  assert.equal(h.state.attConfirmPrompt?.attId,'att');assert.ok(h.messages.includes('offline'));
});
test('employee confirmation sends one RPC for rapid repeated taps',async()=>{
  const d=deferred(),h=setup({state:{role:'staff',attConfirmPrompt:{attId:'att'}},rpcResult:d.promise});
  const a=h.context.confirmAuthAttendance('att'),b=h.context.confirmAuthAttendance('att');assert.equal(h.calls.filter(c=>c.rpc).length,1);
  d.resolve({data:{...saved,staff_confirmed:true}});await Promise.all([a,b]);assert.equal(h.state.attConfirmPrompt,null);assert.equal(h.state.attendance[0].staffConfirmed,true);
});
test('viewing a previous month still loads today and an earlier open shift once each',async()=>{
  const h=setup({state:{role:'staff'}}),queries=[];const old={...saved,id:'old',date:'2026-09-01'},open={...saved,id:'open',date:'2026-08-31',check_out:null},today={...saved,id:'today',date:'2026-10-07'};
  h.context.maneeLoadGuard=()=>()=>true;h.context.monthDateRange=()=>({start:'2026-09-01',end:'2026-09-30'});h.context.bizToday=()=> '2026-10-07';h.context.clearReportDataFailed=()=>{};h.context.markReportDataFailed=()=>assert.fail('lookup failed');
  h.context.db.from=()=>{const filters={};queries.push(filters);const q={select(){return q;},eq(k,v){filters[k]=v;return q;},gte(){return q;},lte(){return q;},or(v){filters.or=v;return q;},then(resolve){return Promise.resolve({data:filters.or?[open,today]:[old,open]}).then(resolve);}};return q;};
  vm.runInContext(fn('loadAttendance'),h.context);await h.context.loadAttendance('A','2026-09');
  assert.equal(queries.length,2);assert.equal(queries[1].crew_id,'c1');assert.match(queries[1].or,/date.eq.2026-10-07,check_out.is.null/);
  assert.deepEqual(Array.from(h.state.attendance,r=>r.id).sort(),['old','open','today']);assert.equal(h.context.findOpenAttendance('c1').id,'open');
});
test('home navigation refreshes the attendance recorded by another phone',async()=>{
  const h=setup({state:{role:'staff',staffView:'home'}}),loads=[];
  Object.assign(h.context,{maneeLoadGuard:()=>()=>true,staffPortal:async()=>({}),tpCancelEdit(){},loadHomeChecklistPreview:async()=>loads.push('checklist'),loadAttendance:async()=>loads.push('attendance'),loadShifts:async()=>loads.push('shifts')});
  vm.runInContext(fn('goToStaffTab'),h.context);await h.context.goToStaffTab('home');assert.deepEqual(loads,['checklist','attendance','shifts']);assert.equal(h.state.loading,false);
});
test('failed edit request keeps the entered correction and blocks repeated taps',async()=>{
  const d=deferred(),h=setup({state:{role:'staff',attConfirmPrompt:{attId:'att',editing:true}},rpcResult:d.promise});
  const a=h.context.requestAuthAttendanceEdit('att','10:00','18:00'),b=h.context.requestAuthAttendanceEdit('att','10:00','18:00');assert.equal(h.calls.filter(c=>c.rpc).length,1);
  d.resolve({error:{message:'offline'}});await Promise.all([a,b]);assert.equal(h.state.attConfirmPrompt.editing,true);
});
