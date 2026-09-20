import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
// V6-1 (GPT v6 review): an explicit sign-in of B must win over a token refresh of the previous account A that finishes while B's session
// is being applied. Runs the REAL @supabase/supabase-js client with the REAL storage adapter and the REAL applyManeeAuthSession from
// index.html; only the network is a local fake fetch (no real server, no real account). Also covers login failure, keep checked/unchecked,
// and that the earlier superseded-tab / repeated-cleanup fixes still hold when the SDK is in the loop.
const sdkVersion=JSON.parse(fs.readFileSync(new URL('../node_modules/@supabase/supabase-js/package.json',import.meta.url),'utf8')).version;
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const block=html.match(/  const MANEE_REMEMBER_KEY[\s\S]*?const db = /)[0].replace(/const db = $/,'');
const start=html.indexOf('  async function applyManeeAuthSession(');
const applyFn=html.slice(start,html.indexOf('\n  }\n',start)+5);
const KEY='sb-example-auth-token';
const area=()=>{const m=new Map();return {m,getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};};
const b64u=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt=id=>[b64u({alg:'HS256',typ:'JWT'}),b64u({sub:id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'}),'c3ludGhldGlj'].join('.');
const makeUser=id=>({id,aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'});
const makeSession=(id,tag='')=>({access_token:jwt(id),refresh_token:'synthetic-refresh-'+id+tag,token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:makeUser(id)});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const idOf=auth=>JSON.parse(Buffer.from(auth.split(' ')[1].split('.')[1],'base64url')).sub;

// one browser = one localStorage; each tab has its own sessionStorage, its own adapter state and its own SDK client
function browser(){
  const local=area();
  function tab({refreshGate,userGate={},rejectUser}={}){
    const session=area();
    const ctx=vm.createContext({window:{localStorage:local,sessionStorage:session},localStorage:local,MANEE_LOCAL_PREFIX:'',MANEE_IS_STAGING:false,MANEE_CONFIG:{projectRef:'example'}});
    vm.runInContext(block+';this.api={storage:maneeAuthStorage,choose:maneeSetRememberLogin,active:maneeActiveUser};',ctx);
    const gates={refreshStarted:deferred(),...userGate};
    const fetchImpl=async(input,init={})=>{
      const url=new URL(String(input));
      if(url.pathname.endsWith('/token')){gates.refreshStarted.resolve();if(refreshGate)await refreshGate.promise;
        const rt=JSON.parse(init.body).refresh_token;const id=rt.replace('synthetic-refresh-','').replace('-rotated','').split('-')[0];
        return new Response(JSON.stringify(makeSession(id,'-rotated')),{status:200,headers:{'content-type':'application/json'}});}
      if(url.pathname.endsWith('/user')){
        const id=idOf(new Headers(init.headers).get('authorization'));
        if(rejectUser&&rejectUser===id)return new Response(JSON.stringify({message:'invalid'}),{status:401,headers:{'content-type':'application/json'}});
        if(gates[id]){gates[id].started.resolve();await gates[id].release.promise;}
        return new Response(JSON.stringify(makeUser(id)),{status:200,headers:{'content-type':'application/json'}});}
      throw new Error('unexpected endpoint '+url.pathname);
    };
    const db=createClient('https://example.supabase.co','synthetic-public-key',{global:{fetch:fetchImpl},auth:{storage:ctx.api.storage,storageKey:KEY,autoRefreshToken:false,detectSessionInUrl:false,persistSession:true}});
    ctx.db=db;vm.runInContext(applyFn,ctx);
    return {ctx,db,session,gates,api:ctx.api,apply:s=>ctx.applyManeeAuthSession(s),login:(s,keep)=>{ctx.api.choose(keep);return ctx.applyManeeAuthSession(s);}};
  }
  return {local,tab};
}
const stored=b=>{const v=b.local.m.get(KEY);return v?JSON.parse(v).user.id:null;};
const storedAnywhere=t=>{const v=t.session.m.get(KEY);return v?JSON.parse(v).user.id:null;};
const accountOf=async t=>(await t.db.auth.getSession()).data.session?.user?.id??null;

for(const [keepA,keepB] of [[true,true],[true,false],[false,true],[false,false]]){
  test('V6-1 (SDK '+sdkVersion+', A keep='+keepA+', B keep='+keepB+'): A\'s refresh finishing while B\'s session is being applied does not win — B is stored, active and returned by getSession',async()=>{
    const refreshGate=deferred(),bUser={started:deferred(),release:deferred()};
    const b=browser(),t=b.tab({refreshGate,userGate:{B:bUser}});
    await t.db.auth.initialize();await t.login(makeSession('A'),keepA);
    assert.equal(t.api.active(),'A');
    const refresh=t.db.auth.refreshSession();await t.gates.refreshStarted.promise;         // A's refresh is in flight
    const switchToB=t.login(makeSession('B'),keepB);await bUser.started.promise;             // B's session is being validated
    refreshGate.resolve();await refresh;                                                       // A's refresh finishes FIRST
    bUser.release.resolve();await switchToB;                                                   // then B's application finishes (must not throw)
    assert.equal(t.api.active(),'B','active marker');
    assert.equal(await accountOf(t),'B','what the SDK returns');
    const where=keepB?stored(b):storedAnywhere(t);
    assert.equal(where,'B','stored session');
    if(!keepB)assert.equal(stored(b),null,'a keep-unchecked login is not copied to localStorage');
    await t.db.auth.stopAutoRefresh();
  });
}
test('V6-1 control: A\'s refresh finishes before B\'s login starts -> B (unchanged behaviour)',async()=>{
  const refreshGate=deferred(),b=browser(),t=b.tab({refreshGate});
  await t.db.auth.initialize();await t.login(makeSession('A'),true);
  const refresh=t.db.auth.refreshSession();await t.gates.refreshStarted.promise;refreshGate.resolve();await refresh;
  await t.login(makeSession('B'),true);
  assert.equal(stored(b),'B');assert.equal(t.api.active(),'B');assert.equal(await accountOf(t),'B');
});
test('V6-1 reverse: B is applied first, A\'s refresh answer arrives afterwards — the late A refresh cannot overwrite B',async()=>{
  const refreshGate=deferred(),b=browser(),t=b.tab({refreshGate});
  await t.db.auth.initialize();await t.login(makeSession('A'),true);
  const refresh=t.db.auth.refreshSession();await t.gates.refreshStarted.promise;
  await t.login(makeSession('B'),true);                                                        // B fully applied while A's refresh is still pending
  refreshGate.resolve();await refresh;
  assert.equal(stored(b),'B');assert.equal(t.api.active(),'B');assert.equal(await accountOf(t),'B');
});
test('V6-1: the permission belongs to the target account — the previous account\'s refresh neither uses nor consumes it',async()=>{
  const refreshGate=deferred(),bUser={started:deferred(),release:deferred()};
  const b=browser(),t=b.tab({refreshGate,userGate:{B:bUser}});
  await t.db.auth.initialize();await t.login(makeSession('A'),true);
  const refresh=t.db.auth.refreshSession();await t.gates.refreshStarted.promise;
  const switchToB=t.login(makeSession('B'),true);await bUser.started.promise;
  refreshGate.resolve();await refresh;
  // A's write happened while B's sign-in was armed: it must have been treated as a plain refresh, so the marker is still A ...
  assert.equal(t.api.active(),'A','the refresh did not take over the browser');
  bUser.release.resolve();await switchToB;
  // ... and B's own write still had its permission
  assert.equal(t.api.active(),'B');assert.equal(stored(b),'B');
});
test('Login failure in ANOTHER tab: a rejected session of B makes apply throw; A in tab 1 stays signed in and keeps refreshing, and no permission is left behind',async()=>{
  const br=browser(),t1=br.tab(),t2=br.tab({rejectUser:'B'});
  await t1.db.auth.initialize();await t2.db.auth.initialize();
  await t1.login(makeSession('A'),true);
  await assert.rejects(()=>t2.login(makeSession('B'),false));
  assert.equal(stored(br),'A','the session of A is untouched');assert.equal(t1.api.active(),'A');assert.equal(await accountOf(t1),'A');
  assert.equal(storedAnywhere(t2),null,'nothing was written to the failing tab');
  const r=await t1.db.auth.refreshSession();                                                   // A's normal refresh still works and is stored
  assert.equal(r.error,null);assert.equal(stored(br),'A');
  // a stray write of another account in the failed tab afterwards is not a sign-in
  t2.api.storage.setItem(KEY,JSON.stringify(makeSession('B','-stray')));
  assert.equal(stored(br),'A');assert.equal(storedAnywhere(t2),null);assert.equal(t1.api.active(),'A');
});
test('A save that was refused or overwritten is not reported as a success: applyManeeAuthSession throws when the applied account differs from the login target',async()=>{
  const b=browser(),t=b.tab();
  await t.db.auth.initialize();await t.login(makeSession('A'),true);
  // make the storage silently keep A: B's write is swallowed (as a refused write would be)
  const real=t.api.storage.setItem.bind(t.api.storage);
  t.api.storage.setItem=(k,v)=>{ if(k===KEY&&JSON.parse(v).user.id==='B')return; return real(k,v); };
  await assert.rejects(()=>t.login(makeSession('B'),true),/로그인 세션을 만들지 못했어요/);
  assert.equal(stored(b),'A');
});
test('A session without a readable account id cannot be applied (no unbound permission is opened)',async()=>{
  const b=browser(),t=b.tab();
  await t.db.auth.initialize();
  await assert.rejects(()=>t.apply({access_token:'not-a-jwt',refresh_token:'x'}),/로그인 세션을 만들지 못했어요/);
  assert.equal(stored(b),null);
});
test('Superseded tab with the SDK in the loop: A (tab 1) is superseded by B (tab 2); A\'s late refresh is dropped and repeated cleanup keeps B',async()=>{
  const refreshGate=deferred(),br=browser();
  const t1=br.tab({refreshGate}),t2=br.tab();
  await t1.db.auth.initialize();await t2.db.auth.initialize();
  await t1.login(makeSession('A'),true);
  const refresh=t1.db.auth.refreshSession();await t1.gates.refreshStarted.promise;               // tab 1's refresh is in flight
  await t2.login(makeSession('B'),true);                                                         // tab 2 signs B in
  refreshGate.resolve();await refresh;                                                           // tab 1's late refresh answer
  assert.equal(stored(br),'B');assert.equal(t2.api.active(),'B');
  assert.equal(await accountOf(t1),null,'tab 1 has no session any more');
  for(let i=0;i<3;i++)t1.api.storage.removeItem(KEY);                                            // repeated cleanup of the superseded tab
  assert.equal(stored(br),'B');assert.equal(t2.api.active(),'B');assert.equal(await accountOf(t2),'B');
  t2.api.storage.removeItem(KEY);                                                                // B logs out; A's tab cannot come back
  t1.api.storage.setItem(KEY,JSON.stringify(makeSession('A','-late')));
  assert.equal(stored(br),null);assert.equal(t1.api.active(),null);
});
test('Normal sign-in (no overlap) with the SDK: keep checked -> localStorage, unchecked -> tab storage only, marker names the account',async()=>{
  for(const keep of [true,false]){
    const b=browser(),t=b.tab();
    await t.db.auth.initialize();await t.login(makeSession('A'),keep);
    assert.equal(await accountOf(t),'A');assert.equal(t.api.active(),'A');
    assert.equal(keep?stored(b):storedAnywhere(t),'A');assert.equal(keep?storedAnywhere(t):stored(b),null);
    const r=await t.db.auth.refreshSession();assert.equal(r.error,null);assert.equal(await accountOf(t),'A');
  }
});
