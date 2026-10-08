// Staff / manager shell: fixed menus, no mockup-only code, no new writes in the shell itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const a=html.indexOf('// ---------- 직원·매니저 앱 (team shell) ----------'),b=html.indexOf('  function renderStaffApp(){');
const block=html.slice(a,b);
test('team shell block exists and has the agreed menus', ()=>{
  assert.ok(a>0&&b>a);
  for(const l of ['"홈"','"내 근무"','"업무"','"공지"','"내 정보"','"직원"','"매출"','"운영"','"더보기"']) assert.ok(block.includes(l),'menu '+l);
});
test('no mockup-only code or fake saves in the team shell', ()=>{
  assert.ok(!/_maneePreview|역할 전환|예시 데이터|실제 저장 안 됨/.test(html));
  assert.deepEqual(block.match(/\.(insert|update|delete|upsert)\(/g)||[],[]);
});
test('team shell styles are scoped, legacy elements only restyled under .team-ui', ()=>{
  const css=readFileSync(new URL('../owner-ui.css',import.meta.url),'utf8');
  assert.ok(/\.team-ui \.staff-back/.test(css)&&!/^\.owner-ui \.staff-back/m.test(css));
});

// ---- regression tests for the review findings T1-T4 (run the real functions from index.html with stubbed data)
const slice=(from,to)=>{const a=html.indexOf(from),b=html.indexOf(to,a);assert.ok(a>0&&b>a,'anchor '+from);return html.slice(a,b);};
test('T1: staff pay summary shows the deduction and the final amount (100,000 won, 3.3% -> 96,700)', ()=>{
  const src=slice('  function getTaxRate(c){','  function calcCrewPay(c, y, m){')+slice('  function renderStaffPayPill(person){','  function renderStaffApp(){');
  const payroll=slice('  function payrollAdjustmentSnapshot(', '  async function loadDashboardData(){');
  const make=new Function('calcCrewPayFrom','state','now',src+payroll+';return renderStaffPayPill;');
  const out=make(()=>({days:5,hours:40,pay:100000}),{monthYear:2026,monthNum:9},new Date(2026,8,19))({tax33:true,probation:false,employmentSetupRequired:false});
  assert.ok(out.includes('100,000원')&&out.includes('(-)3,300원')&&out.includes('96,700원')&&out.includes('세후급여 · 가불 포함'));
  // the new 내 근무 screen and the home shortcut point at it
  assert.ok(/renderStaffSchedule\(person,true\)[^;]*renderStaffPayPill\(person\)/.test(html));
  assert.ok(html.includes('["schedule:pay","wallet","내 예상 급여"]')&&html.includes('state.teamScroll="team-pay"'));
});
test('T2: work->sales (staff with sales access) runs the same lookups as the legacy sales entry, incl. fixed expenses', ()=>{
  const loader=slice('  async function loadSalesEntryData(){','  async function goToStaffTab(tab){');
  for(const l of ['loadSalesReports','loadCrew','loadAttendance','loadExpenseEntries','loadVendors','loadFixedExpenses']) assert.ok(loader.includes(l+'('),l);
  const tabHandler=slice('    app.querySelectorAll("[data-team-tab]")','    if(state.teamScroll)');
  assert.ok(tabHandler.includes('await loadSalesEntryData()')&&tabHandler.includes('maneeLoadGuard("teamSalesTab")'));
  assert.ok(slice('    }else if(tab === "sales"){','    state.staffView = tab;').includes('await loadSalesEntryData()'));
});
test('T3: "이어서 하기" always opens the checklist tab', ()=>{
  assert.ok(/home-go-checklist-btn[\s\S]{0,200}state\.teamTab = "check";\s*goToStaffTab\("checklist"\)/.test(html));
});
test('T4: manager summary verdicts (22 / saved food limit, equal is not over, unknown and no-sales are neutral)', ()=>{
  const src=slice('  function teamRatioCard(','  function teamPayPill(person){');
  const build=(limit,llim=22)=>new Function('state','DEFAULT_LABOR_RATIO_LIMIT','DEFAULT_FOOD_RATIO_LIMIT','laborRatioVerdict','laborRatioLimit','foodRatioVerdict','foodRatioLimit','formatLimit',src+';return renderTeamSummaryCard;')(
    {store:'A',monthNum:9},22,40,(s,r)=>r==null?{state:'none',limit:null}:(llim===null?{state:'unknown',limit:null}:{state:r>llim?'over':'ok',limit:llim}),()=>llim,(s,r)=>r==null?{state:'none',limit:null}:(limit===null?{state:'unknown',limit:null}:{state:r>limit?'over':'ok',limit}),()=>limit,n=>String(Math.round(Number(n)*10)/10));
  const card=(labor,food,limit,sales=1000000)=>build(limit)({salesSum:sales,deliverySum:0,laborRatio:labor,expenseRatio:food});
  let h=card(25.6,51.6,40); assert.ok(h.includes('관리 필요')&&h.includes('22% 이하가 기준')&&h.includes('40% 이하가 기준')&&!/team-ratio ok/.test(h));
  h=card(22,40,40); assert.equal((h.match(/team-ratio ok/g)||[]).length,2);           // equal to the limit is not over
  h=card(22.1,40.1,40); assert.equal((h.match(/team-ratio over/g)||[]).length,2);
  h=card(null,null,40,0); assert.equal((h.match(/집계 전/g)||[]).length>=2,true);
  h=card(10,10,null); assert.ok(h.includes('team-ratio unknown')&&h.includes('판정 불가')&&h.includes('기준을 조회하지 못했어요'));
  assert.ok(html.includes('renderTeamSummaryCard(computeMyStoreSummary())'));
});
test('dark mode exists for the owner, staff and manager shells and never targets HQ / franchise screens', ()=>{
  const css=readFileSync(new URL('../owner-ui.css',import.meta.url),'utf8');
  const i=css.indexOf('@media (prefers-color-scheme: dark){');assert.ok(i>0);
  // Inspect the media block, not every unrelated rule appended after it.
  const open=css.indexOf('{',i);let end=open+1,depth=1;
  for(;end<css.length&&depth;end++){if(css[end]==='{')depth++;else if(css[end]==='}')depth--;}
  assert.equal(depth,0,'dark media block closes');
  const dark=css.slice(i,end);
  assert.ok(/.app.owner-ui{--ink:/.test(dark));
  assert.ok(!/.(hq|franchise)/i.test(dark));
});

// ---- T5: 더보기 / 내 정보 menus, detail pages, role label
test('T5: menu order and detail pages; no unsupported promises', ()=>{
  const me=slice('  function teamMe(person, mgr){','  function teamWorkTabs(person, mgr){');
  const order=['work','personal','connection','notifications','password','settings','help'];
  let last=-1;for(const k of order){const i=me.indexOf("teamMenuRow('"+k+"'");assert.ok(i>last,'order '+k);last=i;}
  assert.ok(me.includes('id="switch-user-btn"'));
  assert.ok(/if\(mgr\) html\+=teamMenuRow\('work'/.test(me)&&/if\(mgr\) html\+=teamMenuRow\('settings'/.test(me));   // manager-only rows
  const pages=slice('  function teamPageBody(','  const TEAM_PAGE_TITLES');
  const code=html;   // the personal-info screens talk to the server through the reviewed RPCs only
  assert.ok(code.includes('manee_my_profile_state')&&code.includes('manee_save_my_profile')&&code.includes('manee_owner_profile_changes'));
  assert.ok(pages.includes('recovery-change-submit')&&pages.includes("staffAuthButton('request'")&&pages.includes('push-toggle-btn'));
});
test('T5: back stays inside the app (no reload / re-login), role labels come from the confirmed membership role', ()=>{
  const ev=slice('    app.querySelectorAll("[data-team-page]")','    const bell=document.getElementById("team-bell");');
  assert.ok(ev.includes('state.teamPage=null; render();')&&!/history\.back|location\./.test(ev));
  const lab=slice('  function staffRoleLabel(role){','  function renderStaffAuthAccount(){');
  const f=new Function(lab+';return staffRoleLabel;')();
  assert.deepEqual(['owner','manager','staff'].map(f),['사장님','매니저','직원']);
  assert.ok(!/m\.role==='owner'\?'사장님':'스텝'/.test(html));
  // request / cancel inside the staff app refresh in place instead of jumping to the legacy account screen
  assert.ok(/state\.role==='staff'\) await teamConnectionRefresh\(\)/.test(html));
});

// ---- self-managed personal info (client side rules; the server rules are checked on staging by security/self-profile-management-verify.sql + QA)
test('personal info: optional phone validates and conflicting names require a choice', ()=>{
  const src=slice('  function tpCheck(f){','  async function teamProfileLoad(){');
  const tpCheck=new Function(src+';return tpCheck;')();
  assert.deepEqual(tpCheck({name:'A',phone:''}),{});
  assert.ok(tpCheck({phone:'12'}).phone);
  const build=slice('  function tpBuildEdit(data){','  function tpStoreChanges(ed){');
  const tpBuildEdit=new Function(build+';return tpBuildEdit;')();
  const ed=tpBuildEdit({profile:null,stores:[{store_name:'A',name:'김',phone:'010-1',bank_text:'retired'},{store_name:'B',name:'김철수',phone:'010-1'}]});
  assert.equal(ed.form.name,'');assert.equal(ed.conflict.name,true);assert.equal(ed.form.phone,'010-1');
  assert.deepEqual(Object.keys(ed.form),['name','phone']);
});
test('personal info: saving needs an explicit confirm step and reports failures without success', ()=>{
  const save=slice('  async function teamEditSave(){','  async function teamEditReload(){');
  assert.ok(save.includes('ed.step!=="confirm"')&&save.includes('ed.step="form"')&&save.includes('PT409'));
  assert.ok(save.indexOf('state.teamEdit={step:"done"')>save.indexOf('manee_save_my_profile'));
});

// ---- SP-01..SP-06 regression tests (the real functions from index.html with stubbed data)
const tpSrc=()=>slice('  const TP_FIELDS =','  async function teamProfileLoad(){');
test('SP-01 client previews name and optional phone changes and never bank data', ()=>{
  const changes=new Function(tpSrc()+slice('  function tpStoreChanges(ed){','  async function teamEditSave(){')+';return tpStoreChanges;')();
  const row={store_name:'A',crew_id:'c1',name:'Kim',phone:'010-1',bank_text:'retired',self_managed:false};
  let r=changes({form:{name:'Kim',phone:'010-2',bank:'retired'},stores:[row]})[0];
  assert.equal(r.needsConfirm,true);assert.deepEqual(r.diffs.map(d=>d.field),['phone']);
  r=changes({form:{name:'Kim',phone:'010-2'},stores:[{...row,self_managed:true}]})[0];
  assert.equal(r.needsConfirm,false);
  r=changes({form:{name:'Kim',phone:'010-1'},stores:[row]})[0];assert.equal(r.diffs.length,0);
});
test('SP-02: a late reload answer cannot put another account\'s data on screen (success and failure)', async()=>{
  const src=slice('  async function teamEditReload(){','  function tpInput(');
  for(const mode of ['success','failure']){
    let epoch=1;const calls={render:0};
    const state={teamEdit:{step:'form',form:{name:'A의 초안'},saving:false}};
    const guard=()=>{const e=epoch;return()=>e===epoch;};
    let release;const gate=new Promise(r=>{release=r;});
    const db={rpc:async()=>{await gate;if(mode==='failure')return {data:null,error:{code:'X'}};return {data:{ok:true,profile:{person_name:'A 이름',revision:1,source:'self'},stores:[]},error:null};}};
    const run=new Function('state','db','maneeLoadGuard','render','tpBuildEdit',src+';return teamEditReload;')(state,db,guard,()=>{calls.render++;},d=>({step:'form',data:d,form:{},confirm:{}}));
    const p=run();
    epoch++;state.teamEdit={step:'form',form:{name:'B의 초안'}};   // sign-out / account switch, B opened their own edit screen
    const b=state.teamEdit;release();await p;
    assert.equal(state.teamEdit,b,mode+': B\'s screen untouched');
    assert.equal(state.teamEdit.form.name,'B의 초안');assert.equal(calls.render,0,mode+': no re-render from the stale answer');
  }
  // the normal case keeps the typed draft and takes the newest revision
  const state={teamEdit:{step:'form',form:{name:'초안'},saving:false}};let n=0;
  const run=new Function('state','db','maneeLoadGuard','render','tpBuildEdit',src+';return teamEditReload;')(state,{rpc:async()=>({data:{ok:true,profile:{revision:7}},error:null})},()=>()=>true,()=>{n++;},d=>({step:'form',revision:d.profile.revision,form:{},confirm:{}}));
  await run();assert.equal(state.teamEdit.revision,7);assert.equal(state.teamEdit.form.name,'초안');
  // open / reload / save / leave share ONE guard name so each newer one invalidates the older
  assert.equal((slice('  async function teamEditOpen(){','  function tpBuildEdit(').match(/maneeLoadGuard\("teamEdit"\)/g)||[]).length,1);
  assert.equal((slice('  async function teamEditSave(){','  async function teamEditReload(){').match(/maneeLoadGuard\("teamEdit"\)/g)||[]).length,1);
  assert.ok(html.includes('function tpCancelEdit(){ maneeLoadGuard("teamEdit")'));
});
test('SP-05: the owner change notices are fetched by an explicit visit trigger, never by render, and a failure does not loop', ()=>{
  assert.ok(!/loadOwnerProfileChanges\(/.test(slice('  function renderOwnerProfileChanges(){','  function teamMe(person, mgr){')));   // renderer only reads state
  const src=slice('  function ownerProfileAfterRender(){','  function ownerProfileBind(){');
  const state={role:'storeOwner',scheduleTab:'crew',section:'schedule',store:'A'};let loads=0,group='people';
  const fn=new Function('state','ownerRouteGroup','loadOwnerProfileChanges',src+';return ownerProfileAfterRender;')(state,()=>group,()=>{loads++;});
  fn();fn();fn();assert.equal(loads,1);                       // repeated renders of the same visit (also after a failure) do not re-request
  group='home';fn();group='people';fn();assert.equal(loads,2);   // leaving and coming back refreshes
  state.store='B';fn();assert.equal(loads,3);                 // another store
  fn();assert.equal(loads,3);
});

// ---- owner home (approved mockup)
test('owner home: one merged per-store card, no duplicate notification strip, real logo, bell carries the count', ()=>{
  const home=slice('  function renderOwnerHome(){','  function renderOwnerPeople(){');
  assert.ok(home.includes('renderOwnerOverview()')&&home.includes('renderOwnerWork()')&&home.includes('renderOwnerFortuneMini()'));
  assert.ok(!home.includes('renderNotifSummaryBar')&&!home.includes('renderDashboard(')&&!home.includes('owner-alerts'));   // no "확인할 일" strip, no second per-store list
  const shell=slice('  function renderOwnerShell(){','    if(!state.dashboardData&&!state.dashboardLoading)');
  assert.ok(shell.includes('MASCOT_IMG_DATA')&&!shell.includes('owner-wordmark'));
  assert.ok(shell.includes('getNotifGroups().length')&&shell.includes('owner-notice-count'));
  const card=slice('  function renderOwnerWork(){','  function ownerWorkPaint(){');
  assert.ok(card.includes('월 누적 매출')&&card.includes('스케줄 미등록')&&card.includes('data-ow-sales'));
});
test('owner home: selected store scopes home cards, numbers and bars', ()=>{
  const scopeSrc=slice('  function ownerHomeScope(){','  // "매장별 오늘 현황"');
  const st={myStores:['A','B','C'],homeStore:'__all__'};
  const scope=new Function('state',scopeSrc+';return ownerHomeScope;')(st);
  assert.deepEqual(scope(),['A','B','C']);st.homeStore='B';assert.deepEqual(scope(),['B']);st.homeStore='Z';assert.deepEqual(scope(),['A','B','C']);   // unknown value falls back to all
  assert.ok(html.includes("state.homeStore = storeName;"));
  const ov=slice('  function renderOwnerOverview(){','  function renderOwnerHome(){');
  assert.ok(ov.includes('scope.includes(d.store)')&&ov.includes('renderOwnerTrend(scope)'));
  assert.ok(ov.includes('집계 전')&&ov.includes('조회 실패'));   // "not yet entered" and "lookup failed" are separate from 0 won
});

// ---- re-review findings V2-01..V2-04 and the owner UI follow-ups (real functions from index.html, stubbed data)
test('V2-01 client requires confirmation for each name or phone not yet adopted', ()=>{
  const changes=new Function(tpSrc()+slice('  function tpStoreChanges(ed){','  async function teamEditSave(){')+';return tpStoreChanges;')();
  const ed=adopted=>({form:{name:'New',phone:'010-9'},stores:[{crew_id:'c1',name:'Old',phone:'010-0',adopted}]});
  const half=changes(ed({name:true,phone:false}))[0];
  assert.equal(half.needsConfirm,true);assert.equal(half.diffs.find(d=>d.field==='name').needs,false);assert.equal(half.diffs.find(d=>d.field==='phone').needs,true);
  assert.equal(changes(ed({name:true,phone:true}))[0].needsConfirm,false);
});
const ovSrc=()=>slice('  function ownerYmdAdd(ymd,n){','  function renderOwnerHome(){');
test('V2-03: sales, labor and food are judged on their own inputs (a failed expense lookup does not hide a readable labor cost)', ()=>{
  // 지출비율 = expenseRatio (total expense ÷ sales, every category) - this test is about which STORE'S inputs feed
  // the combined ratio, not about the category split (see expense-category-and-vat.test.mjs).
  const st={monthNum:9,dashboardLoading:false,myStores:['A','B'],ownerWork:{loadedOnce:false,stores:{}},dashboardData:[
    {store:'A',salesSum:1000000,salesReportCount:1,laborPay:100000,laborRatio:10,expenseSum:100000,foodThreshold:40,expenseRatio:10,foodConfirmedRatio:10,hasUnclassifiedExpense:false,loadFailures:[],dailySales:{}},
    {store:'B',salesSum:1000000,salesReportCount:1,laborPay:600000,laborRatio:60,expenseSum:0,foodThreshold:40,expenseRatio:null,foodConfirmedRatio:null,hasUnclassifiedExpense:false,loadFailures:['지출'],dailySales:{}}]};
  const f=new Function('state','ownerHomeScope','ownerSalesUnreadable','DEFAULT_LABOR_RATIO_LIMIT','ownerRouteButton','escapeHtml','pad','ownerWorkYmd',slice('  function ownerLaborLimit(d){','  function ownerLaborReadable(d){')+ovSrc()+';return renderOwnerOverview;')(st,()=>['A','B'],d=>(d.loadFailures||[]).includes('매출'),22,()=>'',x=>String(x),n=>String(n).padStart(2,'0'),()=>'2026-09-20');
  const out=f();
  assert.ok(/인건비율 <b class="bad">35\.0%<\/b>/.test(out),out.slice(0,600));           // (100k+600k)/(2M) - not 10 %
  assert.ok(/지출비율 <b class="">10\.0%<\/b><small class="oh-of">1\/2곳/.test(out));   // expense: only store A, neutral (never green when partial), range shown
  assert.ok(out.includes('지출 조회 실패(B)')&&out.includes('읽은 매장만으로 계산'));
  // every input readable: green "ok" is allowed again
  st.dashboardData[1]={...st.dashboardData[1],expenseSum:100000,expenseRatio:10,loadFailures:[],laborPay:100000,laborRatio:10};
  const ok=f();assert.ok(/인건비율 <b class="ok">10\.0%/.test(ok)&&/지출비율 <b class="ok">10\.0%/.test(ok)&&!ok.includes('조회 실패('));
  // sales failed for B: B leaves every ratio, "조회 성공 1/2곳" is shown, nothing is turned into 0
  st.dashboardData[1]={store:'B',salesSum:0,salesReportCount:0,laborPay:0,expenseSum:0,foodThreshold:40,expenseRatio:null,foodConfirmedRatio:null,hasUnclassifiedExpense:false,loadFailures:['매출'],dailySales:{}};
  const sf=f();assert.ok(sf.includes('조회 성공 1/2곳')&&/인건비율 <b class="">10\.0%<\/b><small class="oh-of">1\/2곳/.test(sf));
});
test('V2-04: the last 7 days use one business day, separate "not entered" / 0 won / failed, and do not depend on the month view', ()=>{
  const st={ownerWork:{loadedOnce:true,stores:{}},dashboardTrendActiveDate:null};
  const {ownerHomeTrend,ownerTrendLabel,renderOwnerTrend}=new Function('state','pad','ownerWorkYmd','escapeHtml',ovSrc()+';return {ownerHomeTrend,ownerTrendLabel,renderOwnerTrend};')(st,n=>String(n).padStart(2,'0'),()=>'2026-10-03',x=>String(x));
  const store=(name,biz,days,ok=true)=>({store:name,bizDate:biz,sales:{ok,days,from:'2026-09-01',to:'2026-10-31'}});
  // month start (Oct 2): Sept 30 comes from the stores' own last-7-days lookup; no report on Oct 1 is "미입력", a reported 0 won is 0
  st.ownerWork.stores={A:store('A','2026-10-02',{'2026-09-30':1500000,'2026-10-02':0}),B:store('B','2026-10-02',{'2026-09-30':500000})};
  let t=ownerHomeTrend(['A','B']);
  assert.equal(t.days[0].key,'2026-09-26');assert.equal(t.days[6].key,'2026-10-02');assert.equal(t.mixed,false);
  const by=k=>t.days.find(d=>d.key===k);
  assert.equal(ownerTrendLabel(by('2026-09-30')),'200만원');
  assert.equal(ownerTrendLabel(by('2026-10-01')),'미입력');                       // nobody reported: not 0
  assert.equal(ownerTrendLabel(by('2026-10-02')),'0만원');                        // A reported 0 won: a real number
  // failed lookup: partial failure keeps the readable store and says so; total failure is a failure, not 0
  st.ownerWork.stores.B=store('B','2026-10-02',{},false);
  t=ownerHomeTrend(['A','B']);assert.equal(ownerTrendLabel(t.days.find(d=>d.key==='2026-09-30')),'150만원 (일부 조회 실패)');assert.equal(ownerTrendLabel(t.days.find(d=>d.key==='2026-10-01')),'조회 실패');
  st.ownerWork.stores.A=store('A','2026-10-02',{},false);t=ownerHomeTrend(['A','B']);assert.equal(ownerTrendLabel(t.days[0]),'조회 실패');
  // different cutoffs: A is still on Oct 1, B already on Oct 2 -> title, bars and the selected amount all end on Oct 1
  st.ownerWork.stores={A:store('A','2026-10-01',{'2026-10-01':1000000}),B:store('B','2026-10-02',{'2026-10-01':1000000,'2026-10-02':300000})};
  t=ownerHomeTrend(['A','B']);assert.equal(t.ref,'2026-10-01');assert.equal(t.mixed,true);assert.equal(t.days[6].key,'2026-10-01');assert.equal(ownerTrendLabel(t.days[6]),'200만원');
  const out=renderOwnerTrend(['A','B']);
  assert.ok(out.includes('9.25–10.1')&&out.includes('10월 1일')&&out.includes('영업일 기준 오늘'));   // title range, selected day and note agree
  assert.ok(!out.includes('10월 2일'));
  // not loaded yet: no invented zeros
  st.ownerWork.loadedOnce=false;assert.ok(renderOwnerTrend(['A','B']).includes('불러오는 중'));
  // the lookup itself is the stores' own last-7-days query, not the month view
  assert.ok(html.includes('sales_reports").select("date,total_sales").eq("store_id",id).gte("date",salesFrom).lte("date",salesTo)'));
});
test('owner header follows the mockup and AI / store-request are independent detail screens', ()=>{
  const shell=slice('  function renderOwnerShell(){','  function bindOwnerUIEvents(){');
  assert.ok(shell.indexOf('owner-bell')<shell.indexOf('class="owner-picker"'));                       // bell is in the top row, the picker is the second row
  assert.ok(/if\(state\.showAddStoreForm\) html\+=renderAddStoreForm\(\);\s*else if\(state\.showOwnerSalesForm\)/.test(shell));   // one body at a time
  assert.ok(shell.includes("else if(state.section==='ai') html+=renderAiChatSection()"));
  assert.ok(slice('  function renderAiChatSection(){','  function renderAdminSettingsSection(){').includes("ownerDetailHeader('AI 물어보기'"));
  assert.ok(slice('  function renderAddStoreForm(){','  function getExpiringHealthCerts(){').includes("ownerDetailHeader('매장 추가 신청'"));
  // leaving through a menu, the store selector or the bell closes the request form; opening it never saves anything
  assert.ok(html.includes("state.showOwnerSalesForm=false;state.salesEditingId=null;state.salesEditDate=null;state.showAddStoreForm=false;"));
  assert.ok(html.includes("state.showAddStoreForm=false;\n      if(target==='__all__')"));
  const open=slice('    const addStoreRequestBtn = document.getElementById("add-store-request-btn");','    const closeAddStoreBtn');
  assert.ok(!/insert|update|submitAdditionalStoreRequest/.test(open));
});

// ---- v3 recheck: V3-02 (every displayed day is looked up for every store in view)
const loaderRun=async(salesByStore,{failStore}={})=>{
  const code=slice('  function ownerWorkYmd(d){','  // staff_clock stores the BUSINESS date')+slice('  function ownerWorkCompute(store, raw, at){','  async function loadOwnerWork(opts){')+slice('  async function loadOwnerWork(opts){','  function ownerWorkStopTimer()')+ovSrc();
  const FIXED=new Date(2026,8,20,2,0,0).getTime();   // 9/20 02:00 local
  class FakeDate extends Date{constructor(...a){ if(a.length===0) super(FIXED); else super(...a); }}
  const queries=[];
  const db={from(table){const q={table,f:{},select(){return q;},eq(k,v){q.f[k]=v;return q;},gte(k,v){q.f.gte=v;return q;},lte(k,v){q.f.lte=v;return q;},is(){return q;},
    then(res){queries.push({table,...q.f});
      if(table==='sales_reports'){ if(failStore&&q.f.store_id===failStore) return res({data:null,error:new Error('x')});
        return res({data:(salesByStore[q.f.store_id]||[]).filter(r=>r.date>=q.f.gte&&r.date<=q.f.lte),error:null}); }
      return res({data:[],error:null}); }};return q;}};
  const state={role:'storeOwner',myStores:['A','B'],storeIdMap:{A:'ida',B:'idb'},homeStore:'__all__',storeCutoffMap:{A:6,B:0},ownerWork:{stores:{},expanded:{},loadedOnce:false,inflight:0}};
  const f=new Function('state','db','Date','pad','maneeLoadGuard','ownerWorkPaint','ownerRouteGroup','render','OW_OPEN_LOOKBACK_DAYS','OW_STALE_HOURS','storeCutoffHour','escapeHtml',
    'let ownerWorkToken=0;'+code+';return {loadOwnerWork,ownerHomeTrend,ownerTrendLabel,renderOwnerTrend};');
  const api=f(state,db,FakeDate,n=>String(n).padStart(2,'0'),()=>()=>true,()=>{},()=>'home',()=>{},7,12,s=>state.storeCutoffMap[s],x=>String(x));
  await api.loadOwnerWork();
  return {state,queries,api};
};
test('V3-02: stores with different business-day cutoffs are all asked for every day the chart shows', async()=>{
  // 9/20 02:00: A (cutoff 6) is still on 9/19, B (cutoff 0) is already on 9/20; both have 1,000,000 won on 9/13
  const {state,queries,api}=await loaderRun({ida:[{date:'2026-09-13',total_sales:1000000}],idb:[{date:'2026-09-13',total_sales:1000000}]});
  const sq=queries.filter(q=>q.table==='sales_reports');
  assert.equal(sq.length,2);
  for(const q of sq){ assert.equal(q.gte,'2026-09-13'); assert.equal(q.lte,'2026-09-20'); }     // same range for both stores: earliest business day - 6 ... latest business day
  const t=api.ownerHomeTrend(['A','B']);
  assert.equal(t.ref,'2026-09-19');assert.equal(t.days[0].key,'2026-09-13');
  assert.equal(api.ownerTrendLabel(t.days[0]),'200만원');                                       // first day: both stores counted (was 100만원)
  // only B has a report on the first day: it is B's amount, not "미입력"
  const b=await loaderRun({ida:[],idb:[{date:'2026-09-13',total_sales:1000000}]});
  const tb=api.ownerHomeTrend.call(null,['A','B']);void tb;
  assert.equal(b.api.ownerTrendLabel(b.api.ownerHomeTrend(['A','B']).days[0]),'100만원');
  assert.equal(b.api.ownerTrendLabel(b.api.ownerHomeTrend(['A','B']).days[1]),'미입력');          // looked up, nothing reported
  // one store's lookup failed: partial vs total failure, never 0 or 미입력
  const c=await loaderRun({ida:[{date:'2026-09-13',total_sales:1000000}]},{failStore:'idb'});
  assert.equal(c.api.ownerTrendLabel(c.api.ownerHomeTrend(['A','B']).days[0]),'100만원 (일부 조회 실패)');
  assert.equal(c.api.ownerTrendLabel(c.api.ownerHomeTrend(['A','B']).days[1]),'조회 실패');
  assert.equal(c.api.ownerTrendLabel(c.api.ownerHomeTrend(['B']).days[0]),'조회 실패');
  // a day outside a store's lookup window is "조회 전" (not looked up), never "미입력"
  c.state.ownerWork.stores.A.sales={ok:true,days:{},from:'2026-09-15',to:'2026-09-19'};
  c.state.ownerWork.stores.B.sales={ok:true,days:{},from:'2026-09-15',to:'2026-09-19'};
  assert.equal(c.api.ownerTrendLabel(c.api.ownerHomeTrend(['A','B']).days[0]),'조회 전');
  assert.equal(c.api.ownerTrendLabel(c.api.ownerHomeTrend(['A','B']).days[3]),'미입력');
  // the note names what the basis really is
  const out=api.renderOwnerTrend(['A','B']);
  assert.ok(out.includes('영업일이 가장 늦은 매장의 현재 영업일(9.19)')&&!out.includes('모든 매장이 마감한'));
});
