import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fn(name){
  const one=html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\{[^\\n]*\\} *$','m'));
  const block=html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'));
  assert.ok(one||block,'Missing '+name);return (one||block)[0];
}
const names=['maneeLoadGuard','monthKey','monthDateRange','readDashboardRows','dashboardQueryScope','clearStaleDashboard','loadDashboardData','rowToCrew','hoursBetween','calcCrewPayFrom','getTaxRate','getTaxLabel','computeNetPay','payrollAdjustmentSnapshot','settleNetPayroll','crewSettlementFrom','summarizeNetPayroll','adjustmentRow','payrollRow','summarizeSalesFigures','ownerSalesUnreadable','ownerLaborLimit','renderOwnerOverview','canShowOwnerHomeWhileLoading','retryDashboard','changeMonth'];
const clone=x=>JSON.parse(JSON.stringify(x));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(){return {
  stores:['A','B','C'].map(id=>({id,food_ratio_threshold:40,labor_ratio_threshold:22})),
  sales_reports:[
    {id:'s1',store_id:'A',date:'2026-10-01',total_sales:1000000,discount:1000,refund:500,delivery_baemin:100000},
    {id:'s2',store_id:'A',date:'2026-10-02',total_sales:500000,delivery_coupang:50000},
    {id:'s3',store_id:'B',date:'2026-10-01',total_sales:2000000},
    {id:'s4',store_id:'C',date:'2026-10-01',total_sales:0},
    {id:'s5',store_id:'A',date:'2026-09-30',total_sales:800000},
    {id:'secret',store_id:'unrelated',date:'2026-10-01',total_sales:99999999},
  ],
  expense_entries:[{id:'e1',store_id:'A',date:'2026-10-01',amount:300000,category:'food'},{id:'e2',store_id:'A',date:'2026-10-02',amount:200000,category:null},{id:'e3',store_id:'B',date:'2026-10-01',amount:100000}],
  crew:[{id:'ca',store_id:'A',name:'테스트 A',wage:10000,wage_type:'hourly',tax33:true,hire_date:'2026-01-01'},{id:'cb',store_id:'B',name:'테스트 B',wage:3000000,wage_type:'monthly',hire_date:'2026-01-01'}],
  attendance:[{id:'a1',store_id:'A',crew_id:'ca',date:'2026-10-01',check_in:'09:00:00',check_out:'10:59:59',confirmed:true}],
  monthly_net_payroll:[{id:'p1',store_id:'B',crew_id:'cb',month_key:'2026-10',net_pay:123456,adjustment_snapshot:[]}],
  checklist_templates:[],checklist_checks:[],crew_pay_adjustments:[],tax_reminder_ack:[]
};}
function harness({rows=fixture(),respond,state:overrides={}}={}){
  const calls=[],renders=[];
  const state={role:'storeOwner',authProfile:{user_id:'owner-A'},myStores:['A','B','C'],storeList:[],storeIdMap:{A:'A',B:'B',C:'C',unrelated:'unrelated'},store:'A',section:'dashboard',storeOnboardingMap:{A:true},monthYear:2026,monthNum:10,dashboardData:null,dashboardSalesPreview:null,dashboardLoading:false,...overrides};
  function builder(table){
    const q={table,filters:[],orders:[],offset:0,end:999};
    const chain=new Proxy(q,{get(target,key){
      if(key==='then')return (resolve,reject)=>Promise.resolve().then(async()=>{
        const snapshot=clone(q);calls.push(snapshot);
        if(respond){const result=await respond(snapshot);if(result!==undefined)return result;}
        let data=(rows[table]||[]).filter(row=>q.filters.every(([kind,col,value])=>kind==='in'?value.includes(row[col]):kind==='eq'?row[col]===value:kind==='gte'?row[col]>=value:row[col]<=value));
        data=data.slice().sort((a,b)=>{for(const col of q.orders){if(a[col]<b[col])return -1;if(a[col]>b[col])return 1;}return 0;});
        return {data:clone(data.slice(q.offset,q.end+1)),error:null};
      }).then(resolve,reject);
      return (...args)=>{if(['in','eq','gte','lte'].includes(key))q.filters.push([key,...args]);if(key==='order')q.orders.push(args[0]);if(key==='range')[q.offset,q.end]=args;if(key==='select')q.columns=args[0];return chain;};
    }});return chain;
  }
  const ctx=vm.createContext({state,db:{from:builder},now:new Date(2026,9,7),pad:n=>String(n).padStart(2,'0'),daysInMonth:(y,m)=>new Date(y,m,0).getDate(),bizToday:()=> '2026-10-07',todayKey:()=> '2026-10-07',yesterdayKey:()=> '2026-10-06',DEFAULT_FOOD_RATIO_LIMIT:40,DEFAULT_LABOR_RATIO_LIMIT:22,
    render(){renders.push({at:performance.now(),data:clone(state.dashboardData),preview:clone(state.dashboardSalesPreview||null),loading:state.dashboardLoading});},loadDashboardReservations(){},ownerHomeScope:()=>state.myStores,escapeHtml:String,ownerRouteButton:()=>'',renderOwnerTrend:()=>'',
    loadShifts(){},loadAttendance(){},loadSalesReports(){},loadExpenseEntries(){},loadFixedExpenses(){},loadChecklistLog(){},loadPayAdjustments(){},loadMonthlyNetPayroll(){},loadMonthlyCostReview(){}
  });
  vm.runInContext('let maneeViewEpoch=0;const maneeLoadSeq={};\n'+names.map(fn).join('\n'),ctx);
  return {state,calls,renders,ctx,rows};
}

test('three-store dashboard uses 12 bounded reads and preserves sales, unclassified expenses and confirmed payroll',async()=>{
  const h=harness();await h.ctx.loadDashboardData();
  assert.equal(h.calls.length,12);
  for(const call of h.calls){
    const scope=call.filters.find(([op,col])=>op==='in'&&(col==='store_id'||col==='id'));
    assert.ok(scope,'Every query is store scoped');assert.deepEqual(scope[2],['A','B','C']);
    assert.ok(call.orders.length);assert.equal(call.end-call.offset+1,500);
  }
  const [a,b,c]=['A','B','C'].map(store=>h.state.dashboardData.find(row=>row.store===store));
  assert.equal(a.salesSum,1500000);assert.equal(a.deliverySum,150000);assert.equal(a.salesReportCount,2);
  assert.equal(a.expenseSum,500000);assert.equal(a.expenseRatio,500000/1500000*100);
  assert.equal(a.laborPay,14505);assert.equal(a.prevMonthSalesSum,800000);
  assert.equal(b.laborPay,123456);assert.equal(b.payrollConfirmedCount,1);
  assert.equal(c.salesSum,0);assert.equal(c.salesReportCount,1);assert.equal(c.laborRatio,null);
  assert.deepEqual(clone(a.loadFailures),[]);assert.equal(h.state.dashboardDailyTrend['2026-10-01'],3000000);
});

test('sales appears while a slow payroll query is pending; duplicate renders share one request',async()=>{
  const gate=deferred();const h=harness({respond:q=>q.table==='monthly_net_payroll'?gate.promise:undefined});
  const first=h.ctx.loadDashboardData(),second=h.ctx.loadDashboardData();await tick();
  assert.equal(h.state.dashboardLoading,true);assert.equal(h.state.dashboardData,null);
  assert.equal(h.state.dashboardSalesPreview.find(r=>r.store==='A').salesSum,1500000);
  const preview=h.ctx.renderOwnerOverview();assert.match(preview,/3,500,000/);assert.match(preview,/비율 확인 중/);assert.doesNotMatch(preview,/0\.0%|class="ok"/);
  assert.equal(h.calls.filter(q=>q.table==='monthly_net_payroll').length,1);
  gate.resolve({data:[],error:null});await Promise.all([first,second]);
  assert.equal(h.state.dashboardLoading,false);assert.equal(h.state.dashboardSalesPreview,null);assert.equal(h.calls.length,12);
});

test('refresh keeps the previous amount visible but a failed refresh replaces it with unknown, never stale success or zero',async()=>{
  let fail=false;const gate=deferred();const h=harness({respond:q=>fail&&q.table==='sales_reports'?gate.promise:undefined});
  await h.ctx.loadDashboardData();const previous=h.state.dashboardData;fail=true;
  h.ctx.retryDashboard();await tick();assert.equal(h.state.dashboardData,previous);
  assert.match(h.ctx.renderOwnerOverview(),/3,500,000/);assert.match(h.ctx.renderOwnerOverview(),/업데이트 중/);
  const pending=h.state.dashboardRequest.promise;gate.resolve({data:null,error:{code:'network'}});await pending;
  const result=h.ctx.renderOwnerOverview();assert.match(result,/조회 실패/);assert.doesNotMatch(result,/3,500,000|집계 전/);
});

test('late old-month responses cannot overwrite the newly selected month',async()=>{
  const gate=deferred();const h=harness({respond:q=>q.table==='monthly_net_payroll'&&q.filters.some(f=>f[1]==='month_key'&&f[2]==='2026-10')?gate.promise:undefined});
  const older=h.ctx.loadDashboardData();await tick();h.ctx.changeMonth(-1);await h.ctx.loadDashboardData();
  const september=clone(h.state.dashboardData);assert.equal(september.find(d=>d.store==='A').salesSum,800000);
  gate.resolve({data:[],error:null});await older;
  assert.deepEqual(clone(h.state.dashboardData),september);assert.equal(h.state.dashboardLoading,false);
});

test('a new account/scope starts its own request while the old one is pending and never receives its amounts',async()=>{
  const gate=deferred();const h=harness({respond:q=>q.table==='crew'&&q.filters.some(f=>f[0]==='in'&&f[2].includes('A'))?gate.promise:undefined});
  const old=h.ctx.loadDashboardData();await tick();Object.assign(h.state,{authProfile:{user_id:'owner-C'},myStores:['C'],store:'C'});
  await h.ctx.loadDashboardData();const safe=clone(h.state.dashboardData);
  assert.equal(safe.length,1);assert.equal(safe[0].store,'C');assert.equal(safe[0].salesSum,0);
  gate.resolve({data:[],error:null});await old;assert.deepEqual(clone(h.state.dashboardData),safe);
});

test('pagination includes more than 1000 expense/attendance rows with stable order and exact totals',async()=>{
  const rows=fixture();rows.expense_entries=Array.from({length:1203},(_,i)=>({id:'e'+String(i).padStart(5,'0'),store_id:i%2?'B':'A',date:'2026-10-01',amount:101}));
  rows.attendance=Array.from({length:1101},(_,i)=>({id:'att'+String(i).padStart(5,'0'),store_id:'A',crew_id:'ca',date:'2026-10-01',check_in:'09:00:00',check_out:'09:30:00',confirmed:true}));
  const h=harness({rows});await h.ctx.loadDashboardData();
  const a=h.state.dashboardData.find(d=>d.store==='A'),b=h.state.dashboardData.find(d=>d.store==='B');
  assert.equal(a.expenseSum+b.expenseSum,1203*101);assert.equal(a.laborPay,Math.round(1101*5000*0.967));
  assert.deepEqual(h.calls.filter(q=>q.table==='expense_entries').map(q=>q.offset),[0,500,1000]);
});

test('a later page failure discards partial money and marks the total unknown',async()=>{
  const rows=fixture();rows.expense_entries=Array.from({length:700},(_,i)=>({id:String(i).padStart(5,'0'),store_id:'A',date:'2026-10-01',amount:100}));
  const h=harness({rows,respond:q=>q.table==='expense_entries'&&q.offset===500?{data:null,error:{code:'network'}}:undefined});
  await h.ctx.loadDashboardData();const a=h.state.dashboardData.find(d=>d.store==='A');
  assert.ok(a.loadFailures.includes('지출'));assert.equal(a.expenseRatio,null);assert.equal(a.expenseSum,0);
  assert.match(h.ctx.renderOwnerOverview(),/지출 조회 실패/);
});

test('large store lists use bounded batches and isolate a failed batch from other stores',async()=>{
  const ids=Array.from({length:45},(_,i)=>'store'+i),h=harness();const calls=[];
  const result=await h.ctx.readDashboardRows(ids,chunk=>({order(){return this;},range(){calls.push([...chunk]);return Promise.resolve(chunk.includes('store0')?{data:null,error:{code:'network'}}:{data:chunk.map(store_id=>({id:store_id,store_id,amount:1})),error:null});}}));
  assert.deepEqual(calls.map(c=>c.length),[40,5]);assert.ok(result.store0.error);assert.equal(result.store44.data[0].amount,1);
});

test('when the selected month is the previous month, sales and attendance are not queried twice',async()=>{
  const h=harness({state:{monthNum:9}});await h.ctx.loadDashboardData();
  assert.equal(h.calls.filter(q=>q.table==='sales_reports').length,1);assert.equal(h.calls.filter(q=>q.table==='attendance').length,1);
});

test('home can render while detail data loads; forms, unfinished setup and other roles retain the loading gate',()=>{
  const h=harness();assert.equal(h.ctx.canShowOwnerHomeWhileLoading(),true);
  for(const patch of [{section:'sales'},{showOwnerSalesForm:true},{showAddStoreForm:true},{onboardingStep:'location'},{storeOnboardingMap:{}},{role:'staff'}]){
    const saved={...h.state};Object.assign(h.state,patch);assert.equal(h.ctx.canShowOwnerHomeWhileLoading(),false,JSON.stringify(patch));Object.assign(h.state,saved);
    for(const key of Object.keys(patch))if(!Object.hasOwn(saved,key))delete h.state[key];
  }
  assert.match(fn('render'),/state\.loading&&!canShowOwnerHomeWhileLoading\(\)/);
});

// Rendering after an identity/membership change must clear even an already-published preview.
test('render scope invalidation removes an old account preview before starting the new lookup',async()=>{
  const gate=deferred();const h=harness({respond:q=>q.table==='crew'?gate.promise:undefined});
  const pending=h.ctx.loadDashboardData();await tick();assert.ok(h.state.dashboardSalesPreview);
  h.state.authProfile={user_id:'different-owner'};h.ctx.clearStaleDashboard();
  assert.equal(h.state.dashboardData,null);assert.equal(h.state.dashboardSalesPreview,null);assert.equal(h.state.dashboardLoading,false);
  gate.resolve({data:[],error:null});await pending;assert.equal(h.state.dashboardSalesPreview,null);
  assert.match(fn('render'),/clearStaleDashboard\(\)/);
});

test('unreadable per-store limits cannot default to a green verdict',async()=>{
  const h=harness({respond:q=>q.table==='stores'?{data:null,error:{code:'42501'}}:undefined});
  await h.ctx.loadDashboardData();
  for(const row of h.state.dashboardData){assert.equal(row.foodThreshold,null);assert.equal(row.laborThreshold,null);assert.ok(row.loadFailures.includes('인건비 기준'));}
  const view=h.ctx.renderOwnerOverview();assert.match(view,/인건비 기준 확인 불가/);assert.doesNotMatch(view,/class="ok"/);
});
