import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../owner-ui.css',import.meta.url),'utf8');
function fn(name){const a=html.indexOf('  function '+name+'(');const b=html.indexOf('  async function '+name+'(');const s=a>=0?a:b;assert.ok(s>=0,name);const e=html.indexOf('\n  }\n',s);return html.slice(s,e+5);}

// ---------- sign-in persistence adapter ("로그인 상태 유지") ----------
const block=html.match(/  const MANEE_REMEMBER_KEY[\s\S]*?const db = /)[0].replace(/const db = $/,'');
const scoped=html.match(/  const MANEE_SESSION_SCOPED_KEYS[\s\S]*?function localDelete\(key\)\{[\s\S]*?\n  \}\n/)[0];
function storageArea(options={}){
  const map=new Map();
  return {map,getItem:k=>{if(options.blocked)throw new Error('blocked');return map.has(k)?map.get(k):null;},
    setItem:(k,v)=>{if(options.blocked)throw new Error('blocked');map.set(k,String(v));},removeItem:k=>{if(options.blocked)throw new Error('blocked');map.delete(k);}};
}
// Two "tabs" share localStorage but each has its own sessionStorage and its own copy of the module state.
function browser(options={}){
  const local=storageArea(options.local);
  function tab(existingSession){
    const session=existingSession||storageArea(options.session);
    const win={localStorage:local,sessionStorage:session};
    const ctx=vm.createContext({window:win,localStorage:local,MANEE_LOCAL_PREFIX:options.prefix||'',MANEE_IS_STAGING:!!options.staging,MANEE_CONFIG:{projectRef:'exampleref'}});
    vm.runInContext(block+scoped+';this.api={storage:maneeAuthStorage,remember:maneeRememberLogin,setRemember:(v)=>{maneeSetRememberLogin(v);maneeArmLogin();},arm:maneeArmLogin,endPending:maneeEndPendingLogin,key:MANEE_AUTH_KEY,ownUntil:()=>maneeOwnAuthUntil,mode:()=>maneeTabMode,localGet,localSet,localDelete};',ctx);
    return {session,...ctx.api};
  }
  return {local,tab};
}
const KEY='sb-exampleref-auth-token',A='{"user":"A"}',B='{"user":"B"}';
const sess=(uid,tag)=>JSON.stringify({tag,user:{id:uid}});   // session-shaped values (the account is read from user.id)
test('The auth storage key is the SDK default in production and the separate key in staging',()=>{
  assert.equal(browser().tab().key,KEY);
  assert.equal(browser({staging:true}).tab().key,'manee-exampleref-auth');
});
test('Default (no saved choice): the login is kept, the session goes to localStorage only',()=>{
  const t=browser().tab();assert.equal(t.remember(),true);
  t.arm();t.storage.setItem(KEY,A);
  assert.equal(t.session.map.has(KEY),false);assert.equal(t.storage.getItem(KEY),A);
});
test('Unchecked: the session lives in sessionStorage only and never reaches localStorage',()=>{
  const b=browser(),t=b.tab();t.setRemember(false);
  t.storage.setItem(KEY,A);
  assert.equal(t.session.map.get(KEY),A);assert.equal(b.local.map.has(KEY),false);
});
test('A session created before this option existed (localStorage, no saved choice) is still read and keeps its place on refresh',()=>{
  const b=browser();b.local.map.set(KEY,A);
  const t=b.tab();assert.equal(t.storage.getItem(KEY),A);
  t.storage.setItem(KEY,A+' ');assert.equal(b.local.map.get(KEY),A+' ');assert.equal(t.session.map.has(KEY),false);
});
test('Unchecked login of the SAME account after a kept one removes the old localStorage copy, so it cannot come back after the tab closes',()=>{
  const b=browser();b.local.map.set(KEY,sess('A','old'));
  const t=b.tab();t.setRemember(false);t.storage.setItem(KEY,sess('A','new'));
  assert.equal(b.local.map.has(KEY),false);assert.equal(t.session.map.get(KEY),sess('A','new'));
  const reopened=b.tab();                       // browser restarted: sessionStorage is gone, localStorage remains
  assert.equal(reopened.storage.getItem(KEY),null);
});
test('Token refresh keeps this tab\'s place even if another tab flips the shared preference',()=>{
  const b=browser(),keep=b.tab(),temp=b.tab();
  keep.setRemember(true);keep.storage.setItem(KEY,A);
  temp.setRemember(false);                       // another tab signs in with "keep" unchecked: shared flag becomes 0
  keep.storage.setItem(KEY,A+' refreshed');       // this tab's token refresh
  assert.equal(b.local.map.get(KEY),A+' refreshed');assert.equal(keep.session.map.has(KEY),false);
});
test('A tab holding a session-only sign-in keeps refreshing into sessionStorage after a reload, whatever the preference says',()=>{
  const b=browser(),first=b.tab();first.setRemember(false);first.storage.setItem(KEY,A);
  b.local.map.set('remember-login','1');
  const reloaded=b.tab(first.session);     // same tab, page reloaded: module state is fresh, sessionStorage survives
  reloaded.storage.setItem(KEY,A+' refreshed');
  assert.equal(first.session.map.get(KEY),A+' refreshed');assert.equal(b.local.map.has(KEY),false);
});
test('Logout clears this tab\'s session, its same-account duplicate and its memory of where it lived; the next write follows the saved choice',()=>{
  const b=browser(),t=b.tab();t.setRemember(false);t.storage.setItem(KEY,sess('A','a1'));b.local.map.set(KEY,sess('A','dup'));
  t.storage.removeItem(KEY);
  assert.equal(b.local.map.has(KEY),false);assert.equal(t.session.map.has(KEY),false);assert.equal(t.mode(),null);
  t.arm();t.storage.setItem(KEY,sess('A','a2'));assert.equal(b.local.map.has(KEY),false);assert.equal(t.session.map.get(KEY),sess('A','a2')); // the next explicit sign-in follows the saved choice (unchecked)
  t.storage.removeItem(KEY);t.setRemember(true);t.storage.setItem(KEY,sess('A','a3'));assert.equal(b.local.map.get(KEY),sess('A','a3'));
});
test('One account per browser: a different account signing in replaces the other account\'s kept login, and logging out only removes the own',()=>{
  const b=browser(),shared=b.tab(),own=b.tab();
  shared.setRemember(true);shared.storage.setItem(KEY,sess('A','a1'));
  own.setRemember(false);own.storage.setItem(KEY,sess('B','b1'));   // explicit sign-in of a different account
  assert.equal(b.local.map.has(KEY),false,'A\'s kept session is gone from this browser');
  assert.equal(shared.storage.getItem(KEY),null,'tab A no longer has a session');
  own.storage.removeItem(KEY);
  assert.equal(own.storage.getItem(KEY),null);assert.equal(b.local.map.has(KEY),false);
});
test('Reads prefer this tab\'s own session over the shared one, so another account\'s session is not picked up',()=>{
  const b=browser(),t=b.tab();t.session.map.set(KEY,B);b.local.map.set(KEY,A);
  assert.equal(t.storage.getItem(KEY),B);
});
test('The app\'s own sign-in/out/refresh is marked so it is not mistaken for another tab\'s event',()=>{
  const t=browser().tab();assert.equal(t.ownUntil(),0);
  t.arm();t.storage.setItem(KEY,A);assert.ok(t.ownUntil()>Date.now());
  const u=browser().tab();u.storage.setItem('other-key','x');assert.equal(u.ownUntil(),0);
});
test('Only the boolean choice is stored under the app key; never a password',()=>{
  const b=browser(),t=b.tab();t.setRemember(false);
  assert.deepEqual([...b.local.map.entries()],[['remember-login','0']]);
  t.setRemember(true);assert.deepEqual([...b.local.map.entries()],[['remember-login','1']]);
  const s=browser({prefix:'manee:ref:',staging:true}).tab();s.setRemember(true);
  assert.deepEqual([...s.session.map.keys()],[]);
});
test('Blocked browser storage keeps the session in memory only (nothing persisted)',()=>{
  const t=browser({local:{blocked:true},session:{blocked:true}}).tab();
  t.arm();t.storage.setItem(KEY,A);t.endPending();assert.equal(t.storage.getItem(KEY),A);
  t.storage.setItem(KEY,A+' refreshed');assert.equal(t.storage.getItem(KEY),A+' refreshed');   // a refresh of the in-memory session works
  t.storage.removeItem(KEY);assert.equal(t.storage.getItem(KEY),null);
});
test('The last selected store id follows the same choice and is cleared on logout; other app keys are untouched; a new account replaces the old account\'s store id',()=>{
  const b=browser(),keep=b.tab();keep.setRemember(true);keep.storage.setItem(KEY,sess('A','a1'));keep.localSet('auth-store-id','store-1');
  assert.equal(b.local.map.get('auth-store-id'),'store-1');assert.equal(keep.session.map.has('auth-store-id'),false);
  const temp=b.tab();temp.setRemember(false);temp.storage.setItem(KEY,sess('B','b1'));temp.localSet('auth-store-id','store-2');
  assert.equal(temp.session.map.get('auth-store-id'),'store-2');assert.equal(b.local.map.has('auth-store-id'),false,'account A\'s store id left with A\'s login');
  assert.equal(temp.localGet('auth-store-id').value,'store-2');
  b.local.map.set('my-link','legacy');b.local.map.set('unrelated-app-data','keep me');
  temp.storage.removeItem(KEY);temp.localDelete('auth-store-id');
  assert.equal(temp.session.map.size,0);
  assert.equal(b.local.map.get('unrelated-app-data'),'keep me');assert.equal(b.local.map.get('my-link'),'legacy');
  keep.localSet('my-link','x');assert.equal(b.local.map.get('my-link'),'x');   // ordinary keys still use localStorage
});
test('A store id saved before this option existed (localStorage) is still read',()=>{
  const b=browser();b.local.map.set('auth-store-id','old-store');
  assert.equal(b.tab().localGet('auth-store-id').value,'old-store');
});
test('Sign-in writes the chosen persistence BEFORE any session can be stored, and never stores the password',()=>{
  const body=fn('loginStoreOwner');
  const setAt=body.indexOf('maneeSetRememberLogin('),loginAt=body.indexOf('callManeeAuthApi("manee-login"');
  assert.ok(setAt>0&&loginAt>setAt);
  assert.equal(/localStorage\.setItem\([^)]*(pw|password)/i.test(body),false);
  assert.equal(/localSet\([^)]*(pw|password)/i.test(body),false);
});
test('Logout never wipes unrelated app data (no clear() on either storage)',()=>{
  assert.equal(/(local|session)Storage\.clear\(/.test(html),false);
});

// ---------- multi-tab sync ----------
function syncHarness({role='storeOwner',shown='user-A',session,active=null,superseded=false}){
  const calls=[];
  const ctx=vm.createContext({state:{role,authProfile:shown?{user_id:shown}:null},db:{auth:{getSession:async()=>({data:{session}})}},
    location:{reload:()=>calls.push('reload')},clearStaffAuthView(){calls.push('clear');},localDelete(){},render(){calls.push('render');},showToast:m=>calls.push('toast:'+m),
    maneeActiveUser:()=>active,maneeTakeSuperseded:()=>superseded,
    MANEE_ADMIN_AUTH_ENABLED:false});
  vm.runInContext(fn('leaveToLoginScreen')+fn('syncAuthAcrossTabs'),ctx);
  return {calls,run:()=>ctx.syncAuthAcrossTabs()};
}
test('Another tab logged out: this tab returns to the login screen',async()=>{
  const h=syncHarness({session:null});await h.run();
  assert.deepEqual(h.calls.slice(0,2),['clear','render']);assert.ok(h.calls.some(c=>/^toast:.*로그아웃/.test(c)));
});
test('Another account signed in (its marker is now active): this tab goes to the login screen and never reloads into the other account',async()=>{
  for(const h of [syncHarness({session:null,active:'user-B',superseded:true}),syncHarness({session:null,active:'user-B'}),syncHarness({session:{user:{id:'user-B'}}})]){
    await h.run();
    assert.deepEqual(h.calls.slice(0,2),['clear','render']);assert.ok(!h.calls.includes('reload'));
    assert.ok(h.calls.some(c=>/^toast:.*다른 계정으로 로그인/.test(c)),'says why');
  }
});
test('Events about the same account, or a session-only sign-in this tab still holds, change nothing',async()=>{
  const h=syncHarness({session:{user:{id:'user-A'}}});await h.run();assert.deepEqual(h.calls,[]);
});
test('The login screen is left alone',async()=>{
  const h=syncHarness({role:'landing',shown:null,session:null});await h.run();assert.deepEqual(h.calls,[]);
});
test('Sync ignores this tab\'s own actions and re-checks on storage changes and when the tab becomes visible',()=>{
  const init=fn('initAuthTabSync');
  assert.ok(init.includes('maneeOwnAuthUntil'));assert.ok(init.includes('"storage"'));assert.ok(init.includes('visibilitychange'));
  assert.ok(init.includes('"SIGNED_OUT"')&&init.includes('"SIGNED_IN"'));
  assert.ok(html.includes('  initAuthTabSync();'));
});
test('Logging out clears everything cached for the previous account (owner home data, open forms, screen)',()=>{
  const state={dashboardData:[{store:'A'}],dashboardLoading:true,expandedStoreRows:{A:true},expandedCrewIds:{x:1},dashboardReservations:[1],section:'more',showOwnerSalesForm:true,salesEditingId:'id',salesEditDate:'d',showAddStoreForm:true,selectedDate:'d',selectedSalesDate:'d',authProfile:{user_id:'A'},store:'A',crew:[1]};
  const ctx=vm.createContext({state,maneeViewEpoch:0,maneeRestoreSeq:0});vm.runInContext(fn('clearStaffAuthView'),ctx);ctx.clearStaffAuthView();
  assert.equal(ctx.maneeViewEpoch,1,'in-flight lookups of the previous account are invalidated');
  assert.equal(state.dashboardData,null);assert.equal(state.dashboardLoading,false);assert.equal(JSON.stringify(state.expandedStoreRows),'{}');
  assert.equal(state.section,'dashboard');assert.equal(state.showOwnerSalesForm,false);assert.equal(state.salesEditingId,null);
  assert.equal(state.authProfile,null);assert.equal(state.store,null);assert.equal(state.role,'landing');
});

// ---------- login screen ----------
function renderLogin(tab,{staffAuth=true,remember}={}){
  const ctx=vm.createContext({state:{landingTab:tab,rememberMeChecked:remember},MASCOT_IMG_DATA:'data:logo',MASCOT2_IMG_DATA:'data:mascot',
    MANEE_STAFF_AUTH_ENABLED:staffAuth,maneeRememberLogin:()=>true});
  vm.runInContext(fn('loginIcon')+fn('renderLoginScreen'),ctx);return ctx.renderLoginScreen();
}
test('Login screen offers 사장님 / 직원·매니저 and keeps the existing element ids and staff-auth actions',()=>{
  const owner=renderLogin('owner');
  assert.match(owner,/data-landingtab="owner" aria-pressed="true">[\s\S]*?사장님<\/button>/);
  assert.match(owner,/data-landingtab="staff" aria-pressed="false">[\s\S]*?직원·매니저<\/button>/);
  assert.equal(owner.includes('스텝 로그인'),false);assert.equal(owner.includes('사장님 로그인</button>'),false);
  for(const id of ['store-login-username-input','store-login-password-input','store-login-submit-btn','forgot-password-btn','store-signup-btn','remember-login-checkbox','login-message'])assert.ok(owner.includes('id="'+id+'"'),id);
  const staff=renderLogin('staff');
  for(const id of ['store-login-username-input','store-login-password-input','store-login-submit-btn','remember-login-checkbox'])assert.ok(staff.includes('id="'+id+'"'),id);
  assert.ok(staff.includes('data-staff-auth-action="recovery-forgot"'));assert.ok(staff.includes('data-staff-auth-action="signup-screen"'));
  assert.equal(staff.includes('id="forgot-password-btn"'),false);
});
test('"로그인 상태 유지" is offered on both sides, checked by default, and reflects the saved choice',()=>{
  for(const tab of ['owner','staff']){
    assert.match(renderLogin(tab,{remember:undefined}),/id="remember-login-checkbox" checked>로그인 상태 유지/);
    assert.match(renderLogin(tab,{remember:false}),/id="remember-login-checkbox">로그인 상태 유지/);
  }
});
test('The login screen uses the app\'s existing logo and character, byte-for-byte the approved mockup images',()=>{
  const h=name=>createHash('sha256').update(Buffer.from(html.match(new RegExp('const '+name+' = "data:image/png;base64,([A-Za-z0-9+/=]+)"'))[1],'base64')).digest('hex');
  assert.equal(h('MASCOT_IMG_DATA'),'4421e14e3e37d930757f8c471d8d8ef57ad7d032b8bf84b31150878f9b847887');
  assert.equal(h('MASCOT2_IMG_DATA'),'3722ceb07b78927c8526d858f58fafe32458a6dfc4bc26aea85f6f16f22f2687');
  const owner=renderLogin('owner');assert.ok(owner.includes('src="data:logo"'));assert.ok(owner.includes('src="data:mascot"'));
});

// ---------- owner-home status ----------
function statusCtx(){
  const ctx=vm.createContext({escapeHtml:s=>String(s)});
  vm.runInContext(html.match(/  const OWNER_STATUS_TEXT[\s\S]*?\n  function ownerStatusChip/)[0].replace(/\n  function ownerStatusChip$/,'')+html.match(/  const LABOR_RATIO_LIMIT[^\n]*\n/)[0]+fn('formatLimit')+fn('ownerStatusChip')+fn('ownerCostNote')+fn('ownerStoreStatus')+fn('ownerOverallKind')+fn('renderOwnerStatusSummary')+';this.ownerOverallKind=ownerOverallKind;',ctx);
  return ctx;
}
const store=(o)=>({store:'S',salesSum:0,salesReportCount:0,laborPay:0,laborRatio:null,expenseSum:0,expenseRatio:null,...o});
test('Thresholds (owner decision): labor 22% fixed, food 40% by default or the store\'s own value; the old 25% / 35% are gone',()=>{
  assert.match(html,/const LABOR_RATIO_LIMIT = 22, DEFAULT_FOOD_RATIO_LIMIT = 40;/);
  const dash=fn('renderDashboard');
  assert.ok(dash.includes('const laborBad = d.laborRatio!==null && d.laborRatio>LABOR_RATIO_LIMIT;'));
  assert.ok(dash.includes('const foodBad = d.expenseRatio!==null && rowFoodLimit!==null && d.expenseRatio>rowFoodLimit;'));
  assert.ok(dash.includes('const hasIssue = laborBad || foodBad;'));
  // no hard-coded ratio thresholds remain in any verdict / colour / label code
  const code=[fn('ownerStoreStatus'),fn('ownerOverallKind'),dash,fn('renderStaffHomeContent'),fn('renderManagerSummaryCard'),fn('renderMonthlyReport')].join('\n');
  const numbers=new Set([...code.matchAll(/(?:ratio|Ratio)\s*[<>]=?\s*(\d+(?:\.\d+)?)/g)].map(m=>m[1]));
  assert.deepEqual([...numbers].filter(n=>n!=='0'),[],'hard-coded ratio threshold(s): '+[...numbers]);
  assert.ok(!/>\s*25\b|>\s*35\b|25%|35%/.test(code.replace(/\/\/[^\n]*/g,'')),'no 25% / 35% left');
  // owner, manager and detail screens all use the same helpers
  assert.ok(fn('renderManagerSummaryCard').includes('sum.laborRatio>LABOR_RATIO_LIMIT'));
  assert.ok(fn('renderManagerSummaryCard').includes('foodRatioVerdict(state.store'));
  assert.ok(fn('renderMonthlyReport').includes('foodRatioVerdict(state.store'));
  assert.ok(fn('renderStaffHomeContent').includes('renderManagerSummaryCard('));
});
test('Per-store verdicts: 22% labor / 40% default food decide "관리 필요", boundaries are strict (> not >=)',()=>{
  const c=statusCtx();
  assert.equal(c.ownerStoreStatus(store({salesSum:1e6,laborRatio:22,expenseRatio:40})).kind,'ok');
  const labor=c.ownerStoreStatus(store({salesSum:1e6,laborRatio:22.1,expenseRatio:10}));
  assert.equal(labor.kind,'attention');assert.equal(JSON.stringify(labor.reasons),JSON.stringify(['인건비율 22% 초과']));
  assert.equal(c.ownerStoreStatus(store({salesSum:1e6,laborRatio:24,expenseRatio:10})).kind,'attention','the old 25% line no longer applies');
  const food=c.ownerStoreStatus(store({salesSum:1e6,laborRatio:5,expenseRatio:40.1}));
  assert.equal(food.kind,'attention');assert.equal(JSON.stringify(food.reasons),JSON.stringify(['식자재비율 40% 초과']));
  assert.equal(c.ownerStoreStatus(store({salesSum:1e6,laborRatio:5,expenseRatio:37})).kind,'ok','35..40 is fine at the default');
  assert.equal(JSON.stringify(c.ownerStoreStatus(store({salesSum:1e6,laborRatio:30,expenseRatio:50})).reasons),JSON.stringify(['인건비율 22% 초과','식자재비율 40% 초과']));
});
test('A store\'s own food limit decides its verdict and its wording; an unreadable limit is never a verdict',()=>{
  const c=statusCtx();
  assert.equal(c.ownerStoreStatus(store({salesSum:1e6,laborRatio:5,expenseRatio:38,foodThreshold:38})).kind,'ok','exactly equal to the limit is not over');
  const over=c.ownerStoreStatus(store({salesSum:1e6,laborRatio:5,expenseRatio:38.1,foodThreshold:38}));
  assert.equal(over.kind,'attention');assert.equal(JSON.stringify(over.reasons),JSON.stringify(['식자재비율 38% 초과']));
  assert.equal(c.ownerStoreStatus(store({salesSum:1e6,laborRatio:5,expenseRatio:44,foodThreshold:45})).kind,'ok','a raised limit is honoured');
  assert.equal(JSON.stringify(c.ownerStoreStatus(store({salesSum:1e6,laborRatio:5,expenseRatio:38.5,foodThreshold:37.5})).reasons),JSON.stringify(['식자재비율 37.5% 초과']));
  const unknown=c.ownerStoreStatus(store({salesSum:1e6,laborRatio:5,expenseRatio:90,foodThreshold:null,loadFailures:['식자재 기준']}));
  assert.equal(unknown.kind,'error');assert.deepEqual(Array.from(unknown.failures),['식자재 기준']);assert.equal(unknown.reasons.length,0);
});
test('Different limits per store: one store over ITS limit keeps the combined verdict at "관리 필요" even if the average is low',()=>{
  const c=statusCtx();
  const rows=[store({store:'가',salesSum:9e6,laborRatio:5,expenseRatio:30,foodThreshold:40}),store({store:'나',salesSum:1e6,laborRatio:5,expenseRatio:30,foodThreshold:25})];
  const kind=c.ownerOverallKind(rows);
  assert.equal(kind,'attention');
  const out=c.renderOwnerStatusSummary(rows,kind,0,0);
  assert.match(out,/관리 필요 1곳/);assert.match(out,/관리 필요: 나/);
  assert.equal(c.ownerOverallKind([store({store:'가',salesSum:1e6,laborRatio:5,expenseRatio:30})]),'ok');
  assert.equal(c.ownerOverallKind([store({store:'가',salesSum:1e6,laborRatio:5,expenseRatio:30,loadFailures:['지출']}),store({store:'나',salesSum:1e6,laborRatio:5,expenseRatio:10})]),'error');
  assert.equal(c.ownerOverallKind([store({}),store({store:'나',salesReportCount:2})]),'norevenue');
  assert.equal(c.ownerOverallKind([store({})]),'pending');
});
test('No report entered is "집계 전"; reports entered with 0 sales is "매출 없음"; neither is ever green',()=>{
  const c=statusCtx();
  const pending=c.ownerStoreStatus(store({}));assert.equal(pending.kind,'pending');assert.equal(pending.costNote,'');
  const zero=c.ownerStoreStatus(store({salesReportCount:3}));assert.equal(zero.kind,'norevenue');assert.equal(zero.costNote,'');
  assert.notEqual(pending.kind,'ok');assert.notEqual(zero.kind,'ok');
  assert.match(c.ownerStatusChip('pending'),/owner-status none" data-kind="pending"[\s\S]*집계 전<\/span>/);
  assert.match(c.ownerStatusChip('norevenue'),/owner-status none" data-kind="norevenue"[\s\S]*매출 없음<\/span>/);
});
test('Costs are shown as facts when nothing can be judged, never as a verdict',()=>{
  const c=statusCtx();
  const spend=c.ownerStoreStatus(store({expenseSum:120000}));
  assert.equal(spend.kind,'pending');assert.equal(spend.costNote,'지출 120,000원 발생');
  const both=c.ownerStoreStatus(store({salesReportCount:1,laborPay:400000,expenseSum:80000}));
  assert.equal(both.kind,'norevenue');assert.equal(both.costNote,'인건비 400,000원 · 지출 80,000원 발생');
  assert.equal(c.ownerStoreStatus(store({salesReportCount:1,laborPay:1})).costNote,'인건비 1원 발생');
});
test('A healthy total cannot hide a store that needs attention: "합산 기준" plus a separate "관리 필요 N곳" and the store names',()=>{
  const c=statusCtx();
  const rows=[store({store:'가',salesSum:1e6,laborRatio:40,expenseRatio:5}),store({store:'나',salesSum:1e6,laborRatio:10,expenseRatio:60}),store({store:'다',salesSum:2e6,laborRatio:10,expenseRatio:10}),store({store:'라'}),store({store:'마',salesReportCount:1})];
  const out=c.renderOwnerStatusSummary(rows,'ok',0,0);
  assert.match(out,/합산 기준 안정/);assert.match(out,/data-kind="attention"[\s\S]*관리 필요 2곳/);
  assert.match(out,/집계 전 1곳/);assert.match(out,/매출 없음 1곳/);assert.match(out,/관리 필요: 가 · 나/);
  // combined verdict stays as it was, only labelled
  assert.match(c.renderOwnerStatusSummary(rows,'attention',0,0),/합산 기준 관리 필요/);
});
test('With no store judged, "관리 필요 0곳" is not shown as a green all-clear, and cost is stated',()=>{
  const c=statusCtx();
  const none=c.renderOwnerStatusSummary([store({store:'가'}),store({store:'나',salesReportCount:1})],'pending',400000,80000);
  assert.match(none,/data-kind="pending"[\s\S]*관리 필요 0곳/);assert.equal(none.includes('data-kind="ok"'),false);
  assert.match(none,/인건비 400,000원 · 지출 80,000원 발생 · 매출이 없어 비율은 판정하지 않아요/);
  const clear=c.renderOwnerStatusSummary([store({store:'가',salesSum:1e6,laborRatio:10,expenseRatio:10})],'ok',0,0);
  assert.match(clear,/data-kind="ok"[\s\S]*관리 필요 0곳/);
});
test('Dashboard data records whether any sales report was entered (additive field), and the combined kind uses it',()=>{
  assert.ok(fn('loadDashboardData').includes('salesReportCount: salesArr.length'));
  assert.ok(fn('ownerOverallKind').includes('data.some(d=>(d.salesReportCount||0)>0) ? "norevenue" : "pending"'));
});
test('Status renders for the store owner only; HQ and franchise dashboards keep their original markup',()=>{
  const dash=fn('renderDashboard');
  assert.ok(dash.includes('const ownerView = state.role==="storeOwner";'));
  assert.ok(dash.includes('if(ownerView) html += renderOwnerStatusSummary('));
  assert.ok(dash.includes("if(hasIssue && !ownerView) html += '<span style=\"width:6px;height:6px;border-radius:50%;background:var(--danger)"));
  assert.ok(dash.includes('if(ownerView){'));
});
test('Status chip pairs color with text and an icon; styles meet contrast',()=>{
  const c=statusCtx();
  assert.match(c.ownerStatusChip('ok'),/owner-status ok" data-kind="ok"><svg[\s\S]*<\/svg>안정<\/span>/);
  assert.match(c.ownerStatusChip('attention'),/owner-status attention" data-kind="attention"><svg[\s\S]*<\/svg>관리 필요<\/span>/);
  assert.equal(c.ownerStatusChip('x'),'');
  assert.match(css,/\.owner-status\.ok\{color:#146D44;background:#E3F1E8\}/);
  assert.match(css,/\.owner-status\.attention\{color:#A82228;background:#FCE8E8\}/);
});
