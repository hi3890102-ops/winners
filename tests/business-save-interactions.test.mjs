import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=name=>html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))?.[0]||'';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(options={}){
  const state={role:'storeOwner',store:'A',storeIdMap:{A:'s1',B:'s2'},authProfile:{user_id:'u1'},storeCutoffMap:{A:6},storeManagerDashboardMap:{A:false},fixedExpenses:[{id:'f1',amount:1000}],fixedSchedules:[{id:'p1'}],crew:[{id:'c1',name:'가상 직원',wage:12000,wageType:'hourly',salesAccess:false,probation:false,resignDate:'',phone:'',position:'홀'}],...options.state};
  const calls=[],messages=[],inputs={'new-fixedexpense-name-input':{value:'임차료'},'new-fixedexpense-amount-input':{value:'1000'},...options.inputs};
  const context={state,MANEE_STAFF_AUTH_ENABLED:true,Date,Set,Map,console,currentStoreId:()=>state.storeIdMap[state.store],monthKey:()=> '2026-10',todayKey:()=> '2026-10-07',canManageBusinessData:()=>true,canEditStoreSchedule:()=>true,
    render(){},showToast:s=>messages.push(s),businessError:e=>messages.push(e.message||'오류'),staffErrorMessage:e=>e.message||'오류',document:{getElementById:id=>inputs[id]},app:{querySelector:()=>null},askConfirm:(_,cb)=>cb(),
    db:{from(table){const call={table,filters:[]};const q={update(payload){call.payload=payload;call.action='update';calls.push(call);return q;},insert(payload){call.payload=payload;call.action='insert';calls.push(call);return q;},delete(){call.action='delete';calls.push(call);return q;},eq(...a){call.filters.push(a);return q;},select(){return q;},single(){return q;},then(resolve,reject){return Promise.resolve(typeof options.result==='function'?options.result(call):options.result??{data:[{id:table==='crew'?'c1':'f1',name:'가상 직원',wage:12000,wage_type:'hourly',...call.payload}],error:null}).then(resolve,reject);}};return q;}}
  };
  vm.createContext(context);
  vm.runInContext('let maneeViewEpoch=0;const businessMutationLocks=new Set();const crewMutationQueue=new Map();\n'+['isAttendanceDate','businessContextGuard','runBusinessMutation','checkedBusinessMutation','invalidateFinancialViews','invalidateAttendanceSummaries','deleteAuthBusinessRow','updateAuthFixedExpense','addFixedExpense','setStoreCutoffHour','setManagerDashboardEnabled','rowToCrew','updateCrewRow','toggleProbation','updateCrewDate','updateCrewExtraField','updateCrewHealthCert','toggleContractSigned','updateCrewWageType','togglePayrollFlag','resignCrew','reactivateCrew','toggleSalesAccess','saveFixedPattern','deleteFixedPattern'].map(fn).join('\n'),context);
  return {state,calls,messages,context};
}
for(const [name,args,field] of [['toggleProbation',['c1',true],'probation'],['updateCrewDate',['c1','hireDate','2026-10-01'],'hireDate'],['updateCrewWageType',['c1','monthly'],'wageType'],['togglePayrollFlag',['c1','tax33',true],'tax33'],['toggleSalesAccess',['c1',true],'salesAccess'],['reactivateCrew',['c1'],'resignDate']])test(`${name}: rejected save restores the previously saved employee settings`,async()=>{
  const h=setup({result:{data:[],error:null},state:{crew:[{id:'c1',name:'가상 직원',probation:false,wageType:'hourly',resignDate:'2026-09-30',salesAccess:false}]} }),before=h.state.crew[0][field];
  await h.context[name](...args);await new Promise(r=>setImmediate(r));assert.equal(h.state.crew[0][field],before);assert.equal(h.messages.some(x=>/줬어요|돌렸어요/.test(x)),false);
});
for(const name of ['setStoreCutoffHour','setManagerDashboardEnabled'])test(`${name}: failed save does not change visible store settings`,async()=>{
  const h=setup({result:{error:{message:'offline'}}});await h.context[name]('A',name==='setStoreCutoffHour'?8:true);await new Promise(r=>setImmediate(r));assert.equal(h.state.storeCutoffMap.A,6);assert.equal(h.state.storeManagerDashboardMap.A,false);assert.ok(h.messages.length);
});
test('fixed cost refuses invalid input instead of converting it to zero or truncating it',async()=>{
  for(const value of ['','abc','12.5','2147483648']){const h=setup();await h.context.updateAuthFixedExpense('f1',value);assert.equal(h.calls.length,0,value);assert.equal(h.state.fixedExpenses[0].amount,1000);}
});
test('fixed cost preserves zero and signed refund amounts',async()=>{
  for(const value of ['0','-200']){const h=setup();await h.context.updateAuthFixedExpense('f1',value);assert.equal(h.state.fixedExpenses[0].amount,Number(value));}
});
test('late business deletion cannot change the newly selected store',async()=>{
  const d=deferred(),h=setup({result:d.promise});let applied=false;const task=h.context.deleteAuthBusinessRow('fixed_expenses','f1',()=>applied=true);
  h.state.store='B';d.resolve({data:[{id:'f1'}]});await task;assert.equal(applied,false);
});
test('repeated delete runs once until the saved result returns',async()=>{
  const d=deferred(),h=setup({result:d.promise});let applied=0;const a=h.context.deleteAuthBusinessRow('fixed_expenses','f1',()=>applied++),b=h.context.deleteAuthBusinessRow('fixed_expenses','f1',()=>applied++);
  assert.equal(h.calls.length,1);d.resolve({data:[{id:'f1'}]});await Promise.all([a,b]);assert.equal(applied,1);
});
test('fixed-cost add button sends one insert on repeated taps',async()=>{
  const d=deferred(),h=setup({result:d.promise});const a=h.context.addFixedExpense(),b=h.context.addFixedExpense();assert.equal(h.calls.length,1);d.resolve({data:[{id:'f2',name:'임차료',amount:1000}]});await Promise.all([a,b]);assert.equal(h.state.fixedExpenses.length,2);
});
test('failed fixed schedule deletion leaves the pattern visible',async()=>{
  const h=setup({result:{error:{message:'offline'}}});await h.context.deleteFixedPattern('p1');await new Promise(r=>setImmediate(r));assert.equal(h.state.fixedSchedules.length,1);assert.ok(h.messages.length);
});
test('employee changes are saved in order and the latest value is retained',async()=>{
  const d=deferred();let count=0;const h=setup({result:call=>++count===1?d.promise:{data:[{id:'c1',wage:12000,wage_type:'hourly',probation:false,...call.payload}]}});
  const a=h.context.toggleProbation('c1',true),b=h.context.toggleProbation('c1',false);await new Promise(r=>setImmediate(r));assert.equal(h.calls.length,1);
  d.resolve({data:[{id:'c1',wage:12000,wage_type:'hourly',probation:true}]});await Promise.all([a,b]);assert.equal(h.calls.length,2);assert.equal(h.state.crew[0].probation,false);
});
test('an employee save finishing after account switch never changes the new crew list',async()=>{
  const d=deferred(),h=setup({result:d.promise});const task=h.context.toggleSalesAccess('c1',true);await new Promise(r=>setImmediate(r));
  h.state.authProfile={user_id:'u2'};h.state.crew=[{id:'c2'}];d.resolve({data:[{id:'c1',sales_access:true}]});await task;assert.deepEqual(h.state.crew,[{id:'c2'}]);assert.equal(h.messages.length,0);
});
