import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script,createContext} from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  // BEGIN MANEE_STORE_PERMISSIONS'),html.indexOf('  // END MANEE_STORE_PERMISSIONS'));
function harness(options={}){
 const calls=[];const state={store:'Store',checks:{other:true},checklistLog:{},items:{morning:[]},tab:'morning',authMemberships:[],crew:[],...options.state};
 const context=createContext({MANEE_STAFF_AUTH_ENABLED:true,state,console,
  currentStoreId:()=>state.store==='Store'?'store':'other-store',bizToday:()=> '2026-09-11',
  render:()=>calls.push('render'),showToast:t=>calls.push({toast:t}),
  staffErrorMessage:e=>e?.message||'권한 오류',clearStaffAuthView:()=>{calls.push('clear');state.role='landing';state.crew=[];state.checks={};},
  document:{getElementById:()=>({value:options.input||''})},
  loadChecklist:async()=>calls.push('reloadChecklist'),
  db:{rpc:async(name,args)=>{calls.push({name,args});if(options.onRpc)options.onRpc(state);return {error:options.error,data:options.result||{ok:true,checks:{other:true,clicked:true},log:null}};},
   from:table=>{const q={delete(){calls.push({delete:table});return q;},update(x){calls.push({update:table,payload:x});return q;},upsert(x){calls.push({upsert:table,payload:x});return q;},eq(){return q;},select:async()=>({data:options.rows??[{id:'row',read_at:'2026-09-11T12:00:00Z'}],error:options.error})};return q;}}
 });
 new Script(code).runInContext(context);return {context,calls,state};
}
test('Manager controls use current membership rather than the old employee flag',()=>{
 const h=harness({state:{myCrewId:'crew',crew:[{id:'crew',isManager:true}],authMemberships:[{store_id:'store',role:'staff'}]}});
 assert.equal(h.context.canManageBusinessData(),false);
 h.state.authMemberships[0].role='manager';assert.equal(h.context.canManageBusinessData(),true);assert.equal(h.context.canDeleteFinancialData(),false);
 h.state.authMemberships[0].role='owner';assert.equal(h.context.canManageBusinessData(),true);assert.equal(h.context.canDeleteFinancialData(),true);
 h.state.store='Another';assert.equal(h.context.canManageBusinessData(),false);
});
test('Checkbox changes send one item and only use server-confirmed shared state',async()=>{
 const h=harness();await h.context.changeAuthChecklist('check',{item_id:'clicked',checked:true});
 const c=h.calls.find(c=>c.name);assert.equal(c.name,'manee_checklist');assert.deepEqual(JSON.parse(JSON.stringify(c.args.p_payload)),{item_id:'clicked',checked:true});
 assert.equal(h.calls.some(c=>c.delete),false);assert.deepEqual(JSON.parse(JSON.stringify(h.state.checks)),{other:true,clicked:true});
});
test('Failed checklist mutation keeps previous checks and displays no success',async()=>{
 const h=harness({error:{message:'offline'}});assert.equal(await h.context.changeAuthChecklist('close'),false);
 assert.deepEqual(JSON.parse(JSON.stringify(h.state.checks)),{other:true});assert.equal(h.calls.some(c=>c.toast?.includes('마감했어요')),false);
});
test('A revoked membership clears sensitive view state on business mutation denial',async()=>{
 const h=harness({error:{code:'42501'}});await h.context.changeAuthChecklist('check',{item_id:'clicked',checked:true});
 assert.ok(h.calls.includes('clear'));assert.equal(h.state.role,'landing');
});
test('A late response for the old store does not replace the newly selected store state',async()=>{
 const h=harness({onRpc:s=>{s.store='Other';}});await h.context.changeAuthChecklist('check',{item_id:'clicked',checked:true});
 assert.deepEqual(JSON.parse(JSON.stringify(h.state.checks)),{other:true});
});
test('Zero-row delete and backend errors never remove a record from the screen',async()=>{
 for(const options of [{rows:[]},{error:{message:'offline'}}]){
  const h=harness(options);let removed=false;assert.equal(await h.context.deleteAuthBusinessRow('reservations','row',()=>removed=true),false);assert.equal(removed,false);
 }
 const h=harness();let removed=false;assert.equal(await h.context.deleteAuthBusinessRow('reservations','row',()=>removed=true),true);assert.equal(removed,true);
});
test('Acknowledgement success is shown only after a saved read record is returned',async()=>{
 const h=harness({state:{myCrewId:'crew',announcements:[{id:'notice',reads:{}}]},rows:[]});
 await h.context.confirmAuthAnnouncement('notice');assert.equal(h.state.announcements[0].reads.crew,undefined);
 assert.equal(h.calls.some(c=>c.toast==='확인했어요.'),false);
});
test('Failed template editing preserves the previously displayed template',async()=>{
 const items={morning:[{id:'opening',name:'Opening',items:[{id:'first',label:'One'}]}]};
 const h=harness({state:{items},input:'New task',error:{message:'offline'}});await h.context.editAuthChecklistItem('opening',null);
 assert.equal(h.state.items.morning[0].items.length,1);
});
