import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  // BEGIN MANEE_STAFF_AUTH'),html.indexOf('  // END MANEE_STAFF_AUTH'));
function harness(inputs={}){
  const calls=[],values={...inputs};let confirm;
  const state={store:'Store',storeIdMap:{Store:'s'},role:'storeOwner',authProfile:{username:'employee'},authMemberships:[],staffLinkRequests:[],ownerStaffAccess:{storeId:'s',store_join_code:'ABCDEFGH',requests:[],links:[],available_crew:[]}};
  const context=createContext({MANEE_IS_STAGING:true,state,console,SUPABASE_URL:'https://offline.invalid',SUPABASE_ANON_KEY:'test',app:{addEventListener(){}},
    document:{getElementById:id=>({value:values[id]||''})},navigator:{clipboard:{writeText:async value=>calls.push({copied:value})}},
    db:{rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true,store_name:'Store',request_id:'r'}};}},
    currentStoreId:()=>state.storeIdMap[state.store],render:()=>calls.push('render'),showToast:message=>calls.push({toast:message}),
    askConfirm:(message,cb)=>{confirm=cb;calls.push('confirm');},
    escapeHtml:s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))});
  new Script(code).runInContext(context);
  context.refreshOwnerStaffAccess=async()=>calls.push('owner-refresh');context.restoreManeeAuthIdentity=async()=>calls.push('restore');
  function button(action,extra={}){const b={dataset:{staffAuthAction:action,...extra},disabled:false};b.closest=()=>b;return b;}
  return {context,state,calls,values,button,confirm:async()=>{confirm();await new Promise(r=>setImmediate(r));}};
}
function section(a,b){const start=html.indexOf(a),end=html.indexOf(b,start);assert.ok(start>=0&&end>start);return html.slice(start,end);}
test('Employee enters only store code and preview never shows employee records',()=>{
  const body=section('  function renderStaffAuthAccount(){','  function renderOwnerStaffAccess(){');
  assert.ok(body.includes('매장 연결코드'));assert.ok(body.includes('매장명은 입력하지 않아도'));
  assert.ok(body.includes("staffAuthButton('preview-link','매장 확인')"));assert.equal(body.includes('crew_name'),false);
  assert.equal(body.includes('이 연결코드는 사용 완료됐어요'),false);
});
test('Formatted pasted code is normalized before the preview RPC',async()=>{
  const h=harness({'staff-link-code':' abcd-efgh '});const b=h.button('preview-link');await h.context.handleStaffAuthClick({target:b});
  assert.equal(h.calls.find(x=>x.args).args.p_payload.code,'ABCDEFGH');assert.equal(h.state.staffLinkPreview.store_name,'Store');
});
test('Invalid code makes no RPC',async()=>{
  const h=harness({'staff-link-code':'OOOO0000'});await h.context.handleStaffAuthClick({target:h.button('preview-link')});
  assert.equal(h.calls.some(x=>x.args),false);assert.ok(h.calls.some(x=>x.toast));
});
test('Request sends only the code and clears the preview, without a success claim of active membership',async()=>{
  const h=harness();h.state.staffLinkCode='ABCDEFGH';h.state.staffLinkPreview={store_name:'Store'};
  await h.context.handleStaffAuthClick({target:h.button('request')});
  const args=h.calls.find(x=>x.args).args;assert.equal(args.p_action,'request');assert.deepEqual(Object.keys(args.p_payload),['code']);
  assert.equal(h.state.staffLinkPreview,null);assert.equal(h.state.authMemberships.length,0);
});
test('Owner can copy the reusable store code',async()=>{
  const h=harness();await h.context.handleStaffAuthClick({target:h.button('copy-store-code')});assert.equal(h.calls.find(x=>x.copied).copied,'ABCDEFGH');
});
test('Approving without a selected employee does not confirm or send a mutation',async()=>{
  const h=harness();await h.context.handleStaffAuthClick({target:h.button('approve',{requestId:'r'})});
  assert.equal(h.calls.includes('confirm'),false);assert.equal(h.calls.some(x=>x.args),false);
});
test('Confirmation rerender cannot erase or change the selected employee',async()=>{
  const h=harness({'staff-link-crew-r':'crew-a'}),b=h.button('approve',{requestId:'r'});
  await h.context.handleStaffAuthClick({target:b});assert.equal(h.calls.some(x=>x.args),false);
  h.values['staff-link-crew-r']='crew-b';await h.confirm();
  const call=h.calls.find(x=>x.args);assert.equal(call.args.p_payload.crew_id,'crew-a');
});
test('Switching stores while confirmation is open aborts the operation',async()=>{
  const h=harness({'staff-link-crew-r':'crew-a'}),b=h.button('approve',{requestId:'r'});await h.context.handleStaffAuthClick({target:b});
  h.state.store='Other';h.state.storeIdMap.Other='other';await h.confirm();assert.equal(h.calls.some(x=>x.args),false);
});
test('Employee choices exclude records linked to someone else and escape unsafe names',()=>{
  const h=harness();h.state.ownerStaffAccess.requests=[{id:'r',requester_user_id:'me',username:'<script>',display_name:'Worker'}];
  h.state.ownerStaffAccess.available_crew=[{crew_id:'free',crew_name:'Free'},{crew_id:'mine',crew_name:'Mine',linked_user_id:'me'},{crew_id:'foreign',crew_name:'Hidden',linked_user_id:'other'}];
  const output=h.context.renderOwnerStaffAccess();assert.ok(output.includes('value="free"'));assert.ok(output.includes('value="mine"'));assert.equal(output.includes('value="foreign"'),false);assert.equal(output.includes('<script>'),false);
});
test('Pending employee sees an explicit owner-approval waiting message',()=>{
  const h=harness();h.state.staffLinkRequests=[{id:'r',status:'pending',store_name:'Store'}];
  assert.ok(h.context.renderStaffAuthAccount().includes('사장님 승인 대기 중'));
});
test('Auth UI hides employee codes and does not generate them for new employee records',()=>{
  assert.ok(html.includes('if(!MANEE_STAFF_AUTH_ENABLED) html += \'<div class="crew-code-row"'));
  assert.ok(html.includes('const uniqueJoinCode = MANEE_STAFF_AUTH_ENABLED ? null : await genUniqueCode();'));
  assert.ok(html.includes("staffAuthButton('regenerate-store-code','재발급')"));
});
