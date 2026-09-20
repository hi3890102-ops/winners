#!/usr/bin/env node
// Deploys a folder made by staging-build.mjs to a SEPARATE Netlify test site as a draft. DRY RUN unless --execute is given.
//   node scripts/staging-deploy.mjs --site <test site id> --folder <build folder> --alias <name> [--baseline] [--execute]
// Every run, before anything else: (1) refuses the production site ids, (2) preflight of the folder, (3) read-only check that the site
// (including inherited team variables) holds no production URL/key/secret. Only then does it print (dry run) or run the deploy.
// The deploy uses --no-build (the verified files are published byte for byte, nothing is rebuilt under another context), a draft (never
// --prod), and runs from the build folder so its netlify.toml and functions are the ones that were checked.
import {spawnSync} from 'node:child_process';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const arg=n=>{const i=process.argv.indexOf(n);return i>0?process.argv[i+1]:null;};
const site=arg('--site'),folder=arg('--folder'),alias=arg('--alias'),execute=process.argv.includes('--execute');
const DENY=['a94b0ecc-833a-4e33-8ead-076783e6243b','f13b2709-fd79-4855-a020-e0f797779428','cb72151d-5a81-4248-843c-fffded351e36'];
if(!site||!folder||!alias){console.error('usage: staging-deploy.mjs --site <id> --folder <dir> --alias <name> [--execute]');process.exit(2);}
if(DENY.includes(site)){console.error('REFUSED: production site id.');process.exit(3);}
if(process.argv.includes('--prod')){console.error('REFUSED: --prod is not supported; staging deploys are drafts.');process.exit(3);}
if(!/^[a-z0-9-]{3,30}$/.test(alias)){console.error('alias must be lowercase letters, digits and dashes');process.exit(2);}
const step=(name,script,args)=>{const r=spawnSync(process.execPath,[join(here,script),...args],{stdio:'inherit'});if(r.status!==0){console.error('\nSTOPPED at: '+name);process.exit(r.status||1);}};
step('preflight of the build folder','staging-preflight.mjs',[folder,...(process.argv.includes('--baseline')?['--baseline']:[])]);
step('Netlify variable check of the test site','netlify-env-check.mjs',['--site',site]);
const cmd=['netlify','deploy','--dir','dist','--no-build','--site',site,'--alias',alias,'--message','"staging test build"','--json'];
console.log('\ncommand (run from '+resolve(folder)+'):\n  '+cmd.join(' '));
if(!execute){console.log('\nDRY RUN: nothing was created or deployed. Re-run with --execute only after the deploy is approved.');process.exit(0);}
const r=spawnSync(cmd.join(' '),{cwd:resolve(folder),shell:true,stdio:'inherit'});process.exit(r.status||0);
