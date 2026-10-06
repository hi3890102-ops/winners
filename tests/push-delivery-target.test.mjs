import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
const code=readFileSync(new URL('../netlify/functions/send-push.js',import.meta.url),'utf8');
const user='00000000-0000-4000-8000-000000000001',store='00000000-0000-4000-8000-000000000101';
const pair=crypto.createECDH('prime256v1');pair.generateKeys();
const environment={VAPID_PUBLIC_KEY:pair.getPublicKey().toString('base64url'),VAPID_PRIVATE_KEY:pair.getPrivateKey().toString('base64url')};
function handler({failure,env=environment}={}){
 const filters=[],sends=[],deleted=[];
 const rows=[{id:23,user_id:user,store_id:store,role:'storeOwner',endpoint:'secret-endpoint',p256dh:'secret-key',auth:'secret-auth'},
 {id:24,user_id:'other-user',store_id:store,role:'storeOwner',endpoint:'other-endpoint'},
 {id:25,user_id:user,store_id:'other-store',role:'storeOwner',endpoint:'third-endpoint'}];
 const db={from:()=>({select(){const q={eq(k,v){filters.push([k,v]);return q;},then(resolve){resolve({data:rows.filter(r=>filters.every(([k,v])=>r[k]===v))});}};return q;},delete:()=>({eq:async(k,v)=>deleted.push([k,v])})})};
 const context={exports:{},process:{env},Buffer,require(name){
  if(name==='./lib/manee-environment.cjs')return {blockExternalService:()=>null};
  if(name==='node:crypto')return crypto;
  if(name==='@supabase/supabase-js')return {createClient:()=>db};
  if(name==='web-push')return {setVapidDetails(){},sendNotification:async(sub,payload)=>{sends.push({sub,payload});if(failure)throw failure;}};
  throw Error(name);
 }};
 vm.runInNewContext(code,context);
 return {call:payload=>context.exports.handler({httpMethod:'POST',body:JSON.stringify({storeId:store,title:'Test',ownerOnly:true,targetUserId:user,targetSubscriptionId:23,expectedVapidPublicKey:environment.VAPID_PUBLIC_KEY,...payload})}),sends,deleted};
}
test('named-account delivery sends to exactly the selected device even when other owners share the store',async()=>{
 const h=handler();const r=await h.call();assert.equal(r.statusCode,200);assert.equal(h.sends.length,1);assert.equal(h.sends[0].sub.endpoint,'secret-endpoint');
 assert.deepEqual(JSON.parse(r.body),{sent:1,total:1,failed:0,failures:[]});
});
test('partial or invalid target filters cannot broaden a named-account test',async()=>{
 for(const payload of [{targetSubscriptionId:null},{targetUserId:null},{targetUserId:null,targetSubscriptionId:0},{targetUserId:null,targetSubscriptionId:null},{ownerOnly:false},{targetSubscriptionId:'23'}]){
  const h=handler();assert.equal((await h.call(payload)).statusCode,400);assert.equal(h.sends.length,0);
 }
});
test('provider rejection returns a bounded reason without any token or response body',async()=>{
 const h=handler({failure:{statusCode:403,body:'VAPID signature invalid secret-endpoint secret-key secret-auth'}});
 const result=JSON.parse((await h.call()).body);assert.equal(result.sent,0);assert.equal(result.total,1);assert.equal(result.failures[0].reason,'push_authentication_rejected');
 assert.ok(!JSON.stringify(result).includes('secret'));assert.equal(h.deleted.length,0);
});
test('expired device is removed only by its exact subscription id',async()=>{
 const h=handler({failure:{statusCode:410}});const result=JSON.parse((await h.call()).body);
 assert.equal(result.failures[0].reason,'subscription_expired');assert.deepEqual(h.deleted,[['id',23]]);
});
test('client key or server key-pair mismatches fail before any push is attempted',async()=>{
 const a=handler();assert.equal(JSON.parse((await a.call({expectedVapidPublicKey:'different'})).body).error,'vapid_client_key_mismatch');assert.equal(a.sends.length,0);
 const other=crypto.createECDH('prime256v1');other.generateKeys();
 const b=handler({env:{...environment,VAPID_PRIVATE_KEY:other.getPrivateKey().toString('base64url')}});
 assert.equal(JSON.parse((await b.call()).body).error,'vapid_key_pair_mismatch');assert.equal(b.sends.length,0);
});
