import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fn(name){return html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))?.[0]||'';}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

function reservationHarness(result){
  const state={role:'storeOwner',store:'A',storeIdMap:{A:'s1',B:'s2'},authProfile:{user_id:'u1'},myStores:['A'],crew:[],myCrewId:null,reservations:[],upcomingReservations:[],reservationDraft:{name:'가상 예약'},showReservationForm:true};
  const controls=Object.fromEntries(Object.entries({'res-name-input':'가상 예약','res-date-input':'2026-10-07','res-time-input':'19:00','res-party-input':'2','res-phone-input':'','res-memo-input':''}).map(([id,value])=>[id,{value,focus(){}}]));
  controls['add-reservation-btn']={disabled:false,textContent:'예약 등록'};
  const writes=[],messages=[];
  const context={state,Date,console,maneeViewEpoch:0,document:{getElementById:id=>controls[id]},currentStoreId:()=>state.storeIdMap[state.store],monthKey:()=> '2026-10',bizToday:()=> '2026-10-07',showToast:m=>messages.push(m),render(){},formatDateLabel:d=>d,sendReservationPush(){},loadDashboardReservations(){},
    db:{from(table){return {insert(payload){writes.push({table,payload});return {select(){return {single(){return Promise.resolve(typeof result==='function'?result(payload):(result||{data:{id:'r1',...payload},error:null}));}};}};}};}}};
  vm.createContext(context);vm.runInContext(['businessContextGuard','setReservationBusy','isAttendanceDate','isValidTimeStr','addReservation'].map(fn).join('\n'),context);
  return {state,controls,writes,messages,context};
}
test('reservation double tap starts one save and shows its pending state',async()=>{
  const d=deferred(),h=reservationHarness(d.promise),a=h.context.addReservation(),b=h.context.addReservation();
  assert.equal(h.writes.length,1);assert.equal(h.controls['add-reservation-btn'].disabled,true);assert.match(h.controls['add-reservation-btn'].textContent,/등록 중/);
  d.resolve({data:{id:'r1',...h.writes[0].payload}});await Promise.all([a,b]);assert.equal(h.state.reservations.length,1);assert.equal(h.controls['add-reservation-btn'].disabled,false);
});
for(const value of ['-2','0','1.5','2명','2147483648'])test('invalid reservation party size is rejected: '+value,async()=>{
  const h=reservationHarness();h.controls['res-party-input'].value=value;await h.context.addReservation();assert.equal(h.writes.length,0);assert.match(h.messages[0],/인원/);assert.equal(h.state.showReservationForm,true);
});
test('optional reservation fields remain optional',async()=>{
  const h=reservationHarness();h.controls['res-party-input'].value='';h.controls['res-time-input'].value='';await h.context.addReservation();assert.equal(h.writes[0].payload.party_size,null);assert.equal(h.writes[0].payload.time,'');assert.equal(h.state.reservations.length,1);
});
for(const date of ['2026-02-30','2026-10-06'])test('reservation rejects impossible or past date: '+date,async()=>{
  const h=reservationHarness();h.controls['res-date-input'].value=date;await h.context.addReservation();assert.equal(h.writes.length,0);assert.match(h.messages[0],/날짜/);
});
for(const result of [{data:null,error:{message:'offline'}},{data:null,error:null}])test('failed or unconfirmed reservation saves retain the form',async()=>{
  const h=reservationHarness(result);await h.context.addReservation();assert.equal(h.controls['res-name-input'].value,'가상 예약');assert.equal(h.state.showReservationForm,true);assert.equal(h.state.reservations.length,0);assert.equal(h.controls['add-reservation-btn'].disabled,false);assert.match(h.messages[0],/실패/);
});
for(const changed of ['store','account'])test('late reservation response does not change next '+changed,async()=>{
  const d=deferred(),h=reservationHarness(d.promise),task=h.context.addReservation();
  if(changed==='store')h.state.store='B';else h.state.authProfile={user_id:'u2'};
  h.state.reservationDraft={name:'다른 입력'};d.resolve({data:{id:'r1',...h.writes[0].payload}});await task;
  assert.equal(h.state.reservations.length,0);assert.equal(h.state.reservationDraft.name,'다른 입력');assert.equal(h.state.showReservationForm,true);assert.equal(h.messages.length,0);
});

function navigationHarness({portalError,loaderError}={}){
  const state={role:'staff',staffView:'home',store:'A',authProfile:{user_id:'u1'},loading:false,crew:[]},messages=[];
  const context={state,MANEE_STAFF_AUTH_ENABLED:true,maneeLoadGuard:()=>{const user=state.authProfile;return()=>state.authProfile===user;},currentStoreId:()=> 's1',staffPortal:async()=>{if(portalError)throw portalError;return {ok:true};},clearStaffAuthView(){state.role='landing';state.authProfile=null;state.loading=false;},render(){},showToast:m=>messages.push(m),staffErrorMessage:e=>e.message||e.code,tpCancelEdit(){},monthKey:()=> '2026-10',loadShifts:async()=>{},loadCrew:async()=>{if(loaderError)throw loaderError;},loadFixed:async()=>{}};
  vm.createContext(context);vm.runInContext(fn('goToStaffTab'),context);return {context,state,messages};
}
test('temporary network error leaves employee signed in on the current screen',async()=>{
  const h=navigationHarness({portalError:{message:'offline'}});await h.context.goToStaffTab('schedule');assert.equal(h.state.role,'staff');assert.equal(h.state.authProfile.user_id,'u1');assert.equal(h.state.staffView,'home');assert.equal(h.state.loading,false);assert.deepEqual(h.messages,['offline']);
});
test('a loader exception does not leave employee navigation stuck on loading',async()=>{
  const h=navigationHarness({loaderError:{message:'offline'}});await h.context.goToStaffTab('schedule');assert.equal(h.state.role,'staff');assert.equal(h.state.loading,false);assert.equal(h.state.staffView,'home');assert.deepEqual(h.messages,['offline']);
});
for(const code of ['42501','PGRST301','PGRST302','PGRST303'])test('revoked membership or invalid auth still clears the employee screen: '+code,async()=>{
  const h=navigationHarness({portalError:{code}});await h.context.goToStaffTab('schedule');assert.equal(h.state.role,'landing');assert.equal(h.state.authProfile,null);
});
for(const [code,expected]of [[1,/허용/],[2,/위치 기능/],[3,/시간이 초과/]])test('geolocation error '+code+' gets a specific retry instruction',async()=>{
  const context={navigator:{geolocation:{getCurrentPosition(_,reject){reject({code});}}}};vm.createContext(context);vm.runInContext(fn('staffCoordinates'),context);await assert.rejects(context.staffCoordinates(),expected);
});
for(const mode of ['none','failed','valid'])test('expense ratio reports '+mode+' sales accurately',()=>{
  const state={monthYear:2026,monthNum:10,expenseEntries:[{amount:20000}],salesReports:mode==='none'?[]:[{totalSales:100000}],reportDataFailed:new Set(mode==='failed'?['매출']:[])};
  const context={state,renderVendorManage:()=>'',renderExpenseWorkspace:()=>''};vm.createContext(context);vm.runInContext(fn('renderOwnerExpenseSummary'),context);const output=context.renderOwnerExpenseSummary();
  if(mode==='none'){assert.match(output,/지출비율 계산 불가/);assert.doesNotMatch(output,/0\.0%/);}else if(mode==='failed'){assert.match(output,/매출 조회 실패/);assert.doesNotMatch(output,/20\.0%/);}else assert.match(output,/20\.0%/);
});

for(const time of ['00:00','00:30','12:00','23:55'])test('time selector keeps '+time+' unchanged when opened and read',()=>{
  const controls={},context={document:{getElementById:id=>controls[id]}};vm.createContext(context);vm.runInContext(fn('timeSelectHtml')+'\n'+fn('readTimeSelect'),context);
  const output=context.timeSelectHtml('shift',time);
  for(const select of output.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)){
    controls[select[1]]={value:select[2].match(/<option value="([^"]+)" selected>/)?.[1]};
  }
  assert.equal(context.readTimeSelect('shift'),time);
});

for(const failTable of ['checklist_templates','checklist_checks'])test('checklist '+failTable+' failure is visible and never initializes templates',async()=>{
  const state={storeIdMap:{A:'s1'},items:{},checks:{}},calls=[];
  const context={state,MANEE_STAFF_AUTH_ENABLED:true,DEFAULT_ITEMS:{},bizToday:()=> '2026-10-07',maneeLoadGuard:()=>()=>true,canManageBusinessData:()=>true,businessError(){},callAuthChecklist:async()=>calls.push('initialize'),db:{from(table){const q={select(){return q;},eq(){return q;},then(resolve){return Promise.resolve(table===failTable?{data:null,error:{message:'offline'}}:{data:table==='checklist_templates'?[{tab:'morning',data:[{id:'cat',items:[{id:'item',label:'가상 항목'}]}]}]:[]}).then(resolve);}};return q;}}};
  vm.createContext(context);vm.runInContext(fn('loadChecklist')+'\n'+fn('renderChecklist')+'\n'+fn('loadHomeChecklistPreview')+'\n'+fn('teamChecklistCard'),context);
  await context.loadChecklist('A','2026-10-07');assert.equal(state.checklistLoadFailed,true);assert.deepEqual(calls,[]);assert.match(context.renderChecklist(),/checklist-retry-btn/);assert.doesNotMatch(context.renderChecklist(),/아직 등록된 항목이 없어요|0개 완료/);
  await context.loadHomeChecklistPreview('A');assert.equal(state.homeChecklistFailed,true);assert.match(context.teamChecklistCard(),/확인 불가/);assert.doesNotMatch(context.teamChecklistCard(),/완료!|0\/0/);
});
test('a successful checklist retry clears the failure indicator and shows saved checks',async()=>{
  const state={storeIdMap:{A:'s1'},checklistLoadFailed:true},context={state,MANEE_STAFF_AUTH_ENABLED:true,bizToday:()=> '2026-10-07',maneeLoadGuard:()=>()=>true,db:{from(table){const q={select(){return q;},eq(){return q;},then(resolve){return Promise.resolve({data:table==='checklist_templates'?[{tab:'morning',data:[{id:'cat',items:[{id:'item',label:'가상 항목'}]}]}]:[{item_id:'item'}]}).then(resolve);}};return q;}}};
  vm.createContext(context);vm.runInContext(fn('loadChecklist'),context);await context.loadChecklist('A','2026-10-07');assert.equal(state.checklistLoadFailed,false);assert.equal(state.checks.item,true);assert.equal(state.items.morning[0].items[0].id,'item');
});
