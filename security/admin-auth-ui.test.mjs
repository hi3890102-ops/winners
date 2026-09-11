import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';

const user=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const config=JSON.parse(readFileSync(new URL('../scripts/admin-variant.json',import.meta.url),'utf8'));
let admin=user;
for(const change of config.changes){
  assert.equal(admin.split(change.source).length-1,1,'variant anchor must be unique');
  admin=admin.replace(change.source,change.admin);
}
function compileScripts(html){
  for(const match of html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g))if(match[1].trim())new Script(match[1]);
}

test('User and administrator artifacts share one source and compile independently',()=>{
  compileScripts(user);compileScripts(admin);
  assert.match(user,/const MANEE_ADMIN_AUTH_ENABLED = false;/);
  assert.match(admin,/const MANEE_ADMIN_AUTH_ENABLED = MANEE_IS_STAGING;/);
  assert.match(admin,/const MANEE_STAFF_AUTH_ENABLED = false;/);
});
test('Administrator login verifies an Auth session and server-side authority',()=>{
  const body=admin.slice(admin.indexOf('async function restoreManeeAdmin'),admin.indexOf('async function loginManeeAdmin'));
  assert.match(body,/db\.auth\.getSession\(\)/);assert.match(body,/db\.auth\.getUser\(\)/);
  assert.match(body,/from\('platform_admins'\)/);assert.match(body,/from\('franchise_memberships'\)/);
  assert.doesNotMatch(body,/localSet\("my-role"/);
});
test('Staging administrator entry uses username/password and recovery requests instead of the shared PIN',()=>{
  assert.match(admin,/id="admin-auth-username"/);assert.match(admin,/id="admin-auth-password"/);
  assert.match(admin,/manee_recovery_portal/);assert.match(admin,/issue_code/);
  assert.match(admin,/if\(MANEE_ADMIN_AUTH_ENABLED\)/);
});
