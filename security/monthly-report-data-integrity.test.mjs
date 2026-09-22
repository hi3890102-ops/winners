import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// 2026-09-22 bug report: navigating the monthly report to a month with no real data could still show a computed
// net profit that silently included a full month's pay for the CURRENT staff roster - most visibly for FUTURE
// months (which haven't happened yet) and for months where a lookup simply failed. Covers:
//  1) calcCrewPayFrom (월급제): a future month accrues 0 pay/0 days, a past month is unaffected, the current month's
//     existing "clamp to today" behavior is unchanged (owner-preserved-function fixture updated for this fix).
//  2) renderMonthlyReport: "입력된 자료 없음" only when NOTHING failed and every input is genuinely empty; a failed
//     lookup is shown as "조회 실패" with a retry, never silently folded into 0원; real costs without sales keep
//     their real (possibly negative) 예상 순수익.
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fnText(name){const a=html.indexOf('  function '+name+'(');const b=html.indexOf('  async function '+name+'(');const s=a>=0?a:b;if(s<0)throw new Error('missing '+name);const e=html.indexOf('\n  }\n',s);return html.slice(s,e+5);}
function line(re){const m=html.match(re);if(!m)throw new Error('missing '+re);return m[0];}

// ---------- 1) calcCrewPayFrom: monthly-wage staff never accrue pay for days that have not happened yet ----------
function payHarness(nowDate){
  const ctx=vm.createContext({console,
    daysInMonth:(y,m)=>new Date(y,m,0).getDate(),
    hoursBetween:()=>0,
    now:nowDate});
  vm.runInContext(fnText('calcCrewPayFrom')+';this.calcCrewPayFrom=calcCrewPayFrom;',ctx);
  return ctx.calcCrewPayFrom;
}
test('calcCrewPayFrom: a monthly-wage employee accrues 0 pay/0 days for a month entirely in the FUTURE',()=>{
  const calc=payHarness(new Date(2026,8,22)); // today = 2026-09-22
  const c={id:'c1',wageType:'monthly',wage:3000000,hireDate:'2026-01-01',resignDate:null};
  const r=calc(c,[],2026,10); // viewing October 2026 - has not happened yet
  assert.equal(r.pay,0,'future month must not accrue any of the monthly wage');
  assert.equal(r.days,0);
});
test('calcCrewPayFrom: a monthly-wage employee hired before a fully-elapsed PAST month still gets a full month (unaffected by the fix)',()=>{
  const calc=payHarness(new Date(2026,8,22)); // today = 2026-09-22
  const c={id:'c1',wageType:'monthly',wage:3100000,hireDate:'2026-01-01',resignDate:null};
  const r=calc(c,[],2026,8); // August 2026 - fully in the past
  assert.equal(r.days,31);
  assert.equal(r.pay,3100000); // 31/31 days
});
test('calcCrewPayFrom: the CURRENT month is still clamped to today (pre-existing behavior, unchanged by the fix)',()=>{
  const calc=payHarness(new Date(2026,8,22)); // today = 2026-09-22 (22nd of a 30-day month)
  const c={id:'c1',wageType:'monthly',wage:3000000,hireDate:'2026-01-01',resignDate:null};
  const r=calc(c,[],2026,9);
  assert.equal(r.days,22);
  assert.equal(r.pay,Math.round(3000000/30*22));
});
test('calcCrewPayFrom: hourly-wage employees are unaffected (pay only ever comes from confirmed attendance, already 0 with none)',()=>{
  const calc=payHarness(new Date(2026,8,22));
  const c={id:'c1',wageType:'hourly',wage:12000,hireDate:'2026-01-01',resignDate:null};
  const r=calc(c,[],2026,10); // future month, no attendance rows
  assert.equal(r.pay,0);assert.equal(r.hours,0);assert.equal(r.days,0);
});
test('calcCrewPayFrom: a resignation date still caps a past month correctly (fix does not touch this path)',()=>{
  const calc=payHarness(new Date(2026,8,22));
  const c={id:'c1',wageType:'monthly',wage:3000000,hireDate:'2026-01-01',resignDate:'2026-08-10'};
  const r=calc(c,[],2026,8); // resigned mid-August
  assert.equal(r.days,10);
  assert.equal(r.pay,Math.round(3000000/31*10));
});

// ---------- 2) renderMonthlyReport: 입력된 자료 없음 vs 조회 실패 vs real negative profit ----------
function reportHarness(state){
  const ctx=vm.createContext({state,console,
    escapeHtml:s=>String(s),daysInMonth:()=>30,
    computeVendorBreakdown:()=>[],calcCrewPay:(c,y,m)=>({pay:0,hours:0,days:0}),
    navIcon:()=>'',renderRoleAvatar:()=>'',ownerRouteButton:()=>'',pad:n=>String(n).padStart(2,'0'),
    renderFixedExpenseManage:()=>'',labelWithIcon:(i,l)=>l,renderSalesReportRows:()=>'',renderVatSummaryCard:()=>'',
    canManageBusinessData:()=>true,MANEE_STAFF_AUTH_ENABLED:false,formatLimit:n=>String(n)});
  vm.runInContext([line(/  const DEFAULT_LABOR_RATIO_LIMIT[^\n]*\n/),line(/  const FOOD_LIMIT_UNKNOWN_TEXT[^\n]*\n/),
    ...['foodRatioLimit','laborRatioLimit','foodRatioVerdict','laborRatioVerdict','foodRatioColor','foodRatioNote','renderMonthlyReport'].map(fnText),
    ';this.render=renderMonthlyReport;'].join('\n'),ctx);
  return ctx.render;
}
const baseState=()=>({role:'storeOwner',store:'A',monthYear:2026,monthNum:10,storeFoodLimitMap:{},storeLaborLimitMap:{},
  salesReports:[],expenseEntries:[],crew:[],fixedExpenses:[],showFixedExpenseManage:false,classifyVendor:null,showVatDetail:false,
  reportDataFailed:new Set()});
test('renderMonthlyReport: a genuinely untouched month (nothing failed, nothing entered) says "입력된 자료 없음" and 0원 - not a fabricated negative number',()=>{
  const state=baseState();
  const html=reportHarness(state)();
  assert.match(html,/입력된 자료 없음/);
  assert.match(html,/<p class="amount">0원<\/p>/);
});
test('renderMonthlyReport: a failed lookup is shown as "조회 실패" with a retry button - never silently treated as "입력된 자료 없음" or folded into 0원',()=>{
  const state=baseState();
  state.reportDataFailed=new Set(['매출']);
  const html=reportHarness(state)();
  assert.match(html,/조회 실패 · 일부 자료를 불러오지 못했어요 \(매출\)/);
  assert.match(html,/data-retry-report="1"/);
  assert.equal(/입력된 자료 없음/.test(html),false);
});
test('renderMonthlyReport: real costs without any sales keep their real, negative 예상 순수익 (never hidden or zeroed)',()=>{
  const state=baseState();
  state.fixedExpenses=[{id:'f1',name:'월세',amount:1200000}];
  const html=reportHarness(state)();
  assert.match(html,/<p class="amount">-1,200,000원<\/p>/);
  assert.equal(/입력된 자료 없음/.test(html),false,'real fixed-cost data means this is NOT an empty month');
});
