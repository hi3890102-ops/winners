import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script,createContext} from 'node:vm';
import {webcrypto,createHash} from 'node:crypto';
const source=readFileSync(new URL('../supabase/functions/manee-account-recovery/index.ts',import.meta.url),'utf8');
const token='test.'+Buffer.from(JSON.stringify({session_id:'verified-session'})).toString('base64url')+'.test';
const oldKey='0123456789abcdef0123456789abcdef';
const reset={action:'reset',username:'worker_a',recovery_key:oldKey,new_password:'synthetic-new-password'};
function harness(options={}){
  const calls=[];let handler;
  const ok=data=>({data,error:null});
  const admin={
    rpc:async(name,args)=>{calls.push({name,args});
      if(name==='consume_auth_rate_limit')return options.rateError?{error:{code:'offline'}}:ok(options.rateAllowed??true);
      assert.equal(name,'manee_recovery_service');
      const action=args.p_action;
      if(options.rpcError===action)throw new Error('offline');
      if(action==='credentials')return ok(options.deadSession?{ok:false}:{ok:true,user_id:'verified-user',username:'worker_a',email:'synthetic@auth.manee.local'});
      if(action==='issue')return ok({ok:!options.inProgress});
      if(action==='consume')return ok(options.invalidKey?{ok:false}:{ok:true,user_id:'verified-user',operation_id:'operation'});
      if(['complete','uncertain'].includes(action))return ok({ok:!options.completeError});
      throw new Error('unexpected action');
    },
    auth:{getUser:async supplied=>{calls.push({name:'getUser',token:supplied});return options.invalidJwt?{data:{},error:{code:'invalid'}}:ok({user:{id:'verified-user'}});},admin:{
      updateUserById:async(id,args)=>{calls.push({name:'updateUserById',id,args});if(options.updateThrow)throw new Error('lost response');return options.updateError?{error:{code:'offline'}}:ok({user:{id}});}
    }}
  };
  const client={auth:{
    signInWithPassword:async args=>{calls.push({name:'signInWithPassword',args});return options.wrongPassword?{data:{},error:{code:'wrong'}}:ok({user:{id:'verified-user'},session:{access_token:token}});},
    signOut:async args=>{calls.push({name:'signOut',args});return options.cleanupError?{error:{code:'offline'}}:ok({});}
  }};
  const env={SUPABASE_URL:options.production?'https://bhwuuxcrzxespkjlmqxr.supabase.co':'https://obpkzecgswnfuyhwvncd.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-secret',SUPABASE_ANON_KEY:'test-public'};
  const ctx=createContext({Request,Response,TextEncoder,crypto:webcrypto,atob,createClient:(url,key)=>key==='test-secret'?admin:client,
    Deno:{env:{get:n=>env[n]},serve:fn=>handler=fn}});
  new Script(stripTypeScriptTypes(source.replace(/^import .*\n/,''))).runInContext(ctx);
  return {calls,async run(body=reset,authorized=true){
    const headers={'Content-Type':'application/json',apikey:options.badKey?'wrong-key':'test-public'};
    if(authorized)headers.authorization='Bearer '+token;
    const r=await handler(new Request('https://offline.invalid',{method:'POST',headers,body:JSON.stringify(body)}));
    return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};
  }};
}
test('Recovery is staging-only and rejects a wrong application key before service calls',async()=>{
  for(const options of [{production:true},{badKey:true}]){const h=harness(options);assert.ok((await h.run()).status>=400);assert.equal(h.calls.length,0);}
});
test('Key issue requires a verified live session and current password',async()=>{
  for(const options of [{invalidJwt:true},{deadSession:true},{wrongPassword:true}]){
    const h=harness(options);assert.ok((await h.run({action:'issue',current_password:'old-password'})).status>=400);
    assert.equal(h.calls.some(c=>c.args?.p_action==='issue'),false);
  }
  const h=harness();assert.equal((await h.run({action:'issue'},false)).status,401);
});
test('Key issue generates 128 random bits, stores only a SHA256 hash and cleans up reauthentication',async()=>{
  const h=harness();const r=await h.run({action:'issue',current_password:'old-password',user_id:'victim'});
  assert.equal(r.status,200);assert.equal(r.cache,'no-store');assert.match(r.body.recovery_key,/^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/);
  const stored=h.calls.find(c=>c.args?.p_action==='issue').args.p_payload;
  assert.equal(stored.user_id,'verified-user');
  assert.equal(stored.key_hash,createHash('sha256').update(r.body.recovery_key.replaceAll('-','').toLowerCase()).digest('hex'));
  assert.equal(JSON.stringify(stored).includes(r.body.recovery_key),false);
  assert.equal(h.calls.filter(c=>c.name==='signOut').length,1);
  assert.equal(h.calls.find(c=>c.name==='signOut').args.scope,'local');
  assert.equal(Object.keys(r.body).sort().join(','),'ok,recovery_key');
});
test('Key service failure still removes the temporary reauthentication session',async()=>{
  for(const opts of [{rpcError:'issue'},{cleanupError:true},{inProgress:true}]){
    const h=harness(opts);const r=await h.run({action:'issue',current_password:'old-password'});
    assert.ok(r.status>=400);assert.equal(h.calls.some(c=>c.name==='signOut'),true);assert.equal(r.body.recovery_key,undefined);
  }
});
test('Reset consumes one hashed key before updating only the server-resolved Auth identity',async()=>{
  const h=harness();const r=await h.run({...reset,username:'  ＷＯＲＫＥＲ＿Ａ ',user_id:'victim',role:'owner'},false);
  assert.equal(r.status,200);assert.deepEqual(r.body,{ok:true});
  const consume=h.calls.find(c=>c.args?.p_action==='consume');
  assert.equal(consume.args.p_payload.username,'worker_a');assert.equal(consume.args.p_payload.key_hash,createHash('sha256').update(oldKey).digest('hex'));
  const update=h.calls.find(c=>c.name==='updateUserById');assert.equal(update.id,'verified-user');assert.deepEqual(Object.keys(update.args),['password']);
  assert.ok(h.calls.indexOf(consume)<h.calls.indexOf(update));assert.equal(h.calls.some(c=>c.name==='signInWithPassword'),false);
});
test('Invalid or previously used recovery proof cannot reach Auth password update',async()=>{
  const h=harness({invalidKey:true});assert.equal((await h.run()).status,400);assert.equal(h.calls.some(c=>c.name==='updateUserById'),false);
  const malformed=harness();assert.equal((await malformed.run({...reset,recovery_key:'123456'})).status,400);assert.equal(malformed.calls.some(c=>c.args?.p_action==='consume'),false);
});
test('Rate limit failures stop privileged recovery and invalid guesses still count',async()=>{
  for(const options of [{rateAllowed:false},{rateError:true}]){const h=harness(options);assert.ok((await h.run()).status>=400);assert.equal(h.calls.some(c=>c.args?.p_action==='consume'),false);}
  const h=harness();await h.run({...reset,recovery_key:'wrong'});assert.equal(h.calls.filter(c=>c.name==='consume_auth_rate_limit').length,2);
});
test('Lost Auth response and incomplete audit return uncertainty without restoring a key or returning a session',async()=>{
  for(const options of [{updateThrow:true},{updateError:true},{completeError:true},{rpcError:'complete'}]){
    const h=harness(options);const r=await h.run();assert.equal(r.status,503);assert.equal(r.body.error,'recovery_uncertain');
    assert.equal(h.calls.some(c=>c.args?.p_action==='issue'),false);assert.equal(r.body.session,undefined);
    assert.equal(JSON.stringify(r.body).includes(reset.new_password),false);
  }
});
test('Invalid UTF8 password length is rejected before consuming recovery proof',async()=>{
  for(const pw of ['short','a'.repeat(73),'한'.repeat(25)]){const h=harness();assert.equal((await h.run({...reset,new_password:pw})).status,400);assert.equal(h.calls.some(c=>c.args?.p_action==='consume'),false);}
});
