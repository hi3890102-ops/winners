import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {Script,createContext} from 'node:vm';
const source=readFileSync(new URL('./edge-rollback/manee-staff-signup-v1-compat.ts',import.meta.url),'utf8').replace(/\r/g,'');
// sha256 of supabase/functions/manee-staff-signup/index.ts at main 2e4e162
// (the same value CHANGE_MANIFEST.json records as original_sha256; identical to deployed staging v1).
const V1_SHA256='caa30ef921a91b7c48821684059e6a88e2eaa0c07c151070a186b9be34df16c0';
const personal={phone:'010-0000-0000',bank_name:'테스트은행',bank_account:'000-123-4567',account_holder:'Synthetic Worker'};
const defaults={username:'worker_test',display_name:'Synthetic Worker',password:'synthetic-test-password'};
function harness(){
  const calls=[];let handler;const ok=data=>({data,error:null});
  const admin={
    rpc:async(name,args)=>{calls.push({name,args});
      if(name==='consume_auth_rate_limit')return ok(true);
      if(name==='is_manee_username_reserved')return ok(false);
      if(name==='bootstrap_staff_account')return ok('created-user');
      throw new Error('Unexpected privileged RPC '+name);},
    from(){throw new Error('Unexpected table access');},
    auth:{admin:{async createUser(args){calls.push({name:'createUser',args});return ok({user:{id:'created-user'}});},async deleteUser(id){calls.push({name:'deleteUser',id});return ok({});}}}
  };
  const client={auth:{async signInWithPassword(){return ok({session:null});}}};
  const env={SUPABASE_URL:'https://offline.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-secret',SUPABASE_ANON_KEY:'test-public'};
  const context=createContext({Request,Response,TextEncoder,crypto:webcrypto,console:{error(){}},
    createClient:(url,key)=>key===env.SUPABASE_SERVICE_ROLE_KEY?admin:client,
    Deno:{env:{get:name=>env[name]},serve:fn=>{handler=fn;}}});
  const script=source.replace(/^import \{ createClient \} from 'npm:@supabase\/supabase-js@2\.116\.0'\n/m,'');
  assert.notEqual(script,source,'Expected an exact dependency version');
  new Script(stripTypeScriptTypes(script)).runInContext(context);
  return {calls,async run(body){
    const response=await handler(new Request('https://offline.invalid',{method:'POST',headers:{'Content-Type':'application/json',apikey:'test-public'},body:JSON.stringify(body)}));
    return {status:response.status,body:await response.json()};
  }};
}
test('Compat file is the original v1 plus exactly one guard block and a header',()=>{
  const withoutHeader=source.replace(/^(\/\/[^\n]*\n)+/,'');
  const guard=/    \/\/ ROLLBACK GUARD[\s\S]*?\n    \}\n/;
  assert.equal(source.match(new RegExp(guard,'g')).length,1);
  assert.equal(createHash('sha256').update(withoutHeader.replace(guard,'')).digest('hex'),V1_SHA256);
});
test('A stale new-form request is refused loudly before any rate-limit use or account creation',async()=>{
  const h=harness();const r=await h.run({...defaults,personal});
  assert.equal(r.status,426);assert.equal(r.body.error,'app_update_required');
  assert.match(r.body.message,/새로고침/);assert.match(r.body.message,/저장되지 않았어요/);
  assert.deepEqual(h.calls,[],'no RPC, no createUser, no cleanup');
  assert.equal(JSON.stringify(r.body).includes(personal.bank_account),false);
});
test('The guard also fires for a bare probe so deployment can be smoke-tested without side effects',async()=>{
  const h=harness();const r=await h.run({personal:{}});
  assert.equal(r.status,426);assert.equal(r.body.error,'app_update_required');assert.deepEqual(h.calls,[]);
});
test('An old-form request (no personal) still signs up through the original v1 path',async()=>{
  const h=harness();const r=await h.run(defaults);
  assert.equal(r.status,201);
  assert.ok(h.calls.some(c=>c.name==='bootstrap_staff_account'));
  assert.equal(h.calls.some(c=>c.name==='bootstrap_staff_account_with_profile'),false);
});
