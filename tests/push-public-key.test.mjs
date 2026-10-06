import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import crypto from 'node:crypto';
import vm from 'node:vm';
const {getVapidDetails}=createRequire(import.meta.url)('../netlify/functions/lib/push-vapid.cjs');
const code=readFileSync(new URL('../netlify/functions/push-public-key.js',import.meta.url),'utf8');
function endpoint(env,blocked=null){
 const context={exports:{},require(name){
  if(name==='./lib/manee-environment.cjs')return {blockExternalService:()=>blocked};
  if(name==='./lib/push-vapid.cjs')return {getVapidDetails:()=>getVapidDetails(env)};
  throw Error(name);
 }};vm.runInNewContext(code,context);return context.exports.handler;
}
test('public configuration derives the matching key and exposes only the public half',async()=>{
 const pair=crypto.createECDH('prime256v1');pair.generateKeys();
 const env={VAPID_PRIVATE_KEY:pair.getPrivateKey().toString('base64url'),VAPID_PUBLIC_KEY:'stale-public-copy'};
 const r=await endpoint(env)({httpMethod:'GET'});assert.equal(r.statusCode,200);
 assert.deepEqual(JSON.parse(r.body),{publicKey:pair.getPublicKey().toString('base64url')});
 assert.ok(!r.body.includes(env.VAPID_PRIVATE_KEY));assert.equal(r.headers['Cache-Control'],'no-store');
 assert.equal(getVapidDetails(env).privateKey,env.VAPID_PRIVATE_KEY);
});
test('missing/invalid signing keys fail closed without leaking configuration',async()=>{
 for(const env of [{},{VAPID_PRIVATE_KEY:'never-return-this-secret'}]){
  const r=await endpoint(env)({httpMethod:'GET'});assert.equal(r.statusCode,503);
  assert.deepEqual(JSON.parse(r.body),{error:'push_key_unavailable'});
 }
});
test('public key endpoint preserves staging isolation and does not accept writes',async()=>{
 assert.equal((await endpoint({})({httpMethod:'POST'})).statusCode,405);
 assert.equal((await endpoint({},{statusCode:503,body:'staging_external_service_disabled'})({httpMethod:'GET'})).body,'staging_external_service_disabled');
});
