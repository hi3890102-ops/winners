import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// v5 review (V5-2): a food-ratio limit that could not be read is "기준 조회 실패 / 판정 불가" on EVERY screen that uses it — never a green
// "안정" — while a normally unset limit (NULL) is the 40% default. Checked on the real render output of the owner home, the owner's monthly
// report and the manager home card, with the same store data and the same limit states.
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fnText(name){const a=html.indexOf('  function '+name+'(');const b=html.indexOf('  async function '+name+'(');const s=a>=0?a:b;if(s<0)throw new Error('missing '+name);const e=html.indexOf('\n  }\n',s);return html.slice(s,e+5);}
function line(re){const m=html.match(re);if(!m)throw new Error('missing '+re);return m[0];}
const text=h=>h.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');

// limit states as the app stores them: undefined/null = not set (default 40), number = saved, false = could not be read
function screens(limitState,{sales=1000000,expense=600000}={}){
  const state={role:'storeOwner',store:'A',myStores:['A'],monthYear:2026,monthNum:9,storeFoodLimitMap:limitState===undefined?{}:{A:limitState},
    salesReports:[{totalSales:sales,deliveryBaemin:0,deliveryCoupang:0,deliveryYogiyo:0}],crew:[],fixedExpenses:[],expandedStoreRows:{},
    dashboardLoading:false,storeList:['A'],dashboardDailyTrend:{},dashboardTrendActiveDate:null};
  const ctx=vm.createContext({state,console,escapeHtml:s=>String(s),daysInMonth:()=>30,computeVendorBreakdown:()=>[{name:'식자재',amount:expense}],calcCrewPay:()=>({pay:0,hours:0,days:0}),
    navIcon:()=> '',renderRoleAvatar:()=> '',ownerRouteButton:()=> '',pad:n=>String(n).padStart(2,'0'),bizDateObj:()=>new Date(2026,8,19),
    renderFixedExpenseManage:()=> '',labelWithIcon:(i,l)=>l,renderSalesReportRows:()=> '',OWNER_STATUS_TEXT:{attention:'관리 필요',ok:'안정',norevenue:'매출 없음',pending:'집계 전',error:'확인 필요'}});
  vm.runInContext([line(/  const DEFAULT_LABOR_RATIO_LIMIT[^\n]*\n/),line(/  const FOOD_LIMIT_UNKNOWN_TEXT[^\n]*\n/),line(/  function formatLimit\([^\n]*\n/),
    ...['foodRatioLimit','foodRatioVerdict','laborRatioLimit','laborRatioVerdict','ownerFoodReadable','ownerLaborReadable','ownerLaborLimit','renderManagerSummaryCard','renderMonthlyReport','ownerSalesUnreadable','ownerStatusChip','ownerCostNote','ownerStoreStatus','ownerOverallKind','renderOwnerStatusSummary','renderSalesTrendBars','renderDashboard'].map(fnText),
    ';this.api={renderManagerSummaryCard,renderMonthlyReport,renderDashboard,foodRatioVerdict};'].join('\n'),ctx);
  const ratio=expense/sales*100;
  const failure=limitState===false;
  const dashRow={store:'A',foodThreshold:failure?null:(typeof limitState==='number'?limitState:40),salesSum:sales,salesReportCount:1,deliverySum:0,laborPay:0,laborRatio:5,expenseSum:expense,expenseRatio:ratio,
    prevMonthSalesSum:0,prevMonthFailed:false,loadFailures:failure?['식자재 기준']:[],dailySales:{},crewCount:0};
  state.dashboardData=[dashRow];
  return {
    owner:text(ctx.api.renderDashboard()),
    report:ctx.api.renderMonthlyReport(),
    manager:ctx.api.renderManagerSummaryCard({salesSum:sales,deliverySum:0,laborRatio:10,expenseRatio:ratio,checklistPct:50}),
    api:ctx.api
  };
}

test('Same data (sales 1,000,000 / expenses 600,000 = 60%), limit READ as unset: every screen says "over" (default 40%) — no green',()=>{
  const s=screens(null);
  assert.match(s.owner,/관리 필요[\s\S]*식자재비율 40% 초과/);
  assert.match(s.report,/data-state="over"[\s\S]*식자재 관리필요/);
  assert.match(s.manager,/color:var\(--danger\)[^>]*>60\.0%/);
});
test('Limit NOT READABLE: monthly report shows "기준 조회 실패 · 판정 불가", not "식자재 안정"; manager home is neutral with the same wording; owner home is "확인 필요"',()=>{
  const s=screens(false);
  assert.match(s.report,/data-state="unknown"/);assert.match(s.report,/식자재 기준 조회 실패 · 판정 불가/);
  assert.equal(/식자재 안정/.test(s.report),false,'no "식자재 안정"');assert.equal(/#7CE6A6/.test(s.report.match(/<span class="food-verdict"[\s\S]*?<\/span>/)[0]),false,'and no green colour on the chip');
  assert.match(s.manager,/기준 조회 실패 · 판정 불가/);
  assert.match(s.manager,/color:var\(--ink-soft\)[^>]*>60\.0%/,'the real ratio is still shown, in a neutral colour');
  assert.equal(/var\(--olive\)[^>]*>60\.0%/.test(s.manager),false,'never green');assert.equal(/var\(--danger\)[^>]*>60\.0%/.test(s.manager),false,'and not a red verdict either');
  assert.match(s.owner,/확인 필요|읽지 못한 항목: 식자재 기준/);assert.equal(/합산 기준 안정/.test(s.owner),false);
});
test('Limit read as a saved value: every screen uses it (38% -> over at 60%, and at 38% exactly it is fine)',()=>{
  const over=screens(38);
  assert.match(over.owner,/식자재비율 38% 초과/);assert.match(over.report,/data-state="over"/);assert.match(over.manager,/var\(--danger\)[^>]*>60\.0%/);
  const equal=screens(38,{sales:1000000,expense:380000});
  assert.match(equal.report,/data-state="ok"[\s\S]*식자재 안정/);assert.match(equal.manager,/var\(--olive\)[^>]*>38\.0%/);assert.equal(/식자재비율 38% 초과/.test(equal.owner),false);
});
test('Normally unset (NULL) and never-loaded limit both mean the 40% default; only an unreadable limit is "판정 불가"',()=>{
  for(const st of [null,undefined]){
    const s=screens(st,{sales:1000000,expense:390000});
    assert.match(s.report,/data-state="ok"/,String(st));assert.equal(/판정 불가/.test(s.report+s.manager),false,String(st));
  }
  const api=screens(null).api;
  assert.equal(api.foodRatioVerdict('A',null).state,'none');
});
test('No ratio (no sales): no food verdict is shown at all, on any screen',()=>{
  const state=screens(false,{sales:0,expense:0});
  assert.equal(/식자재 (안정|관리필요)/.test(state.report),false);
});
