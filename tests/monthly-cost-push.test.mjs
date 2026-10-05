import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{notificationFor,sendClaimedReminders}=require('../netlify/functions/lib/monthly-cost-reminders.cjs');
const target={store_id:'00000000-0000-4000-8000-000000000101',name:'매장',subscription_id:1,month_key:'2026-09',send_date:'2026-10-05',endpoint:'https://push.example.test',p256dh:'fake',auth:'fake'};
test('notification opens the intended month/store without implying recorded expenses are absent',()=>{
 const n=notificationFor(target),u=new URL(n.url,'https://manee.example');assert.equal(u.searchParams.get('month'),'2026-09');assert.equal(u.searchParams.get('store'),target.store_id);assert.ok(n.body.includes('다시 입력하지 않아도'));assert.throws(()=>notificationFor({...target,month_key:'2026-99'}));
});
test('push delivery records success and invalid endpoints without printing subscription secrets',async()=>{
 const finishes=[];const db={rpc:async(name,args)=>name==='manee_claim_cost_reminders'?{data:[target,{...target,subscription_id:2,endpoint:'https://push.example.test/expired'}]}:(finishes.push(args),{})};
 const push={sendNotification:async(s)=>{if(s.endpoint.endsWith('/expired'))throw {statusCode:410};}};
 assert.deepEqual(await sendClaimedReminders(db,push),{sent:1,failed:0,expired:1});assert.deepEqual(finishes.map(f=>f.p_status).sort(),['expired','sent']);
});
test('a claim failure prevents all sends',async()=>{let sends=0;await assert.rejects(()=>sendClaimedReminders({rpc:async()=>({error:true})},{sendNotification:async()=>sends++}));assert.equal(sends,0);});
test('notification click navigates an existing same-origin window and rejects external destinations',async()=>{
 const listeners={},navigations=[];const client={focus:async()=>{},url:'https://manee.example/',navigate:async url=>{navigations.push(url);return {focus:async()=>{}};}};
 const self={location:{origin:'https://manee.example'},addEventListener:(name,fn)=>listeners[name]=fn,clients:{matchAll:async()=>[client],openWindow:async()=>{throw Error('unexpected');}}};
 vm.runInNewContext(fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8'),{self,URL});
 for(const url of [notificationFor(target).url,'https://evil.example/']){let done;listeners.notificationclick({notification:{close(){},data:{url}},waitUntil:p=>done=p});await done;}
 assert.ok(navigations[0].includes('view=monthly-costs'));assert.equal(navigations[1],'https://manee.example/');
});
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const fn=n=>html.match(new RegExp('^  (?:async )?function '+n+'\\([^\\n]*\\n[\\s\\S]*?^  }','m'))[0];
test('push route waits for login and rejects an unrelated store before any load',()=>{
 let calls=0;const state={role:'landing',myStores:['mine'],storeIdMap:{mine:target.store_id}},ctx=vm.createContext({state,URLSearchParams,window:{location:{search:'?view=monthly-costs&store=wrong&month=2026-09'}},showToast(){},loadAllForStore(){calls++;}});
 vm.runInContext('let monthlyCostRouteHandled=false;'+fn('tryMonthlyCostRoute'),ctx);assert.equal(ctx.tryMonthlyCostRoute(),false);state.role='storeOwner';assert.equal(ctx.tryMonthlyCostRoute(),false);assert.equal(calls,0);
});
