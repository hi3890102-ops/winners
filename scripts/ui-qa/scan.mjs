import { runFlows } from './flows.mjs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, extname } from 'node:path';
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
const out=resolve(process.env.QA_OUTPUT||'ui-qa-results');mkdirSync(out,{recursive:true});
let html=readFileSync(root+'/index.html','utf8');
html=html.replace('const MANEE_STAFF_AUTH_ENABLED = MANEE_IS_STAGING;','const MANEE_STAFF_AUTH_ENABLED = true;');
html=html.replace(/<script src="[^"]+"><\/script>/g,'');
const stub=readFileSync(new URL('stub.js',import.meta.url),'utf8');
html=html.replace('<head>','<head><script>'+stub+'</script>');
const hook=`
  const qaInitial=structuredClone(state);
  window.__qa={ get state(){return state;},render,
    reset(seed){maneeViewEpoch++;state=structuredClone(qaInitial);Object.assign(state,{splashDone:true,loading:false},seed);window.__mock.calls=[];window.__mock.fail=null;window.__mock.delay=0;render();},
    seed(patch){Object.assign(state,patch);render();},
    fns:{openMonthlyCostEntry,renderMonthlyCostReview,renderExpenseEditor,goToStaffTab,loadAllForStore,loadChecklist,clockAuthStaff,openOwnerSalesForm,renderStaffAuthAccount},
    bizToday,monthKey
  };
  window.__qa.reset({role:'landing'});
`;
if(!html.includes('  initAuthTabSync();\n\n  resolveIdentity();'))throw Error('QA boot anchor changed');
html=html.replace('  initAuthTabSync();\n\n  resolveIdentity();',hook);
const types={'.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.ttf':'font/ttf'};
const server=createServer((req,res)=>{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(path==='/'||path==='/index.html'){res.setHeader('Content-Type','text/html');res.end(html);return;}const f=resolve(root,'.'+path);if(!f.startsWith(root+'/')){res.writeHead(403).end();return;}try{res.setHeader('Content-Type',types[extname(f)]||'application/octet-stream');res.end(readFileSync(f));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
const stores=['가상 신촌점','가상 송파직영점','가상 매장명이 아주 긴 프랜차이즈 대학로점'];
const storeIdMap=Object.fromEntries(stores.map((s,i)=>[s,'s'+(i+1)]));
const crew=[{id:'c1',name:'가상직원',store:stores[0],position:'홀',wageType:'hourly',wage:12000,salary:0,weeklyHours:20,isManager:false,salesAccess:false,hireDate:'2026-09-01',deleted:false,phone:'01000000000'},{id:'c2',name:'가상매니저',store:stores[0],position:'매니저',wageType:'hourly',wage:15000,salary:0,weeklyHours:40,isManager:true,salesAccess:true,hireDate:'2026-09-01',deleted:false}];
const day='2026-10-07',month='2026-10';
const items={morning:[{id:'cat1',name:'오픈 준비',items:[{id:'i1',label:'바닥 청소'}]}],afternoon:[],routine:[]};
const base={role:'storeOwner',store:stores[0],myStores:stores,storeList:stores,storeIdMap,homeStore:stores[0],authProfile:{user_id:'qa-user',name:'가상 사용자'},authMemberships:stores.map((s,i)=>({store_id:'s'+(i+1),store_name:s,role:'owner'})),crew,myCrewId:'c1',monthYear:2026,monthNum:10,selectedDate:null,storeCutoffMap:{[stores[0]]:6},storeOnboardingMap:{[stores[0]]:{onboarding_state:'completed'}},storeLocationMap:{[stores[0]]:{lat:37.5,lng:127}},items,checks:{},homeChecklistItems:items,homeChecklistChecks:{},shifts:[{id:'shift1',crewId:'c1',date:day,start:'10:00',end:'18:00'}],attendance:[{id:'att1',crewId:'c1',date:'2026-10-06',checkIn:'10:00',checkOut:'18:00',checkInExact:'10:00:00',checkOutExact:'18:00:00',confirmed:true,staffConfirmed:true}],vendors:[{id:'v1',name:'가상 식자재 거래처',category:'food'},{id:'v2',name:'매장용소모품인터넷구매처이름이길어지는상황테스트',category:null}],expenseEntries:[{id:'e1',date:day,description:'가상 식자재 거래처',amount:158000,category:'food',memo:'샘플 채소 구매'},{id:'e2',date:day,description:'매장용소모품인터넷구매처이름이길어지는상황테스트',amount:48000,category:null,memo:'손님용 사탕 및 수도꼭지 수리'}],fixedExpenses:[{id:'f1',name:'임대료',amount:1500000}],salesReports:[{id:'sale1',date:'2026-10-06',totalSales:1500000,cashSales:100000,cardSales:1300000,discount:0,refund:0,deliveryBaemin:100000,deliveryCoupang:0,deliveryYogiyo:0,deliverySum:100000}],monthlyPayrolls:[],payAdjustments:[],reservations:[],announcements:[{id:'ann1',title:'가상 직원 공지',body:'손 씻기와 마감 점검을 확인해 주세요.',createdAt:'2026-10-06T00:00:00Z',reads:{}}],storeFoodLimitMap:{[stores[0]]:40},storeLaborLimitMap:{[stores[0]]:25},dashboardData:stores.map(store=>({store,salesSum:1500000,salesReportCount:1,laborPay:240000,laborRatio:16,expenseSum:206000,expenseRatio:13.7,foodThreshold:40,laborThreshold:25,loadFailures:[],crewCount:2,attPending:0,uncheckedItems:0,checkDone:1,checkTotal:1})),ownerWork:{stores:{},expanded:{},loadedOnce:true,lastStartAt:Date.now(),wasHome:true,inflight:0},ownerReportHomeNotices:{userId:'qa-user',rows:[],checkedAt:Date.now(),loading:false},monthlyCostReview:{scope:'s1:'+month,checks:[],templates:[],review:{}},reportHistory:[],businessCalendar:{closed_weekdays:[],closed_dates:[],open_dates:[]},showOwnerSalesForm:false};

const scenarios=[
 ['login-owner',{role:'landing'}],['login-staff',{role:'landing',landingTab:'staff'}],['signup-owner',{role:'landing',landingMode:'request-form'}],['signup-staff',{role:'landing',landingMode:'staff-signup'}],['recovery',{role:'landing',landingMode:'account-recovery'}],
 ['owner-home',{}],['owner-long-store',{store:stores[2],homeStore:stores[2]}],['owner-empty',{crew:[],salesReports:[],expenseEntries:[],fixedExpenses:[],dashboardData:[]}],['owner-all-stores',{homeStore:'__all__'}],['owner-attendance',{section:'schedule',scheduleTab:'attendance',selectedDate:day}],['owner-schedule',{section:'schedule',scheduleTab:'calendar',selectedDate:day}],['owner-fixed-schedule',{section:'schedule',scheduleTab:'calendar',showFixedPanel:true}],['owner-crew',{section:'schedule',scheduleTab:'crew'}],['owner-crew-edit',{section:'schedule',scheduleTab:'crew',expandedCrewIds:{c1:true}}],['owner-pay',{section:'sales',salesSectionTab:'pay',payCrewId:'c1'}],['owner-sales',{section:'sales',salesSectionTab:'sales'}],['owner-sales-form',{section:'sales',salesSectionTab:'sales',showOwnerSalesForm:true}],['owner-expenses',{section:'sales',salesSectionTab:'expenses',expenseViewMode:'date'}],['owner-vendors',{section:'sales',salesSectionTab:'expenses',showVendorManage:true}],['owner-expense-edit',{section:'sales',salesSectionTab:'expenses',editingExpenseEntryId:'e1',expenseEditDraft:{id:'e1',date:day,description:'가상 식자재 거래처',amount:'158000',category:'food',memo:'샘플'}}],['owner-report',{section:'sales',salesSectionTab:'report'}],['owner-costs',{section:'sales',salesSectionTab:'report',costReviewOpen:true,costEditKey:'electricity'}],['owner-fixed-costs',{section:'sales',salesSectionTab:'report',showFixedExpenseManage:true}],['owner-checklist',{section:'checklist'}],['owner-reservations',{section:'reservations',showReservationForm:true}],['owner-announcements',{section:'announce',showAnnounceForm:true}],['owner-more',{section:'more'}],['owner-settings',{section:'settings'}],['owner-alerts',{section:'alerts'}],['owner-ai',{section:'ai'}],
 ...['staff','manager'].flatMap(role=>{
   const patch={role:'staff',myCrewId:role==='manager'?'c2':'c1',authMemberships:stores.map((s,i)=>({store_id:'s'+(i+1),store_name:s,role:role==='manager'?'manager':'staff',crew_id:role==='manager'?'c2':'c1'}))};
   return [['home',{}],['schedule',{selectedDate:day}],['checklist',{teamTab:'check'}],['reservations',{staffView:'checklist',teamTab:'res',showReservationForm:true}],['expenses',{staffView:'checklist',teamTab:'exp'}],['announcements',{}],['me',{staffView:role==='manager'?'more':'me'}],...['connection','notifications','password','help','personal'].map(teamPage=>[teamPage,{staffView:role==='manager'?'more':'me',teamPage}]),['sales',{staffView:'sales'}],['sales-form',{staffView:'salesReport'}]].map(([name,more])=>[role+'-'+name,{...patch,staffView:name,...more}]);
 })
];
const metrics=()=>{
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
 const outside=[...document.querySelectorAll('#app *')].filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.right>innerWidth+2||r.left< -2;}).slice(0,15).map(el=>({tag:el.tagName,id:el.id,class:el.className,text:el.innerText?.slice(0,65),right:Math.round(el.getBoundingClientRect().right)}));
 const small=[...document.querySelectorAll('button,[role=button]')].filter(visible).filter(el=>{const r=el.getBoundingClientRect();return r.height<40||r.width<40;}).map(el=>({id:el.id,text:el.innerText?.slice(0,40),w:Math.round(el.getBoundingClientRect().width),h:Math.round(el.getBoundingClientRect().height)}));
 const controls=[...document.querySelectorAll('button,input,select,textarea')].filter(visible).map(el=>({tag:el.tagName,id:el.id,text:el.innerText?.slice(0,50),type:el.type,disabled:el.disabled}));
 return {overflow:document.documentElement.scrollWidth>innerWidth+2,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,outside,small,controls,body:document.body.innerText.slice(0,1800)};
};
const results=[];
try{
 for(const width of (process.env.QA_ONLY==='flows'?[]:[320,375,430])){
  const context=await browser.newContext({viewport:{width,height:812},isMobile:true,hasTouch:true,timezoneId:'Asia/Seoul',serviceWorkers:'block'});
  const page=await context.newPage();const errors=[];
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.setFixedTime(new Date('2026-10-07T03:00:00Z'));
  await page.goto(origin);await page.waitForFunction(()=>window.__qa);
  for(const [name,patch]of scenarios.filter(([name])=>!process.env.QA_SCREENS||process.env.QA_SCREENS.split(',').includes(name))){
   errors.length=0;
   try{
    await page.evaluate(({base,patch})=>{window.__mock.tables={};window.__qa.reset({...base,...patch});}, {base,patch});
    await page.waitForTimeout(80);
    const result={name,width,...await page.evaluate(metrics),errors:[...errors]};
    await page.screenshot({path:out+'/'+name+'-'+width+'.png',fullPage:true});
    results.push(result);
    console.log(name,width,result.overflow?'OVERFLOW':'ok','errors='+result.errors.length,'small='+result.small.length);
   }catch(e){results.push({name,width,error:e.message,errors:[...errors]});console.log(name,width,'ERROR',e.message.split('\n')[0]);}
  }
  await context.close();
 }
 if(results.length)writeFileSync(out+'/scan.json',JSON.stringify(results,null,2));
 const flowResults=await runFlows({browser,origin,base,out});
 if(results.some(r=>r.error||r.errors.length||r.overflow)||flowResults.some(r=>!r.pass))process.exitCode=1;
}finally{await browser.close();server.close();}
