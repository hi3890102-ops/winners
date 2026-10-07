import {writeFileSync} from 'node:fs';
export async function runFlows({browser,origin,base,out}){
 const reports=[];
 const expectations={
  'staff-transient-navigation-error':r=>r.role==='staff'&&r.user==='qa-user'&&!r.loading,
  'manager-transient-navigation-error':r=>r.role==='staff'&&r.user==='qa-user'&&!r.loading,
  'location-permission':r=>r.message.includes('허용')&&!r.buttonDisabled&&!r.rpcSent,
  'location-unavailable':r=>r.message.includes('위치 기능')&&!r.buttonDisabled&&!r.rpcSent,
  'location-timeout':r=>r.message.includes('시간이 초과')&&!r.buttonDisabled&&!r.rpcSent,
  'reservation-double-submit':r=>r.writes===1&&r.reservations===1,
  'reservation-invalid-party--2':r=>r.writes===0&&r.formOpen,
  'reservation-invalid-party-1.5':r=>r.writes===0&&r.formOpen,
  'reservation-invalid-party-empty':r=>r.writes===1&&!r.formOpen,
  'reservation-failure-retains-input':r=>r.reservationName==='가상 예약자'&&r.party==='2'&&r.message.includes('실패'),
  'reservation-late-save-after-store-change':r=>r.reservations===0&&r.draft.name==='다른 매장 입력'&&r.formOpen,
  'reservation-zero-row-response':r=>r.reservationName==='가상 예약자',
  'cost-entry-open':r=>r.title==='수도요금 입력'&&r.focused&&r.costName==='수도요금',
  'expense-failure-retains-input':r=>r.amount==='12345'&&r.memo==='가상 메모'&&r.writes===1&&r.message.includes('실패'),
  'expense-ratio-with-no-sales':r=>r.text.includes('206,000원')&&r.text.includes('계산 불가')&&!r.text.includes('0.0%'),
  'expense-ratio-with-failed-sales':r=>r.text.includes('조회 실패')&&r.text.includes('확인 불가')&&!r.text.includes('13.7%'),
  'login-validation-and-password-toggle':r=>r.message.includes('아이디')&&r.passwordRetained&&r.type==='text',
  'zoom-setting':r=>!r.viewport.includes('maximum-scale')&&!r.viewport.includes('user-scalable=no'),
  'checklist-read-failure-checklist_templates':r=>r.retry&&!r.initialized&&r.body.includes('불러오지 못'),
  'checklist-read-failure-checklist_checks':r=>r.retry&&!r.initialized&&r.body.includes('불러오지 못'),
  'staff-regular-permissions':r=>r.hasDelete===0&&r.hasReset===0&&!r.nav.includes('매출'),
 };
 async function test(name,patch,fn){
  const context=await browser.newContext({viewport:{width:375,height:812},isMobile:true,hasTouch:true,timezoneId:'Asia/Seoul',serviceWorkers:'block'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  try{await page.clock.setFixedTime(new Date('2026-10-07T03:00:00Z'));await page.goto(origin);await page.waitForFunction(()=>window.__qa);await page.evaluate(({base,patch})=>window.__qa.reset({...base,...patch}),{base,patch});const result=await fn(page);const pass=errors.length===0&&expectations[name](result);reports.push({name,...result,errors,pass});console.log('FLOW',name,pass?'PASS':'FAIL',JSON.stringify(result));}
  catch(e){reports.push({name,error:e.message,errors,pass:false});console.log('FLOW',name,'ERROR',e.message.split('\n')[0]);}
  finally{await context.close();}
 }
 const staff={role:'staff',myCrewId:'c1',authMemberships:[{store_id:'s1',role:'staff',crew_id:'c1'}]};
 const manager={role:'staff',myCrewId:'c2',authMemberships:[{store_id:'s1',role:'manager',crew_id:'c2'}]};
 for(const [role,patch]of [['staff',staff],['manager',manager]])await test(role+'-transient-navigation-error',patch,async p=>{
  await p.evaluate(()=>{window.__mock.fail='manee_staff_portal';});await p.locator('[data-staffnav="schedule"]').click();await p.waitForTimeout(80);
  return p.evaluate(()=>({role:__qa.state.role,user:__qa.state.authProfile?.user_id??null,view:__qa.state.staffView,loading:__qa.state.loading,message:document.getElementById('toast').innerText}));
 });
 for(const [code,label]of [[1,'permission'],[2,'unavailable'],[3,'timeout']])await test('location-'+label,staff,async p=>{
  await p.evaluate(code=>Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(_,reject){reject({code});}}}),code);
  await p.locator('#clock-in-btn').click();await p.waitForTimeout(40);return p.evaluate(()=>({message:document.getElementById('toast').innerText,buttonDisabled:document.getElementById('clock-in-btn').disabled,rpcSent:__mock.calls.some(c=>c.rpc==='clock_in')}));
 });
 const reservation={section:'reservations',showReservationForm:true,upcomingReservations:[]};
 async function fillReservation(p,party='2'){
  await p.locator('#res-name-input').fill('가상 예약자');await p.locator('#res-party-input').fill(party);await p.locator('#res-time-input').fill('19:00');
 }
 await test('reservation-double-submit',reservation,async p=>{
  await fillReservation(p);await p.evaluate(()=>{__mock.delay=120;document.getElementById('add-reservation-btn').click();document.getElementById('add-reservation-btn').click();});await p.waitForTimeout(450);
  return p.evaluate(()=>({writes:__mock.calls.filter(c=>c.table==='reservations'&&c.action==='insert').length,reservations:__qa.state.reservations.length,message:document.getElementById('toast').innerText}));
 });
 for(const party of ['-2','1.5',''])await test('reservation-invalid-party-'+(party||'empty'),reservation,async p=>{
  await fillReservation(p,party);await p.locator('#add-reservation-btn').click();await p.waitForTimeout(40);return p.evaluate(()=>({writes:__mock.calls.filter(c=>c.table==='reservations'&&c.action==='insert').length,message:document.getElementById('toast').innerText,formOpen:__qa.state.showReservationForm}));
 });
 await test('reservation-failure-retains-input',reservation,async p=>{
  await fillReservation(p);await p.evaluate(()=>{__mock.fail='reservations'});await p.locator('#add-reservation-btn').click();await p.waitForTimeout(40);return {reservationName:await p.locator('#res-name-input').inputValue(),party:await p.locator('#res-party-input').inputValue(),message:await p.locator('#toast').innerText()};
 });
 await test('reservation-late-save-after-store-change',reservation,async p=>{
  await fillReservation(p);await p.evaluate(()=>{__mock.delay=120;document.getElementById('add-reservation-btn').click();__qa.state.store=__qa.state.myStores[1];__qa.state.reservations=[];__qa.state.reservationDraft={name:'다른 매장 입력'};});await p.waitForTimeout(450);return p.evaluate(()=>({store:__qa.state.store,reservations:__qa.state.reservations.length,draft:__qa.state.reservationDraft,formOpen:__qa.state.showReservationForm}));
 });
 await test('reservation-zero-row-response',reservation,async p=>{
  await fillReservation(p);await p.evaluate(()=>{__mock.zero='reservations'});await p.locator('#add-reservation-btn').click();await p.waitForTimeout(50);return {reservationName:await p.locator('#res-name-input').inputValue()};
 });
 await test('cost-entry-open', {section:'sales',salesSectionTab:'report',costReviewOpen:true},async p=>{
  await p.locator('[data-cost-add="water"]').click();return {title:await p.locator('#cost-entry-title').innerText(),focused:await p.locator('#cost-entry-title').evaluate(e=>document.activeElement===e),costName:await p.locator('#cost-name').inputValue()};
 });
 await test('expense-failure-retains-input',{...staff,staffView:'checklist',teamTab:'exp'},async p=>{
  await p.locator('#quick-expense-category-select').selectOption('food');await p.locator('#quick-expense-amount-input').fill('12345');await p.locator('#quick-expense-memo-input').fill('가상 메모');await p.evaluate(()=>{__mock.fail='expense_entries'});await p.locator('#add-quick-expense-btn').click();await p.waitForTimeout(50);return {amount:await p.locator('#quick-expense-amount-input').inputValue(),memo:await p.locator('#quick-expense-memo-input').inputValue(),writes:await p.evaluate(()=>__mock.calls.filter(c=>c.table==='expense_entries'&&c.action==='insert').length),message:await p.locator('#toast').innerText()};
 });
 await test('expense-ratio-with-no-sales',{section:'sales',salesSectionTab:'expenses',salesReports:[]},async p=>({text:await p.locator('.pay-summary').innerText()}));
 await test('expense-ratio-with-failed-sales',{section:'sales',salesSectionTab:'expenses'},async p=>{
  await p.evaluate(()=>{__qa.state.reportDataFailed=new Set(['매출']);__qa.render();});return {text:await p.locator('.pay-summary').innerText()};
 });
 await test('login-validation-and-password-toggle',{role:'landing'},async p=>{
  await p.locator('#store-login-submit-btn').click();const message=await p.locator('#login-message').innerText();await p.locator('#store-login-username-input').fill('qa_not_real');await p.locator('#store-login-password-input').fill('Fake-password-123');await p.locator('#toggle-pw-visibility-btn').click();return {message,passwordRetained:(await p.locator('#store-login-password-input').inputValue())==='Fake-password-123',type:await p.locator('#store-login-password-input').getAttribute('type')};
 });
 await test('zoom-setting',{role:'landing'},async p=>({viewport:await p.locator('meta[name=viewport]').getAttribute('content')}));
 for(const target of ['checklist_templates','checklist_checks'])await test('checklist-read-failure-'+target,{section:'checklist'},async p=>{
  await p.evaluate(async target=>{__mock.fail=target;__mock.tables.checklist_templates=[{store_id:'s1',tab:'morning',data:__qa.state.items.morning}];await __qa.fns.loadChecklist(__qa.state.store,__qa.bizToday());__qa.render();},target);
  return p.evaluate(()=>({body:document.querySelector('main').innerText,initialized:__mock.calls.some(c=>c.rpc==='manee_checklist'&&c.args?.p_action==='initialize'),retry:!!document.getElementById('checklist-retry-btn')}));
 });
 await test('staff-regular-permissions',{...staff,staffView:'checklist'},async p=>({hasDelete:await p.locator('[data-delitem]').count(),hasReset:await p.locator('#reset-btn').count(),nav:await p.locator('.bottom-nav').innerText()}));
 writeFileSync(out+'/flows.json',JSON.stringify(reports,null,2));
 return reports;
}
