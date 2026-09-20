import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// One account per browser (owner decision, 2026-09-19), on top of R2 (a refresh/logout of one tab must never delete another
// account's sign-in by accident):
//  * an explicit sign-in of account B makes account A's tabs of this browser lose their session ("keep signed in" checked or not);
//  * a FAILED sign-in changes nothing;
//  * a superseded tab can neither refresh, overwrite nor delete B's session or store id, and never comes back to life;
//  * a persistent (localStorage) sign-in is never copied for an unchecked login; the marker holds an account id only.
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const block=html.match(/  const MANEE_REMEMBER_KEY[\s\S]*?const db = /)[0].replace(/const db = $/,'');
const scoped=html.match(/  const MANEE_SESSION_SCOPED_KEYS[\s\S]*?function localDelete\(key\)\{[\s\S]*?\n  \}\n/)[0];
function area(){const map=new Map();return {map,getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)};}
function browser(){
  const local=area();
  function tab(session){
    const s=session||area();
    const ctx=vm.createContext({window:{localStorage:local,sessionStorage:s},localStorage:local,MANEE_LOCAL_PREFIX:'',MANEE_IS_STAGING:false,MANEE_CONFIG:{projectRef:'exampleref'}});
    vm.runInContext(block+scoped+';this.api={storage:maneeAuthStorage,setRemember:(v)=>{maneeSetRememberLogin(v);maneeArmLogin();},click:maneeSetRememberLogin,arm:maneeArmLogin,endPending:maneeEndPendingLogin,takeSuperseded:maneeTakeSuperseded,activeUser:maneeActiveUser,localGet,localSet,localDelete};',ctx);
    return {session:s,...ctx.api};
  }
  return {local,tab};
}
const KEY='sb-exampleref-auth-token', MARK='active-account';
const sess=(uid,tag)=>JSON.stringify({access_token:tag,user:{id:uid}});
const userOf=v=>v===null||v===undefined?null:JSON.parse(v).user.id;
const login=(tab,uid,tag,keep)=>{tab.setRemember(keep);tab.storage.setItem(KEY,sess(uid,tag));};

test('Review scenario under the new policy: A (keep unchecked) then B (keep checked) — A\'s tab loses its session and cannot refresh over B',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',false);
  assert.equal(a.activeUser(),'A');
  login(c,'B','b1',true);
  assert.equal(b.local.map.get(KEY),sess('B','b1'));assert.equal(a.activeUser(),'B');
  assert.equal(a.storage.getItem(KEY),null,'tab A must not have (or show) a session any more');
  assert.equal(a.session.map.has(KEY),false,'A\'s stale sign-in is removed from A\'s own tab storage');
  assert.equal(a.takeSuperseded(),true,'the UI is told why');
  a.storage.setItem(KEY,sess('A','a2'));                                // A's late token refresh
  assert.equal(b.local.map.get(KEY),sess('B','b1'),'B\'s session must be untouched');
  assert.equal(a.session.map.has(KEY),false,'and A is not revived');
  assert.equal(userOf(c.storage.getItem(KEY)),'B');
});
test('Reverse order: B kept first, then A signs in with keep unchecked — B\'s tab loses its session and its late refresh cannot overwrite A',()=>{
  const b=browser(),c=b.tab(),a=b.tab();
  login(c,'B','b1',true);
  login(a,'A','a1',false);
  assert.equal(b.local.map.has(KEY),false,'B\'s persistent login is removed by A\'s explicit sign-in');
  assert.equal(c.storage.getItem(KEY),null);
  c.storage.setItem(KEY,sess('B','b2'));                                // B's late refresh
  assert.equal(b.local.map.has(KEY),false,'must not write B\'s token back');
  assert.equal(a.session.map.get(KEY),sess('A','a1'));assert.equal(userOf(a.storage.getItem(KEY)),'A');
});
test('Both tabs keep signed in: the later account replaces the shared session; the earlier tab cannot refresh over it or read it',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',true);login(c,'B','b1',true);
  assert.equal(b.local.map.get(KEY),sess('B','b1'));
  assert.equal(a.storage.getItem(KEY),null,'A must not silently adopt B');
  a.storage.setItem(KEY,sess('A','a2'));
  assert.equal(b.local.map.get(KEY),sess('B','b1'));
  assert.equal(a.takeSuperseded(),true);
});
test('A failed sign-in of another account changes nothing for the signed-in account (session, marker, refresh)',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',true);
  const before=JSON.stringify([...b.local.map.entries()]);
  c.setRemember(false);                                                 // the sign-in is started ... and then rejected (wrong password)
  c.endPending();
  assert.equal(a.activeUser(),'A');
  assert.equal(b.local.map.get(KEY),sess('A','a1'));
  assert.equal(JSON.stringify([...b.local.map.entries()].filter(([k])=>k!=='remember-login')),JSON.stringify(JSON.parse(before).filter(([k])=>k!=='remember-login')));
  a.storage.setItem(KEY,sess('A','a2'));assert.equal(b.local.map.get(KEY),sess('A','a2'),'A keeps refreshing normally');
  assert.equal(a.takeSuperseded(),false);
  c.storage.setItem(KEY,sess('B','late'));                              // after a failed attempt no stray write may become a sign-in
  assert.equal(b.local.map.get(KEY),sess('A','a2'));assert.equal(a.activeUser(),'A');
});
test('Logging out of a superseded tab deletes neither the new account\'s session, store id nor marker; logging out of the active account clears them',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',true);a.localSet('auth-store-id','store-of-A');
  login(c,'B','b1',true);c.localSet('auth-store-id','store-of-B');
  a.storage.removeItem(KEY);a.localDelete('auth-store-id');            // late logout of the superseded tab
  assert.equal(b.local.map.get(KEY),sess('B','b1'));assert.equal(b.local.map.get('auth-store-id'),'store-of-B');assert.equal(c.activeUser(),'B');
  c.storage.removeItem(KEY);c.localDelete('auth-store-id');
  assert.equal(b.local.map.has(KEY),false);assert.equal(b.local.map.has('auth-store-id'),false);assert.equal(c.activeUser(),null);
});
test('A superseded tab\'s late store-id writes do not touch the new account\'s store id',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',true);login(c,'B','b1',true);c.localSet('auth-store-id','store-of-B');
  a.localSet('auth-store-id','store-of-A');
  assert.equal(b.local.map.get('auth-store-id'),'store-of-B');
  assert.equal(a.localGet('auth-store-id'),null,'and A does not read B\'s store id');
});
test('A tab-private (keep unchecked) sign-in is never copied to localStorage; the marker holds only an account id',()=>{
  const b=browser(),a=b.tab();
  login(a,'A','a1',false);
  assert.equal(b.local.map.has(KEY),false);
  const marker=JSON.parse(b.local.map.get(MARK));
  assert.deepEqual(Object.keys(marker).sort(),['at','user']);assert.equal(marker.user,'A');
  assert.equal(/a1|access_token/.test(b.local.map.get(MARK)),false);
});
test('A superseded tab that was hidden and is reloaded later is not revived (its own session is dropped)',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',false);login(c,'B','b1',true);
  a.session.map.set(KEY,sess('A','a1'));                                // the stale copy is still in A's tab storage (the tab was asleep)
  const reloaded=b.tab(a.session);                                      // fresh module state, same tab storage
  assert.equal(reloaded.storage.getItem(KEY),null);
  assert.equal(a.session.map.has(KEY),false);
  assert.equal(reloaded.takeSuperseded(),true);assert.equal(b.local.map.get(KEY),sess('B','b1'));
});
test('The same account signed in twice (two tabs) is not a conflict: both keep working and refreshing',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',true);login(c,'A','a2',true);
  assert.equal(userOf(a.storage.getItem(KEY)),'A');assert.equal(userOf(c.storage.getItem(KEY)),'A');
  a.storage.setItem(KEY,sess('A','a3'));assert.equal(b.local.map.get(KEY),sess('A','a3'));
  assert.equal(a.takeSuperseded(),false);assert.equal(c.takeSuperseded(),false);
});
test('Signing in again as the same account in the other mode replaces its own duplicate (no old session comes back)',()=>{
  const b=browser(),t=b.tab();
  b.local.map.set(KEY,sess('A','old'));
  login(t,'A','new',false);
  assert.equal(b.local.map.has(KEY),false);assert.equal(t.session.map.get(KEY),sess('A','new'));
  assert.equal(b.tab().storage.getItem(KEY),null,'after the tab closes nothing is left to resurrect');
});
test('A session created before this rule (no marker) is claimed by its first reader; a different account\'s stale copy is then refused',()=>{
  const b=browser();
  b.local.map.set(KEY,sess('A','old'));
  const first=b.tab();assert.equal(userOf(first.storage.getItem(KEY)),'A');assert.equal(first.activeUser(),'A');
  const other=b.tab();other.session.map.set(KEY,sess('B','b-old'));
  assert.equal(other.storage.getItem(KEY),null);assert.equal(other.session.map.has(KEY),false);
});
test('After logging out, a tab does not adopt another account\'s session until it signs in again',()=>{
  const b=browser(),c=b.tab(),a=b.tab();
  login(a,'A','a1',false);login(c,'B','b1',true);
  a.storage.removeItem(KEY);
  assert.equal(a.storage.getItem(KEY),null,'the logged-out tab must not read B\'s session');
  assert.equal(b.local.map.get(KEY),sess('B','b1'),'and B\'s session is untouched');
  login(a,'A','a2',false);                                              // a new explicit sign-in works again, and replaces B
  assert.equal(userOf(a.storage.getItem(KEY)),'A');assert.equal(b.local.map.has(KEY),false);
});
test('A fresh page load of the ACTIVE account derives where its sign-in lives and keeps refreshing there',()=>{
  const b=browser(),first=b.tab();login(first,'A','a1',false);
  const reloaded=b.tab(first.session);
  assert.equal(userOf(reloaded.storage.getItem(KEY)),'A');
  reloaded.storage.setItem(KEY,sess('A','a2'));
  assert.equal(first.session.map.get(KEY),sess('A','a2'));assert.equal(b.local.map.has(KEY),false);
});
test('Logging out clears the marker only if it names the logging-out account',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',false);
  login(c,'B','b1',true);
  a.storage.removeItem(KEY);assert.equal(c.activeUser(),'B','B\'s marker survives A\'s late logout');
  c.storage.removeItem(KEY);assert.equal(c.activeUser(),null);
});

// ---------- v5 review (V5-1): superseded / logged-out tabs cannot come back, and cleanup is repeat-safe ----------
const COMBOS=[[true,true],[true,false],[false,true],[false,false]];   // [A keeps signed in, B keeps signed in]
for(const [keepA,keepB] of COMBOS){
  const label=' (A keep='+keepA+', B keep='+keepB+')';
  test('V5-1 A: after B logs out (marker gone), A\'s late token refresh cannot revive A'+label,()=>{
    const b=browser(),a=b.tab(),c=b.tab();
    login(a,'A','a1',keepA);login(c,'B','b1',keepB);
    assert.equal(a.storage.getItem(KEY),null,'A finds out it was superseded');
    a.takeSuperseded();                                                   // the UI notice is consumed; this must not re-enable A
    c.storage.removeItem(KEY);c.localDelete('auth-store-id');             // B logs out: the marker disappears
    assert.equal(c.activeUser(),null);
    a.storage.setItem(KEY,sess('A','a-late'));                            // an A refresh that was already in flight finishes
    assert.equal(b.local.map.has(KEY),false,'nothing stored in localStorage');
    assert.equal(a.session.map.has(KEY),false,'nothing stored in the tab');
    assert.equal(a.storage.getItem(KEY),null,'and A cannot read a session');
    assert.equal(a.activeUser(),null,'A must not become the active account again');
  });
  test('V5-1 B: cleaning up the superseded tab repeatedly keeps B\'s session, store id and marker'+label,()=>{
    const b=browser(),a=b.tab(),c=b.tab();
    login(a,'A','a1',keepA);a.localSet('auth-store-id','store-of-A');
    login(c,'B','b1',keepB);c.localSet('auth-store-id','store-of-B');
    const bSession=keepB?b.local.map.get(KEY):c.session.map.get(KEY);
    for(let i=0;i<3;i++){a.storage.removeItem(KEY);a.localDelete('auth-store-id');}
    if(keepB){assert.equal(b.local.map.get(KEY),bSession,'B\'s shared session survives');assert.equal(b.local.map.get('auth-store-id'),'store-of-B');}
    else{assert.equal(c.session.map.get(KEY),bSession,'B\'s own tab session survives');assert.equal(c.session.map.get('auth-store-id'),'store-of-B');}
    assert.equal(c.activeUser(),'B','B stays the active account');
    assert.equal(userOf(c.storage.getItem(KEY)),'B');
  });
}
test('V5-1: repeated logout of an ordinary (not superseded) tab is safe and only clears its own account',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',true);
  a.storage.removeItem(KEY);a.storage.removeItem(KEY);                  // the SDK may clean up more than once
  assert.equal(b.local.map.has(KEY),false);assert.equal(a.activeUser(),null);
  login(c,'B','b1',true);                                                // B signs in afterwards
  a.storage.removeItem(KEY);a.storage.removeItem(KEY);                  // A's tab cleans up again, late
  assert.equal(b.local.map.get(KEY),sess('B','b1'));assert.equal(c.activeUser(),'B');
});
test('V5-1: a tab that never held an account cannot delete anybody\'s session',()=>{
  const b=browser(),c=b.tab(),stranger=b.tab();
  login(c,'B','b1',true);
  stranger.storage.removeItem(KEY);stranger.storage.removeItem(KEY);
  assert.equal(b.local.map.get(KEY),sess('B','b1'));assert.equal(c.activeUser(),'B');
});
test('V5-1: a refresh is never a sign-in — only the session-apply window is; pressing the button alone does not open it',()=>{
  const b=browser(),a=b.tab();
  login(a,'A','a1',true);
  a.storage.removeItem(KEY);                                            // A logged out
  a.click(true);                                                        // the login form was submitted, the session is not applied yet
  a.storage.setItem(KEY,sess('A','a-late'));                            // a late refresh of the old account arrives in that gap
  assert.equal(b.local.map.has(KEY),false,'not accepted as a sign-in');assert.equal(a.activeUser(),null);
  a.arm();a.storage.setItem(KEY,sess('B','b1'));a.endPending();         // the real sign-in (applyManeeAuthSession)
  assert.equal(b.local.map.get(KEY),sess('B','b1'));assert.equal(a.activeUser(),'B');
  a.storage.setItem(KEY,sess('B','b2'));assert.equal(b.local.map.get(KEY),sess('B','b2'),'B\'s own refresh works');
  a.storage.setItem(KEY,sess('A','a-late-2'));assert.equal(b.local.map.get(KEY),sess('B','b2'),'an old account\'s refresh never replaces it');
});
test('V5-1: a sign-in of the same tab after being superseded works again and is the only way back',()=>{
  const b=browser(),a=b.tab(),c=b.tab();
  login(a,'A','a1',false);login(c,'B','b1',true);a.storage.getItem(KEY);
  login(a,'A','a3',false);                                              // A explicitly signs in again: B is now the superseded one
  assert.equal(userOf(a.storage.getItem(KEY)),'A');assert.equal(b.local.map.has(KEY),false);assert.equal(a.activeUser(),'A');
  assert.equal(c.storage.getItem(KEY),null);
});

// ---------- v6 review (V6-1): the sign-in permission is bound to the target account ----------
test('V6-1: an armed sign-in for B is not used or consumed by a refresh write of A; B keeps its permission', () => {
  const b = browser(), t = b.tab();
  login(t, 'A', 'a1', true);
  t.click(true); t.arm('B');                                            // applyManeeAuthSession for B starts
  t.storage.setItem(KEY, sess('A', 'a-refresh'));                       // A refresh finishes meanwhile: a plain refresh
  assert.equal(t.activeUser(), 'A', 'the refresh did not take over the browser');
  assert.equal(b.local.map.get(KEY), sess('A', 'a-refresh'), 'and it was stored as a refresh of the still-active A');
  t.storage.setItem(KEY, sess('B', 'b1'));                              // B own write
  assert.equal(t.activeUser(), 'B'); assert.equal(b.local.map.get(KEY), sess('B', 'b1'));
  t.storage.setItem(KEY, sess('A', 'a-late'));                          // any later A write is refused
  assert.equal(b.local.map.get(KEY), sess('B', 'b1'));
});
test('V6-1: ending the armed sign-in of one account does not clear the permission of another', () => {
  const b = browser(), t = b.tab();
  t.click(true); t.arm('B'); t.endPending('A');                         // a stale end for another account
  t.storage.setItem(KEY, sess('B', 'b1'));
  assert.equal(t.activeUser(), 'B'); assert.equal(b.local.map.get(KEY), sess('B', 'b1'));
  t.arm('C'); t.endPending('C');                                        // the matching end closes it
  t.storage.setItem(KEY, sess('C', 'c-stray'));
  assert.equal(b.local.map.get(KEY), sess('B', 'b1'));
});
