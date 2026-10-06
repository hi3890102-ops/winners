import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=name=>html.match(new RegExp('^  (?:async )?function '+name+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))[0];
function app({rpc=async()=>({data:true}),existing=true,permission='granted',keyMismatch=false,configOk=true}={}){
 const calls=[],toasts=[],counters={prompts:0,subscribes:0,unsubscribes:0};
 const key=Uint8Array.from({length:65},(_,i)=>i===0?4:1),publicKey=Buffer.from(key).toString('base64url');
 const subscription=n=>({endpoint:'https://fcm.googleapis.com/fcm/send/test-'+n,
  options:{applicationServerKey:Uint8Array.from(n===1&&keyMismatch?key.map((b,i)=>i===0?b:2):key).buffer},
  toJSON(){return {endpoint:this.endpoint,keys:{p256dh:'A'.repeat(87),auth:'B'.repeat(22)}};},
  async unsubscribe(){counters.unsubscribes++;current=null;return true;}});
 let current=existing?subscription(1):null,epoch=0,seq=0;
 const reg={pushManager:{getSubscription:async()=>current,subscribe:async()=>{counters.subscribes++;return current=subscription(2);}}};
 const state={role:'storeOwner',store:'mine',pushSubscribed:false,pushBusy:false,authProfile:{user_id:'owner'}};
 const ctx=vm.createContext({state,MANEE_IS_STAGING:false,
  navigator:{serviceWorker:{ready:Promise.resolve(reg)}},window:{PushManager:{}},
  Notification:{permission,requestPermission:async()=>{counters.prompts++;return permission;}},
  db:{rpc:async(name,args)=>{calls.push({name,args});return rpc(name,args);},from(){throw Error('owner must not use direct table access');}},
  currentStoreId:()=>state.store,maneeLoadGuard(){const at=epoch,n=++seq;return ()=>at===epoch&&n===seq;},
  fetch:async()=>({ok:configOk,json:async()=>({publicKey})}),atob:value=>Buffer.from(value,'base64').toString('binary'),
  isInstalledApp:()=>true,showToast:t=>toasts.push(t),render(){}});
 vm.runInContext(['urlBase64ToUint8Array','registerOwnerPush','removeOwnerPush','getPushApplicationKey','pushSubscriptionUsesKey','refreshPushSubStatus','subscribeToPush','unsubscribeFromPush'].map(fn).join('\n'),ctx);
 return {ctx,state,calls,toasts,counters,changeAccount(){epoch++;state.pushSubscribed=false;state.pushBusy=false;state.authProfile={user_id:'other'};}};
}

test('existing permission is repaired on refresh using the full device subscription without another prompt',async()=>{
 const a=app();await a.ctx.refreshPushSubStatus();
 assert.equal(a.state.pushSubscribed,true);assert.equal(a.state.pushBusy,false);assert.equal(a.counters.prompts,0);
 assert.equal(a.calls[0].name,'manee_register_owner_push');assert.equal(a.calls[0].args.p_store_id,'mine');
 assert.equal(a.calls[0].args.p_auth,'B'.repeat(22));assert.equal(Object.hasOwn(a.calls[0].args,'user_id'),false);
});
test('a device alone never shows enabled when registration is denied or unconfirmed',async()=>{
 for(const result of [{error:{code:'42501'}},{data:null},{data:false}]){
  const a=app({rpc:async()=>result});await a.ctx.refreshPushSubStatus();
  assert.equal(a.state.pushSubscribed,false);assert.equal(a.state.pushBusy,false);assert.ok(a.state.pushRegistrationError);
 }
});
test('new permission saves through the server RPC before showing success',async()=>{
 const a=app({existing:false});await a.ctx.subscribeToPush();assert.equal(a.counters.subscribes,1);
 assert.equal(a.state.pushSubscribed,true);assert.equal(a.calls.length,1);assert.equal(a.toasts.at(-1),'알림 연결이 완료됐어요.');
});
test('permission denial and registration failure cannot show a success toast',async()=>{
 const denied=app({permission:'default'});await denied.ctx.subscribeToPush();assert.equal(denied.calls.length,0);assert.equal(denied.state.pushSubscribed,false);
 const failed=app({rpc:async()=>({error:{code:'42501',message:'sensitive raw details'}})});await failed.ctx.subscribeToPush();
 assert.equal(failed.state.pushSubscribed,false);assert.equal(failed.state.pushBusy,false);assert.ok(failed.state.pushRegistrationError);
 assert.ok(!failed.toasts.join().includes('sensitive'));
});
test('explicit enable rotates a shared browser subscription instead of taking over another account',async()=>{
 let attempts=0;const a=app({rpc:async()=>++attempts===1?{error:{code:'23505'}}:{data:true}});
 await a.ctx.subscribeToPush();assert.equal(a.counters.unsubscribes,1);assert.equal(a.counters.subscribes,1);
 assert.equal(a.calls.length,2);assert.notEqual(a.calls[0].args.p_endpoint,a.calls[1].args.p_endpoint);assert.equal(a.state.pushSubscribed,true);
});
test('disable confirms server removal; a server error keeps a retry available',async()=>{
 const a=app();a.state.pushSubscribed=true;await a.ctx.unsubscribeFromPush();
 assert.equal(a.calls[0].name,'manee_unregister_owner_push');assert.equal(a.counters.unsubscribes,1);assert.equal(a.state.pushSubscribed,false);
 const failed=app({rpc:async()=>({error:{code:'42501'}})});failed.state.pushSubscribed=true;await failed.ctx.unsubscribeFromPush();
 assert.equal(failed.counters.unsubscribes,0);assert.equal(failed.state.pushSubscribed,true);assert.ok(failed.state.pushRegistrationError);
});
test('late registration results cannot change the next signed-in account',async()=>{
 let resolve,entered;const start=new Promise(r=>entered=r);const result=new Promise(r=>resolve=r);
 const a=app({rpc:async()=>{entered();return result;}});const done=a.ctx.refreshPushSubStatus();await start;
 a.changeAccount();resolve({data:true});await done;assert.equal(a.state.pushSubscribed,false);assert.equal(a.state.pushBusy,false);
});
test('a refresh in progress does not overlap a second enable or disable',async()=>{
 let resolve,entered;const start=new Promise(r=>entered=r),result=new Promise(r=>resolve=r);
 const a=app({rpc:async()=>{entered();return result;}});const done=a.ctx.refreshPushSubStatus();await start;
 await a.ctx.subscribeToPush();await a.ctx.unsubscribeFromPush();assert.equal(a.calls.length,1);resolve({data:true});await done;
});
test('a stale application key is not reported as working and is renewed only on explicit enable',async()=>{
 const a=app({keyMismatch:true});await a.ctx.refreshPushSubStatus();assert.equal(a.state.pushSubscribed,false);
 assert.equal(a.calls[0].name,'manee_unregister_owner_push');assert.ok(a.state.pushRegistrationError.includes('갱신'));
 assert.equal(a.counters.prompts,0);assert.equal(a.counters.subscribes,0);assert.equal(a.counters.unsubscribes,0);
 await a.ctx.subscribeToPush();assert.equal(a.state.pushSubscribed,true);assert.equal(a.counters.subscribes,1);assert.equal(a.counters.unsubscribes,1);
 assert.equal(a.calls.at(-1).name,'manee_register_owner_push');
});
test('unavailable server configuration does not discard or recreate a browser subscription',async()=>{
 const a=app({configOk:false});await a.ctx.refreshPushSubStatus();assert.equal(a.state.pushSubscribed,false);assert.equal(a.calls.length,0);
 await a.ctx.subscribeToPush();assert.equal(a.counters.unsubscribes,0);assert.equal(a.counters.subscribes,0);assert.equal(a.calls.length,0);
});
