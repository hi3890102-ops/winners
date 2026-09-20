import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// The browser SDK is pinned to the version the login / token-refresh / one-account-per-browser tests run against (node_modules), the same
// version the Edge Functions import. A floating "@2" would let a CDN update change login behaviour without any test noticing.
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const installed=JSON.parse(readFileSync(new URL('../node_modules/@supabase/supabase-js/package.json',import.meta.url),'utf8')).version;
test('index.html loads @supabase/supabase-js at the exact version the tests run against',()=>{
  const tags=[...html.matchAll(/<script[^>]+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@([^/"]+)\/dist\/umd\/supabase\.js"/g)];
  assert.equal(tags.length,1,'exactly one SDK script tag');
  assert.equal(tags[0][1],'2.116.0','pinned, not a floating range');
  assert.equal(tags[0][1],installed,'equals the installed version used by the SDK regression tests');
});
test('Edge Functions import the same SDK version',()=>{
  for(const f of ['manee-staff-signup','manee-signup','manee-login']){
    let src='';try{src=readFileSync(new URL('../supabase/functions/'+f+'/index.ts',import.meta.url),'utf8');}catch(e){continue;}
    const m=src.match(/@supabase\/supabase-js@([0-9.]+)/);if(m)assert.equal(m[1],'2.116.0',f);
  }
});
