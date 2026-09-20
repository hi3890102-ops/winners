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
test('dark mode exists for the staff/manager shell only', ()=>{
  const css=readFileSync(new URL('../owner-ui.css',import.meta.url),'utf8');
  const i=css.indexOf('@media (prefers-color-scheme: dark){');assert.ok(i>0);
  const dark=css.slice(i);
  assert.ok(/\.app\.team-ui\{--ink:/.test(dark));
  assert.ok(!/\n  \.owner-ui|\n  \.app\.owner-ui/.test(dark));   // nothing in the dark block targets the owner UI
});

// ---- T5: 더보기 / 내 정보 menus, detail pages, role label
test('T5: menu order and detail pages; no unsupported promises', ()=>{
  const me=slice('  function teamMe(person, mgr){','  function teamWorkTabs(person, mgr){');
  const order=['work','personal','connection','notifications','password','settings','help'];
  let last=-1;for(const k of order){const i=me.indexOf("teamMenuRow('"+k+"'");assert.ok(i>last,'order '+k);last=i;}
  assert.ok(me.includes('id="switch-user-btn"'));
  assert.ok(/if\(mgr\) html\+=teamMenuRow\('work'/.test(me)&&/if\(mgr\) html\+=teamMenuRow\('settings'/.test(me));   // manager-only rows
  const pages=slice('  function teamPageBody(','  const TEAM_PAGE_TITLES');
  assert.ok(!/자동 반영|내 정보 수정|변경 알림/.test(pages+me));   // features that do not exist are not offered or promised
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
