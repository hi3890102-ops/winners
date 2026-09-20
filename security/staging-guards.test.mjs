import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,appendFileSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classify,evaluate} from '../scripts/netlify-env-check.mjs';
// The staging-deploy guards: build folder preflight (app + Netlify functions + Edge address), Netlify variable classification, and the
// deploy wrapper's refusals. No network, no Netlify call, nothing is deployed.
const cfg=JSON.parse(readFileSync(new URL('../config/environments.json',import.meta.url),'utf8'));
const node=process.execPath;const root=new URL('..',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
const run=(script,args)=>spawnSync(node,[join(root,'scripts',script),...args],{encoding:'utf8',cwd:root});
const tmp=mkdtempSync(join(tmpdir(),'manee-stg-'));const good=join(tmp,'good');
test('a fresh staging build of the working tree passes the preflight (app, function guard, pinned SDK)',()=>{
  const b=run('staging-build.mjs',['--worktree','--out',good]);assert.equal(b.status,0,b.stderr);
  const p=run('staging-preflight.mjs',[good]);assert.equal(p.status,0,p.stdout+p.stderr);
  assert.match(p.stdout,/PREFLIGHT PASSED/);assert.match(p.stdout,/SDK pinned: 2\.116\.0/);
  assert.equal(existsSync(join(good,'BUILD.json')),true);
  // the repository's own tracked function guard was not touched by that build
  const g=JSON.parse(readFileSync(join(root,'netlify/functions/lib/manee-environment.json'),'utf8'));assert.ok(g.environment==='production'||g.environment==='staging');
});
function tamper(name,mutate,expect){
  test('preflight STOPS when '+name,()=>{
    const d=join(tmp,'t-'+Math.random().toString(36).slice(2));const cp=spawnSync(process.platform==='win32'?'xcopy':'cp',process.platform==='win32'?[good,d,'/E','/I','/Q','/Y']:['-r',good,d]);assert.equal(cp.status,0);
    mutate(d);const p=run('staging-preflight.mjs',[d]);assert.notEqual(p.status,0,p.stdout);assert.match(p.stdout,expect);assert.match(p.stdout,/PREFLIGHT FAILED/);
  });
}
tamper('the app config points at production',d=>{const f=join(d,'dist/app-config.js');writeFileSync(f,readFileSync(f,'utf8').split(cfg.staging.projectRef).join(cfg.production.projectRef));},/not the staging|production (project ref|URL)/);
tamper('a production URL appears in a Netlify function file',d=>{mkdirSync(join(d,'netlify/functions'),{recursive:true});writeFileSync(join(d,'netlify/functions/x.js'),'const u="'+cfg.production.supabaseUrl+'";');},/production URL found in netlify/);
tamper('a service_role key is embedded in a published file',d=>{const p=Buffer.from(JSON.stringify({ref:'anything',role:'service_role'})).toString('base64url');appendFileSync(join(d,'dist/index.html'),'\n<!-- eyJhbGciOiJIUzI1NiJ9.'+p+'.c2lnbmF0dXJlLXNpZ25hdHVyZQ -->');},/service_role key is embedded/);
tamper('the SDK is not pinned',d=>{const f=join(d,'dist/index.html');writeFileSync(f,readFileSync(f,'utf8').replace('supabase-js@2.116.0','supabase-js@2'));},/not pinned/);
tamper('the function guard says production',d=>{const f=join(d,'netlify/functions/lib/manee-environment.json');writeFileSync(f,JSON.stringify({environment:'production',projectRef:cfg.production.projectRef,externalServicesEnabled:true}));},/function guard is not staging/);
test('variable classification: production URL / project ref / publishable key / service_role of production / secret key are all flagged; staging and unrelated are not',()=>{
  const jwt=ref=>'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({ref,role:'service_role'})).toString('base64url')+'.sig';
  assert.equal(classify(cfg.production.supabaseUrl),'PRODUCTION');assert.equal(classify('x'+cfg.production.projectRef),'PRODUCTION');
  assert.equal(classify(cfg.production.publishableKey),'PRODUCTION');assert.match(classify(jwt(cfg.production.projectRef)),/^PRODUCTION\(service_role\)/);
  assert.equal(classify('sb_secret_abcdefghijklmnop'),'SECRET-KEY');
  assert.match(classify(jwt(cfg.staging.projectRef)),/^staging/);assert.equal(classify('22'),'other');assert.equal(classify(cfg.staging.supabaseUrl),'staging');
  const e=evaluate({'deploy-preview':{A:{value:cfg.production.supabaseUrl},B:{value:'22'}},'dev':{C:{value:jwt(cfg.staging.projectRef)}}});
  assert.equal(e.violations,1);assert.equal(JSON.stringify(e.rows).includes(cfg.production.supabaseUrl),false,'rows never contain a value');
});
test('the deploy wrapper refuses production site ids and --prod before doing anything, and prints the exact draft command only',()=>{
  for(const id of ['a94b0ecc-833a-4e33-8ead-076783e6243b','f13b2709-fd79-4855-a020-e0f797779428','cb72151d-5a81-4248-843c-fffded351e36']){
    const r=run('staging-deploy.mjs',['--site',id,'--folder',good,'--alias','qa-test']);assert.equal(r.status,3);assert.match(r.stderr,/REFUSED/);
  }
  const p=run('staging-deploy.mjs',['--site','11111111-1111-4111-8111-111111111111','--folder',good,'--alias','qa-test','--prod']);assert.equal(p.status,3);
  const src=readFileSync(join(root,'scripts/staging-deploy.mjs'),'utf8');
  assert.ok(src.includes("'--no-build'"));assert.equal(/'--prod'\]|"--prod",|deploy --prod/.test(src.replace(/process\.argv\.includes\('--prod'\)/,'')),false);
});
test.after?.(()=>{try{rmSync(tmp,{recursive:true,force:true});}catch(e){}});
