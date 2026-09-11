import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Script,createContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../supabase/functions/manee-staff-signup/index.ts',import.meta.url),'utf8');
const defaults={username:'worker_test',display_name:'Synthetic Worker',password:'synthetic-test-password'};
function harness(options={}){
  const calls=[];let handler;
  const ok=data=>({data,error:null});
  const admin={
    rpc:async(name,args)=>{calls.push({name,args});
      if(name==='consume_auth_rate_limit')return options.rateError?{error:{code:'offline'}}:ok(options.rateAllowed??true);
      if(name==='is_manee_username_reserved')return options.lookupError?{error:{code:'offline'}}:ok(Object.hasOwn(options,'reserved')?options.reserved:false);
      if(name==='bootstrap_staff_account')return options.bootstrapError?{error:options.bootstrapError}:ok('created-user');
      throw new Error('Unexpected privileged RPC '+name);
    },
    from(table){assert.equal(table,'profiles');const q={select(){return q;},eq(){return q;},async maybeSingle(){return options.recoveryError?{error:{code:'offline'}}:ok(options.recoveredProfile||null);}};return q;},
    auth:{admin:{
      async createUser(args){calls.push({name:'createUser',args});return options.createError?{error:{code:'offline'}}:ok({user:{id:'created-user'}});},
      async deleteUser(id){calls.push({name:'deleteUser',id});return options.cleanupError?{error:{code:'offline'}}:ok({});}
    }}
  };
  const client={auth:{async signInWithPassword(args){calls.push({name:'signInWithPassword',args});return ok({session:options.session||null});}}};
  const env={SUPABASE_URL:'https://offline.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-secret',SUPABASE_ANON_KEY:'test-public'};
  const context=createContext({Request,Response,TextEncoder,crypto:webcrypto,console:{error(...args){calls.push({log:args});}},
    createClient:(url,key)=>key===env.SUPABASE_SERVICE_ROLE_KEY?admin:client,
    Deno:{env:{get:name=>env[name]},serve:fn=>{handler=fn;}}
  });
  const script=source.replace(/^import \{ createClient \} from 'npm:@supabase\/supabase-js@2\.116\.0'\r?\n/,'');
  assert.notEqual(script,source,'Expected an exact dependency version');
  new Script(stripTypeScriptTypes(script)).runInContext(context);
  return {calls,async run(body=defaults){const response=await handler(new Request('https://offline.invalid',{method:'POST',headers:{'Content-Type':'application/json','apikey':options.badKey?'wrong-key':'test-public'},body:JSON.stringify(body)}));return {status:response.status,body:await response.json(),cache:response.headers.get('cache-control')};}};
}
test('Employee signup never calls owner bootstrap or returns an owner store',async()=>{
  const h=harness();const r=await h.run({...defaults,role:'owner',store_name:'Injected store',user_id:'injected'});
  assert.equal(r.status,201);assert.equal(Object.hasOwn(r.body,'store'),false);assert.equal(r.cache,'no-store');
  const bootstrap=h.calls.find(c=>c.name==='bootstrap_staff_account');assert.equal(bootstrap.args.p_user_id,'created-user');assert.equal(Object.hasOwn(bootstrap.args,'p_store_name'),false);
  assert.equal(h.calls.some(c=>c.name==='bootstrap_owner_account'),false);assert.equal(JSON.stringify(r.body).includes(defaults.password),false);
});
test('Pre-auth signup rejects a different application key before privileged work',async()=>{
  const h=harness({badKey:true});assert.equal((await h.run()).status,403);assert.equal(h.calls.length,0);
});
test('Username normalization runs before reservation and profile bootstrap',async()=>{
  const h=harness();await h.run({...defaults,username:'  ＷＯＲＫＥＲ＿ＴＥＳＴ  '});
  assert.equal(h.calls.find(c=>c.name==='is_manee_username_reserved').args.p_username,'worker_test');
  assert.equal(h.calls.find(c=>c.name==='bootstrap_staff_account').args.p_username,'worker_test');
});
for(const [name,options,expected] of [
  ['reserved owner/staff username',{reserved:true},409],
  ['unavailable reservation lookup',{lookupError:true},503],
  ['invalid reservation result',{reserved:null},503],
  ['rate limit exceeded',{rateAllowed:false},429],
  ['rate limit unavailable',{rateError:true},500]
])test(name+' creates no Auth account',async()=>{const h=harness(options);assert.equal((await h.run()).status,expected);assert.equal(h.calls.some(c=>c.name==='createUser'),false);});
test('Bootstrap failure cleans up only the newly created Auth identity',async()=>{
  const h=harness({bootstrapError:{code:'23505'}});assert.equal((await h.run()).status,409);
  assert.deepEqual(h.calls.filter(c=>c.name==='deleteUser').map(c=>c.id),['created-user']);
});
test('Uncertain committed bootstrap or failed recovery lookup never deletes the identity',async()=>{
  for(const opts of [{recoveredProfile:{user_id:'created-user',username:'worker_test'}},{recoveryError:true}]){
    const h=harness({bootstrapError:{code:'timeout'},...opts});assert.equal((await h.run()).status,503);assert.equal(h.calls.some(c=>c.name==='deleteUser'),false);
  }
});
test('Cleanup failure is surfaced without returning secrets or a success response',async()=>{
  const h=harness({bootstrapError:{code:'offline'},cleanupError:true});const r=await h.run();assert.equal(r.status,503);assert.equal(r.body.error,'signup_cleanup_failed');
  assert.equal(JSON.stringify(h.calls.filter(c=>c.log)).includes(defaults.password),false);
});
test('Invalid names, passwords and usernames are rejected before Auth creation',async()=>{
  for(const values of [{display_name:''},{display_name:'<script>'},{password:'1234'},{password:'x'.repeat(73)},{username:'bad%name'}]){
    const h=harness();assert.equal((await h.run({...defaults,...values})).status,400);assert.equal(h.calls.some(c=>c.name==='createUser'),false);
  }
});
