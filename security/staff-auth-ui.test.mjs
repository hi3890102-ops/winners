import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  // BEGIN MANEE_STAFF_AUTH'),html.indexOf('  // END MANEE_STAFF_AUTH'));
const owner={id:'member-owner',store_id:'store-owner',store_name:'Owner Store',role:'owner',crew_id:null};
const staff={id:'member-staff',store_id:'store-staff',store_name:'Staff Store',role:'staff',crew_id:'crew-self',lat:37.5,lng:127,cutoff:6};
function harness(options={}){
  const calls=[],storage=new Map(Object.entries(options.storage||{}));
  const state={storeIdMap:{},attendance:[],...options.state};
  const snapshot={ok:true,profile:{user_id:'verified-user',username:'worker',display_name:'Worker'},memberships:options.memberships||[],requests:options.requests||[]};
  const db={
    auth:{getSession:async()=>{calls.push('getSession');return {data:{session:options.noSession?null:{user:{id:'untrusted-cache'}}},error:options.sessionError||null};},
      getUser:async()=>{calls.push('getUser');return options.invalidUser?{error:{code:'invalid'},data:null}:{data:{user:{id:'verified-user'}}};}},
    rpc:async(name,args)=>{calls.push({name,args});
      if(options.rpcError)return {error:options.rpcError,data:null};
      if(name==='manee_staff_portal')return {data:options.badProfile?{...snapshot,profile:{user_id:'other-user'}}:snapshot};
      return {data:options.attendanceResult||null};}
  };
  const context=createContext({
    MANEE_IS_STAGING:true,state,db,console,app:{addEventListener(){}},document:{getElementById(id){return {value:options.inputs?.[id]||''};}},
    navigator:{geolocation:{getCurrentPosition(resolve){resolve({coords:{latitude:37.5,longitude:127}});}}},
    localGet:k=>storage.has(k)?{value:storage.get(k)}:null,localSet:(k,v)=>storage.set(k,v),localDelete:k=>storage.delete(k),
    render(){calls.push('render');},showToast(message){calls.push({toast:message});},
    restoreManeeAuthOwner:async name=>{calls.push({owner:name});state.role='storeOwner';return true;},
    loadStaffHome:async(name,cid)=>{calls.push({staff:name,crewId:cid});state.loading=false;},
    currentStoreId:()=>state.storeIdMap[state.store],
    findOpenAttendance:cid=>state.attendance.find(a=>a.crewId===cid && !a.checkOut),
    escapeHtml:x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
    askConfirm:(message,cb)=>{calls.push({confirmation:message});if(options.confirm)cb();},
    callManeeAuthApi:async(name,args)=>{calls.push({edge:name,args});return {session:{access_token:'test-access',refresh_token:'test-refresh'}};},
    applyManeeAuthSession:async()=>{calls.push('setSession');},switchUser:()=>{calls.push('switchUser');},
  });
  new Script(code).runInContext(context);
  return {context,state,calls,storage,snapshot};
}
test('Unlinked Auth profile reaches approval portal without restoring a legacy crew link',async()=>{
  const h=harness({storage:{'my-link':'{"crewId":"victim"}'}});await h.context.restoreManeeAuthIdentity();
  assert.equal(h.state.role,'landing');assert.equal(h.state.landingMode,'auth-account');assert.equal(h.state.myCrewId,null);
  assert.ok(h.calls.indexOf('getUser')<h.calls.findIndex(c=>c.name==='manee_staff_portal'));
  assert.equal(h.storage.has('my-link'),false);
});
test('Approved staff resumes by server membership, preserving original crew identity',async()=>{
  const h=harness({memberships:[staff],storage:{'my-link':'{"crewId":"victim"}'}});await h.context.restoreManeeAuthIdentity();
  assert.equal(h.state.role,'staff');assert.equal(h.state.myCrewId,'crew-self');
  assert.equal(h.state.storeIdMap['Staff Store'],'store-staff');assert.equal(h.storage.get('auth-store-id'),'store-staff');
});
test('A revoked cached store cannot become a current store',async()=>{
  const h=harness({memberships:[staff],storage:{'auth-store-id':'revoked-store'}});await h.context.restoreManeeAuthIdentity();
  assert.equal(h.state.store,'Staff Store');
});
test('One account can select owner and employee memberships without promoting employee role',async()=>{
  const h=harness({memberships:[owner,staff]});await h.context.restoreManeeAuthIdentity('store-staff');assert.equal(h.state.role,'staff');
  await h.context.restoreManeeAuthIdentity('store-owner');assert.equal(h.state.role,'storeOwner');
});
test('A missing or unverifiable session cannot resume staff work',async()=>{
  const absent=harness({noSession:true,state:{role:'staff',myCrewId:'old',crew:[{id:'old'}]}});
  assert.equal(await absent.context.restoreManeeAuthIdentity(),false);assert.equal(absent.state.myCrewId,null);assert.equal(absent.state.crew.length,0);
  const invalid=harness({invalidUser:true});await assert.rejects(()=>invalid.context.restoreManeeAuthIdentity());
  assert.equal(invalid.calls.some(c=>c.name==='manee_staff_portal'),false);
  const mismatch=harness({badProfile:true});await assert.rejects(()=>mismatch.context.restoreManeeAuthIdentity());
});
test('Portal renders user text escaped and shows explicit request state',()=>{
  const h=harness({state:{authProfile:{username:'<script>'},authMemberships:[{...staff,store_name:'<img onerror="evil()">'}],staffLinkRequests:[{id:'r',store_name:'Shop',status:'pending'}]}});
  const output=h.context.renderStaffAuthAccount();assert.equal(output.includes('<script>'),false);assert.equal(output.includes('<img onerror'),false);assert.ok(output.includes('승인 대기'));
});
test('Clock sends only store plus device coordinates and uses the returned server time',async()=>{
  const h=harness({state:{store:'Staff Store',storeIdMap:{'Staff Store':'store-staff'},myCrewId:'crew-self'},attendanceResult:{id:'a',crew_id:'crew-self',date:'2026-09-11',check_in:'12:34:56',check_out:null}});
  await h.context.clockAuthStaff('in');const call=h.calls.find(c=>c.name==='clock_in');
  assert.deepEqual(Object.keys(call.args).sort(),['current_lat','current_lng','target_store_id']);assert.equal(h.state.attendance[0].checkIn,'12:34');
});
test('Failed clock-out keeps existing record unchanged, while revoked access clears the display',async()=>{
  const existing={id:'a',crewId:'crew-self',checkIn:'10:00',checkOut:null};
  const h=harness({state:{myCrewId:'crew-self',attendance:[{...existing}]},rpcError:{message:'offline'}});
  await h.context.clockAuthStaff('out');assert.equal(h.state.attendance[0].checkOut,null);
  const revoked=harness({state:{myCrewId:'crew-self',attendance:[{...existing}]},rpcError:{code:'42501'}});
  await revoked.context.clockAuthStaff('out');assert.equal(revoked.state.attendance.length,0);assert.equal(revoked.state.role,'landing');
});
test('Staff signup calls only the employee endpoint and then opens connection portal',async()=>{
  const h=harness({inputs:{'staff-signup-name':'Worker','staff-signup-username':'worker','staff-signup-password':'synthetic-password','staff-signup-confirm':'synthetic-password'}});
  const button={dataset:{staffAuthAction:'signup'},disabled:false};button.closest=()=>button;
  await h.context.handleStaffAuthClick({target:button});
  assert.equal(h.calls.find(c=>c.edge).edge,'manee-staff-signup');assert.equal(h.state.landingMode,'auth-account');
});
test('Owner review requires confirmation before any mutation RPC',async()=>{
  const h=harness();const button={dataset:{staffAuthAction:'approve',requestId:'request'},disabled:false};button.closest=()=>button;
  await h.context.handleStaffAuthClick({target:button});assert.ok(h.calls.some(c=>c.confirmation));assert.equal(h.calls.some(c=>c.name),false);
});
