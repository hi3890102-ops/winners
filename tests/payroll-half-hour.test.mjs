import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=name=>html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))?.[0];
const now=new Date(2026,9,3),crew={id:'c',wageType:'hourly',wage:10000,hireDate:'2026-01-01'};
const context=vm.createContext({now,daysInMonth:(y,m)=>new Date(y,m,0).getDate()});
vm.runInContext(['hoursBetween','calcCrewPayFrom','getTaxRate','getTaxLabel','computeNetPay','payrollAdjustmentSnapshot','settleNetPayroll','crewSettlementFrom','summarizeNetPayroll'].map(fn).join('\n'),context);
const shift=(checkOut,over={})=>({crewId:'c',date:'2026-09-01',checkIn:'09:00',checkOut,confirmed:true,...over});

for(const [end,hours] of [['09:29:59.999999',0],['09:30:00',0.5],['09:59:59',0.5],['10:00:00',1],['17:29',8],['17:30',8.5]]){
  test('completed shift ending '+end+' pays '+hours+' hours',()=>{
    const p=context.calcCrewPayFrom(crew,[shift(end)],2026,9);assert.equal(p.hours,hours);assert.equal(p.pay,hours*10000);
  });
}
test('floor every shift before summing, including multiple shifts on one day',()=>{
  const rows=[shift('09:29'),shift('10:29',{checkIn:'10:00'})];
  const p=context.calcCrewPayFrom(crew,rows,2026,9);assert.equal(p.hours,0);assert.equal(p.pay,0);assert.equal(p.days,1);
});
test('raw seconds survive minute-only UI and avoid rounding a 29m10s shift to 30m',()=>{
  const a=shift('09:30',{checkInExact:'09:00:50',checkOutExact:'09:30:00'});
  const before=JSON.stringify(a);assert.equal(context.calcCrewPayFrom(crew,[a],2026,9).hours,0);assert.equal(JSON.stringify(a),before);
});
test('overnight shift and month attribution use the original attendance date',()=>{
  const a=shift('01:14:59',{date:'2026-09-30',checkIn:'23:45:00'});
  assert.equal(context.calcCrewPayFrom(crew,[a],2026,9).hours,1);
  assert.equal(context.calcCrewPayFrom(crew,[a],2026,10).hours,0);
});
test('other staff, other months, unconfirmed and open shifts do not accrue wages',()=>{
  const rows=[shift('18:00',{crewId:'other'}),shift('18:00',{date:'2026-08-31'}),shift('18:00',{confirmed:false}),shift(null)];
  assert.equal(context.calcCrewPayFrom(crew,rows,2026,9).pay,0);
});
test('monthly prorating and actual confirmed net pay remain authoritative',()=>{
  const c={...crew,wageType:'monthly',wage:3100000};
  assert.equal(context.calcCrewPayFrom(c,[],2026,10).pay,300000);
  const p=context.crewSettlementFrom(crew,[shift('09:29')],[],[{crewId:'c',monthKey:'2026-09',netPay:123456,adjustmentSnapshot:[]}],2026,9);
  assert.equal(p.netPay,123456);assert.equal(p.confirmed,true);
});
test('probation, deductions and advances run after shift flooring',()=>{
  const c={...crew,probation:true,tax33:true};
  const p=context.crewSettlementFrom(c,[shift('10:59')],[{id:'a',crewId:'c',monthKey:'2026-09',type:'가불',amount:-1000}],[],2026,9);
  assert.equal(p.hours,1.5);assert.equal(p.grossPay,13500);assert.equal(p.netPay,13054);assert.equal(p.balance,12054);
});
test('deduction half-won boundary matches numeric SQL rounding',()=>{
  assert.equal(context.computeNetPay({...crew,insurance2:true},22500).taxAmount,203);
  assert.equal(context.computeNetPay({...crew,insurance2:true},22500).netPay,22297);
});
test('missing hire date, missing wage and malformed times remain explicit unknowns',()=>{
  for(const [c,rows] of [[{...crew,wageType:'monthly',hireDate:null},[]],[{...crew,wage:0},[shift('09:10')]],[crew,[shift('25:00')]]]){
    const p=context.crewSettlementFrom(c,rows,[],[],2026,9);assert.equal(p.unknown,true);assert.ok(p.reasons.length);
  }
});
test('all attendance loaders retain exact time inputs for parity with database payroll',()=>{
  for(const name of ['applyStaffAttendance','loadAttendance','loadDashboardData']){
    assert.match(fn(name),/checkInExact:r\.check_in/);assert.match(fn(name),/checkOutExact:r\.check_out/);
  }
});
test('attendance workbook separates original elapsed hours from the same paid hours as payroll',()=>{
  const sheets={};
  Object.assign(context,{state:{crew:[{...crew,name:'Synthetic'}],attendance:[shift('09:59',{checkInExact:'09:00:00',checkOutExact:'09:59:59'})],payAdjustments:[],monthlyPayrolls:[],monthYear:2026,monthNum:9,store:'Synthetic'},monthKey:()=> '2026-09',styleWorksheet(){},showToast(){},XLSX:{utils:{book_new:()=>({}),aoa_to_sheet:rows=>rows,book_append_sheet:(_,sheet,name)=>{sheets[name]=sheet;}},writeFile(){}}});
  vm.runInContext(['calcCrewPay','crewSettlement','exportExcelAttendance'].map(fn).join('\n'),context);
  context.exportExcelAttendance();
  assert.equal(sheets['요약'][1][4],0.5);assert.equal(sheets['요약'][1][6],5000);
  assert.equal(sheets['상세기록'][1][3],'09:00:00');assert.equal(sheets['상세기록'][1][4],'09:59:59');
  assert.equal(sheets['상세기록'][1][5],0.9997);assert.equal(sheets['상세기록'][1][6],0.5);
});

function dashboard(rows){
  const c=vm.createContext({state:{role:'storeOwner',dashboardData:rows,dashboardLoading:false,storeList:[],myStores:[],expandedStoreRows:{},monthYear:2026,monthNum:9,dashboardDailyTrend:{}},escapeHtml:s=>String(s),navIcon:()=>'',ownerRouteButton:()=>'',renderSalesTrendBars:()=>'',DEFAULT_LABOR_RATIO_LIMIT:22,DEFAULT_FOOD_RATIO_LIMIT:40,OWNER_STATUS_TEXT:{ok:'안정',error:'확인 필요',pending:'집계 전',attention:'관리 필요'},formatLimit:n=>String(n)});
  const names=['ownerLaborLimit','ownerLaborReadable','ownerFoodReadable','ownerSalesUnreadable','ownerStatusChip','ownerCostNote','ownerStoreStatus','ownerOverallKind','renderOwnerStatusSummary','renderDashboard'];
  // Some helpers are intentionally one-line declarations.
  vm.runInContext(names.map(n=>html.match(new RegExp('^  function '+n+'\\([^\\n]*\\{[^\\n]*\\} *$','m'))?.[0]||fn(n)).join('\n'),c);
  return c.renderDashboard().replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
}
const row=(store,over={})=>({store,salesSum:1000000,laborPay:200000,laborRatio:20,expenseSum:300000,expenseRatio:30,salesReportCount:1,deliverySum:0,prevMonthSalesSum:0,loadFailures:[],...over});
test('expense failure does not drop readable payroll from combined labor total or ratio',()=>{
  const out=dashboard([row('A'),row('B',{loadFailures:['지출']})]);
  assert.match(out,/합산 인건비 \(세후\) 400,000원/);assert.match(out,/인건비율 20\.0%/);assert.doesNotMatch(out,/인건비 합산/);
});
test('unknown payroll is excluded with a coverage count, store name and concrete reason',()=>{
  const out=dashboard([row('A'),row('B',{loadFailures:['급여미확정'],payrollIssues:['입사일이 없어 과거 급여 미확정'],laborRatio:null})]);
  assert.match(out,/부분 인건비 \(세후\) 200,000원/);assert.match(out,/인건비 합산 1\/2곳/);assert.match(out,/제외 매장: B \(입사일이 없어 과거 급여 미확정\)/);
  assert.match(out,/부분 인건비율 20\.0%/);assert.match(out,/지출비율 30\.0%/);
});
