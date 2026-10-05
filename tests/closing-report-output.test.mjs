import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const script=fs.readFileSync(new URL('../report-assets/monthly-report.js',import.meta.url),'utf8'),c=vm.createContext({});vm.runInContext(script,c);
const report=()=>({month_key:'2026-09',revision:1,closed_at:'2026-10-01T00:00:00Z',snapshot:{store_name:'Synthetic',month_key:'2026-09',gross_sales:1000,discount:100,refund:50,net_sales:850,net_payroll:300,expenses_total:200,fixed_total:100,profit:250,operating_days:1,labor_ratio:30,food_ratio:20,expense_ratio:20,profit_ratio:25,invalid_sales_count:0,payroll_status:{unknown_count:0,estimated_count:0},sales:[{date:'2026-09-01',gross:1000,discount:100,refund:50,net:850,card:600,cash:250,emoney:0,delivery_baemin:200,delivery_coupang:0,delivery_yogiyo:0}],expenses:[{date:'2026-09-01',category:'insurance',amount:200}],fixed:[{name:'임대료',amount:100}]}});
test('PDF and Excel validate the same closed snapshot and reject contradictory totals',()=>{const r=report();assert.equal(c.MANEE_REPORTS.validate(r).profit,250);const summary=new Map(c.MANEE_REPORTS.excelRows(r).summary);assert.equal(summary.get('실매출'),850);assert.equal(summary.get('지출 기준 예상 수익'),250);r.snapshot.expenses[0].amount=201;assert.throws(()=>c.MANEE_REPORTS.validate(r),/reconcile/);});
test('unknown or estimated payroll is never exported as finalized',()=>{for(const key of ['unknown_count','estimated_count']){const r=report();r.snapshot.payroll_status[key]=1;assert.throws(()=>c.MANEE_REPORTS.excelRows(r),/unconfirmed/);}});
test('negative profit and negative legitimate expense returns remain signed',()=>{const r=report();r.snapshot.net_payroll=900;r.snapshot.profit=-350;assert.equal(new Map(c.MANEE_REPORTS.excelRows(r).summary).get('지출 기준 예상 수익'),-350);r.snapshot.expenses[0].amount=-200;r.snapshot.expenses_total=-200;r.snapshot.profit=50;assert.equal(c.MANEE_REPORTS.validate(r).profit,50);});
test('spreadsheet outputs use numerical amounts, identify payment channels without adding them twice',()=>{const r=report(),s=c.MANEE_REPORTS.excelRows(r);assert.equal(typeof s.expenses[1][3],'number');assert.equal(s.expenses[1][2],'보험료 납부');assert.equal(s.sales[1][8],200);assert.equal(s.sales[1][1],1000);assert.equal(s.fixed[1][1],100);});
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=n=>html.match(new RegExp('^  (?:async )?function '+n+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))[0];
test('closing refuses unchecked confirmation and staff before any database call',async()=>{
 let calls=0;const messages=[];const context=vm.createContext({state:{},canManageBusinessData:()=>true,document:{getElementById:()=>({checked:false})},showToast:m=>messages.push(m),db:{rpc:()=>{calls++;}}});vm.runInContext(fn('closeCurrentMonth'),context);await context.closeCurrentMonth();assert.equal(calls,0);assert.ok(messages.length);context.canManageBusinessData=()=>false;await context.closeCurrentMonth();assert.equal(calls,0);
});
test('download response guards include account, store, screen epoch and month',()=>{
 const state={authProfile:{user_id:'u1'}},context=vm.createContext({state,maneeViewEpoch:1,currentStoreId:()=> 's1',monthKey:()=> '2026-09'});vm.runInContext(fn('reportActionGuard'),context);const alive=context.reportActionGuard();assert.equal(alive(),true);context.monthKey=()=> '2026-10';assert.equal(alive(),false);context.monthKey=()=> '2026-09';state.authProfile.user_id='u2';assert.equal(alive(),false);
});
test('saved report filenames remove filesystem control characters and identify revision',()=>{
 const context=vm.createContext({});vm.runInContext(fn('reportDownloadName'),context);assert.equal(context.reportDownloadName({snapshot:{store_name:'A/B:*?'},month_key:'2026-09',revision:2},'pdf'),'매니_A_B____2026-09_v2.pdf');
});
