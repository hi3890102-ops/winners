import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=name=>html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))[0];
function app(query=async()=>({data:[{store_id:'store-a',month_key:'2026-09'}]})){
  const calls=[],state={role:'storeOwner',section:'dashboard',authProfile:{user_id:'owner-a'},myStores:['A','B'],storeIdMap:{A:'store-a',B:'store-b'},store:'B',homeStore:'__all__',monthYear:2026,monthNum:10};
  const ctx=vm.createContext({state,Date,document:{hidden:false},window:{scrollTo(){}},render(){},escapeHtml:v=>String(v).replaceAll('<','&lt;'),ownerHomeScope:()=>state.homeStore==='__all__'?state.myStores:[state.homeStore],maneeLoadGuard:()=>()=>true,showToast:m=>calls.push(m),loadAllForStore:async store=>calls.push({store,month:state.monthYear+'-'+String(state.monthNum).padStart(2,'0'),open:state.costReviewOpen}),db:{from(table){calls.push({table});return {select(){return this;},eq(column,value){calls.push({column,value});return this;},order(){return query();}};}}});
  vm.runInContext(['loadOwnerReportHomeNotices','renderOwnerReportHomeNotices','openOwnerReportHomeNotice'].map(fn).join('\n'),ctx);
  return {ctx,state,calls};
}
test('home notice loads by signed-in account without any push/browser permission API',async()=>{
  const a=app();await a.ctx.loadOwnerReportHomeNotices();
  assert.ok(a.calls.some(x=>x.column==='user_id'&&x.value==='owner-a'));
  const h=a.ctx.renderOwnerReportHomeNotices();assert.match(h,/9월 보고서를 마무리/);assert.match(h,/다시 입력하지 않아도/);
  await a.ctx.loadOwnerReportHomeNotices();assert.equal(a.calls.filter(x=>x.table).length,1);
  a.state.homeStore='B';assert.equal(a.ctx.renderOwnerReportHomeNotices(),'');
});
test('click opens the notice month and store, never the currently selected month/store',async()=>{
  const a=app();await a.ctx.loadOwnerReportHomeNotices();await a.ctx.openOwnerReportHomeNotice('store-a','2026-09');
  assert.equal(a.state.store,'A');assert.equal(a.state.homeStore,'A');assert.equal(a.state.section,'sales');assert.equal(a.state.salesSectionTab,'report');
  assert.deepEqual(a.calls.at(-1),{store:'A',month:'2026-09',open:true});
  const n=a.calls.length;await a.ctx.openOwnerReportHomeNotice('store-b','2026-09');await a.ctx.openOwnerReportHomeNotice('store-a','2026-10');assert.equal(a.calls.length,n);
});
test('late account A response cannot populate account B or navigate to its store',async()=>{
  let resolve;const a=app(()=>new Promise(r=>resolve=r));const done=a.ctx.loadOwnerReportHomeNotices();
  a.state.authProfile={user_id:'owner-b'};resolve({data:[{store_id:'store-a',month_key:'2026-09'}]});await done;
  assert.equal(a.ctx.renderOwnerReportHomeNotices(),'');await a.ctx.openOwnerReportHomeNotice('store-a','2026-09');assert.equal(a.state.store,'B');
});
test('a refresh removes a completed notice on another phone; errors do not block home',async()=>{
  let rows=[{store_id:'store-a',month_key:'2026-09'}];const a=app(async()=>({data:rows}));await a.ctx.loadOwnerReportHomeNotices();
  rows=[];await a.ctx.loadOwnerReportHomeNotices(true);assert.equal(a.ctx.renderOwnerReportHomeNotices(),'');
  const failed=app(async()=>({error:{message:'unavailable'}}));await failed.ctx.loadOwnerReportHomeNotices();assert.equal(failed.ctx.renderOwnerReportHomeNotices(),'');assert.equal(failed.state.ownerReportHomeNotices.loading,false);
});
test('staff, signed-out and hidden/non-home screens never load notices',async()=>{
  for(const props of [{role:'staff'},{authProfile:null},{section:'sales'}]){const a=app();Object.assign(a.state,props);await a.ctx.loadOwnerReportHomeNotices();assert.equal(a.calls.length,0);}
  const a=app();a.ctx.document.hidden=true;await a.ctx.loadOwnerReportHomeNotices();assert.equal(a.calls.length,0);
});
test('all-stores home groups the same month and completion removes only the completed store',async()=>{
  let rows=[{store_id:'store-a',month_key:'2026-09'},{store_id:'store-b',month_key:'2026-09'}];
  const a=app(async()=>({data:rows}));await a.ctx.loadOwnerReportHomeNotices();
  let h=a.ctx.renderOwnerReportHomeNotices();assert.match(h,/확인할 매장 2곳/);assert.equal((h.match(/<section/g)||[]).length,1);assert.equal((h.match(/data-home-report-store/g)||[]).length,2);
  a.state.homeStore='A';h=a.ctx.renderOwnerReportHomeNotices();assert.match(h,/확인할 매장 1곳/);assert.ok(!h.includes('data-home-report-store="store-b"'));
  a.state.homeStore='__all__';rows=rows.slice(1);await a.ctx.loadOwnerReportHomeNotices(true);h=a.ctx.renderOwnerReportHomeNotices();
  assert.match(h,/확인할 매장 1곳/);assert.ok(h.includes('data-home-report-store="store-b"'));assert.ok(!h.includes('data-home-report-store="store-a"'));
});
