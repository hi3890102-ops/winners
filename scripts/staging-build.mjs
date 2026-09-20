#!/usr/bin/env node
// Builds a STAGING site folder from a git ref (the production baseline, e.g. 2e4e162) or from the working tree (the changed version)
// into a separate folder, never touching the repository's own dist/ or the tracked netlify/functions/lib/manee-environment.json.
//   node scripts/staging-build.mjs --ref 2e4e162 --out <folder>          baseline (what production runs)
//   node scripts/staging-build.mjs --worktree --out <folder>             changed version (uncommitted files included)
// The folder can be deployed with scripts/staging-deploy.mjs. BUILD.json records the source and the SHA-256 of every published file.
import {spawnSync} from 'node:child_process';
import {cpSync,mkdirSync,existsSync,readFileSync,readdirSync,statSync,writeFileSync,rmSync,mkdtempSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const arg=n=>{const i=process.argv.indexOf(n);return i>0?process.argv[i+1]:null;};
const out=arg('--out');if(!out){console.error('--out <folder> is required');process.exit(2);}
if(existsSync(out)&&readdirSync(out).length){console.error('output folder is not empty');process.exit(2);}
mkdirSync(out,{recursive:true});
const ref=arg('--ref');let source;
if(ref){
  const tmp=mkdtempSync(join(tmpdir(),'manee-src-'));
  const r=spawnSync('git',['-C',repo,'archive','--format=tar',ref],{maxBuffer:1<<28});if(r.status!==0){console.error('git archive failed');process.exit(2);}
  writeFileSync(join(tmp,'src.tar'),r.stdout);
  if(spawnSync('tar',['-xf','src.tar'],{cwd:tmp}).status!==0){console.error('tar failed');process.exit(2);}
  rmSync(join(tmp,'src.tar'));source=tmp;
  var sourceLabel='git '+ref+' ('+spawnSync('git',['-C',repo,'rev-parse','--short',ref],{encoding:'utf8'}).stdout.trim()+')';
}else if(process.argv.includes('--worktree')){
  source=mkdtempSync(join(tmpdir(),'manee-src-'));
  for(const p of ['index.html','owner-ui.css','manifest.json','sw.js','icons','config','scripts','netlify','netlify.toml','package.json'])if(existsSync(join(repo,p)))cpSync(join(repo,p),join(source,p),{recursive:true});
  var sourceLabel='working tree of '+spawnSync('git',['-C',repo,'rev-parse','--short','HEAD'],{encoding:'utf8'}).stdout.trim()+' + uncommitted changes';
}else{console.error('use --ref <git ref> or --worktree');process.exit(2);}
// the build always runs with an explicit STAGING context: no fallback to production exists in the build script
const b=spawnSync(process.execPath,['scripts/build-environment.mjs'],{cwd:source,env:{...process.env,CONTEXT:'deploy-preview',BRANCH:''},encoding:'utf8'});
if(b.status!==0){console.error('build failed: '+(b.stderr||b.stdout).split('\n')[0]);process.exit(2);}
for(const p of ['dist','netlify','netlify.toml','config'])if(existsSync(join(source,p)))cpSync(join(source,p),join(out,p),{recursive:true});
// The Netlify functions need their runtime dependencies (web-push, supabase-js) next to them when they are deployed with --no-build.
for(const p of ['package.json','package-lock.json'])if(existsSync(join(source,p)))cpSync(join(source,p),join(out,p));
const ni=spawnSync('npm',['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:out,encoding:'utf8',shell:process.platform==='win32'});
if(ni.status!==0){console.error('npm install of function dependencies failed');process.exit(2);}
const files={};(function walk(d){for(const f of readdirSync(d)){const p=join(d,f);statSync(p).isDirectory()?walk(p):files[relative(join(out,'dist'),p).replaceAll('\\','/')]=createHash('sha256').update(readFileSync(p)).digest('hex');}})(join(out,'dist'));
writeFileSync(join(out,'BUILD.json'),JSON.stringify({source:sourceLabel,context:'deploy-preview',builtAt:new Date().toISOString(),build:JSON.parse(b.stdout.trim().split('\n').pop()),publishedFiles:files},null,2));
rmSync(source,{recursive:true,force:true});
console.log('built '+sourceLabel+' -> '+out+' ('+Object.keys(files).length+' published files)');
