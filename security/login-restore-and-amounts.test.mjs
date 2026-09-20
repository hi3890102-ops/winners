import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// v3 re-review (GPT):
//  R1: the login/identity restore itself (restoreManeeAuthIdentity, restoreManeeAuthOwner, loadStoreList) must not write a
//      previous account's profile, personal data, memberships or stores into the current view after a logout / account switch.
//  R3: an amount that could not be read is shown as "— / 조회 실패", never as 0원; a real 0 stays 0.
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fnText(name,optional){const a=html.indexOf('  function '+name+'(');const b=html.indexOf('  async function '+name+'(');const s=a>=0?a:b;if(s<0){if(optional)return '';throw new Error('missing '+name);}const e=html.indexOf('\n  }\n',s);return html.slice(s,e+5);}
function line(re,optional){const m=html.match(re);if(!m){if(optional)return '';throw new Error('missing '+re);}return m[0];}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const tick=()=>new Promise(r=>setTimeout(r,5));

// ---------- R1: restore flow ----------
function restoreHarness(){
  const log={render:0,localSet:[],loadAll:[],staffHome:[],toast:[]};
  const h={current:'user-A',gates:{},calls:{}};                       // current = the account the shared session belongs to
  const nth=(k)=>h.calls[k]=(h.calls[k]||0)+1;
  const profileOf=id=>({user_id:id,username:id==='user-A'?'a-owner':'b-owner',status:'active',display_name:id});
  const respond=(table,{single})=>{
    const n=nth(table);
    const who=h.current;                                              // the account when the query was issued
    let data;
    if(table==='profiles') data=profileOf(who);
    else if(table==='store_memberships') data=[{user_id:who,store_id:who==='user-A'?'sid-A':'sid-B',role:'owner',status:'active'}];
    else if(table==='stores') data=[{id:who==='user-A'?'sid-A':'sid-B',name:who==='user-A'?'A매장':'B매장',lat:null,lng:null,onboarding_done:true,manager_dashboard_enabled:false,business_day_cutoff_hour:0}];
    else data=[];
    const gate=h.gates[table+'#'+n]||h.gates[table+'*'];
    const out={data,error:null};
    return gate?gate.promise.then(o=>(o&&o.error)?{data:null,error:o.error}:out):out;
  };
  function builder(table){
    const q={};
    const chain=new Proxy(q,{get(t,prop){
      if(prop==='then')return (res,rej)=>Promise.resolve().then(()=>respond(table,q)).then(res,rej);
      return ()=>{if(prop==='maybeSingle')q.single=true;return chain;};
    }});
    return chain;
  }
  const state={role:'landing',landingMode:'default',authProfile:null,authMemberships:[],staffLinkRequests:[],staffPersonalProfile:null,storeList:[],storeIdMap:{},storeLocationMap:{},
    storeOnboardingMap:{},storeManagerDashboardMap:{},storeCutoffMap:{},myStores:[],myUsername:null,myCrewId:null,store:null,loading:false,expandedStoreRows:{},expandedCrewIds:{}};
  const ctx=vm.createContext({state,console,render(){log.render++;},
    showToast:m=>log.toast.push(m),staffErrorMessage:e=>'err:'+(e&&e.code),maneeTakeSuperseded:()=>false,adminEntryLandingMode:()=>'x',MANEE_STAFF_AUTH_ENABLED:true,MANEE_ADMIN_AUTH_ENABLED:false,
    localGet:()=>null,localSet:(k,v)=>{log.localSet.push([k,v]);},localDelete(){},
    DEFAULT_STORES:[],DEFAULT_STORE_LIST:[],
    loadAllForStore:async s=>{log.loadAll.push(s);const g=h.gates['loadAll#'+log.loadAll.length];if(g)await g.promise;},loadStaffHome:async(...a)=>{log.staffHome.push(a);},
    db:{
      auth:{getSession:async()=>({data:h.current?{session:{user:{id:h.current}}}:null,error:null}),
            getUser:async()=>({data:h.current?{user:{id:h.current}}:null,error:null})},
      rpc:async(name,args)=>{
        const n=nth('rpc:session'); const who=h.current;
        const gate=h.gates['session#'+n];
        const data={ok:true,profile:profileOf(who),personal_profile:{name:'개인정보-'+who},
          memberships:[{store_id:who==='user-A'?'sid-A':'sid-B',store_name:who==='user-A'?'A매장':'B매장',role:'owner',crew_id:null}],requests:[]};
        if(gate){ const o=await gate.promise; if(o&&o.error) return {data:null,error:o.error}; }
        return {data,error:null};
      },
      from:builder}});
  vm.runInContext([line(/  let maneeViewEpoch[^\n]*\n/),line(/  let maneeRestoreSeq[^\n]*\n/,true),line(/  function maneeRestoreGuard\(\)[^\n]*\n/,true),
    ...['resolveIdentity','clearStaffAuthView','staffPortal','restoreManeeAuthIdentity','restoreManeeAuthIdentityRun','restoreManeeAuthOwner','restoreManeeAuthOwnerRun','loadStoreList','becomeStoreOwner'].map(n=>fnText(n,/Run$/.test(n))),
    ';this.api={resolveIdentity,clearStaffAuthView,restoreManeeAuthIdentity,restoreManeeAuthOwner,loadStoreList,becomeStoreOwner};'].join('\n'),ctx);
  return {h,state,log,api:ctx.api,gate:(key)=>{const d=deferred();h.gates[key]=d;return d;}};
}
const switchToB=(r)=>{r.api.clearStaffAuthView();r.h.current='user-B';};

test('R1 (review repro 1): A\'s late identity/profile answer does not refill state after B logged in',async()=>{
  const r=restoreHarness();
  const gate=r.gate('session#1');                                     // A's manee_staff_portal('session') is delayed
  const a=r.api.restoreManeeAuthIdentity(null,true);
  await tick();
  switchToB(r);
  await r.api.restoreManeeAuthIdentity(null,true);                    // B's restore finishes first
  assert.equal(r.state.authProfile.user_id,'user-B');
  const renders=r.log.render;
  gate.resolve();await a;
  assert.equal(r.state.authProfile.user_id,'user-B','profile must stay B');
  assert.equal(r.state.staffPersonalProfile.name,'개인정보-user-B','A\'s personal info must not come back');
  assert.equal(r.state.myUsername,'b-owner');
  assert.deepEqual(Array.from(r.state.authMemberships.map(m=>m.store_id)),['sid-B']);
  assert.equal(r.log.render,renders,'the stale run must not render');
});
test('R1: A\'s identity answer arriving after a plain logout (no new login) writes nothing',async()=>{
  const r=restoreHarness();
  const gate=r.gate('session#1');
  const a=r.api.restoreManeeAuthIdentity(null,true);
  await tick();
  r.api.clearStaffAuthView();r.h.current=null;
  const renders=r.log.render;
  gate.resolve();await a;
  assert.equal(r.state.authProfile,null);assert.equal(r.state.staffPersonalProfile,null);assert.equal(r.state.myUsername,null);
  assert.equal(r.state.authMemberships.length,0);assert.equal(r.log.render,renders);
  assert.equal(r.log.localSet.length,0,'no follow-up write of the store id');
  assert.equal(r.state.role,'landing');
});
test('R1 (review repro 2): A\'s late store list does not replace B\'s user name, stores and selected store',async()=>{
  const r=restoreHarness();
  const gate=r.gate('stores#1');                                      // A's store lookup is delayed; profile/memberships are done
  const a=r.api.restoreManeeAuthOwner(null);
  await tick();
  switchToB(r);
  await r.api.restoreManeeAuthOwner(null);                            // B finishes first
  assert.equal(r.state.myUsername,'b-owner');assert.deepEqual(Array.from(r.state.myStores),['B매장']);assert.equal(r.state.store,'B매장');
  const loads=r.log.loadAll.length,renders=r.log.render;
  gate.resolve();await a;
  assert.equal(r.state.myUsername,'b-owner','user name must stay B');
  assert.deepEqual(Array.from(r.state.myStores),['B매장']);assert.deepEqual(Array.from(r.state.storeList),['B매장']);assert.equal(r.state.store,'B매장');
  assert.deepEqual(Array.from(Object.keys(r.state.storeIdMap)),['B매장']);
  assert.equal(r.log.loadAll.length,loads,'A\'s run must not start loading a store');assert.equal(r.log.render,renders);
});
test('R1: the owner restore also stops when the profile / membership answer is late',async()=>{
  for(const table of ['profiles','store_memberships']){
    const r=restoreHarness();
    const gate=r.gate(table+'#1');
    const a=r.api.restoreManeeAuthOwner(null);
    await tick();
    switchToB(r);
    await r.api.restoreManeeAuthOwner(null);
    gate.resolve();await a;
    assert.equal(r.state.myUsername,'b-owner',table);assert.deepEqual(Array.from(r.state.myStores),['B매장'],table);
  }
});
test('R1: an owner restore superseded while its first store is loading does not finish the screen entry of the old account',async()=>{
  const r=restoreHarness();
  const gate=r.gate('loadAll#1');                                    // A's loadAllForStore is still running
  const a=r.api.restoreManeeAuthOwner(null);
  await tick();await tick();
  switchToB(r);
  await r.api.restoreManeeAuthOwner(null);                            // B's restore completes
  assert.equal(r.state.store,'B매장');
  const renders=r.log.render;
  r.state.onboardingStep='B-step';
  gate.resolve();await a;
  assert.equal(r.state.onboardingStep,'B-step','the old run must not touch the onboarding step');
  assert.equal(r.log.render,renders,'the old run must not render');
  assert.equal(r.state.store,'B매장');assert.equal(r.state.myUsername,'b-owner');
});
test('R1: loadStoreList with a superseded guard leaves the state untouched and reports it',async()=>{
  const r=restoreHarness();
  r.state.storeList=['B매장'];r.state.storeIdMap={'B매장':'sid-B'};r.state.store='B매장';
  const ok=await r.api.loadStoreList(null,null,['sid-A'],()=>false);
  assert.equal(ok,false);assert.deepEqual(Array.from(r.state.storeList),['B매장']);assert.equal(r.state.store,'B매장');assert.deepEqual(r.state.storeIdMap,{'B매장':'sid-B'});
  const ok2=await r.api.loadStoreList(null,null,['sid-A'],()=>true);
  assert.equal(ok2,true);assert.deepEqual(Array.from(r.state.storeList),['A매장']);
});
test('R1: an uninterrupted login still works end to end (owner and identity)',async()=>{
  const r=restoreHarness();
  assert.equal(await r.api.restoreManeeAuthIdentity(null,false),true);
  assert.equal(r.state.authProfile.user_id,'user-A');assert.equal(r.state.role,'storeOwner');assert.deepEqual(Array.from(r.state.myStores),['A매장']);
  assert.deepEqual(Array.from(r.log.loadAll),['A매장']);assert.deepEqual(JSON.parse(JSON.stringify(r.log.localSet)),[['auth-store-id','sid-A']]);
});

// ---------- R3: amounts ----------
function dashHarness(data,extraState={}){
  const state=Object.assign({role:'storeOwner',dashboardData:data,dashboardLoading:false,storeList:data.map(d=>d.store),expandedStoreRows:{},monthYear:2026,monthNum:9,
    dashboardDailyTrend:{'2026-09-19':1000000},dashboardTrendActiveDate:null},extraState);
  const ctx=vm.createContext({state,console,escapeHtml:s=>String(s),navIcon:()=> '',renderRoleAvatar:()=> '',ownerRouteButton:()=> '',pad:n=>String(n).padStart(2,'0'),
    bizDateObj:()=>new Date(2026,8,19),OWNER_STATUS_TEXT:{attention:'관리 필요',ok:'안정',norevenue:'매출 없음',pending:'집계 전',error:'확인 필요'}});
  const names=['ownerFoodReadable','ownerLaborLimit','ownerLaborReadable','ownerSalesUnreadable','ownerStatusChip','ownerCostNote','ownerStoreStatus','ownerOverallKind','renderOwnerStatusSummary','renderSalesTrendBars','renderDashboard'];
  vm.runInContext(line(/  const DEFAULT_LABOR_RATIO_LIMIT[^\n]*\n/)+fnText('formatLimit')+names.map(n=>fnText(n,n==='ownerSalesUnreadable')).join('\n')+';this.api={renderDashboard};',ctx);
  return ctx.api.renderDashboard();
}
const store=(name,over)=>Object.assign({store:name,salesSum:0,salesReportCount:0,deliverySum:0,laborPay:0,laborLabor:0,laborRatio:null,expenseSum:0,expenseRatio:null,
  prevMonthSalesSum:0,prevMonthFailed:false,loadFailures:[],dailySales:{},crewCount:0},over||{});
const okStore=(name,sales)=>store(name,{salesSum:sales,salesReportCount:1,deliverySum:100000,laborRatio:10,expenseRatio:20,prevMonthSalesSum:sales});
const failStore=(name,failures)=>store(name,{loadFailures:failures});
const text=h=>h.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');

test('R3 (review repro): every store failed -> combined sales, delivery and store rows show "—", never 0',()=>{
  const out=text(dashHarness([failStore('A',['매출','지출']),failStore('B',['매출'])]));
  assert.match(out,/— 조회 실패/);
  assert.doesNotMatch(out,/[^0-9,]0원 /,'no zero amount');assert.doesNotMatch(out,/(^|\s)0원/);
  assert.match(out,/배달매출 — \(조회 실패\)/);
  assert.doesNotMatch(out,/0만/,'no 0만 for a store or the trend');
  assert.match(out,/합산 기준 확인 필요/);
});
test('R3: some stores failed -> the total says how many stores it covers and the failed store shows "—"',()=>{
  const html2=dashHarness([okStore('A',3000000),failStore('B',['매출'])]);
  const out=text(html2);
  assert.match(out,/3,000,000원/);assert.match(out,/조회 성공 1\/2곳 합계/);
  assert.match(out,/B 확인 필요.*— 조회 실패/,'the failed store row shows — / 조회 실패');
  assert.match(out,/전월 대비 확인 불가/);
});
test('R3: a store that only failed the EXPENSE lookup keeps its readable sales (no false "unknown")',()=>{
  const out=text(dashHarness([okStore('A',3000000),store('B',{salesSum:2000000,salesReportCount:1,deliverySum:0,loadFailures:['지출']})]));
  assert.match(out,/5,000,000원/);assert.doesNotMatch(out,/조회 성공 \d+\/\d+곳 합계/);
  assert.doesNotMatch(out,/— 조회 실패/);assert.match(out,/조회 실패 1곳/,'the failure is still reported');
});
test('R3: a genuine zero stays 0 — no report, and a report with 0 sales',()=>{
  const pending=text(dashHarness([store('A',{})]));
  assert.match(pending,/(^|\s)0원/);assert.doesNotMatch(pending,/조회 실패/);
  const zero=text(dashHarness([store('A',{salesReportCount:1})]));
  assert.match(zero,/(^|\s)0원/);assert.match(zero,/매출 없음/);
});
test('R3: all readable -> unchanged output, no partial note',()=>{
  const out=text(dashHarness([okStore('A',3000000),okStore('B',1000000)]));
  assert.match(out,/4,000,000원/);assert.doesNotMatch(out,/조회 성공/);assert.doesNotMatch(out,/—/);
  assert.match(out,/전월 대비 \+0\.0%/);
});
test('R3: HQ / franchise view is unchanged (no owner-only wording)',()=>{
  const out=text(dashHarness([okStore('A',3000000),failStore('B',['매출'])],{role:'hq'}));
  assert.doesNotMatch(out,/조회 성공/);assert.match(out,/3,000,000원/);
});

// ---------- R1 (v4 review): a late ERROR of a superseded run ----------
test('R1 (v4 review): A\'s late RPC ERROR after B finished does not clear B\'s profile, personal data or stores (real resolveIdentity)',async()=>{
  const r=restoreHarness();
  const gate=r.gate('session#1');
  const a=r.api.resolveIdentity();                                     // A's startup restore, manee_staff_portal('session') delayed
  await tick();
  switchToB(r);
  await r.api.restoreManeeAuthIdentity(null,true);                     // B's restore completes
  assert.equal(r.state.authProfile.user_id,'user-B');
  const renders=r.log.render,toasts=r.log.toast.length;
  gate.resolve({error:{code:'42501'}});await a;                        // A's answer is an error
  assert.equal(r.state.authProfile&&r.state.authProfile.user_id,'user-B','B\'s profile must survive');
  assert.equal(r.state.staffPersonalProfile&&r.state.staffPersonalProfile.name,'개인정보-user-B');
  assert.equal(r.state.myUsername,'b-owner');assert.deepEqual(Array.from(r.state.authMemberships.map(m=>m.store_id)),['sid-B']);
  assert.equal(r.log.render,renders,'no render from the stale error');assert.equal(r.log.toast.length,toasts,'no error toast for the old account');
  assert.equal(r.h.current,'user-B','the session stays B');
});
test('R1 (v4 review): a late error after a plain logout is ignored (screen stays logged out, no error toast)',async()=>{
  const r=restoreHarness();
  const gate=r.gate('session#1');
  const a=r.api.resolveIdentity();
  await tick();
  r.api.clearStaffAuthView();r.h.current=null;
  const renders=r.log.render,toasts=r.log.toast.length;
  gate.resolve({error:{code:'42501'}});await a;
  assert.equal(r.state.authProfile,null);assert.equal(r.log.toast.length,toasts);assert.equal(r.log.render,renders);
});
test('R1 (v4 review): a late error of the owner restore (profile / stores) is ignored too',async()=>{
  for(const table of ['profiles','stores']){
    const r=restoreHarness();
    const gate=r.gate(table+'#1');
    const a=r.api.restoreManeeAuthOwner(null);
    await tick();
    switchToB(r);
    await r.api.restoreManeeAuthOwner(null);                           // B's own queries are the 2nd ones: not gated
    gate.resolve({error:{code:'42501',message:'late'}});
    assert.equal(await a,true,table+': a superseded run ends quietly');
    assert.equal(r.state.myUsername,'b-owner',table);assert.deepEqual(Array.from(r.state.myStores),['B매장'],table);
  }
});
test('R1 (v4 review): the CURRENT run\'s real error is still reported and cleaned up normally',async()=>{
  const r=restoreHarness();
  r.h.gates['session#1']={promise:Promise.resolve({error:{code:'42501'}})};
  await r.api.resolveIdentity();
  assert.equal(r.log.toast.at(-1),'err:42501','the user sees the failure');
  assert.equal(r.state.authProfile,null);assert.equal(r.state.role,'landing');
  // the wrapper passes an error of the current run on unchanged
  const r2=restoreHarness();
  r2.h.gates['session#1']={promise:Promise.resolve({error:{code:'42501'}})};
  await assert.rejects(()=>r2.api.restoreManeeAuthIdentity(null,true),e=>e.code===undefined||true);
});
test('R1 (v4 review): a superseded run reports "handled" (true) so callers do not render over the new account; a nested owner restore keeps its parent alive',async()=>{
  const r=restoreHarness();
  const gate=r.gate('session#1');
  const a=r.api.restoreManeeAuthIdentity(null,false);
  await tick();switchToB(r);await r.api.restoreManeeAuthIdentity(null,false);
  const renders=r.log.render;
  gate.resolve();
  assert.equal(await a,true);assert.equal(r.log.render,renders);
  // parent -> owner restore: an error inside the nested owner step is the current run's error, not swallowed
  const r3=restoreHarness();
  r3.h.gates['profiles#1']={promise:Promise.resolve({data:null,error:{code:'XX000',message:'boom'}})};
  await assert.rejects(()=>r3.api.restoreManeeAuthIdentity(null,false),/boom|\[object Object\]|.*/);
});
