import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// Owner decision (2026-09-21): the labor warning threshold is a per-store setting (default 22% while NOT SET), like the food threshold
// (default 40%). Only warning labels change: pay, wages, deductions, hours, sales and expense amounts and the ratio formulas do not.
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const sql=readFileSync(new URL('./labor-ratio-threshold.sql',import.meta.url),'utf8');
const rollback=readFileSync(new URL('./labor-ratio-threshold-rollback.sql',import.meta.url),'utf8');
function fnText(name){const a=html.indexOf('  function '+name+'(');const b=html.indexOf('  async function '+name+'(');const s=a>=0?a:b;if(s<0)throw new Error('missing '+name);const e=html.indexOf('\n  }\n',s);return html.slice(s,e+5);}
function line(re){const m=html.match(re);if(!m)throw new Error('missing '+re);return m[0];}
const tick=()=>new Promise(r=>setTimeout(r,5));

function harness({storeRow,storeError,rpcResult,rpcError,role='storeOwner'}={}){
  const log={rpc:[],toast:[],render:0,dashLoads:0,select:[]};
  const h={storeRow,storeError,rpcResult,rpcError};
  const db={
    from(table){
      const chain=new Proxy({table},{get(t,prop){
        if(prop==='then')return (res,rej)=>Promise.resolve().then(()=>{log.select.push(table);
          if(h.storeError==='throw')throw new Error('network');
          return h.storeError?{data:null,error:h.storeError}:{data:h.storeRow===undefined?null:h.storeRow,error:null};}).then(res,rej);
        return ()=>chain;}});
      return chain;
    },
    async rpc(name,args){log.rpc.push({name,args});if(h.rpcError)return {data:null,error:h.rpcError};return {data:h.rpcResult||{ok:true},error:null};}
  };
  const state={role,store:'A',myStores:['A'],storeIdMap:{A:'sid-A'},storeFoodLimitMap:{},storeLaborLimitMap:{},authProfile:{user_id:'user-A'},dashboardData:{old:true}};
  const ctx=vm.createContext({state,db,console,showToast:m=>log.toast.push(m),render(){log.render++;},loadDashboardData(){log.dashLoads++;}});
  vm.runInContext([line(/  let maneeViewEpoch[^\n]*\n/),'let maneeRestoreSeq=0;',line(/  const maneeLoadSeq[^\n]*\n/),fnText('maneeLoadGuard'),
    line(/  const DEFAULT_LABOR_RATIO_LIMIT[^\n]*\n/),line(/  function formatLimit\([^\n]*\n/),...['laborRatioLimit','laborRatioVerdict','foodRatioLimit','loadLaborLimit','loadFoodLimit','loadRatioLimits','saveLaborLimit','saveFoodLimit'].map(fnText),
    ';this.api={laborRatioLimit,laborRatioVerdict,foodRatioLimit,formatLimit,loadLaborLimit,loadFoodLimit,loadRatioLimits,saveLaborLimit,saveFoodLimit,setLimit:(s,v)=>{state.storeLaborLimitMap[s]=v;},setFood:(s,v)=>{state.storeFoodLimitMap[s]=v;}};'].join('\n'),ctx);
  return {h,state,log,api:ctx.api};
}

test('defaults: NOT SET means 22, a saved number is used, an unreadable value is null (never 22), junk falls back to the default',()=>{
  const r=harness();
  assert.equal(r.api.laborRatioLimit('A'),22);
  r.api.setLimit('A',null);assert.equal(r.api.laborRatioLimit('A'),22);
  r.api.setLimit('A',30);assert.equal(r.api.laborRatioLimit('A'),30);
  r.api.setLimit('A',false);assert.equal(r.api.laborRatioLimit('A'),null);
  for(const bad of [0,-3,150,NaN,'x',undefined]){r.api.setLimit('A',bad);assert.equal(r.api.laborRatioLimit('A'),22,String(bad));}
});
test('verdict: exactly the limit is not over, 0.1 above is over; an unreadable limit is unknown (never green, never red)',()=>{
  const r=harness();r.api.setLimit('A',30);
  assert.equal(r.api.laborRatioVerdict('A',30).state,'ok');
  assert.equal(r.api.laborRatioVerdict('A',30.1).state,'over');
  assert.equal(r.api.laborRatioVerdict('A',22.1).state,'ok');       // the old fixed 22 no longer decides
  assert.equal(r.api.laborRatioVerdict('A',null).state,'none');
  r.api.setLimit('A',false);assert.equal(r.api.laborRatioVerdict('A',50).state,'unknown');
  r.api.setLimit('A',null);assert.equal(r.api.laborRatioVerdict('A',22).state,'ok');assert.equal(r.api.laborRatioVerdict('A',22.1).state,'over');
});
test('loadLaborLimit: saved value; NULL / missing column mean "not set"; other errors mean "unreadable"; food is read independently',async()=>{
  let r=harness({storeRow:{labor_ratio_threshold:'27.50'}});await r.api.loadLaborLimit('A');assert.equal(r.state.storeLaborLimitMap.A,27.5);
  r=harness({storeRow:{labor_ratio_threshold:null}});await r.api.loadLaborLimit('A');assert.equal(r.state.storeLaborLimitMap.A,null);
  r=harness({storeError:{code:'42703',message:'column does not exist'}});await r.api.loadLaborLimit('A');assert.equal(r.state.storeLaborLimitMap.A,null);assert.equal(r.api.laborRatioLimit('A'),22);
  r=harness({storeError:{code:'42501',message:'denied'}});await r.api.loadLaborLimit('A');assert.equal(r.state.storeLaborLimitMap.A,false);assert.equal(r.api.laborRatioLimit('A'),null);
  r=harness({storeError:'throw'});await r.api.loadRatioLimits('A');
  assert.equal(r.state.storeLaborLimitMap.A,false);assert.equal(r.state.storeFoodLimitMap.A,false);assert.equal(r.log.select.length,2,'two separate lookups, one per limit');
  // a late answer for the previous account is discarded
  r=harness({storeRow:{labor_ratio_threshold:30}});const p=r.api.loadLaborLimit('A');r.state.authProfile={user_id:'user-B'};await p;assert.equal(r.state.storeLaborLimitMap.A,undefined);
});
test('saveLaborLimit: rounded to one decimal, sent to the owner-only RPC, food setting untouched; screen and dashboard refresh',async()=>{
  const r=harness();r.api.setFood('A',35);
  assert.equal(await r.api.saveLaborLimit('A','30.04'),true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.log.rpc)),[{name:'manee_set_store_labor_ratio',args:{p_store_id:'sid-A',p_threshold:30}}]);
  assert.equal(r.state.storeLaborLimitMap.A,30);assert.equal(r.state.storeFoodLimitMap.A,35,'the food value is not touched');
  assert.equal(r.state.dashboardData,null);assert.equal(r.log.dashLoads,1);
  assert.equal(await r.api.saveLaborLimit('A','27.46'),true);assert.equal(r.state.storeLaborLimitMap.A,27.5);
  // and the other way round
  assert.equal(await r.api.saveFoodLimit('A','41'),true);assert.equal(r.state.storeLaborLimitMap.A,27.5,'the labor value is not touched by a food save');
  assert.equal(r.log.rpc.at(-1).name,'manee_set_store_food_ratio');
});
test('saveLaborLimit: empty, non-numeric, zero, negative and >100 are refused before any request; 1 and 100 are allowed',async()=>{
  const r=harness();
  for(const bad of ['','  ','abc','0','0.9','-5','100.1','1000','NaN','Infinity']) assert.equal(await r.api.saveLaborLimit('A',bad),false,'"'+bad+'"');
  assert.equal(r.log.rpc.length,0);assert.equal(r.state.storeLaborLimitMap.A,undefined);assert.ok(r.log.toast.every(m=>/1에서 100/.test(m)));
  assert.equal(await r.api.saveLaborLimit('A','1'),true);assert.equal(await r.api.saveLaborLimit('A','100'),true);
});
test('saveLaborLimit(null) resets to the default: NULL is sent, the default 22 applies again',async()=>{
  const r=harness();r.api.setLimit('A',30);
  assert.equal(await r.api.saveLaborLimit('A',null),true);
  assert.equal(r.log.rpc[0].args.p_threshold,null);assert.equal(r.state.storeLaborLimitMap.A,null);assert.equal(r.api.laborRatioLimit('A'),22);
  assert.match(r.log.toast.at(-1),/기본값\(22%\)/);
});
test('saveLaborLimit: a rejected request changes nothing and says so; a missing function says the server is not ready; unknown store refused',async()=>{
  let r=harness({rpcError:{code:'42501',message:'only an owner'}});r.api.setLimit('A',30);
  assert.equal(await r.api.saveLaborLimit('A','25'),false);assert.equal(r.state.storeLaborLimitMap.A,30);assert.equal(r.log.dashLoads,0);assert.match(r.log.toast.at(-1),/저장하지 못했어요/);
  r=harness({rpcError:{code:'PGRST202',message:'function not found'}});assert.equal(await r.api.saveLaborLimit('A','25'),false);assert.match(r.log.toast.at(-1),/서버 준비/);
  r=harness({rpcResult:{ok:false}});assert.equal(await r.api.saveLaborLimit('A','25'),false);
  assert.equal(await harness().api.saveLaborLimit('Z','25'),false);
});
test('saveLaborLimit: a save that finishes after an account switch / logout is not applied to the new account',async()=>{
  const r=harness();const p=r.api.saveLaborLimit('A','25');r.state.authProfile={user_id:'user-B'};await p;
  assert.equal(r.state.storeLaborLimitMap.A,undefined);assert.equal(r.log.dashLoads,0);
  const r2=harness({rpcError:{code:'42501',message:'x'}});const p2=r2.api.saveLaborLimit('A','25');r2.state.authProfile={user_id:'user-B'};await p2;assert.equal(r2.log.toast.length,0,'a late error is not shown to the new account either');
});
test('a save for store A that finishes after the owner switched to store B is stored under A only', async()=>{
  const r=harness();r.state.myStores=['A','B'];r.state.storeIdMap.B='sid-B';
  const p=r.api.saveLaborLimit('A','25');r.state.store='B';await p;
  assert.equal(r.state.storeLaborLimitMap.A,25);assert.equal(r.state.storeLaborLimitMap.B,undefined);
});

// ---- the verdict everywhere (real functions from index.html)
const ctxFor=()=>{
  const ctx=vm.createContext({escapeHtml:s=>String(s),state:{}});
  vm.runInContext(line(/  const OWNER_STATUS_TEXT[\s\S]*?\n  function ownerStatusChip/).replace(/\n  function ownerStatusChip$/,'')+line(/  const DEFAULT_LABOR_RATIO_LIMIT[^\n]*\n/)+line(/  function formatLimit\([^\n]*\n/)+['ownerStatusChip','ownerCostNote','ownerLaborLimit','ownerStoreStatus','ownerOverallKind'].map(fnText).join('\n')+';this.api={ownerStoreStatus,ownerOverallKind};',ctx);
  return ctx.api;
};
// foodConfirmedRatio mirrors expenseRatio by default (every mocked expense is confirmed 식자재) - see
// expense-category-and-vat.test.mjs for the category-split tests themselves.
const row=(o)=>{
  const base={store:'S',salesSum:1000000,salesReportCount:1,laborPay:0,laborRatio:null,expenseSum:0,expenseRatio:null,foodThreshold:40,laborThreshold:22,loadFailures:[],...o};
  if(base.foodConfirmedRatio===undefined) base.foodConfirmedRatio=base.expenseRatio;
  if(base.hasUnclassifiedExpense===undefined) base.hasUnclassifiedExpense=false;
  return base;
};
test('per-store status: limit 30 -> 30.0 is not over, 30.1 is over with the store\'s own wording',()=>{
  const {ownerStoreStatus}=ctxFor();
  assert.equal(ownerStoreStatus(row({laborRatio:30,laborThreshold:30})).kind,'ok');
  const over=ownerStoreStatus(row({laborRatio:30.1,laborThreshold:30}));
  assert.equal(over.kind,'attention');assert.deepEqual(JSON.parse(JSON.stringify(over.reasons)),['인건비율 30% 초과']);
  assert.equal(ownerStoreStatus(row({laborRatio:25,laborThreshold:22})).reasons[0],'인건비율 22% 초과');
  assert.equal(ownerStoreStatus(row({laborRatio:25,laborThreshold:22.5})).reasons[0],'인건비율 22.5% 초과');
  assert.equal(ownerStoreStatus(row({laborRatio:25,laborThreshold:30})).kind,'ok');        // 25 > 22 but the store's own limit is 30
  assert.equal(ownerStoreStatus(row({laborRatio:25})).reasons[0],'인건비율 22% 초과');     // a row without the field: default
});
test('an unreadable labor limit is neutral ("판정 불가") and never the default 22; it does not block the food verdict',()=>{
  const {ownerStoreStatus}=ctxFor();
  const s=ownerStoreStatus(row({laborRatio:80,laborThreshold:null,loadFailures:['인건비 기준']}));
  assert.equal(s.kind,'error');assert.deepEqual(JSON.parse(JSON.stringify(s.reasons)),[]);assert.ok(s.failures.includes('인건비 기준'));
  const f=ownerStoreStatus(row({laborRatio:80,laborThreshold:null,expenseRatio:55,foodThreshold:40,loadFailures:['인건비 기준']}));
  assert.equal(f.kind,'attention');assert.deepEqual(JSON.parse(JSON.stringify(f.reasons)),['지출비율 40% 초과']);   // expense is judged on its own
});
test('all stores: each store is judged by its own limit; one store over its own limit is "관리 필요" even if the others are fine',()=>{
  const {ownerStoreStatus,ownerOverallKind}=ctxFor();
  const a=row({store:'A',laborRatio:28,laborThreshold:30}), b=row({store:'B',laborRatio:23,laborThreshold:22}), c=row({store:'C',laborRatio:10,laborThreshold:22});
  assert.equal(ownerStoreStatus(a).kind,'ok');assert.equal(ownerStoreStatus(b).kind,'attention');
  assert.equal(ownerOverallKind([a,b,c]),'attention');assert.equal(ownerOverallKind([a,c]),'ok');
  // one store's limit unreadable: no all-clear
  assert.equal(ownerOverallKind([a,c,row({store:'D',laborThreshold:null,loadFailures:['인건비 기준']})]),'error');
});

// ---- the settings card, the loaders and "no fixed 22 left"
test('no fixed labor constant remains: 22 exists only as DEFAULT_LABOR_RATIO_LIMIT (used for "not set")',()=>{
  assert.equal(/[^_]LABOR_RATIO_LIMIT/.test(html),false,'old fixed constant');
  assert.match(html,/const DEFAULT_LABOR_RATIO_LIMIT = 22, DEFAULT_FOOD_RATIO_LIMIT = 40;/);
  assert.equal(html.includes('인건비율 기준은 '),false);                                   // the fixed-22 sentence is gone
  // no hard-coded ratio numbers in any labor verdict
  const code=['ownerStoreStatus','renderManagerSummaryCard','renderTeamSummaryCard','renderMonthlyReport','renderOwnerOverview','renderDashboard'].map(fnText).join('\n');
  assert.deepEqual([...code.matchAll(/(?:laborRatio|labor)\s*[<>]=?\s*(\d+(?:\.\d+)?)/g)].map(m=>m[1]).filter(n=>n!=='0'),[]);
  for(const n of ['renderManagerSummaryCard','renderTeamSummaryCard','renderMonthlyReport','ownerStoreStatus','renderDashboard','renderOwnerOverview']) assert.ok(!/[^_]LABOR_RATIO_LIMIT/.test(fnText(n)),n);
});
test('every screen that judges labor reads the store\'s own limit: owner home card / overview, dashboard, monthly report, manager home, team summary',()=>{
  assert.ok(fnText('renderManagerSummaryCard').includes('laborRatioVerdict(state.store'));
  assert.ok(fnText('renderTeamSummaryCard').includes('laborRatioVerdict(state.store'));
  assert.ok(fnText('renderMonthlyReport').includes('laborRatioVerdict(state.store'));
  assert.ok(fnText('renderDashboard').includes('rowLaborLimit')&&fnText('renderDashboard').includes('ownerLaborLimit'));
  assert.ok(fnText('renderOwnerOverview').includes('ownerLaborLimit(d)'));
  assert.ok(fnText('renderOwnerWork').includes('ownerLaborLimit(d)'));
  assert.ok(fnText('loadAllForStore').includes('loadRatioLimits(store)')&&fnText('loadAuthStaffHome').includes('loadRatioLimits(store)'));
  // the dashboard reads each store's limit with its own lookup and its own failure entry
  assert.ok(html.includes("db.from('stores').select('labor_ratio_threshold')")&&html.includes('failed.push("인건비 기준")'));
});
test('settings card: one "비율 경고 기준" card, two independent rows, owner only, RPC only',()=>{
  const start=html.indexOf('<h3 style="margin:0 0 6px;">비율 경고 기준</h3>');assert.ok(start>0);
  const block=html.slice(html.lastIndexOf('if(state.role === "storeOwner"){',start),html.indexOf("알림</h3>'",start));
  assert.ok(block.includes('넘으면 관리 필요로 표시해요. 이 매장의 사장님·매니저 화면에 같은 기준이 적용돼요.'));
  assert.ok(block.includes("'인건비율 경고 기준','labor'")&&block.includes("'지출비율 경고 기준','food'"));
  assert.ok(block.includes("kind+'-limit-input\"")&&block.includes("kind+'-limit-save-btn\"")&&block.includes("kind+'-limit-reset-btn\""));
  assert.ok(block.includes("if(typeof saved === \"number\")"));                                    // reset only when a user value exists
  assert.ok(html.includes('saveLaborLimit(state.store, (document.getElementById("labor-limit-input")||{}).value)')&&html.includes('saveLaborLimit(state.store, null)'));
  assert.ok(fnText('saveLaborLimit').includes("db.rpc('manee_set_store_labor_ratio'"));
  assert.equal(/from\('stores'\)\s*\.update\([^)]*labor_ratio/.test(html),false,'the labor limit is never written by a direct table update');
  assert.equal(html.includes("'labor_ratio_threshold'")&&/\.update\([^)]*labor_ratio/.test(html),false);
});
test('only warning labels change: pay calculation, wages and ratio formulas are the same functions as before',()=>{
  for(const n of ['calcCrewPayFrom','calcCrewPay','computeMyStoreSummary']) assert.ok(html.includes('function '+n+'('),n);
  assert.ok(html.includes('const laborRatio = (laborReadable && salesSum>0) ? (laborPay/salesSum*100) : null;'));
  assert.ok(html.includes('const laborRatio = salesSum>0 ? (laborPay/salesSum*100) : null;'));
});

// ---- server (static checks; the behaviour was verified on the staging project)
test('SQL: additive, nullable, range-checked, owner-only RPC, no update of existing rows, no grant of column UPDATE',()=>{
  assert.match(sql,/add column if not exists labor_ratio_threshold numeric\(5,2\)/);
  assert.match(sql,/labor_ratio_threshold is null or \(labor_ratio_threshold>=1 and labor_ratio_threshold<=100\)/);
  assert.match(sql,/has_store_membership\(p_store_id, array\['owner'\]::text\[\]\)/);
  assert.match(sql,/is_live_manee_session\(\)/);
  assert.match(sql,/update public\.stores set labor_ratio_threshold = v where id = p_store_id;/);
  assert.equal((sql.match(/update public\.stores/g)||[]).length,1);                       // only the RPC's single-row update
  assert.equal(/grant update/i.test(sql),false);
  assert.match(sql,/revoke all on function public\.manee_set_store_labor_ratio\(uuid, numeric\) from public, anon;/);
  assert.equal(/delete\s+from|truncate|drop\s+(column|table)/i.test(sql.replace(/--[^\n]*/g,'')),false);
});
test('SQL rollback: only revokes the RPC; column and values stay; re-run is documented',()=>{
  const code=rollback.replace(/--[^\n]*/g,'');
  assert.match(code,/revoke all on function public\.manee_set_store_labor_ratio\(uuid, numeric\) from public, anon, authenticated;/);
  assert.equal(/drop|delete|update|alter/i.test(code),false);
  assert.match(rollback,/labor-ratio-threshold\.sql ONLY/);
});

// ---- expense edit/delete buttons: the screen follows the database's notion of "manager" (owner, manager, or staff flagged as manager)
test('canManageBusinessData: a staff membership whose employee record is flagged as manager counts as manager, like the database', ()=>{
  const src=html.slice(html.indexOf('  function canManageBusinessData(){'),html.indexOf('  function canDeleteFinancialData(){'));
  const mk=(state)=>new Function('state','MANEE_STAFF_AUTH_ENABLED','currentStoreId',src+';return canManageBusinessData;')(state,true,()=> 'S1');
  const st=(role,flag,storeId='S1',crewId='C1')=>({authMemberships:[{store_id:storeId,role,crew_id:crewId}],crew:[{id:'C1',isManager:flag},{id:'C2',isManager:true}]});
  assert.equal(mk(st('owner',false))(),true);
  assert.equal(mk(st('manager',false))(),true);
  assert.equal(mk(st('staff',true))(),true);            // the reported case: manager flag on the employee record, membership role staff
  assert.equal(mk(st('staff',false))(),false);          // plain staff: no
  assert.equal(mk(st('staff',true,'OTHER'))(),false);   // flagged in another store only: no
  assert.equal(mk(st('staff',false,'S1','C2'))(),true); // the link points at the crew record that carries the flag
  assert.equal(mk({authMemberships:[],crew:[]})(),false);
});
