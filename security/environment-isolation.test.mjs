import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(resolve(root,p),'utf8');
const html=read('index.html');
const configs=JSON.parse(read('config/environments.json'));
const bootstrap=html.match(/\/\/ BEGIN MANEE_ENVIRONMENT([\s\S]*?)\/\/ END MANEE_ENVIRONMENT/)[1];
function start(config,hostname='deploy-preview-1--winners-staffapp.netlify.app'){
  const calls=[]; const nodes={app:{},'environment-banner':{hidden:true}};
  const document={getElementById:id=>nodes[id],title:'original'};
  const window={MANEE_CONFIG:config,supabase:{createClient:(...args)=>{calls.push(args);return {};}}};
  const result=vm.runInNewContext('(function(){'+bootstrap+';return {prefix:MANEE_LOCAL_PREFIX};})()',{
    window,document,location:{hostname},
  });
  return {calls,nodes,document,result};
}
test('Preview initializes only the staging backend and a separate Auth storage key',()=>{
  const r=start(configs.staging);
  assert.equal(r.calls.length,1);
  assert.equal(r.calls[0][0],configs.staging.supabaseUrl);
  assert.equal(r.calls[0][1],configs.staging.publishableKey);
  assert.ok(r.calls[0][2].auth.storageKey.includes(configs.staging.projectRef));
  assert.equal(r.nodes['environment-banner'].hidden,false);
  assert.equal(r.document.title,'매니 · 테스트');
});
test('Missing runtime configuration creates no backend client',()=>{
  const r=start(undefined); assert.equal(r.calls.length,0); assert.ok(r.nodes.app.textContent);
});
test('A preview cannot initialize production configuration',()=>{
  assert.equal(start(configs.production).calls.length,0);
});
test('A staging label with the production project is rejected',()=>{
  assert.equal(start({...configs.production,environment:'staging'}).calls.length,0);
});
test('Endpoint and project reference must match',()=>{
  assert.equal(start({...configs.staging,supabaseUrl:configs.production.supabaseUrl}).calls.length,0);
});
test('Secret keys and unexpected environment names are rejected',()=>{
  assert.equal(start({...configs.staging,publishableKey:'sb_secret_fake'}).calls.length,0);
  assert.equal(start({...configs.staging,environment:'unknown'}).calls.length,0);
});
test('Production keeps its original legacy storage namespace and SDK storage default',()=>{
  const r=start(configs.production,'winners-staffapp.netlify.app');
  assert.equal(r.result.prefix,''); assert.equal(r.calls[0][2],undefined);
});
test('Staging legacy identity storage neither reads nor overwrites production entries',()=>{
  const prefix=start(configs.staging).result.prefix;
  const map=new Map([['my-link','production-identity']]);
  const helpers=html.slice(html.indexOf('  function localGet('),html.indexOf('  const DEFAULT_STORES'));
  const api=vm.runInNewContext(helpers+';({localGet,localSet,localDelete})',{
    MANEE_LOCAL_PREFIX:prefix,localStorage:{getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)},
  });
  assert.equal(api.localGet('my-link'),null);
  api.localSet('my-link','staging-identity');
  assert.equal(map.get('my-link'),'production-identity');
  assert.equal(api.localGet('my-link').value,'staging-identity');
  api.localDelete('my-link'); assert.equal(map.get('my-link'),'production-identity');
});

function sandbox(){
  const temp=mkdtempSync(resolve(tmpdir(),'manee-build-'));
  for(const path of ['scripts','config','index.html','manifest.json','sw.js']) cpSync(resolve(root,path),resolve(temp,path),{recursive:true});
  mkdirSync(resolve(temp,'netlify/functions/lib'),{recursive:true});
  return temp;
}
function build(temp,context){return spawnSync(process.execPath,['scripts/build-environment.mjs'],{cwd:temp,env:{...process.env,CONTEXT:context,BRANCH:context==='production'?'main':'security-v2'},encoding:'utf8'});}
test('Preview publish output excludes production URL/key and disables old push subscriptions',()=>{
  const temp=sandbox();
  try{
    const r=build(temp,'deploy-preview'); assert.equal(r.status,0,r.stderr);
    for(const f of ['index.html','app-config.js','sw.js','manifest.json']){
      const s=readFileSync(resolve(temp,'dist',f),'utf8');
      assert.ok(!s.includes(configs.production.supabaseUrl),f);
      assert.ok(!s.includes(configs.production.publishableKey),f);
    }
    assert.ok(readFileSync(resolve(temp,'dist/app-config.js'),'utf8').includes(configs.staging.supabaseUrl));
    assert.equal(JSON.parse(readFileSync(resolve(temp,'netlify/functions/lib/manee-environment.json'),'utf8')).externalServicesEnabled,false);
    const handlers={};let shown=0;
    vm.runInNewContext(readFileSync(resolve(temp,'dist/sw.js'),'utf8'),{self:{addEventListener:(name,fn)=>{handlers[name]=fn;},registration:{showNotification:()=>{shown++;}}}});
    handlers.push({data:{json:()=>({title:'old production push'})},waitUntil:()=>{}});
    assert.equal(shown,0);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
test('Production build selects production configuration explicitly',()=>{
  const temp=sandbox();
  try{const r=build(temp,'production');assert.equal(r.status,0,r.stderr);
    assert.ok(readFileSync(resolve(temp,'dist/app-config.js'),'utf8').includes(configs.production.supabaseUrl));
    assert.equal(JSON.parse(readFileSync(resolve(temp,'netlify/functions/lib/manee-environment.json'),'utf8')).externalServicesEnabled,true);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
test('Unknown build context and shared backend configuration fail the build',()=>{
  const temp=sandbox();
  try{assert.notEqual(build(temp,'unknown').status,0);
    writeFileSync(resolve(temp,'config/environments.json'),JSON.stringify({...configs,staging:{...configs.production,environment:'staging'}}));
    assert.notEqual(build(temp,'deploy-preview').status,0);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
test('A feature branch cannot produce a production build even with a wrong context',()=>{
  const temp=sandbox();
  try{const r=spawnSync(process.execPath,['scripts/build-environment.mjs'],{cwd:temp,env:{...process.env,CONTEXT:'production',BRANCH:'security-v2'},encoding:'utf8'});assert.notEqual(r.status,0);}
  finally{rmSync(temp,{recursive:true,force:true});}
});

function guardFor(config){
  const exports={};vm.runInNewContext(read('netlify/functions/lib/manee-environment.cjs'),{exports,require:()=>config});return exports;
}
for(const file of ['ask-app.js','read-receipt.js','send-push.js','notify-reservations-cron.js']){
  test(`${file}: staging exits before secrets, database or external API access`,async()=>{
    const exports={};let sideEffects=0;
    const forbidden=()=>{sideEffects++;throw Error('Unexpected external access');};
    vm.runInNewContext(read('netlify/functions/'+file),{
      exports,process:{env:new Proxy({},{get:forbidden})},fetch:forbidden,
      require:name=>name==='./lib/manee-environment.cjs'?guardFor({environment:'staging',externalServicesEnabled:false}):name==='web-push'?{setVapidDetails:forbidden,sendNotification:forbidden}:{createClient:forbidden},
    });
    const response=await exports.handler({httpMethod:'POST',headers:{'x-manee-environment':'production'},body:'{}'});
    assert.equal(response.statusCode,503);assert.equal(sideEffects,0);
    assert.equal(JSON.parse(response.body).code,'staging_external_service_disabled');
  });
}
test('External service guard permits only an explicit production build',()=>{
  assert.equal(guardFor({environment:'production',externalServicesEnabled:true}).blockExternalService(),null);
  assert.equal(guardFor({environment:'staging',externalServicesEnabled:true}).blockExternalService().statusCode,503);
  assert.equal(guardFor({}).blockExternalService().statusCode,503);
});
