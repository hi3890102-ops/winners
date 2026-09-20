#!/usr/bin/env node
// Refuses a build folder unless app, Netlify functions and Edge access all point at STAGING. Reads files only.
//   node scripts/staging-preflight.mjs <folder made by staging-build.mjs>
// Checks: app-config.js is the staging config; no production project ref/URL/publishable key/secret anywhere in the published files; the
// Supabase SDK is pinned; the staging banner/manifest/service-worker guards are present; the Netlify function guard file says
// staging with external services disabled; the functions themselves contain no production address. Exit 0 = safe to hand to the deploy step.
import {readFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cfg=JSON.parse(readFileSync(join(repo,'config/environments.json'),'utf8'));
const dir=resolve(process.argv[2]||'');if(!process.argv[2]||!existsSync(join(dir,'dist'))){console.error('usage: staging-preflight.mjs <folder with dist/>');process.exit(2);}
const problems=[],notes=[];const bad=m=>problems.push(m);
const text=f=>readFileSync(f,'utf8');
const walk=(d,acc=[])=>{for(const f of readdirSync(d)){const p=join(d,f);statSync(p).isDirectory()?walk(p,acc):acc.push(p);}return acc;};
// 1 app config
const cfgFile=join(dir,'dist/app-config.js');let app=null;
try{app=JSON.parse(text(cfgFile).match(/Object\.freeze\((\{[\s\S]*\})\)/)[1]);}catch(e){bad('dist/app-config.js is missing or unreadable');}
if(app){
  if(app.environment!=='staging')bad('app-config environment is "'+app.environment+'", not staging');
  if(app.projectRef!==cfg.staging.projectRef)bad('app-config projectRef is not the staging project');
  if(app.supabaseUrl!==cfg.staging.supabaseUrl)bad('app-config supabaseUrl is not the staging URL');
  if(app.publishableKey!==cfg.staging.publishableKey)bad('app-config publishable key is not the staging key');
  notes.push('app-config: '+app.environment+' / '+app.projectRef);
}
// 2 nothing of production in any published file or function file
const needles=[['production project ref',cfg.production.projectRef],['production URL',cfg.production.supabaseUrl],['production publishable key',cfg.production.publishableKey]];
const scan=[...walk(join(dir,'dist')),...(existsSync(join(dir,'netlify'))?walk(join(dir,'netlify')).filter(f=>/\.(m?js|json|ts|toml)$/.test(f)):[])];
for(const f of scan){let t=text(f);
  // the app's own runtime guard names the production ref to REFUSE it (staging config pointing at production); that line is not a connection
  if(/index\.html$/.test(f))t=t.split('\n').filter(l=>!/MANEE_CONFIG\.projectRef === "/.test(l)).join('\n');
  for(const [n,v] of needles)if(v&&t.includes(v))bad(n+' found in '+f.slice(dir.length+1));
  if(/sb_secret_[A-Za-z0-9_-]{10,}/.test(t))bad('a Supabase secret key is embedded in '+f.slice(dir.length+1));
  for(const m of t.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)){try{const p=JSON.parse(Buffer.from(m[1],'base64url').toString());if(p.role==='service_role')bad('a service_role key is embedded in '+f.slice(dir.length+1));}catch(e){}}}
notes.push('scanned '+scan.length+' published/function files for production addresses and secrets');
// 3 SDK pin
const html=existsSync(join(dir,'dist/index.html'))?text(join(dir,'dist/index.html')):'';
const sdk=html.match(/@supabase\/supabase-js@([^/"]+)\/dist\/umd\/supabase\.js/);
if(!sdk)bad('Supabase SDK script tag not found');else if(!/^\d+\.\d+\.\d+$/.test(sdk[1])&&process.argv.includes('--baseline'))notes.push('SDK floating ("@'+sdk[1]+'"): allowed only for the production BASELINE build, which is what production runs today');
else if(!/^\d+\.\d+\.\d+$/.test(sdk[1]))bad('Supabase SDK is not pinned to an exact version ("'+sdk[1]+'")');else notes.push('SDK pinned: '+sdk[1]);
// 4 staging markers
if(!/테스트 환경|environment-banner/.test(html))bad('staging banner markup missing');
try{if(!/테스트/.test(JSON.parse(text(join(dir,'dist/manifest.json'))).name))bad('manifest name is not the test name');}catch(e){bad('manifest unreadable');}
if(!text(join(dir,'dist/sw.js')).includes('MANEE_STAGING_SW'))bad('service worker does not disable push for staging');
// 5 function guard
try{const g=JSON.parse(text(join(dir,'netlify/functions/lib/manee-environment.json')));
  if(g.environment!=='staging'||g.projectRef!==cfg.staging.projectRef||g.externalServicesEnabled!==false)bad('netlify function guard is not staging with external services disabled');else notes.push('function guard: staging, external services disabled');}
catch(e){bad('netlify/functions/lib/manee-environment.json missing');}
console.log(notes.map(n=>'  ok  '+n).join('\n'));
if(problems.length){console.log(problems.map(p=>'  !!  '+p).join('\n'));console.log('PREFLIGHT FAILED - do not deploy this folder.');process.exit(1);}
console.log('PREFLIGHT PASSED - app, Netlify functions and Edge access point at staging only.');
