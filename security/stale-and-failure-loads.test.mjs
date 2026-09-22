import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// R1 (GPT review of v2): an in-flight lookup of the PREVIOUS account must not refill the screen state after a
// logout / account switch, and a month/store answer arriving late must not overwrite a newer one.
// R3: a lookup that FAILED must never be treated as "no rows" and shown as a green "안정".
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function fnText(name){const a=html.indexOf('  function '+name+'(');const b=html.indexOf('  async function '+name+'(');const s=a>=0?a:b;if(s<0)return '';const e=html.indexOf('\n  }\n',s);return html.slice(s,e+5);}
function optional(re){const m=html.match(re);return m?m[0]:'';}
const NAMES=['monthKey','monthDateRange','rowToCrew','prevMonthKey','clearStaffAuthView','clearReportDataFailures','markReportDataFailed','clearReportDataFailed','loadDashboardData','loadDashboardReservations','loadCrewRaw','loadCrew','loadShifts','loadAttendance','loadFixed','loadSalesReports','loadExpenseEntries','loadVendors','loadFixedExpenses','loadTodayReservations','loadUpcomingReservations','loadAnnouncements','loadPayAdjustments','loadChecklist','loadChecklistLog','loadAllForStore',
  'formatLimit','foodRatioLimit','loadFoodLimit','loadLaborLimit','loadRatioLimits','ownerLaborLimit','ownerSalesUnreadable','ownerStatusChip','ownerCostNote','ownerStoreStatus','ownerOverallKind','renderOwnerStatusSummary','splitExpenseByCategory'];
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
// A fake Supabase query builder. `respond(table,{storeId,gte})` may return {data,error}, throw, or return a promise.
function harness(respond,extra={}){
  const log={render:0,inserts:[],reservationLoads:0};
  function builder(table){
    const q={filters:{}};
    const chain=new Proxy(q,{get(t,prop){
      if(prop==='then')return (res,rej)=>Promise.resolve().then(()=>respond(table,{storeId:t.filters.store_id,gte:t.filters.gte,inserting:t.inserting})).then(res,rej);
      return (...args)=>{
        if(prop==='eq')t.filters[args[0]]=args[1];
        if(prop==='gte')t.filters.gte=args[1];
        if(prop==='insert'){t.inserting=args[0];log.inserts.push({table,rows:args[0]});}
        return chain;};
    }});
    return chain;
  }
  const state={role:'storeOwner',myStores:['A'],storeList:[],storeIdMap:{A:'sid-A',B:'sid-B'},monthYear:2026,monthNum:9,store:'A',
    dashboardData:null,dashboardLoading:false,dashboardDailyTrend:null,authProfile:{user_id:'user-A'},
    crew:[],shifts:[],attendance:[],salesReports:[],expenseEntries:[],vendors:[],fixedSchedules:[],fixedExpenses:[],reservations:[],upcomingReservations:[],announcements:[],payAdjustments:[],checklistLog:{},...extra};
  const ctx=vm.createContext({state,db:{from:builder},render(){log.render++;},pad:n=>String(n).padStart(2,'0'),now:new Date(2026,8,19),
    bizToday:()=> '2026-09-19',todayKey:()=> '2026-09-19',yesterdayKey:()=> '2026-09-18',
    calcCrewPayFrom:(c,att)=>({pay:att.length*8*(c.wage||0)}),rowToSalesReport:r=>r,canManageBusinessData:()=>true,MANEE_STAFF_AUTH_ENABLED:true,
    loadDashboardReservations:async()=>{log.reservationLoads++;},escapeHtml:s=>String(s),refreshPushSubStatus(){},DEFAULT_ITEMS:{},callAuthChecklist:async()=>{},businessError(){},console});
  vm.runInContext('let maneeRestoreSeq=0;\n'+optional(/  const DEFAULT_LABOR_RATIO_LIMIT[^\n]*\n/)+optional(/  let maneeViewEpoch[^\n]*\n/)+optional(/  const OWNER_STATUS_TEXT[^\n]*\n/)+optional(/  const maneeLoadSeq[^\n]*\n/)+optional(/  const FOOD_RATIO_CATEGORY_SET[^\n]*\n/)+fnText('maneeLoadGuard')+NAMES.map(fnText).join('\n')
    +';this.api={'+NAMES.filter(n=>fnText(n)).join(',')+'};',ctx);
  return {state,log,api:ctx.api,ctx};
}
const emptyOk={data:[],error:null};
const crewA=[{id:'c1',name:'직원',wage:10000,wage_type:'hourly',created_at:'2026-01-01'}];
const attA=Array.from({length:5},(_,i)=>({id:'a'+i,crew_id:'c1',date:'2026-09-0'+(i+1),check_in:'09:00:00',check_out:'17:00:00',confirmed:true}));
const salesA=[{store_id:'sid-A',date:'2026-09-01',total_sales:1000000,delivery_baemin:0,delivery_coupang:0,delivery_yogiyo:0}];

// ---------- R1 ----------
test('R1 (review scenario): a late dashboard answer for account A does not refill the state after switching to account B',async()=>{
  const gate=deferred();
  const h=harness((table,{storeId})=>table==='crew'&&storeId==='sid-A'?gate.promise:emptyOk);
  const pending=h.api.loadDashboardData();                              // A's lookup starts, its first staff query is delayed
  await new Promise(r=>setTimeout(r,5));   // let A's queries actually go out before the switch (they are in flight)
  h.api.clearStaffAuthView();                                           // logout ...
  Object.assign(h.state,{authProfile:{user_id:'user-B'},role:'storeOwner',myStores:['B']});   // ... and account B is shown
  const renders=h.log.render;
  gate.resolve({data:crewA,error:null});await pending;
  assert.equal(h.state.dashboardData,null,'A\'s rows must not be written into B\'s state');
  assert.equal(h.state.dashboardLoading,false);assert.equal(h.log.render,renders,'no render caused by the stale answer');
  assert.equal(h.log.reservationLoads,0,'the stale run must not start follow-up lookups');
});
test('R1: B\'s own dashboard, loaded while A\'s answer is still pending, is not replaced when A\'s answer arrives',async()=>{
  const gateA=deferred();
  const h=harness((table,{storeId})=>table==='crew'&&storeId==='sid-A'?gateA.promise:emptyOk);
  const pendingA=h.api.loadDashboardData();
  await new Promise(r=>setTimeout(r,5));   // let A's queries actually go out before the switch (they are in flight)
  h.api.clearStaffAuthView();
  Object.assign(h.state,{authProfile:{user_id:'user-B'},role:'storeOwner',myStores:['B']});
  await h.api.loadDashboardData();                                      // B's lookup completes first
  assert.equal(h.state.dashboardData.length,1);assert.equal(h.state.dashboardData[0].store,'B');
  gateA.resolve({data:crewA,error:null});await pendingA;
  assert.equal(h.state.dashboardData.length,1);assert.equal(h.state.dashboardData[0].store,'B');
});
test('R1: a switch that never called clearStaffAuthView (only the shown account changed) is also detected',async()=>{
  const gate=deferred();
  const h=harness((table,{storeId})=>table==='crew'&&storeId==='sid-A'?gate.promise:emptyOk);
  const pending=h.api.loadDashboardData();
  await new Promise(r=>setTimeout(r,5));   // let A's queries actually go out before the switch (they are in flight)
  h.state.authProfile={user_id:'user-B'};h.state.myStores=['B'];
  gate.resolve({data:crewA,error:null});await pending;
  assert.equal(h.state.dashboardData,null);
});
for(const [name,table,field,rows]of[
  ['loadShifts','shifts','shifts',[{id:'s1',date:'2026-09-01',crew_id:'c1',start_time:'09:00:00',end_time:'17:00:00'}]],
  ['loadAttendance','attendance','attendance',attA],
  ['loadSalesReports','sales_reports','salesReports',salesA],
  ['loadExpenseEntries','expense_entries','expenseEntries',[{id:'e1',date:'2026-09-01',description:'x',amount:5000}]],
  ['loadVendors','vendors','vendors',[{id:'v1',name:'거래처A'}]],
  ['loadFixed','fixed_schedules','fixedSchedules',[{id:'f1',crew_id:'c1',days:[1],start_time:'09:00:00',end_time:'17:00:00'}]],
  ['loadTodayReservations','reservations','reservations',[{id:'r1',date:'2026-09-19',time:'18:00',customer_name:'A손님'}]],
  ['loadUpcomingReservations','reservations','upcomingReservations',[{id:'r2',date:'2026-09-20',time:'18:00',customer_name:'A손님'}]],
  ['loadAnnouncements','announcements','announcements',[{id:'n1',title:'A공지',created_at:'2026-09-01T00:00:00Z',announcement_reads:[]}]],
  ['loadPayAdjustments','crew_pay_adjustments','payAdjustments',[{id:'p1',crew_id:'c1',type:'bonus',amount:1000,note:''}]],
  ['loadCrew','crew','crew',crewA],
]){
  test('R1: '+name+' - a late answer for the previous account does not overwrite the screen state',async()=>{
    const gate=deferred();
    const h=harness((t,{storeId})=>t===table&&storeId==='sid-A'?gate.promise:emptyOk);
    const pending=h.api[name]('A','2026-09');
    h.api.clearStaffAuthView();Object.assign(h.state,{authProfile:{user_id:'user-B'},store:'B',myStores:['B']});
    h.state[field]=[];                                                    // B's screen starts with nothing from A
    gate.resolve({data:rows,error:null});await pending;
    assert.equal(h.state[field].length,0,name+' must not write A\'s rows into B\'s state');
  });
}
test('R1: an older month answering after a newer month does not overwrite it (latest request wins)',async()=>{
  const slow=deferred();
  const h=harness((t,{gte})=>{if(t!=='attendance')return emptyOk;return gte==='2026-08-01'?slow.promise:{data:attA,error:null};});
  const august=h.api.loadAttendance('A','2026-08');
  await h.api.loadAttendance('A','2026-09');
  assert.equal(h.state.attendance.length,5);
  slow.resolve({data:[{id:'old',crew_id:'c1',date:'2026-08-01',check_in:'09:00:00',check_out:'17:00:00'}],error:null});await august;
  assert.equal(h.state.attendance.length,5);assert.equal(h.state.attendance[0].date.slice(0,7),'2026-09');
});
test('R1: a stale fixed-expense lookup does not perform its copy-forward INSERT after the account changed',async()=>{
  const gate=deferred();let call=0;
  const h=harness((t,{inserting})=>{
    if(t!=='fixed_expenses')return emptyOk;
    if(inserting)return {data:[{id:'new'}],error:null};
    call++;return call===1?gate.promise:{data:[{name:'월세',amount:1}],error:null};
  });
  const pending=h.api.loadFixedExpenses('A','2026-09');
  h.api.clearStaffAuthView();Object.assign(h.state,{authProfile:{user_id:'user-B'},store:'B',myStores:['B']});
  gate.resolve({data:[],error:null});await pending;
  assert.equal(h.log.inserts.length,0,'a stale run must not write anything');
});
test('R1: loadAllForStore of the previous account does not finish the new account\'s loading state',async()=>{
  const gate=deferred();
  const h=harness((t,{storeId})=>t==='crew'&&storeId==='sid-A'?gate.promise:emptyOk);
  const pending=h.api.loadAllForStore('A');
  h.api.clearStaffAuthView();Object.assign(h.state,{authProfile:{user_id:'user-B'},store:'B',myStores:['B'],loading:true});
  const renders=h.log.render;
  gate.resolve({data:crewA,error:null});await pending;
  assert.equal(h.state.loading,true,'B\'s loading flag belongs to B\'s own request');assert.equal(h.log.render,renders);
});

// ---------- R3 ----------
const SOURCES=[['sales_reports','매출'],['expense_entries','지출'],['crew','직원'],['attendance','근태']];
// By default a store has sales only (no staff), so no rule is broken; pass labor=true to add staff and attendance.
function dataFor(table,labor){return table==='sales_reports'?salesA:table==='crew'?(labor?crewA:[]):table==='attendance'?(labor?attA:[]):[];}
function dashboard(failTable,mode){
  return harness((table)=>{
    if(table!==failTable)return {data:dataFor(table),error:null};
    if(mode==='error')return {data:null,error:{code:'42501',message:'permission denied'}};
    if(mode==='network')throw new Error('Failed to fetch');
    return emptyOk;
  });
}
test('R3 (review scenario): sales succeed with 1,000,000 but the expense lookup fails -> NOT "안정"',async()=>{
  const h=dashboard('expense_entries','error');
  await h.api.loadDashboardData();
  const row=h.state.dashboardData[0],st=h.api.ownerStoreStatus(row);
  assert.notEqual(st.kind,'ok');assert.equal(st.kind,'error');
  assert.equal(row.expenseRatio,null,'an unreadable expense total must not become a 0% ratio');
  assert.ok(row.loadFailures.includes('지출'));
});
for(const [table,label] of SOURCES){
  for(const mode of ['error','network']){
    test('R3: '+label+' lookup '+(mode==='error'?'returns a permission/query error':'fails at the network level')+' -> "조회 실패", never ok/pending',async()=>{
      const h=dashboard(table,mode);await h.api.loadDashboardData();
      const row=h.state.dashboardData[0],st=h.api.ownerStoreStatus(row);
      assert.equal(st.kind,'error');assert.ok(row.loadFailures.includes(label),JSON.stringify(row.loadFailures));
      assert.equal(h.api.ownerStatusChip('error').includes('조회 실패'),true);
    });
  }
  test('R3: '+label+' lookup returning a normal EMPTY result is not a failure',async()=>{
    const h=dashboard(table,'empty');await h.api.loadDashboardData();
    const row=h.state.dashboardData[0];
    assert.equal((row.loadFailures||[]).length,0);assert.notEqual(h.api.ownerStoreStatus(row).kind,'error');
  });
}
test('R3: a broken rule is still reported as 관리 필요 even when another lookup failed, and the failure is noted',async()=>{
  const h=harness((table)=>table==='expense_entries'?{data:null,error:{code:'X'}}:{data:dataFor(table,true),error:null});
  h.state.__x=0;await h.api.loadDashboardData();
  const row=h.state.dashboardData[0],st=h.api.ownerStoreStatus(row);
  assert.equal(row.laborRatio,40);assert.equal(st.kind,'attention');assert.ok(st.failures.includes('지출'));
});
test('R3: with no failure the normal verdicts are unchanged',async()=>{
  const h=harness((table)=>({data:dataFor(table),error:null}));
  await h.api.loadDashboardData();
  assert.equal(h.api.ownerStoreStatus(h.state.dashboardData[0]).kind,'ok');
});
// ---------- 2026-09-22: crew load failure must degrade only labor-derived figures, never masquerade as "0 employees" ----------
test('loadCrew: a failed lookup marks "직원" as a report data failure (never silently treated as "0 employees")',async()=>{
  const h=harness((t)=>t==='crew'?{data:null,error:{code:'42501',message:'permission denied'}}:emptyOk);
  await h.api.loadCrew('A');
  assert.equal(h.state.crew.length,0,'failure still yields an empty roster for safety (never a stale one)');
  assert.ok(h.state.reportDataFailed.has('직원'),'the failure must be recorded so the report can show 계산 불가, not 0 직원');
});
test('loadCrew: a successful retry after a prior failure clears the "직원" failure mark and restores the roster',async()=>{
  const failedSet=new Set(['직원']);
  const h=harness((t)=>t==='crew'?{data:crewA,error:null}:emptyOk,{reportDataFailed:failedSet});
  await h.api.loadCrew('A');
  assert.equal(h.state.crew.length,1);
  assert.equal(h.state.reportDataFailed.has('직원'),false,'a successful retry must clear the prior failure mark');
});
test('loadCrew: a stale (superseded) failure does not mark the CURRENT store/account\'s report as failed',async()=>{
  const gate=deferred();
  const h=harness((t,{storeId})=>t==='crew'&&storeId==='sid-A'?gate.promise:emptyOk);
  const pending=h.api.loadCrew('A');
  h.api.clearStaffAuthView();Object.assign(h.state,{authProfile:{user_id:'user-B'},store:'B',myStores:['B']});
  gate.resolve({data:null,error:{code:'X'}});await pending;
  assert.equal(!!(h.state.reportDataFailed&&h.state.reportDataFailed.has('직원')),false,'A\'s stale failure must not taint B\'s freshly-shown screen');
});
test('R3: the combined view never shows a green all-clear while a store could not be read, and names the store',()=>{
  const c=harness(()=>emptyOk);const ok=(store,extra={})=>({store,salesSum:1e6,salesReportCount:1,laborPay:0,laborRatio:5,expenseSum:0,expenseRatio:5,loadFailures:[],...extra});
  const rows=[ok('가'),ok('나',{loadFailures:['지출'],expenseRatio:null,salesSum:1e6})];
  assert.equal(c.api.ownerOverallKind(rows),'error');
  assert.equal(c.api.ownerOverallKind([ok('가')]),'ok');
  assert.equal(c.api.ownerOverallKind([ok('가',{laborRatio:30}),rows[1]]),'attention');
  // Every store unreadable: the total is 0 only because nothing could be read, so it must not read as "매출 없음"/"집계 전".
  const unreadable=(store)=>({store,salesSum:0,salesReportCount:0,laborPay:0,laborRatio:null,expenseSum:0,expenseRatio:null,loadFailures:['매출']});
  assert.equal(c.api.ownerOverallKind([unreadable('가'),unreadable('나')]),'error');
  assert.equal(c.api.ownerOverallKind([unreadable('가'),ok('나',{salesSum:0,salesReportCount:2})]),'error');
  assert.equal(c.api.ownerOverallKind([ok('가',{salesSum:0,salesReportCount:0})]),'pending');   // nothing failed: unchanged
  const out=c.api.renderOwnerStatusSummary(rows,'error',0,0);
  assert.match(out,/조회 실패 1곳/);assert.match(out,/합산 기준 확인 필요/);assert.match(out,/나/);assert.match(out,/data-retry-dashboard/);
  assert.equal(out.includes('합산 기준 안정'),false);assert.equal(out.includes('data-kind="ok"'),false);
});
