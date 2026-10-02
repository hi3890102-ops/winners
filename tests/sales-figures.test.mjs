import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// 섹션1 1차 (CHAT-D52FC7DC16F4C8A0A8EF6511): 총매출(할인 전 total_sales) / 실매출(총매출-할인-반품) 계산 통일.
// 실행: node --test tests/sales-figures.test.mjs
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fnText(name){const a=html.indexOf('  function '+name+'(');if(a<0)throw new Error('missing '+name);const e=html.indexOf('\n  }\n',a);return html.slice(a,e+5);}
function line(re){const m=html.match(re);if(!m)throw new Error('missing '+re);return m[0];}

const pure=(()=>{const ctx=vm.createContext({});
  vm.runInContext(fnText('summarizeSalesFigures')+line(/  function salesCostRatio\([^\n]*\n/)+';this.api={summarizeSalesFigures,salesCostRatio};',ctx);
  return ctx.api;})();

test('실매출 = 총매출 - 할인 - 반품, 총매출은 할인 전 값 그대로',()=>{
  const r=pure.summarizeSalesFigures([{date:'d1',totalSales:1000000,discount:50000,refund:20000},{date:'d2',totalSales:'500000',discount:'0',refund:''}]);
  assert.equal(r.grossSales,1500000);assert.equal(r.discount,50000);assert.equal(r.refund,20000);assert.equal(r.netSales,1430000);assert.equal(r.invalid.length,0);
});
test('반품 초과 → 음수 실매출을 숨기지 않음',()=>{
  const r=pure.summarizeSalesFigures([{date:'d1',totalSales:100000,discount:0,refund:150000}]);
  assert.equal(r.netSales,-50000);
});
test('0매출 → 비율 null, 분모는 총매출',()=>{
  assert.equal(pure.salesCostRatio(300000,0),null);
  assert.equal(pure.salesCostRatio(300000,1000000),30);
  const r=pure.summarizeSalesFigures([{date:'d1',totalSales:1000000,discount:500000,refund:0}]);
  assert.equal(pure.salesCostRatio(300000,r.grossSales),30,'할인이 있어도 비율 분모는 총매출');
});
test('음수/NaN 입력은 합산하지 않고 invalid로 보고',()=>{
  const r=pure.summarizeSalesFigures([{date:'d1',totalSales:-1000,discount:'abc',refund:Infinity},{date:'d2',totalSales:2000}]);
  assert.equal(r.grossSales,2000);assert.equal(r.netSales,2000);
  assert.deepEqual(Array.from(r.invalid,x=>x.field),['totalSales','discount','refund']);
});
test('배달 3사 금액은 총매출/실매출에 더하지 않음',()=>{
  const r=pure.summarizeSalesFigures([{date:'d1',totalSales:100000,deliveryBaemin:30000,deliveryCoupang:20000,deliveryYogiyo:10000}]);
  assert.equal(r.grossSales,100000);assert.equal(r.netSales,100000);assert.equal(r.delivery,60000);
});

// ---- renderMonthlyReport (인라인 계산)이 공통 pure 함수와 같은 값을 내는지 ----
function report(salesReports,{fixed=0,expense=0,failed=[]}={}){
  const state={role:'storeOwner',store:'A',monthYear:2026,monthNum:10,storeFoodLimitMap:{},storeLaborLimitMap:{},
    salesReports,expenseEntries:[],crew:[],fixedExpenses:fixed?[{id:'f',name:'월세',amount:fixed}]:[],showFixedExpenseManage:false,classifyVendor:null,showVatDetail:false,
    reportDataFailed:new Set(failed)};
  const ctx=vm.createContext({state,console,escapeHtml:s=>String(s),daysInMonth:()=>30,
    computeVendorBreakdown:()=>expense?[{name:'v',amount:expense}]:[],calcCrewPay:()=>({pay:0,hours:0,days:0}),
    navIcon:()=>'',renderRoleAvatar:()=>'',ownerRouteButton:()=>'',pad:n=>String(n).padStart(2,'0'),
    renderFixedExpenseManage:()=>'',labelWithIcon:(i,l)=>l,renderSalesReportRows:()=>'',renderVatSummaryCard:()=>'',
    canManageBusinessData:()=>true,MANEE_STAFF_AUTH_ENABLED:false,formatLimit:n=>String(n)});
  vm.runInContext([line(/  const DEFAULT_LABOR_RATIO_LIMIT[^\n]*\n/),line(/  const FOOD_LIMIT_UNKNOWN_TEXT[^\n]*\n/),
    ...['summarizeSalesFigures','foodRatioLimit','laborRatioLimit','foodRatioVerdict','laborRatioVerdict','foodRatioColor','foodRatioNote','renderMonthlyReport'].map(fnText),
    ';this.render=renderMonthlyReport;'].join('\n'),ctx);
  return ctx.render();
}
const won=n=>n.toLocaleString()+'원';
test('월리포트 예상 순수익 = 실매출 - 지출 - 인건비 - 고정지출 (pure 함수와 일치)',()=>{
  const rows=[{date:'2026-10-01',totalSales:2000000,discount:100000,refund:50000,deliveryBaemin:300000,deliveryCoupang:0,deliveryYogiyo:0}];
  const sf=pure.summarizeSalesFigures(rows);
  const h=report(rows,{fixed:500000,expense:400000});
  assert.match(h,new RegExp('<p class="amount">'+won(sf.netSales-400000-500000)+'</p>'));
  assert.match(h,/<span>매출<\/span><strong>2,000,000원<\/strong>/,'매출 줄은 총매출 그대로');
  assert.match(h,/실매출[\s\S]*?<strong>1,850,000원<\/strong>/);
  assert.match(h,/>20\.0%</,'지출비율 = 400,000 ÷ 총매출 2,000,000');
});
test('월리포트: 반품 초과 음수 실매출이 순수익에 그대로 반영',()=>{
  const h=report([{date:'2026-10-01',totalSales:100000,discount:0,refund:150000}]);
  assert.match(h,/<p class="amount">-50,000원<\/p>/);
});
test('월리포트: 0매출 → 비율 "—", 할인/반품 없는 기존 화면은 그대로',()=>{
  const h=report([],{fixed:1000});
  assert.match(h,/<p class="amount">-1,000원<\/p>/);
  assert.equal(/실매출/.test(h.replace(/순수익은 실매출/,'')),false);
});
test('월리포트: 음수/NaN 매출 입력 → 순수익 계산 불가 (0으로 덮지 않음)',()=>{
  const h=report([{date:'2026-10-01',totalSales:'abc',discount:0,refund:0}]);
  assert.match(h,/<p class="amount">계산 불가<\/p>/);
  assert.match(h,/음수\/잘못된 금액/);
});

function excel(reports,failed=[]){
  let workbook,toast;
  const ctx=vm.createContext({state:{salesReports:reports,monthYear:2026,monthNum:10,crew:[],fixedExpenses:[{amount:100}],store:'A',reportDataFailed:new Set(failed)},
    XLSX:{utils:{book_new:()=>({}),aoa_to_sheet:rows=>rows,book_append_sheet:(wb,sheet,name)=>wb[name]=sheet},writeFile:wb=>workbook=wb},
    computeVendorBreakdown:()=>[{name:'식자재',amount:200}],styleWorksheet(){},monthKey:()=> '2026-10',showToast:m=>toast=m});
  vm.runInContext(fnText('summarizeSalesFigures')+line(/  function salesCostRatio\([^\n]*\n/)+fnText('exportExcelMonthlyReport'),ctx);ctx.exportExcelMonthlyReport();
  return {workbook,toast};
}
test('Excel actual output shares gross denominator and net profit formula',()=>{
  const {workbook}=excel([{totalSales:1000,discount:100,refund:50,deliveryBaemin:400}]);
  const rows=new Map(workbook['종합']);assert.equal(rows.get('총매출'),1000);assert.equal(rows.get('실매출'),850);
  assert.equal(rows.get('예상 순수익 (실매출 기준)'),550);assert.equal(rows.get('지출비율(%)'),20);
  assert.equal(rows.get('배달매출 (합산 안 함)'),400);
});
test('Excel refuses incomplete/invalid reports instead of exporting partial sums',()=>{
  for(const [reports,failed] of [[[{totalSales:'abc'}],[]],[[],['매출']]]){
    const result=excel(reports,failed);assert.equal(result.workbook,undefined);assert.match(result.toast,/내보낼 수 없어요/);
  }
});
test('Sales save rejects invalid raw amounts before any database request',async()=>{
  const start=html.indexOf('  async function submitSalesReport('),end=html.indexOf('\n  }\n',start);
  for(const bad of ['-100','abc','NaN','Infinity','1.5','1,23','2147483648']){
    let requests=0,toast;
    const ctx=vm.createContext({state:{crew:[],role:'storeOwner',store:'A',salesDraft:{totalSales:bad,cardSales:bad}},
      currentStoreId:()=> 's1',bizToday:()=> '2026-10-01',sumCashExpenseItems:()=>0,showToast:m=>toast=m,db:{from(){requests++;throw Error('must not write')}}});
    vm.runInContext(html.slice(start,end+5),ctx);await ctx.submitSalesReport();assert.equal(requests,0,bad);assert.match(toast,/정수/);
  }
});
