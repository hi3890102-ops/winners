import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// Owner decision (2026-09-19): labor warning 22% (fixed), food warning 40% by default, changeable per store by that store's owner;
// owner, manager and staff screens of a store judge with the same value. Only warning labels change: pay, wages, sales and
// personal data are not touched (see owner-ui-regression.test.mjs for the preserved-function hashes).
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fnText(name){const a=html.indexOf('  function '+name+'(');const b=html.indexOf('  async function '+name+'(');const s=a>=0?a:b;if(s<0)throw new Error('missing '+name);const e=html.indexOf('\n  }\n',s);return html.slice(s,e+5);}
function line(re){const m=html.match(re);if(!m)throw new Error('missing '+re);return m[0];}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const tick=()=>new Promise(r=>setTimeout(r,5));

function harness({storeRow,storeError,rpcResult,rpcError,role='storeOwner'}={}){
  const log={rpc:[],toast:[],render:0,dashLoads:0,select:[]};
  const h={storeRow,storeError,rpcResult,rpcError};
  const db={
    from(table){
      const q={table};
      const chain=new Proxy(q,{get(t,prop){
        if(prop==='then')return (res,rej)=>Promise.resolve().then(()=>{log.select.push(table);
          if(h.storeError==='throw')throw new Error('network');
          return h.storeError?{data:null,error:h.storeError}:{data:h.storeRow===undefined?null:h.storeRow,error:null};}).then(res,rej);
        return ()=>chain;}});
      return chain;
    },
    async rpc(name,args){log.rpc.push({name,args});if(h.rpcError)return {data:null,error:h.rpcError};return {data:h.rpcResult||{ok:true},error:null};}
  };
  const state={role,store:'A',myStores:['A'],storeIdMap:{A:'sid-A'},storeFoodLimitMap:{},authProfile:{user_id:'user-A'},dashboardData:{old:true}};
  const ctx=vm.createContext({state,db,console,showToast:m=>log.toast.push(m),render(){log.render++;},loadDashboardData(){log.dashLoads++;}});
  vm.runInContext([line(/  let maneeViewEpoch[^\n]*\n/),'let maneeRestoreSeq=0;',line(/  const maneeLoadSeq[^\n]*\n/),fnText('maneeLoadGuard'),
    line(/  const LABOR_RATIO_LIMIT[^\n]*\n/),line(/  function formatLimit\([^\n]*\n/),...['foodRatioLimit','loadFoodLimit','saveFoodLimit'].map(fnText),
    ';this.api={foodRatioLimit,formatLimit,loadFoodLimit,saveFoodLimit,setLimit:(s,v)=>{state.storeFoodLimitMap[s]=v;}};'].join('\n'),ctx);
  return {h,state,log,api:ctx.api};
}

test('Constants: labor 22, food default 40',()=>{
  assert.match(html,/const LABOR_RATIO_LIMIT = 22, DEFAULT_FOOD_RATIO_LIMIT = 40;/);
});
test('foodRatioLimit: unset -> 40; saved number -> that number; unreadable -> null (unknown, never a verdict); junk -> 40',()=>{
  const r=harness();
  assert.equal(r.api.foodRatioLimit('A'),40);
  r.api.setLimit('A',null);assert.equal(r.api.foodRatioLimit('A'),40);
  r.api.setLimit('A',38);assert.equal(r.api.foodRatioLimit('A'),38);
  r.api.setLimit('A',false);assert.equal(r.api.foodRatioLimit('A'),null);
  for(const bad of [0,-3,150,NaN,'x',undefined]){r.api.setLimit('A',bad);assert.equal(r.api.foodRatioLimit('A'),40,String(bad));}
  assert.equal(r.api.formatLimit(37.5),'37.5');assert.equal(r.api.formatLimit(38),'38');assert.equal(r.api.formatLimit(38.04),'38');
});
test('loadFoodLimit: reads the store\'s saved value; NULL and a missing column both mean "not set"; other errors mean "unreadable"',async()=>{
  let r=harness({storeRow:{food_ratio_threshold:'36.50'}});await r.api.loadFoodLimit('A');assert.equal(r.state.storeFoodLimitMap.A,36.5);
  r=harness({storeRow:{food_ratio_threshold:null}});await r.api.loadFoodLimit('A');assert.equal(r.state.storeFoodLimitMap.A,null);
  r=harness({storeRow:null});await r.api.loadFoodLimit('A');assert.equal(r.state.storeFoodLimitMap.A,null);
  r=harness({storeError:{code:'42703',message:'column stores.food_ratio_threshold does not exist'}});await r.api.loadFoodLimit('A');
  assert.equal(r.state.storeFoodLimitMap.A,null);assert.equal(r.api.foodRatioLimit('A'),40,'server not prepared yet: default');
  r=harness({storeError:{code:'42501',message:'denied'}});await r.api.loadFoodLimit('A');
  assert.equal(r.state.storeFoodLimitMap.A,false);assert.equal(r.api.foodRatioLimit('A'),null);
  r=harness({storeError:'throw'});await r.api.loadFoodLimit('A');assert.equal(r.state.storeFoodLimitMap.A,false);
});
test('loadFoodLimit: a late answer for the previous account is discarded',async()=>{
  const r=harness({storeRow:{food_ratio_threshold:30}});
  const p=r.api.loadFoodLimit('A');                 // the lookup is in flight ...
  r.state.authProfile={user_id:'user-B'};           // ... and the shown account changes before it is applied
  await p;
  assert.equal(r.state.storeFoodLimitMap.A,undefined,'not written for another account');
});
test('saveFoodLimit: valid numbers are rounded to one decimal and sent to the owner-only RPC; the screen and dashboard refresh',async()=>{
  const r=harness();
  assert.equal(await r.api.saveFoodLimit('A','38.04'),true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.log.rpc)),[{name:'manee_set_store_food_ratio',args:{p_store_id:'sid-A',p_threshold:38}}]);
  assert.equal(r.state.storeFoodLimitMap.A,38);assert.equal(r.state.dashboardData,null,'old verdicts are dropped');assert.equal(r.log.dashLoads,1);
  assert.equal(await r.api.saveFoodLimit('A','42.46'),true);assert.equal(r.state.storeFoodLimitMap.A,42.5);
});
test('saveFoodLimit: empty, non-numeric, zero, negative and >100 are refused before any request',async()=>{
  const r=harness();
  for(const bad of ['','  ','abc','0','0.9','-5','100.1','1000','NaN','Infinity']){
    assert.equal(await r.api.saveFoodLimit('A',bad),false,'"'+bad+'"');
  }
  assert.equal(r.log.rpc.length,0);assert.equal(r.state.storeFoodLimitMap.A,undefined);
  assert.ok(r.log.toast.every(m=>/1에서 100/.test(m)));
  assert.equal(await r.api.saveFoodLimit('A','1'),true);assert.equal(await r.api.saveFoodLimit('A','100'),true);   // the ends are allowed
});
test('saveFoodLimit(null) resets to the default (sends NULL)',async()=>{
  const r=harness();r.api.setLimit('A',35);
  assert.equal(await r.api.saveFoodLimit('A',null),true);
  assert.equal(r.log.rpc[0].args.p_threshold,null);assert.equal(r.state.storeFoodLimitMap.A,null);assert.equal(r.api.foodRatioLimit('A'),40);
});
test('saveFoodLimit: a rejected request (not the owner / server error) changes nothing and says so; a missing function says the server is not ready',async()=>{
  let r=harness({rpcError:{code:'42501',message:'only an owner'}});r.api.setLimit('A',35);
  assert.equal(await r.api.saveFoodLimit('A','30'),false);
  assert.equal(r.state.storeFoodLimitMap.A,35,'value unchanged');assert.equal(r.log.dashLoads,0);assert.match(r.log.toast.at(-1),/저장하지 못했어요/);
  r=harness({rpcError:{code:'PGRST202',message:'function not found'}});
  assert.equal(await r.api.saveFoodLimit('A','30'),false);assert.match(r.log.toast.at(-1),/서버 준비/);
  r=harness({rpcResult:{ok:false}});assert.equal(await r.api.saveFoodLimit('A','30'),false);
  assert.equal(await harness().api.saveFoodLimit('Z','30'),false,'unknown store');
});
test('saveFoodLimit: a save that finishes after an account switch is not applied to the new account',async()=>{
  const r=harness();
  const p=r.api.saveFoodLimit('A','30');
  r.state.authProfile={user_id:'user-B'};
  await p;
  assert.equal(r.state.storeFoodLimitMap.A,undefined);
});

// ---- the same value is used by every screen ----
test('Owner dashboard, owner monthly report and manager home all use foodRatioLimit / LABOR_RATIO_LIMIT (no per-screen copies)',()=>{
  const mgr=fnText('renderManagerSummaryCard'),report=fnText('renderMonthlyReport'),dash=fnText('renderDashboard'),status=fnText('ownerStoreStatus');
  assert.ok(mgr.includes('foodRatioVerdict(state.store')&&mgr.includes('LABOR_RATIO_LIMIT'));
  assert.ok(report.includes('foodRatioVerdict(state.store')&&report.includes('LABOR_RATIO_LIMIT'));
  assert.ok(dash.includes('LABOR_RATIO_LIMIT')&&dash.includes('formatLimit(rowFoodLimit)'));
  assert.ok(status.includes('LABOR_RATIO_LIMIT')&&status.includes('formatLimit(foodLimit)'));
  // both the owner flow and the staff/manager flow load the limit of the store they show
  assert.ok(fnText('loadAllForStore').includes('loadFoodLimit(store)'));
  assert.ok(fnText('loadAuthStaffHome').includes('loadFoodLimit(store)'));
});
test('Only the owner sees the setting; it is stored through the RPC, not a direct table update',()=>{
  const start=html.indexOf('식자재비율 경고 기준</h3>');
  assert.ok(start>0);
  const before=html.slice(Math.max(0,start-500),start);
  assert.ok(/state\.role === "storeOwner"/.test(before));
  assert.ok(fnText('saveFoodLimit').includes("db.rpc('manee_set_store_food_ratio'"));
  assert.equal(/from\('stores'\)\s*\.update\([^)]*food_ratio/.test(html),false);
});
test('The change only affects labels: pay, wage and sales calculations are not part of it',()=>{
  const helpers=['foodRatioLimit','formatLimit','loadFoodLimit','saveFoodLimit'].map(fnText).join('\n');
  assert.equal(/calcCrewPayFrom|wage|salesSum\s*[+*/-]?=|total_sales/.test(helpers),false);
  assert.ok(/food_ratio_threshold/.test(helpers));
});
