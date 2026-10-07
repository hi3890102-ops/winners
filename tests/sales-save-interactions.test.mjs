import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=n=>html.match(new RegExp('^  (?:async )?function '+n+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))[0];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(result){
 const state={role:'storeOwner',store:'A',authProfile:{user_id:'u1'},myCrewId:null,crew:[],salesReports:[],salesEditDate:'2026-10-06',dashboardData:{old:true},vatData:{old:true}},calls=[],messages=[];
 const c=vm.createContext({state,MANEE_STAFF_AUTH_ENABLED:true,Date,Number,currentStoreId:()=>state.store,monthKey:()=> '2026-10',bizToday:()=> '2026-10-07',sumCashExpenseItems:()=>0,sumBankTransferItems:()=>0,daysInMonth:()=>31,render(){},showToast:m=>messages.push(m),autoCloseChecklistForDate:()=>calls.push('checklist'),fetch:()=>{calls.push('push');return Promise.resolve();},
 db:{from:()=>({upsert:payload=>{calls.push(payload);return {select:()=>({single:()=>Promise.resolve(result??{data:{id:'report',...payload}})})};}})}});
 vm.runInContext('let maneeViewEpoch=0;\n'+['businessContextGuard','freshSalesDraft','rowToSalesReport','invalidateFinancialViews','submitSalesReport'].map(fn).join('\n'),c);
 state.salesDraft={...c.freshSalesDraft(),totalSales:'1000',cardSales:'1000'};return {state,c,calls,messages};
}
test('sales submit ignores repeated taps until the first result returns',async()=>{const d=deferred(),h=setup(d.promise);const a=h.c.submitSalesReport(),b=h.c.submitSalesReport();assert.equal(h.calls.length,1);d.resolve({data:{id:'r',date:'2026-10-06'}});await Promise.all([a,b]);assert.equal(h.state.salesReports.length,1);});
test('old sales reply cannot clear the new store draft or close its checklist',async()=>{const d=deferred(),h=setup(d.promise);const p=h.c.submitSalesReport();h.state.store='B';h.state.salesDraft={note:'new draft'};d.resolve({data:{id:'r',date:'2026-10-06'}});await p;assert.equal(h.state.salesDraft.note,'new draft');assert.equal(h.state.salesReports.length,0);assert.equal(h.calls.includes('checklist'),false);assert.equal(h.messages.length,0);});
test('failed sales save preserves the input and does not report success',async()=>{const h=setup({error:{message:'offline'}});await h.c.submitSalesReport();assert.equal(h.state.salesDraft.totalSales,'1000');assert.equal(h.state.salesReports.length,0);assert.equal(h.calls.includes('checklist'),false);assert.equal(h.messages.some(m=>m.includes('제출했어요')),false);});
test('saved sales invalidates home and report totals before navigating away',async()=>{const h=setup();await h.c.submitSalesReport();assert.equal(h.state.dashboardData,null);assert.equal(h.state.vatData,null);assert.equal(h.state.salesReports[0].totalSales,1000);});
