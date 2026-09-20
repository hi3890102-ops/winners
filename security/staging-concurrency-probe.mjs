#!/usr/bin/env node
// MANUAL, STAGING-ONLY concurrency probe for the new-employee approval flow.
// This is NOT a test: it is not named *.test.mjs, CI never runs it, and it refuses to run unless
// every guard below passes. It talks to the public app API only (publishable key + the QA
// accounts' own sessions): no service key, no SQL, no deletes, no existing-store access.
//
// Prerequisites (created by hand in the app on STAGING, prefix qa0919-):
//   - owner account qa0919-owner with a store named "[QA-0919] ..." (its store id and 8-char join code)
//   - staff account qa0919-new1 (signed up with the new form, personal info filled with fake values)
// Passwords are read from the environment and never printed or stored.
//
//   node security/staging-concurrency-probe.mjs --phase=approve [--dry-run]
//   node security/staging-concurrency-probe.mjs --phase=retry --request-id=<uuid> --crew-id=<uuid> --expect-wage=14000
// Between the two phases the owner sets the wage in the app (the normal "수정 저장" flow).
import {readFileSync} from 'node:fs';
const STAGING_URL='https://obpkzecgswnfuyhwvncd.supabase.co';
const PRODUCTION_URL='https://bhwuuxcrzxespkjlmqxr.supabase.co';
const args=process.argv.slice(2),flag=n=>args.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3),dry=args.includes('--dry-run');
const env=process.env;
function refuse(reason){console.error('REFUSED: '+reason);process.exit(2);}
export function checkConfig(e=env){
  const url=e.MANEE_STAGING_URL||'',key=e.MANEE_STAGING_PUBLISHABLE_KEY||'';
  if(url===PRODUCTION_URL||url.includes('bhwuuxcrzxespkjlmqxr'))refuse('production URL');
  if(url!==STAGING_URL)refuse('MANEE_STAGING_URL must be exactly '+STAGING_URL);
  if(!key.startsWith('sb_publishable_'))refuse('MANEE_STAGING_PUBLISHABLE_KEY must be a publishable key');
  try{
    const prod=JSON.parse(readFileSync(new URL('../config/environments.json',import.meta.url),'utf8')).production.publishableKey;
    if(key===prod)refuse('the production publishable key was supplied');
  }catch{refuse('cannot read config/environments.json to check the key');}
  for(const n of ['QA_OWNER_USERNAME','QA_WORKER_USERNAME'])if(!/^qa0919-[a-z0-9._-]{1,20}$/.test(e[n]||''))refuse(n+' must start with qa0919-');
  if(!/^[0-9a-f-]{36}$/.test(e.QA_STORE_ID||''))refuse('QA_STORE_ID must be a uuid');
  if(!/^[A-HJ-NP-Z2-9]{8}$/.test(e.QA_STORE_CODE||''))refuse('QA_STORE_CODE must be the 8-character store code');
  return {url,key};
}
const {url,key}=checkConfig();
const phase=flag('phase');
if(!['approve','retry'].includes(phase))refuse('--phase=approve|retry is required');
if(dry){console.log('dry-run: configuration accepted for '+STAGING_URL+', phase='+phase+'. No request was sent.');process.exit(0);}
for(const n of ['QA_OWNER_PASSWORD','QA_WORKER_PASSWORD'])if(!env[n])refuse(n+' is required');

async function login(username,password){
  const r=await fetch(url+'/functions/v1/manee-login',{method:'POST',headers:{'Content-Type':'application/json',apikey:key},body:JSON.stringify({username,password})});
  const d=await r.json().catch(()=>null);
  if(!r.ok||!d?.session?.access_token)throw new Error('login failed for '+username+' (status '+r.status+')');
  return d.session.access_token;
}
async function portal(token,action,payload){
  const r=await fetch(url+'/rest/v1/rpc/manee_staff_portal',{method:'POST',headers:{'Content-Type':'application/json',apikey:key,Authorization:'Bearer '+token},body:JSON.stringify({p_action:action,p_payload:payload})});
  const d=await r.json().catch(()=>null);
  if(!r.ok)return {ok:false,http:r.status,error:d?.code||d?.message||'http_error'};
  return d;
}
async function crewRow(token,id){
  const r=await fetch(url+'/rest/v1/crew?id=eq.'+encodeURIComponent(id)+'&select=id,store_id,wage,employment_setup_required,self_service_profile',{headers:{apikey:key,Authorization:'Bearer '+token}});
  const rows=await r.json();return Array.isArray(rows)?rows[0]:null;
}
function check(condition,message){if(!condition){console.error('FAILED: '+message);process.exitCode=1;throw new Error(message);}console.log('ok: '+message);}
const owner=await login(env.QA_OWNER_USERNAME,env.QA_OWNER_PASSWORD);
// Store guard: the owner's membership for QA_STORE_ID must be a QA-named store.
const session=await portal(owner,'session');
const membership=(session.memberships||[]).find(m=>m.store_id===env.QA_STORE_ID);
if(!membership||!String(membership.store_name||'').startsWith('[QA-0919]'))refuse('QA_STORE_ID is not a [QA-0919] store of the QA owner; no request was sent');

if(phase==='approve'){
  const worker=await login(env.QA_WORKER_USERNAME,env.QA_WORKER_PASSWORD);
  const requests=await Promise.all(Array.from({length:6},()=>portal(worker,'request',{code:env.QA_STORE_CODE})));
  check(requests.every(x=>x.ok===true),'6 concurrent join requests all answered ok');
  const ids=new Set(requests.map(x=>x.request_id));check(ids.size===1,'they resolved to exactly one pending request');
  const requestId=[...ids][0];
  const approvals=await Promise.all(Array.from({length:8},()=>portal(owner,'approve_new',{request_id:requestId})));
  check(approvals.every(x=>x.ok===true),'8 concurrent approve_new calls all answered ok');
  check(approvals.filter(x=>x.created_new===true).length===1,'exactly one call created the employee record');
  const crewIds=new Set(approvals.map(x=>x.crew_id));check(crewIds.size===1,'all calls returned the same crew id');
  const crewId=[...crewIds][0],row=await crewRow(owner,crewId);
  check(row&&row.store_id===env.QA_STORE_ID,'the record belongs to the QA store');
  check(row.self_service_profile===true&&row.employment_setup_required===true,'new-cohort flags set once (self_service_profile, employment_setup_required)');
  console.log(JSON.stringify({request_id:requestId,crew_id:crewId,note:'Now set a wage in the app, then run --phase=retry with these ids.'}));
}else{
  const requestId=flag('request-id'),crewId=flag('crew-id'),wage=Number(flag('expect-wage'));
  if(!/^[0-9a-f-]{36}$/.test(requestId||'')||!/^[0-9a-f-]{36}$/.test(crewId||'')||!Number.isInteger(wage)||wage<=0)refuse('--request-id, --crew-id and a positive --expect-wage are required');
  const retries=await Promise.all(Array.from({length:4},()=>portal(owner,'approve_new',{request_id:requestId})));
  check(retries.every(x=>x.ok===true&&x.created_new===false&&x.crew_id===crewId),'4 concurrent retries return the existing record without creating another');
  const row=await crewRow(owner,crewId);
  check(row&&row.wage===wage,'the wage the owner set was not reset');
  check(row.employment_setup_required===false,'setup-required stayed cleared');
}
