import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function section(name,next){const a=html.indexOf('  function '+name+'('),b=html.indexOf('  function '+next+'(',a);assert.ok(a>=0&&b>a);return html.slice(a,b);}
function setup(){
 const counts={}, controls={};
 for(const [attr,fn] of Object.entries({delexpense:'deleteExpenseEntry',editexpense:'startEditExpenseEntry',saveexpense:'saveExpenseEntry',cancelexpense:'cancelEditExpenseEntry',classifyvendor:'toggleClassifyVendor',classifyconfirm:'bulkClassifyVendorExpenses'})){
  controls['[data-'+attr+']']={listeners:[],getAttribute:()=> 'fixture-1',addEventListener(type,cb){this.listeners.push(cb)},click(){this.onclick?.();this.listeners.forEach(cb=>cb())}};
  counts[fn]=0;
 }
 const context={app:{querySelectorAll:sel=>controls[sel]?[controls[sel]]:[]},document:{getElementById:()=>null},bindVendorExpenseDefault(){},bindVendorClassificationEvents(){}};
 for(const fn of Object.keys(counts))context[fn]=()=>counts[fn]++;
 vm.createContext(context);vm.runInContext(section('bindSalesReportEvents','bindCrewManageEvents')+section('bindSalesSectionEvents','bindOwnerEvents'),context);
 return {context,controls,counts};
}
test('one tap runs each shared expense action once when both screen binders run',()=>{
 const {context,controls,counts}=setup();context.bindSalesSectionEvents();context.bindSalesReportEvents();
 for(const control of Object.values(controls))control.click();
 for(const [fn,count] of Object.entries(counts))assert.equal(count,1,fn);
});
test('rebinding does not close classification again or duplicate a save',()=>{
 const {context,controls,counts}=setup();for(let i=0;i<3;i++){context.bindSalesReportEvents();context.bindSalesSectionEvents();}
 controls['[data-classifyvendor]'].click();controls['[data-saveexpense]'].click();
 assert.equal(counts.toggleClassifyVendor,1);assert.equal(counts.saveExpenseEntry,1);
});
test('calendar keyboard activation is single, labelled, and space does not scroll',()=>{
 let clicked=0,prevented=0;const attrs={};const el={dataset:{salesformdate:'2026-09-25'},setAttribute:(k,v)=>attrs[k]=v,click:()=>clicked++};
 const context={app:{querySelectorAll:()=>[el]}};vm.createContext(context);vm.runInContext(section('bindAccessibleActions','bindOwnerUIEvents'),context);
 context.bindAccessibleActions();context.bindAccessibleActions();assert.equal(el.tabIndex,0);assert.equal(attrs['aria-label'],'2026-09-25 선택');
 for(const key of ['Enter',' ','ArrowRight'])el.onkeydown({key,preventDefault:()=>prevented++});
 assert.equal(clicked,2);assert.equal(prevented,2);
});
test('all inline scripts parse after interaction changes',()=>{
 for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
});

test('store changes synchronize home and work context, including same-store selections',async()=>{
 const state={myStores:['A','B'],store:'A',homeStore:'__all__'};const loaded=[];
 const start=html.indexOf('  async function switchOwnerStore('),end=html.indexOf('  function adminEntryLandingMode(',start);
 const context={state,loadAllForStore:async name=>loaded.push(name),render(){},loadVatData(){}};
 vm.createContext(context);vm.runInContext(html.slice(start,end),context);
 await context.switchOwnerStore('B');assert.equal(state.store,'B');assert.equal(state.homeStore,'B');assert.deepEqual(loaded,['B']);
 state.homeStore='__all__';await context.switchOwnerStore('B');assert.equal(state.homeStore,'B');assert.equal(loaded.length,1);
 await context.switchOwnerStore('unknown');assert.equal(state.store,'B');assert.equal(state.homeStore,'B');
});
test('all-store overview requires explicit work-store confirmation and cancel leaves context intact',()=>{
 const state={homeStore:'__all__',store:'B'};let pending,message,navigated=0;
 const context={state,askConfirm:(text,go)=>{message=text;pending=go;}};vm.createContext(context);
 vm.runInContext(section('ownerNavigateFromOverview','bindOwnerUIEvents'),context);
 context.ownerNavigateFromOverview('sales',()=>navigated++);assert.equal(navigated,0);assert.match(message,/B/);assert.equal(state.homeStore,'__all__');
 pending();assert.equal(navigated,1);assert.equal(state.homeStore,'B');
 context.ownerNavigateFromOverview('schedule',()=>navigated++);assert.equal(navigated,2);
 state.homeStore='__all__';context.ownerNavigateFromOverview('dashboard',()=>navigated++);assert.equal(navigated,3);assert.equal(state.homeStore,'__all__');
});
