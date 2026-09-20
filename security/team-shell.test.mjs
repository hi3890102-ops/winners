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
  const make=new Function('calcCrewPay','state',src+';return renderStaffPayPill;');
  const out=make(()=>({days:5,hours:40,pay:100000}),{monthYear:2026,monthNum:9})({tax33:true,probation:false,employmentSetupRequired:false});
  assert.ok(out.includes('100,000원')&&out.includes('(-)3,300원')&&out.includes('96,700원')&&out.includes('최종 환산금액'));
  // the new 내 근무 screen and the home shortcut point at it
  assert.ok(/renderStaffSchedule\(person,true\)[^;]*renderStaffPayPill\(person\)/.test(html));
  assert.ok(html.includes('["schedule:pay","wallet","내 예상 급여"]')&&html.includes('state.teamScroll="team-pay"'));
});
test('T2: work->sales (staff with sales access) runs the same lookups as the legacy sales entry, incl. fixed expenses', ()=>{
  const loader=slice('  async function loadSalesEntryData(){','  async function goToStaffTab(tab){');
  for(const l of ['loadSalesReports','loadCrew','loadAttendance','loadExpenseEntries','loadVendors','loadFixedExpenses']) assert.ok(loader.includes(l+'('),l);
  const tabHandler=slice('    app.querySelectorAll("[data-team-tab]")','    if(state.teamScroll)');
  assert.ok(tabHandler.includes('await loadSalesEntryData()')&&tabHandler.includes('maneeLoadGuard("teamSalesTab")'));
  assert.ok(slice('    }else if(tab === "sales"){','    }\n    state.staffView = tab;').includes('await loadSalesEntryData()'));
});
test('T3: "이어서 하기" always opens the checklist tab', ()=>{
  assert.ok(/home-go-checklist-btn[\s\S]{0,200}state\.teamTab = "check";\s*goToStaffTab\("checklist"\)/.test(html));
});
test('T4: manager summary verdicts (22 / saved food limit, equal is not over, unknown and no-sales are neutral)', ()=>{
  const src=slice('  function teamRatioCard(','  function teamPayPill(person){');
  const build=(limit)=>new Function('state','LABOR_RATIO_LIMIT','DEFAULT_FOOD_RATIO_LIMIT','foodRatioVerdict','foodRatioLimit','formatLimit',src+';return renderTeamSummaryCard;')(
    {store:'A',monthNum:9},22,40,(s,r)=>r==null?{state:'none',limit:null}:(limit===null?{state:'unknown',limit:null}:{state:r>limit?'over':'ok',limit}),()=>limit,n=>String(Math.round(Number(n)*10)/10));
  const card=(labor,food,limit,sales=1000000)=>build(limit)({salesSum:sales,deliverySum:0,laborRatio:labor,expenseRatio:food});
  let h=card(25.6,51.6,40); assert.ok(h.includes('관리 필요')&&h.includes('22% 이하 안정')&&h.includes('40% 이하 안정')&&!/team-ratio ok/.test(h));
  h=card(22,40,40); assert.equal((h.match(/team-ratio ok/g)||[]).length,2);           // equal to the limit is not over
  h=card(22.1,40.1,40); assert.equal((h.match(/team-ratio over/g)||[]).length,2);
  h=card(null,null,40,0); assert.equal((h.match(/집계 전/g)||[]).length>=2,true);
  h=card(10,10,null); assert.ok(h.includes('team-ratio unknown')&&h.includes('판정 불가')&&h.includes('기준을 조회하지 못했어요'));
  assert.ok(html.includes('renderTeamSummaryCard(computeMyStoreSummary())'));
});
test('dark mode exists for the owner, staff and manager shells and never targets HQ / franchise screens', ()=>{
  const css=readFileSync(new URL('../owner-ui.css',import.meta.url),'utf8');
  const i=css.indexOf('@media (prefers-color-scheme: dark){');assert.ok(i>0);
  const dark=css.slice(i);
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
test('personal info: masked or malformed values are rejected before saving; conflicts never default to a value', ()=>{
  const src=slice('  function tpParseBank(t){','  async function teamProfileLoad(){');
  const {tpCheck,tpParseBank,tpMask}=new Function(src+';return {tpCheck,tpParseBank,tpMask};')();
  assert.ok(tpCheck({name:'',phone:'',bank:'',account:'000-***-0003',holder:''}).account);   // a masked string is never a valid account number
  assert.ok(tpCheck({phone:'12',account:''}).phone);
  assert.deepEqual(tpCheck({name:'A',phone:'010-1234-5678',bank:'X',account:'123-456-789012',holder:'A'}),{});
  assert.equal(tpMask('123-456-789012'),'123-***-9012');
  assert.deepEqual(tpParseBank('가상은행 / 123-456-789012 / 홍길동'),{bank:'가상은행',account:'123-456-789012',holder:'홍길동'});
  assert.equal(tpParseBank('123456789 국민 홍길동'),null);   // not clearly separable -> never guessed
  const build=slice('  function tpBuildEdit(data){','  function tpStoreChanges(ed){');
  const tpBuildEdit=new Function(tpSrc()+build+';return tpBuildEdit;')();
  const ed=tpBuildEdit({profile:null,stores:[{store_name:'A',name:'김',phone:'010-1',bank_text:'X / 11111 / 김'},{store_name:'B',name:'김철수',phone:'010-1',bank_text:'원문만 있음 987654'}]});
  assert.equal(ed.form.name,'');assert.equal(ed.conflict.name,true);      // stores disagree -> the person must choose
  assert.equal(ed.form.phone,'010-1');                                   // one consistent store value -> proposed, still confirmed by the person
  assert.equal(ed.form.account,'11111');assert.equal(ed.raw.length,1);   // unparsable text is kept as raw reference, not split
});
test('personal info: saving needs an explicit confirm step and reports failures without success', ()=>{
  const save=slice('  async function teamEditSave(){','  async function teamEditReload(){');
  assert.ok(save.includes('ed.step!=="confirm"')&&save.includes('ed.step="form"')&&save.includes('PT409'));
  assert.ok(save.indexOf('state.teamEdit={step:"done"')>save.indexOf('manee_save_my_profile'));
});

// ---- SP-01..SP-06 regression tests (the real functions from index.html with stubbed data)
const tpSrc=()=>slice('  const TP_FIELDS =','  async function teamProfileLoad(){');
const tp=()=>new Function(tpSrc()+';return {tpParseBank,tpParseMasked,tpMask,tpMaskText,tpCheck,tpBankComplete,tpBankAny,tpBankComposed};')();
test('SP-06: a bank text is split only when it is exactly three clean parts with a numeric middle', ()=>{
  const {tpParseBank}=tp();
  assert.equal(tpParseBank('QA Bank / 12345 / QA Holder / extra'),null);          // four parts
  assert.equal(tpParseBank('QA Bank / ----- / QA Holder'),null);                  // no digits
  assert.equal(tpParseBank('QA Bank / 12 34 / QA Holder'),null);                  // fewer than 5 digits
  assert.equal(tpParseBank('국민 1234567890 홍길동'),null);                          // no separators
  assert.equal(tpParseBank(' / 12345 / 홍'),null);                                // empty part
  assert.deepEqual(tpParseBank('QA Bank / 12345 / QA Holder'),{bank:'QA Bank',account:'12345',holder:'QA Holder'});
});
test('SP-04: masking never leaves a short or unparsable number readable (same rule as the server)', ()=>{
  const {tpMask,tpMaskText,tpParseMasked}=tp();
  for(const a of ['12345','123456','1234567']) assert.equal(tpMask(a),'*****');
  assert.equal(tpMask('12-34-56-78'),'***-678');
  assert.equal(tpMask('123-456-789012'),'123-***-9012');
  assert.equal(tpMaskText('국민 1234567890 홍길동'),'국민 ********** 홍길동');   // unparsable text: every digit hidden
  assert.equal(tpMaskText('QA Bank / 12345 / QA Holder / extra'),'QA Bank / ***** / QA Holder / extra'.replace('***** / QA Holder / extra','***** / QA Holder / extra'));
  assert.deepEqual(tpParseMasked('가상은행 / 000-***-0003 / QA'),{bank:'가상은행',account_masked:'000-***-0003',holder:'QA'});
});
test('SP-03 / SP-01 client preview follows the server rules (bank bundle, confirmation only for stored values)', ()=>{
  const f=tpSrc()+slice('  function tpStoreChanges(ed){','  async function teamEditSave(){')+';return tpStoreChanges;';
  const changes=new Function(f)();
  const store=(o)=>({store_name:'A',crew_id:'c1',name:'김',phone:'010-1',bank_text:'구은행 / 11111 / 김',self_managed:false,...o});
  let r=changes({form:{name:'김',phone:'010-2',bank:'',account:'22222',holder:''},stores:[store({})]})[0];
  assert.equal(r.held,true);assert.ok(!r.diffs.some(d=>d.field==='bank_account'));                  // partial bundle: nothing composed, store text kept
  assert.equal(r.needsConfirm,true);                                                              // the stored phone would be replaced
  r=changes({form:{name:'김',phone:'010-2',bank:'새',account:'22222',holder:'예'},stores:[store({})]})[0];
  assert.ok(r.diffs.some(d=>d.field==='bank_account'&&d.to==='새 / ***** / 예'));                 // masked in the preview
  r=changes({form:{name:'김',phone:'010-2',bank:'',account:'',holder:''},stores:[store({self_managed:true})]})[0];
  assert.equal(r.needsConfirm,false);                                                             // already self-managed
  r=changes({form:{name:'김',phone:'010-1',bank:'',account:'',holder:''},stores:[store({})]})[0];
  assert.equal(r.diffs.length,0);assert.equal(r.needsConfirm,false);
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
test('owner home: the header selection only filters the home cards, numbers and bars', ()=>{
  const scopeSrc=slice('  function ownerHomeScope(){','  // "매장별 오늘 현황"');
  const st={myStores:['A','B','C'],homeStore:'__all__'};
  const scope=new Function('state',scopeSrc+';return ownerHomeScope;')(st);
  assert.deepEqual(scope(),['A','B','C']);st.homeStore='B';assert.deepEqual(scope(),['B']);st.homeStore='Z';assert.deepEqual(scope(),['A','B','C']);   // unknown value falls back to all
  assert.ok(html.includes("if(ownerRouteGroup()==='home'){ state.homeStore=target; render(); return; }"));
  const ov=slice('  function renderOwnerOverview(){','  function renderOwnerHome(){');
  assert.ok(ov.includes('scope.includes(d.store)')&&ov.includes('renderOwnerTrend(scope)'));
  assert.ok(ov.includes('집계 전')&&ov.includes('조회 실패'));   // "not yet entered" and "lookup failed" are separate from 0 won
});

// ---- re-review findings V2-01..V2-04 and the owner UI follow-ups (real functions from index.html, stubbed data)
const tpAll=()=>new Function(tpSrc()+slice('  function tpBuildEdit(data){','  async function teamEditSave(){')+';return {tpBuildEdit,tpStoreChanges,tpBankComplete,tpBankAny};')();
test('V2-02: bank / account / holder are one bundle - a partial own bundle is never completed from a store', ()=>{
  const {tpBuildEdit}=tpAll();
  const store={store_name:'A',crew_id:'c1',name:'김',phone:'010-1',bank_text:'QA Legacy Bank / 0000011111 / QA Legacy Holder'};
  // own profile: account number only (bank and holder empty) -> exactly that, nothing borrowed
  let ed=tpBuildEdit({profile:{person_name:'김',phone:'010-1',bank_name:null,bank_account:'0000022222',account_holder:null,revision:2,source:'self'},stores:[store]});
  assert.deepEqual([ed.form.bank,ed.form.account,ed.form.holder],['','0000022222','']);
  assert.ok(!ed.fromStore.bank&&!ed.conflict.bank);
  assert.equal(ed.bundles.length,1);                     // the store's bundle is only OFFERED, as a whole
  // no own bank data + one store bundle -> proposed as a whole, marked as coming from the store
  ed=tpBuildEdit({profile:null,stores:[store]});
  assert.deepEqual([ed.form.bank,ed.form.account,ed.form.holder],['QA Legacy Bank','0000011111','QA Legacy Holder']);assert.equal(ed.fromStore.bank,true);
  // stores disagree -> nothing filled in, the person picks one whole bundle
  ed=tpBuildEdit({profile:null,stores:[store,{...store,store_name:'B',crew_id:'c2',bank_text:'Other / 22222 / Someone'}]});
  assert.deepEqual([ed.form.bank,ed.form.account,ed.form.holder],['','','']);assert.equal(ed.conflict.bank,true);assert.equal(ed.bundles.length,2);
  // choosing a store's bundle copies all three fields at once
  assert.ok(html.includes('data-tp-bundle')&&/ed\(\)\.form\.bank=c\.bank; ed\(\)\.form\.account=c\.account; ed\(\)\.form\.holder=c\.holder/.test(html));
});
test('V2-01 client: a confirmation is required per field that was not taken over yet (same rule as the server)', ()=>{
  const {tpStoreChanges}=tpAll();
  const row=(ad)=>({store_name:'A',crew_id:'c1',name:'옛이름',phone:'010-0',bank_text:'옛 / 11111 / 옛',adopted:ad,self_managed:Object.values(ad).some(Boolean)});
  const ed=(r)=>({form:{name:'새이름',phone:'010-9',bank:'새',account:'22222',holder:'새'},stores:[r]});
  assert.equal(tpStoreChanges(ed(row({name:false,phone:false,bank_account:false})))[0].needsConfirm,true);
  // name and phone taken over, bank not: the bank text still needs a confirmation although the record is "managed"
  const half=tpStoreChanges(ed(row({name:true,phone:true,bank_account:false})))[0];
  assert.equal(half.needsConfirm,true);assert.equal(half.diffs.find(d=>d.field==='bank_account').needs,true);assert.equal(half.diffs.find(d=>d.field==='phone').needs,false);
  assert.equal(tpStoreChanges(ed(row({name:true,phone:true,bank_account:true})))[0].needsConfirm,false);   // fully taken over: later edits flow
});
const ovSrc=()=>slice('  function ownerYmdAdd(ymd,n){','  function renderOwnerHome(){');
test('V2-03: sales, labor and food are judged on their own inputs (a failed expense lookup does not hide a readable labor cost)', ()=>{
  const st={monthNum:9,dashboardLoading:false,myStores:['A','B'],ownerWork:{loadedOnce:false,stores:{}},dashboardData:[
    {store:'A',salesSum:1000000,salesReportCount:1,laborPay:100000,expenseSum:100000,foodThreshold:40,expenseRatio:10,loadFailures:[],dailySales:{}},
    {store:'B',salesSum:1000000,salesReportCount:1,laborPay:600000,expenseSum:0,foodThreshold:40,expenseRatio:null,loadFailures:['지출'],dailySales:{}}]};
  const f=new Function('state','ownerHomeScope','ownerSalesUnreadable','LABOR_RATIO_LIMIT','ownerRouteButton','escapeHtml','pad','ownerWorkYmd',ovSrc()+';return renderOwnerOverview;')(st,()=>['A','B'],d=>(d.loadFailures||[]).includes('매출'),22,()=>'',x=>String(x),n=>String(n).padStart(2,'0'),()=>'2026-09-20');
  const out=f();
  assert.ok(/인건비율 <b class="bad">35\.0%<\/b>/.test(out),out.slice(0,600));           // (100k+600k)/(2M) - not 10 %
  assert.ok(/식자재비율 <b class="">10\.0%<\/b><small class="oh-of">1\/2곳/.test(out));   // food: only store A, neutral (never green when partial), range shown
  assert.ok(out.includes('지출 조회 실패(B)')&&out.includes('읽은 매장만으로 계산'));
  // every input readable: green "ok" is allowed again
  st.dashboardData[1]={...st.dashboardData[1],expenseSum:100000,expenseRatio:10,loadFailures:[],laborPay:100000};
  const ok=f();assert.ok(/인건비율 <b class="ok">10\.0%/.test(ok)&&/식자재비율 <b class="ok">10\.0%/.test(ok)&&!ok.includes('조회 실패('));
  // sales failed for B: B leaves every ratio, "조회 성공 1/2곳" is shown, nothing is turned into 0
  st.dashboardData[1]={store:'B',salesSum:0,salesReportCount:0,laborPay:0,expenseSum:0,foodThreshold:40,expenseRatio:null,loadFailures:['매출'],dailySales:{}};
  const sf=f();assert.ok(sf.includes('조회 성공 1/2곳')&&/인건비율 <b class="">10\.0%<\/b><small class="oh-of">1\/2곳/.test(sf));
});
test('V2-04: the last 7 days use one business day, separate "not entered" / 0 won / failed, and do not depend on the month view', ()=>{
  const st={ownerWork:{loadedOnce:true,stores:{}},dashboardTrendActiveDate:null};
  const {ownerHomeTrend,ownerTrendLabel,renderOwnerTrend}=new Function('state','pad','ownerWorkYmd','escapeHtml',ovSrc()+';return {ownerHomeTrend,ownerTrendLabel,renderOwnerTrend};')(st,n=>String(n).padStart(2,'0'),()=>'2026-10-03',x=>String(x));
  const store=(name,biz,days,ok=true)=>({store:name,bizDate:biz,sales:{ok,days}});
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
  assert.ok(html.includes('sales_reports").select("date,total_sales").eq("store_id",id).gte("date",ownerYmdAdd(bizDate,-6)).lte("date",bizDate)'));
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
  assert.ok(html.includes("state.showAddStoreForm=false;\n      if(ownerRouteGroup()==='home')"));
  const open=slice('    const addStoreRequestBtn = document.getElementById("add-store-request-btn");','    const closeAddStoreBtn');
  assert.ok(!/insert|update|submitAdditionalStoreRequest/.test(open));
});
