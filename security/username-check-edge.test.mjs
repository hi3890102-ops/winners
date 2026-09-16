import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script,createContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../supabase/functions/manee-check-username/index.ts',import.meta.url),'utf8');
const defaults={username:'worker_test'};
function harness(options={}){
  const calls=[];let handler;
  const ok=data=>({data,error:null});
  const admin={
    rpc:async(name,args)=>{calls.push({name,args});
      if(name==='consume_auth_rate_limit')return options.rateError?{error:{code:'offline'}}:ok(options.rateAllowed??true);
      if(name==='is_manee_username_reserved')return options.lookupError?{error:{code:'offline'}}:ok(Object.hasOwn(options,'reserved')?options.reserved:false);
      throw new Error('Unexpected privileged RPC '+name);
    },
  };
  const env={SUPABASE_URL:'https://offline.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-secret',SUPABASE_ANON_KEY:'test-public'};
  const context=createContext({Request,Response,TextEncoder,crypto:webcrypto,console:{error(...args){calls.push({log:args});}},
    createClient:(url,key)=>{assert.equal(key,env.SUPABASE_SERVICE_ROLE_KEY);return admin;},
    Deno:{env:{get:name=>env[name]},serve:fn=>{handler=fn;}}
  });
  const script=source.replace(/^import \{ createClient \} from 'npm:@supabase\/supabase-js@2\.116\.0'\r?\n/,'');
  assert.notEqual(script,source,'Expected an exact dependency version');
  new Script(stripTypeScriptTypes(script)).runInContext(context);
  return {calls,async run(body=defaults){const response=await handler(new Request('https://offline.invalid',{method:'POST',headers:{'Content-Type':'application/json','apikey':options.badKey?'wrong-key':'test-public'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};}};
}
test('Pre-auth check rejects a different application key before any lookup',async()=>{
  const h=harness({badKey:true});assert.equal((await h.run()).status,403);assert.equal(h.calls.length,0);
});
test('Available username reports available without creating or touching any account',async()=>{
  const h=harness();const r=await h.run();
  assert.equal(r.status,200);assert.equal(r.body.available,true);assert.equal(r.cache,'no-store');
  assert.equal(h.calls.some(c=>c.name==='createUser'||c.name==='bootstrap_staff_account'||c.name==='bootstrap_owner_account'),false);
});
test('Taken username (owner or staff) reports unavailable',async()=>{
  const h=harness({reserved:true});const r=await h.run();
  assert.equal(r.status,200);assert.equal(r.body.available,false);
});
test('Username normalization runs before the reservation lookup',async()=>{
  const h=harness();await h.run({username:'  ＷＯＲＫＥＲ＿ＴＥＳＴ  '});
  assert.equal(h.calls.find(c=>c.name==='is_manee_username_reserved').args.p_username,'worker_test');
});
test('Invalid username format is rejected before any RPC',async()=>{
  const h=harness();const r=await h.run({username:'bad%name'});
  assert.equal(r.status,400);assert.equal(h.calls.length,0);
});
test('Unavailable or invalid reservation lookup fails closed',async()=>{
  for(const opts of [{lookupError:true},{reserved:null}]){
    const h=harness(opts);assert.equal((await h.run()).status,503);
  }
});
test('IP rate limit uses its own bucket, separate from signup attempts',async()=>{
  const h=harness({rateAllowed:false});const r=await h.run();
  assert.equal(r.status,429);
  const limitCall=h.calls.find(c=>c.name==='consume_auth_rate_limit');
  assert.equal(limitCall.args.p_action,'username_check_ip');
});
test('Rate limit check failure is fail-closed',async()=>{
  const h=harness({rateError:true});assert.equal((await h.run()).status,500);
});
