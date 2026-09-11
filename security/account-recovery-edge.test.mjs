import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script,createContext} from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';

const source=readFileSync(new URL('../supabase/functions/manee-account-recovery/index.ts',import.meta.url),'utf8');
const token='test.'+Buffer.from(JSON.stringify({session_id:'verified-session'})).toString('base64url')+'.test';
function harness(options={}){
  const calls=[];let handler;
  const ok=data=>({data,error:null});
  const admin={
    rpc:async(name,args)=>{calls.push({name,args});
      if(name==='consume_auth_rate_limit')return options.rateError?{error:{code:'offline'}}:ok(options.rateAllowed??true);
      assert.equal(name,'manee_support_recovery_service');
      const action=args.p_action;
      if(options.rpcError===action)throw new Error('offline');
      if(action==='request')return ok({ok:true});
      if(action==='credentials')return ok(options.deadSession?{ok:false}:{ok:true,user_id:'verified-user',username:'worker_a',email:'synthetic@auth.manee.local'});
      if(action==='issue'||action==='reject')return ok(options.denied?{ok:false,error:'permission_denied'}:{ok:true});
      if(action==='consume')return ok(options.invalidCode?{ok:false}:{ok:true,user_id:'verified-user',request_id:'reset-request',operation_id:'operation'});
      if(action==='complete'||action==='uncertain')return ok({ok:!options.completeError});
      throw new Error('unexpected action');
    },
    auth:{getUser:async supplied=>{calls.push({name:'getUser',token:supplied});return options.invalidJwt?{data:{},error:{code:'invalid'}}:ok({user:{id:'verified-user'}});},admin:{
      updateUserById:async(id,args)=>{calls.push({name:'updateUserById',id,args});if(options.updateThrow)throw new Error('lost response');return options.updateError?{error:{code:'offline'}}:ok({user:{id}});}
    }}
  };
  const client={auth:{
    signInWithPassword:async args=>{calls.push({name:'signInWithPassword',args});return options.wrongPassword?{data:{},error:{code:'wrong'}}:ok({user:{id:'verified-user'},session:{access_token:token}});},
    signOut:async args=>{calls.push({name:'signOut',args});return ok({});}
  }};
  const env={SUPABASE_URL:options.production?'https://bhwuuxcrzxespkjlmqxr.supabase.co':'https://obpkzecgswnfuyhwvncd.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-secret',SUPABASE_ANON_KEY:'test-public'};
  const ctx=createContext({Request,Response,TextEncoder,crypto:webcrypto,atob,createClient:(url,key)=>key==='test-secret'?admin:client,
    Deno:{env:{get:n=>env[n]},serve:fn=>handler=fn}});
  new Script(stripTypeScriptTypes(source.replace(/^import .*\n/,''))).runInContext(ctx);
  return {calls,async run(body,authorized=false){
    const headers={'Content-Type':'application/json',apikey:options.badKey?'wrong-key':'test-public'};
    if(authorized)headers.authorization='Bearer '+token;
    const r=await handler(new Request('https://offline.invalid',{method:'POST',headers,body:JSON.stringify(body)}));
    return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
  }};
}

test('Support recovery is staging-only and rejects a wrong application key before service calls',async()=>{
  for(const options of [{production:true},{badKey:true}]){const h=harness(options);assert.ok((await h.run({action:'request'})).status>=400);assert.equal(h.calls.length,0);}
});
test('A recovery request has a uniform response and sends no password or Auth identity',async()=>{
  const h=harness();const r=await h.run({action:'request',username:'  ＷＯＲＫＥＲ＿Ａ ',affiliation:'Synthetic A',user_id:'victim'});
  assert.equal(r.status,200);assert.equal(r.cache,'no-store');
  const call=h.calls.find(c=>c.args?.p_action==='request');
  assert.equal(JSON.stringify(call.args.p_payload),JSON.stringify({username:'worker_a',affiliation:'Synthetic A'}));
  assert.equal(r.body.ok,true);assert.equal(r.body.user_id,undefined);
});
test('Only a verified signed-in reviewer can issue or reject a request',async()=>{
  const absent=harness();assert.equal((await absent.run({action:'issue_code',request_id:'00000000-0000-4000-8000-000000000001'})).status,401);
  const invalid=harness({invalidJwt:true});assert.equal((await invalid.run({action:'reject',request_id:'00000000-0000-4000-8000-000000000001'},true)).status,401);
  const denied=harness({denied:true});assert.equal((await denied.run({action:'issue_code',request_id:'00000000-0000-4000-8000-000000000001'},true)).status,403);
});
test('The reviewer receives one 6-digit code while the database receives only its hash',async()=>{
  const h=harness();const r=await h.run({action:'issue_code',request_id:'00000000-0000-4000-8000-000000000001'},true);
  assert.equal(r.status,200);assert.match(r.body.reset_code,/^\d{6}$/);assert.equal(r.body.expires_in_minutes,15);
  const stored=h.calls.find(c=>c.args?.p_action==='issue').args.p_payload;
  assert.equal(stored.actor_user_id,'verified-user');assert.equal(stored.session_id,'verified-session');
  assert.equal(stored.code_hash,createHash('sha256').update(r.body.reset_code).digest('hex'));
  assert.equal(JSON.stringify(stored).includes(r.body.reset_code),false);
});
test('Reset consumes the hashed code before updating only the resolved Auth identity',async()=>{
  const h=harness();const payload={action:'reset',username:'worker_a',reset_code:'123456',new_password:'synthetic-new-password',user_id:'victim'};
  const r=await h.run(payload);assert.equal(r.status,200);assert.deepEqual(r.body,{ok:true});
  const consume=h.calls.find(c=>c.args?.p_action==='consume');
  assert.equal(consume.args.p_payload.code_hash,createHash('sha256').update('123456').digest('hex'));
  const update=h.calls.find(c=>c.name==='updateUserById');assert.equal(update.id,'verified-user');assert.deepEqual(Object.keys(update.args),['password']);
  assert.ok(h.calls.indexOf(consume)<h.calls.indexOf(update));
});
test('Invalid proof and rate limits prevent password changes',async()=>{
  const payload={action:'reset',username:'worker_a',reset_code:'123456',new_password:'synthetic-new-password'};
  for(const options of [{invalidCode:true},{rateAllowed:false},{rateError:true}]){const h=harness(options);assert.ok((await h.run(payload)).status>=400);assert.equal(h.calls.some(c=>c.name==='updateUserById'),false);}
  const malformed=harness();assert.equal((await malformed.run({...payload,reset_code:'123'})).status,400);assert.equal(malformed.calls.some(c=>c.args?.p_action==='consume'),false);
});
test('A signed-in user can change their own password only after reauthentication',async()=>{
  const payload={action:'change_password',current_password:'old-password',new_password:'synthetic-new-password'};
  const wrong=harness({wrongPassword:true});assert.equal((await wrong.run(payload,true)).status,400);assert.equal(wrong.calls.some(c=>c.name==='updateUserById'),false);
  const h=harness();const r=await h.run(payload,true);assert.equal(r.status,200);
  assert.equal(h.calls.find(c=>c.name==='updateUserById').id,'verified-user');assert.equal(h.calls.some(c=>c.name==='signOut'),true);
});
test('Ambiguous Auth update returns uncertainty without returning a session or code',async()=>{
  const payload={action:'reset',username:'worker_a',reset_code:'123456',new_password:'synthetic-new-password'};
  for(const options of [{updateThrow:true},{updateError:true},{completeError:true},{rpcError:'complete'}]){
    const h=harness(options);const r=await h.run(payload);assert.equal(r.status,503);assert.equal(r.body.error,'recovery_uncertain');
    assert.equal(r.body.session,undefined);assert.equal(r.body.reset_code,undefined);
  }
});
