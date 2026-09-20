#!/usr/bin/env node
// Read-only check of the environment variables a Netlify site will hand to its builds and functions - including variables it INHERITS
// from the team (shared variables) - and refusal when anything points at production. It never prints a value: only variable names and a
// classification (staging / production / other) and lengths.
//
//   node scripts/netlify-env-check.mjs --site <site id> [--expect staging]      exit 0 only if no production URL/key/secret is visible
//
// Uses the logged-in Netlify CLI (read-only calls: env:list, api listAccountsForUser, api getEnvVars). Nothing is created or changed.
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const cfg=JSON.parse(readFileSync(resolve(root,'config/environments.json'),'utf8'));
const PROD={ref:cfg.production.projectRef,url:cfg.production.supabaseUrl,pub:cfg.production.publishableKey};
const STAGING={ref:cfg.staging.projectRef,url:cfg.staging.supabaseUrl};
const SITE_DENY=['a94b0ecc-833a-4e33-8ead-076783e6243b','f13b2709-fd79-4855-a020-e0f797779428','cb72151d-5a81-4248-843c-fffded351e36'];   // winners-staffapp, manee-partner, manee-hq (production sites)
const arg=n=>{const i=process.argv.indexOf(n);return i>0?process.argv[i+1]:null;};
export function classify(value){
  const s=String(value??'');
  if(s.includes(PROD.ref)||s.includes(PROD.url)||(PROD.pub&&s.includes(PROD.pub)))return 'PRODUCTION';
  if(/^sb_secret_/.test(s))return 'SECRET-KEY';
  if(/^eyJ/.test(s)){try{const p=JSON.parse(Buffer.from(s.split('.')[1],'base64url').toString());
    if(p.ref===PROD.ref)return 'PRODUCTION('+(p.role||'jwt')+')';if(p.ref===STAGING.ref)return 'staging('+(p.role||'jwt')+')';return 'jwt(other project)';}catch(e){return 'jwt';}}
  if(s.includes(STAGING.ref))return 'staging';
  return 'other';
}
export function evaluate(entriesByContext){
  const rows=[];let violations=0;
  for(const [ctx,entries] of Object.entries(entriesByContext))for(const [k,v] of Object.entries(entries)){const c=classify(v.value);const bad=c.startsWith('PRODUCTION')||c==='SECRET-KEY';if(bad)violations++;rows.push({context:ctx,name:k,source:v.source,class:c,length:String(v.value??'').length,bad});}
  return {rows,violations};
}
const q=o=>process.platform==='win32'?'"'+JSON.stringify(o).replace(/"/g,'\\"')+'"':JSON.stringify(o);
function cli(args){const r=spawnSync('netlify',args,{encoding:'utf8',shell:process.platform==='win32',maxBuffer:1<<26});return {code:r.status,out:r.stdout||''};}
function main(){
  const site=arg('--site');if(!site){console.error('usage: netlify-env-check.mjs --site <id>');process.exit(2);}
  const inspect=process.argv.includes('--inspect');   // read-only look at ANY site (e.g. a production site) - never reports "OK to deploy"
  if(SITE_DENY.includes(site)&&!inspect){console.error('REFUSED: this is a production site id. The staging test must use a separate site.');process.exit(3);}
  const byCtx={};
  for(const ctx of ['production','deploy-preview','branch-deploy','dev']){
    const r=cli(['env:list','--site',site,'--context',ctx,'--json']);let o={};try{o=JSON.parse(r.out||'{}');}catch(e){console.error('could not read variables for context '+ctx);process.exit(2);}
    byCtx[ctx]={};for(const [k,v] of Object.entries(o))byCtx[ctx][k]={value:v,source:'site or inherited (env:list merges them)'};
  }
  // Team-level shared variables are inherited by new sites. They are listed by the account-level call (no site id); site-level ones above.
  let teamNames=[];
  try{const acc=JSON.parse(cli(['api','listAccountsForUser']).out||'[]');
    for(const a of acc){const t=JSON.parse(cli(['api','getEnvVars','--data',q({account_id:a.id})]).out||'[]');
      for(const e of t)for(const val of (e.values||[{context:'all',value:''}])){const c=classify(val.value);teamNames.push({name:e.key,context:val.context,class:c,bad:c.startsWith('PRODUCTION')||c==='SECRET-KEY'});}}}
  catch(e){console.error('could not read team-level variables: refusing to give a verdict');process.exit(2);}
  const {rows,violations}=evaluate(byCtx);
  const teamBad=teamNames.filter(t=>t.bad).length;
  console.log('site '+site+' - variables per context (names and classes only, never values)');
  for(const r of rows)console.log((r.bad?'!! ':'   ')+r.context.padEnd(15)+r.name.padEnd(34)+r.class.padEnd(26)+'len='+r.length);
  console.log('variables from the team/account level visible to this site: '+teamNames.length+(teamBad?'  ('+teamBad+' point to production)':''));
  for(const t of teamNames)console.log((t.bad?'!! ':'   ')+String(t.context||'').padEnd(15)+String(t.name).padEnd(34)+t.class);
  if(violations||teamBad){console.log('STOP: '+(violations+teamBad)+' variable(s) contain a production address, key or secret. Do not deploy the staging build to this site.');process.exit(1);}
  console.log(inspect?'(inspect mode: no verdict about deploying)':'OK: no production URL, key or secret is visible to this site in any deploy context.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
