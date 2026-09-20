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
  const tpBuildEdit=new Function('tpParseBank',slice('  const TP_FIELDS =','  function tpParseBank(t){')+build+';return tpBuildEdit;')(tpParseBank);
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
  assert.ok(ov.includes('scope.includes(d.store)')&&ov.includes('renderSalesTrendBars(unknown,trend)'));
  assert.ok(ov.includes('집계 전')&&ov.includes('조회 실패'));   // "not yet entered" and "lookup failed" are separate from 0 won
});
