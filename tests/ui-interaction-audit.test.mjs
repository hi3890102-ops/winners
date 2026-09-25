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
test('overview opens store choices without preselecting a store; direct routes do not prompt',()=>{
 const state={homeStore:'__all__',store:'A',myStores:['A','B']};let navigated=0;
 const context={state,render(){}};vm.createContext(context);
 vm.runInContext(section('ownerNavigateFromOverview','bindOwnerUIEvents'),context);
 context.ownerNavigateFromOverview('sales',()=>navigated++);assert.equal(navigated,0);assert.equal(state.store,'A');assert.equal(state.homeStore,'__all__');assert.equal(state.ownerStoreChoice.section,'sales');
 state.ownerStoreChoice=null;assert.equal(state.homeStore,'__all__');
 state.homeStore='B';context.ownerNavigateFromOverview('schedule',()=>navigated++);assert.equal(navigated,1);assert.equal(state.ownerStoreChoice,null);
 state.homeStore='__all__';context.ownerNavigateFromOverview('dashboard',()=>navigated++);assert.equal(navigated,2);assert.equal(state.ownerStoreChoice,null);
});
test('choosing a store loads that store before the requested route and ignores double taps',async()=>{
 const state={homeStore:'__all__',store:'A',myStores:['A','B']};const events=[];let finish;
 const context={state,render(){},maneeLoadGuard:()=>()=>true,freshSalesDraft:()=>({}),showToast(){},switchOwnerStore:async name=>{events.push('load '+name);await new Promise(resolve=>finish=resolve);state.store=name;state.homeStore=name;}};
 vm.createContext(context);vm.runInContext(section('ownerNavigateFromOverview','bindOwnerUIEvents'),context);
 for(const route of ['schedule','sales','checklist']){
  state.homeStore='__all__';context.ownerNavigateFromOverview(route,()=>events.push(route+' '+state.store));
  await context.chooseOwnerWorkStore('unknown');assert.ok(state.ownerStoreChoice);
  const pending=context.chooseOwnerWorkStore('B');assert.equal(state.ownerStoreChoice,null);
  await context.chooseOwnerWorkStore('A');assert.equal(events.at(-1),'load B');finish();await pending;
  assert.equal(events.at(-1),route+' B');assert.equal(state.homeStore,'B');
 }
 assert.equal(events.length,6);
});
test('store choice renders escaped store names as direct actions, without yes/no confirmation',()=>{
 const state={ownerStoreChoice:{section:'sales'},myStores:['A','<B>']};
 const context={state,escapeHtml:s=>s.replaceAll('<','&lt;').replaceAll('>','&gt;')};vm.createContext(context);
 vm.runInContext(section('ownerNavigateFromOverview','bindOwnerUIEvents'),context);
 const output=context.renderOwnerStoreChoice();assert.match(output,/매출 · 매장 선택/);assert.match(output,/&lt;B&gt;/);assert.match(output,/data-owner-choose-store="1"/);assert.doesNotMatch(output,/이동할까요|confirm-ok/);
});
