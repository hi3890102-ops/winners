#!/usr/bin/env node
// Runs security/backup-run.mjs with a database credential that the OWNER typed into a Netlify environment variable of a dedicated, empty
// transfer site. Two input modes:
//   --password-var NAME   RECOMMENDED: the variable holds ONLY the raw database password. Host, port and user are fixed here per environment
//                         (verified), and the password is passed to the connection tool unchanged through PGPASSWORD - no URI is built,
//                         so no special character ever needs encoding.
//   --var NAME            the variable holds a complete postgres:// URI (percent-encoding is then the owner's job).
// The value is read by this process only (never printed, never on a command line, never written to a file), handed to the child through
// its environment, and the variable is removed afterwards (success OR failure) and the removal is verified.
//
//   node scripts/backup-via-netlify-var.mjs --site <transfer site id> --password-var <NAME> --env staging|production --check    connection test only
//   node scripts/backup-via-netlify-var.mjs --site <transfer site id> --password-var <NAME> --env staging|production --out <folder> [--keep-var]
//
// Refuses: production site ids; a transfer site that has a repository or any deploy; a variable that exists in any context other than "dev".
import {spawnSync,spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {redact} from '../security/backup-run.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const arg=n=>{const i=process.argv.indexOf(n);return i>0?process.argv[i+1]:null;};
const site=arg('--site'),uriVar=arg('--var'),pwVar=arg('--password-var'),label=arg('--env'),out=arg('--out'),check=process.argv.includes('--check'),keep=process.argv.includes('--keep-var');
const name=pwVar||uriVar;
// Verified 2026-09-20 with a wrong password: both projects answer on the aws-0 pooler (the aws-1 pooler says "tenant not found").
const TARGETS={staging:{host:'aws-0-ap-northeast-2.pooler.supabase.com',port:'5432',user:'postgres.obpkzecgswnfuyhwvncd',db:'postgres'},
  production:{host:'aws-0-ap-northeast-2.pooler.supabase.com',port:'5432',user:'postgres.bhwuuxcrzxespkjlmqxr',db:'postgres'}};
// test hook, loopback only: lets the tests point the same code path at a local disposable server
const LOCAL=arg('--local-target');
const DENY=['a94b0ecc-833a-4e33-8ead-076783e6243b','f13b2709-fd79-4855-a020-e0f797779428','cb72151d-5a81-4248-843c-fffded351e36'];
const die=(m,c=2)=>{console.error('ERROR: '+m);process.exit(c);};
if(!site||!name||(pwVar&&uriVar))die('usage: --site <id> (--password-var <NAME> | --var <NAME>) --env <staging|production> [--check | --out <dir>]');
if(DENY.includes(site))die('production site ids are refused',3);
if(!/^[A-Z0-9_]{3,60}$/.test(name))die('invalid variable name');
if(!['staging','production'].includes(label))die('--env staging|production is required');
if(!check&&!out)die('--out <dir> is required');
const q=o=>process.platform==='win32'?'"'+JSON.stringify(o).replace(/"/g,'\\"')+'"':JSON.stringify(o);
const nl=(args)=>{const r=spawnSync('netlify',args,{encoding:'utf8',shell:process.platform==='win32',maxBuffer:1<<26});return {code:r.status,out:r.stdout||'',err:(r.stderr||'').replace(/[A-Za-z0-9+/_=-]{24,}/g,'<x>')};};
let value='';
function cleanup(){
  value='';
  if(keep)return true;
  nl(['env:unset',name,'--site',site,'--force']);   // all contexts: the Netlify screen may also have created empty entries for the other contexts
  let gone=true;
  for(const ctx of ['production','deploy-preview','branch-deploy','dev']){let after={};try{after=JSON.parse(nl(['env:list','--site',site,'--context',ctx,'--json']).out||'{}');}catch(e){gone=false;}
    if(Object.prototype.hasOwnProperty.call(after,name))gone=false;}
  console.log(gone?'variable '+name+' removed and verified absent':'WARNING: variable '+name+' is STILL SET - remove it in the Netlify screen');
  return gone;
}
function finish(code){const gone=cleanup();process.exit(code||(gone?0:1));}
// 1. the transfer site must be empty
const s=JSON.parse(nl(['api','getSite','--data',q({site_id:site})]).out||'{}');
if(!s.id)die('cannot read the site');
if((s.build_settings&&s.build_settings.repo_url)||s.published_deploy)die('the transfer site has a repository or a deploy: refusing (nothing may be able to build or serve with this value)',3);
if(JSON.parse(nl(['api','listSiteDeploys','--data',q({site_id:site})]).out||'[]').length)die('the transfer site has deploys: refusing',3);
// 2. the variable must exist ONLY in the Local development context
const seen={};
for(const ctx of ['production','deploy-preview','branch-deploy','dev']){try{const o=JSON.parse(nl(['env:list','--site',site,'--context',ctx,'--json']).out||'{}');seen[ctx]=Object.prototype.hasOwnProperty.call(o,name)&&o[name]!=='';}catch(e){die('cannot list variables for '+ctx);}}
if(!seen.dev)die('the variable '+name+' is not set for the Local development context yet');
const others=['production','deploy-preview','branch-deploy'].filter(c=>seen[c]);
if(others.length){cleanup();die('the variable was also set for: '+others.join(', ')+' - it must exist only for Local development. It was removed; enter it again for Local development only.',3);}
// 3. read the value (captured, never echoed). Only a trailing line break added by copy/paste is removed; nothing else is changed.
const got=nl(['env:get',name,'--site',site,'--context','dev','--json']);
try{const o=JSON.parse(got.out);value=typeof o==='string'?o:(o[name]??Object.values(o)[0]??'');}catch(e){value=(got.out||'').replace(/\r?\n$/,'');}
value=String(value).replace(/[\r\n]+$/,'');
if(!value){cleanup();die('the variable could not be read (was "Contains secret values" ticked? it must be OFF, otherwise the value cannot be read back)');}
// 4. build the connection environment
let env,secrets,target;
const target0=LOCAL?{host:'127.0.0.1',port:LOCAL.split(':')[1]||'5432',user:LOCAL.split(':')[0]||'postgres',db:LOCAL.split(':')[2]||'postgres'}:TARGETS[label];
if(LOCAL&&!/^[A-Za-z0-9_.]+:[0-9]+:[A-Za-z0-9_]+$/.test(LOCAL))die('bad --local-target');
if(pwVar){
  target=target0;const pw=value;
  if(/^\s|\s$/.test(pw)){console.log('note: the password has a leading or trailing space; it is used exactly as entered');}
  env={...process.env,MANEE_DB_HOST:target.host,MANEE_DB_PORT:target.port,MANEE_DB_USER:target.user,MANEE_DB_PASSWORD:pw,MANEE_DB_NAME:target.db,MANEE_ENV:label};
  secrets=[pw,encodeURIComponent(pw),target.user,target.host];
}else{
  let u;try{u=new URL(value);}catch(e){cleanup();die('the value is not a valid URI');}
  env={...process.env,MANEE_DB_URL:value,MANEE_ENV:label};secrets=[value,u.password,safeDecode(u.password),u.username,u.hostname];
}
function safeDecode(x){try{return decodeURIComponent(x);}catch(e){return x;}}
delete env.PGHOST;delete env.PGPASSWORD;delete env.PGUSER;delete env.PGPORT;delete env.PGDATABASE;
const PGBIN=process.env.PGBIN||'';const psql=path.join(PGBIN,'psql'+(process.platform==='win32'?'.exe':''));
if(check){
  // connection test only: SELECT 1 as the real login, nothing is read from the tables
  if(pwVar)console.log('target: host '+target.host+', port '+target.port+', user '+target.user+', database '+target.db+' | password: '+value.length+' characters, used unchanged');
  const cenv={...process.env};for(const k of Object.keys(cenv))if(/^PG/.test(k))delete cenv[k];
  if(pwVar)Object.assign(cenv,{PGHOST:target.host,PGPORT:target.port,PGUSER:target.user,PGPASSWORD:value,PGDATABASE:target.db,PGSSLMODE:LOCAL?'disable':'require',PGCONNECT_TIMEOUT:'15'});
  else{const u=new URL(value);Object.assign(cenv,{PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:safeDecode(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1))||'postgres',PGSSLMODE:LOCAL?'disable':'require',PGCONNECT_TIMEOUT:'15'});}
  const r=spawnSync(psql,['-qAt','-c','select 1'],{encoding:'utf8',env:cenv});
  if(r.status===0){console.log('CONNECTION OK (login accepted; nothing was read)');}
  else console.log('CONNECTION FAILED: '+redact((r.stderr||'').split('\n').filter(l=>/FATAL|error|refused|timeout/i.test(l)).join(' ').slice(0,200),secrets)+'\n(no data was touched)');
  finish(r.status===0?0:1);
}
// 5. run the backup with the value in the child's environment only
const child=spawn(process.execPath,[path.join(here,'..','security','backup-run.mjs'),'backup','--out',out],{env,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',d=>process.stdout.write(redact(String(d),secrets)+'\n'));child.stderr.on('data',d=>process.stderr.write(redact(String(d),secrets)+'\n'));
child.on('close',code=>finish(code));
