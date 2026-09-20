#!/usr/bin/env node
// Independent, off-database backup of a Supabase project with pg_dump, a restore rehearsal into an ISOLATED local PostgreSQL, and
// public-key sealing of the backup files. Read-only against the source (SELECT and pg_dump only).
//
// Secrets: the connection string is read from MANEE_DB_URL, split into PG* environment variables for the child tools (it never appears
// on a command line) and every message that could contain it, the password, the user, the host, a hostname of supabase.co/.com or a data
// row (pg_restore prints failing COPY lines) is redacted before it is shown. Reports contain table names, counts, hashes and sizes only.
//
//   set MANEE_DB_URL=<postgres connection string, Session pooler URI>   set MANEE_ENV=staging|production   set PGBIN=<pg tools folder>
//   node security/backup-run.mjs backup   [--out <folder>]           consistent snapshot: digest + pg_dump of the same snapshot
//   node security/backup-run.mjs verify   <folder>                    files vs manifest (sealed or plain)
//   node security/backup-run.mjs rehearse <folder>                    restore into a temporary LOCAL database and compare hashes
//   node security/backup-run.mjs keygen   <folder>                    RSA key pair (keep the PRIVATE key offline, away from the backups)
//   node security/backup-run.mjs seal     <folder> --pubkey <pem> [--delete-plain --key <private pem>]
//   node security/backup-run.mjs unseal   <folder> --key <private pem> --out <empty folder>
import {spawn,spawnSync} from 'node:child_process';
import {createHash,createCipheriv,createDecipheriv,generateKeyPairSync,publicEncrypt,privateDecrypt,randomBytes,constants,createPublicKey} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';

const PGBIN=process.env.PGBIN||'';
const bin=n=>path.join(PGBIN,n+(process.platform==='win32'?'.exe':''));
const label=process.env.MANEE_ENV||'unlabeled';
const sha=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sha256=b=>createHash('sha256').update(b).digest('hex');
const fail=m=>{const e=new Error(m);e.userFacing=true;throw e;};
const need=(c,m)=>{if(!c)fail(m);};

// ---------- connection handling and redaction ----------
const PG_ENV_KEYS=['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE','PGSERVICEFILE','PGPASSFILE','PGSSLMODE','PGSSLCERT','PGSSLKEY','PGSSLROOTCERT','PGOPTIONS','PGCONNECT_TIMEOUT','DATABASE_URL','MANEE_DB_URL','MANEE_DB_HOST','MANEE_DB_PORT','MANEE_DB_USER','MANEE_DB_PASSWORD','MANEE_DB_NAME'];
export function parseConn(u){
  const x=new URL(u);need(/^postgres(ql)?:$/.test(x.protocol),'MANEE_DB_URL must be a postgres:// URI');
  return {host:x.hostname,port:x.port||'5432',user:decodeURIComponent(x.username),password:decodeURIComponent(x.password),db:decodeURIComponent(x.pathname.replace(/^\//,''))||'postgres',
    sslmode:x.searchParams.get('sslmode')||(['127.0.0.1','localhost'].includes(x.hostname)?'disable':'require')};
}
// Either MANEE_DB_URL (a URI) or the separate variables MANEE_DB_HOST / _PORT / _USER / _PASSWORD / _NAME. In the separate form the password
// is used exactly as given (no URI is built, so nothing is encoded or decoded).
export function connFromEnv(){
  if(process.env.MANEE_DB_HOST){
    const e=process.env;need(e.MANEE_DB_USER&&e.MANEE_DB_PASSWORD,'MANEE_DB_USER and MANEE_DB_PASSWORD are required with MANEE_DB_HOST');
    return {host:e.MANEE_DB_HOST,port:e.MANEE_DB_PORT||'5432',user:e.MANEE_DB_USER,password:e.MANEE_DB_PASSWORD,db:e.MANEE_DB_NAME||'postgres',
      sslmode:['127.0.0.1','localhost'].includes(e.MANEE_DB_HOST)?'disable':'require'};
  }
  need(process.env.MANEE_DB_URL,'MANEE_DB_URL (or MANEE_DB_HOST/USER/PASSWORD) is not set');
  return parseConn(process.env.MANEE_DB_URL);
}
export function envFor(c){return {...cleanEnv(),PGHOST:c.host,PGPORT:String(c.port),PGUSER:c.user,PGPASSWORD:c.password,PGDATABASE:c.db,PGSSLMODE:c.sslmode,PGCONNECT_TIMEOUT:'20'};}
function cleanEnv(){const e={...process.env};for(const k of PG_ENV_KEYS)delete e[k];return e;}
export function redact(text,secrets=[]){
  let t=String(text||'');
  for(const s of secrets.filter(x=>x&&String(x).length>=3))t=t.split(String(s)).join('<redacted>');
  t=t.replace(/postgres(ql)?:\/\/[^\s'"]+/gi,'<connection-string>').replace(/[a-z0-9.-]+\.(supabase\.(co|com)|pooler\.supabase\.com)/gi,'<host>');
  // a failing COPY/INSERT statement echoes row data: keep only the first line of an error and drop statement/detail lines entirely
  return t.split('\n').filter(l=>l.trim()&&!/^(COPY|INSERT|DETAIL|CONTEXT|HINT|Command was|LINE \d+)/i.test(l.trim())).map(l=>l.replace(/"[^"]{0,200}"/g,'"…"').slice(0,140)).join('\n');
}
let SECRETS=[];
function remember(c){SECRETS=[c.password,c.user,c.host,c.db].filter(Boolean);}
function run(cmd,args,env,opts={}){
  const r=spawnSync(cmd,args,{encoding:'utf8',maxBuffer:1<<28,env,...opts});
  return {code:r.status,out:r.stdout||'',err:redact(r.stderr||'',SECRETS),rawErr:r.stderr||''};
}

// ---------- SQL ----------
const TABLES_SQL=`select table_schema||'.'||table_name from information_schema.tables where table_type='BASE TABLE'
  and table_schema not in ('pg_catalog','information_schema') order by 1`;
const inDump=t=>/^(public|private)\./.test(t)||t==='auth.users'||t==='auth.identities';
// The hash is over each row's TEXT form, which depends on session settings (time zone, date style, float digits). They are pinned so the source
// and the restored copy are compared under identical rules. The ROW ORDER inside the hash is also pinned (collate "C"): the source database
// (en_US.UTF-8) and a restored copy on another OS sort text differently, which made two production columns look "different" although their content was identical.
const DIGEST_SQL=`set timezone='UTC'; set datestyle='ISO, MDY'; set intervalstyle='postgres'; set extra_float_digits=1; set bytea_output='hex';
select 'T|'||table_schema||'.'||table_name||'|'||
 (xpath('/row/c/text()',query_to_xml(format('select count(*) as c from %I.%I',table_schema,table_name),false,true,'')))[1]::text||'|'||
 (xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,%L order by x::text collate "C"),%L)) as h from %I.%I x','|','',table_schema,table_name),false,true,'')))[1]::text
from information_schema.tables where table_type='BASE TABLE' and (table_schema in ('public','private') or (table_schema='auth' and table_name in ('users','identities')));
select 'B|'||c.table_schema||'.'||c.table_name||'.'||c.column_name||'|'||
 (xpath('/row/c/text()',query_to_xml(format('select coalesce(sum(length(%I::text)),0) as c from %I.%I',c.column_name,c.table_schema,c.table_name),false,true,'')))[1]::text||'|'||
 (xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(%I::text,%L order by %I::text collate "C"),%L)) as h from %I.%I',c.column_name,'|',c.column_name,'',c.table_schema,c.table_name),false,true,'')))[1]::text
from information_schema.columns c join information_schema.tables t using(table_schema,table_name)
where t.table_type='BASE TABLE' and c.data_type in ('jsonb','json','bytea') and c.table_schema in ('public','private');`;
function parseDigest(out){
  const tables={},blobs={};
  for(const l of out.split(/\r?\n/)){const p=l.trim().split('|');
    if(p[0]==='T'&&p.length>=4)tables[p[1]]={rows:Number(p[2]),md5:p[3]};
    if(p[0]==='B'&&p.length>=4)blobs[p[1]]={textBytes:Number(p[2]),md5:p[3]};}
  return {tables,blobs};
}
function digestOnce(env){
  const r=run(bin('psql'),['-qAt','-c',DIGEST_SQL],env);need(r.code===0,'digest query failed: '+r.err.split('\n')[0]);return parseDigest(r.out);
}
// One repeatable-read transaction is kept open; its exported snapshot is used by the digest AND by every pg_dump, so digest and dump
// describe exactly the same state even while the production data keeps changing.
function openSnapshot(env){
  return new Promise((resolve,reject)=>{
    const child=spawn(bin('psql'),['-qAt','-v','ON_ERROR_STOP=1'],{env,stdio:['pipe','pipe','pipe']});
    let buf='',err='';const waiters=[];
    child.stdout.on('data',d=>{buf+=d;for(const w of [...waiters])w();});child.stderr.on('data',d=>err+=d);
    const waitFor=marker=>new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('timeout waiting for the database')),120000);
      const check=()=>{const i=buf.indexOf(marker);if(i>=0){clearTimeout(t);const seg=buf.slice(0,i);buf=buf.slice(i+marker.length);waiters.splice(waiters.indexOf(check),1);res(seg);}};waiters.push(check);check();});
    child.on('error',reject);child.on('exit',c=>{if(c)reject(new Error('psql exited: '+redact(err,SECRETS).split('\n')[0]));});
    (async()=>{
      child.stdin.write("begin isolation level repeatable read read only;\nselect 'SNAP:'||pg_export_snapshot();\nselect 'M1END';\n");
      const seg=await waitFor('M1END');const m=seg.match(/SNAP:(\S+)/);if(!m)throw new Error('no snapshot id (a transaction-mode pooler cannot export snapshots; use the Session pooler)');
      resolve({id:m[1],digest:async()=>{child.stdin.write(DIGEST_SQL+"\nselect 'M2END';\n");return parseDigest(await waitFor('M2END'));},
        close:()=>{try{child.stdin.write('commit;\n\\q\n');}catch(e){}}});
    })().catch(reject);
  });
}

// ---------- folder rules ----------
function insideRepo(dir){for(let p=path.resolve(dir);;){if(fs.existsSync(path.join(p,'.git')))return true;const up=path.dirname(p);if(up===p)return false;p=up;}}
function restrictAccess(dir){
  try{
    if(process.platform==='win32'){const u=process.env.USERNAME||os.userInfo().username;const r=spawnSync('icacls',[dir,'/inheritance:r','/grant:r',u+':(OI)(CI)F'],{encoding:'utf8'});return r.status===0?'only the current Windows user has access (icacls)':'could not restrict access: set it manually';}
    fs.chmodSync(dir,0o700);return 'mode 700';
  }catch(e){return 'could not restrict access: set it manually';}
}

// ---------- backup ----------
async function cmd_backup(){
  need(PGBIN&&fs.existsSync(bin('pg_dump')),'PGBIN must point to the PostgreSQL client tools');
  const c=connFromEnv();remember(c);const env=envFor(c);
  const stamp=new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'Z';
  const oi=process.argv.indexOf('--out');
  const dir=oi>0?process.argv[oi+1]:path.join(os.homedir(),'Desktop','manee-backups',label+'-'+stamp);
  need(!insideRepo(dir),'the output folder must be outside every git repository (backups contain personal data)');
  need(!fs.existsSync(dir)||fs.readdirSync(dir).length===0,'output folder exists and is not empty');
  fs.mkdirSync(dir,{recursive:true});const access=restrictAccess(dir);
  const inv=run(bin('psql'),['-qAt','-c',TABLES_SQL],env);need(inv.code===0,'cannot read the table list: '+inv.err.split('\n')[0]);
  const allTables=inv.out.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);   // Windows tools print \r\n
  const wanted=allTables.filter(inDump);
  console.log('[1/6] snapshot + digest of the state that will be dumped');
  const snap=await openSnapshot(env);let snapDigest;
  try{
    snapDigest=await snap.digest();
    console.log('[2/6] pg_dump public+private (data, custom format)');
    let r=run(bin('pg_dump'),['-Fc','--no-owner','--no-privileges','--snapshot='+snap.id,'-n','public','-n','private','-f',path.join(dir,'data.dump')],env);
    need(r.code===0,'pg_dump (public/private) failed: '+r.err.split('\n')[0]);
    console.log('[3/6] pg_dump auth accounts (auth.users, auth.identities) - a separate dump: -n and -t combined would silently intersect');
    r=run(bin('pg_dump'),['-Fc','--no-owner','--no-privileges','--snapshot='+snap.id,'-t','auth.users','-t','auth.identities','-f',path.join(dir,'auth-accounts.dump')],env);
    need(r.code===0,'pg_dump (auth accounts) failed: '+r.err.split('\n')[0]);
    console.log('[4/6] definitions of all schemas (no data)');
    r=run(bin('pg_dump'),['--schema-only','--no-owner','--snapshot='+snap.id,'-f',path.join(dir,'definitions.sql')],env);
    need(r.code===0,'pg_dump (definitions) failed: '+r.err.split('\n')[0]);
  }finally{snap.close();}
  console.log('[5/6] coverage: every table that should be in the dump is listed in it');
  const listed=new Set();
  for(const f of ['data.dump','auth-accounts.dump']){const l=run(bin('pg_restore'),['-l',path.join(dir,f)],cleanEnv());need(l.code===0,'pg_restore -l failed');
    for(const m of l.out.matchAll(/TABLE DATA (\S+) (\S+)/g))listed.add(m[1]+'.'+m[2]);}
  const missing=wanted.filter(t=>!listed.has(t));need(missing.length===0,'tables missing from the dump: '+missing.join(', '));
  const live=digestOnce(env);
  const drift=Object.keys(live.tables).filter(t=>!snapDigest.tables[t]||snapDigest.tables[t].md5!==live.tables[t].md5);
  console.log('[6/6] manifest');
  const files={};for(const f of fs.readdirSync(dir)){const p=path.join(dir,f);files[f]={bytes:fs.statSync(p).size,sha256:sha(p)};}
  const notInDump=allTables.filter(t=>!inDump(t));
  const manifest={label,createdAt:new Date().toISOString(),tool:'security/backup-run.mjs',pgDump:run(bin('pg_dump'),['--version'],cleanEnv()).out.trim(),consistentSnapshot:true,files,
    coverage:{includedTables:wanted,excludedTables:notInDump.map(t=>({table:t,reason:/^auth\./.test(t)?'auth internals (sessions, refresh tokens, audit log, MFA...) - not needed to restore accounts and not recoverable as tokens':'platform-managed schema'})),
      photoAndBinaryColumns:Object.keys(snapDigest.blobs),notInAnyDump:['Edge Function source and secrets','project and Auth settings','API keys','Storage objects (none exist in these projects; photos are jsonb inside public.sales_reports)']},
    snapshotDigest:snapDigest,liveDigestAfter:live,changedSinceSnapshot:drift,accessRestriction:access,
    proves:['every public/private table and auth.users/identities is in the dump (checked against pg_restore -l)','digest and dump were taken from ONE snapshot, so a later restore must match it exactly','files exist with the recorded size and SHA-256'],
    doesNotProve:['that the dump restores (run "rehearse")','that a restore into Supabase itself works','that the files are still unchanged later (run "verify")']};
  fs.writeFileSync(path.join(dir,'MANIFEST.json'),JSON.stringify(manifest,null,2));
  console.log('OK backup written ('+access+')');
  console.log('tables in dump: '+wanted.length+' | rows: '+Object.values(snapDigest.tables).reduce((a,b)=>a+b.rows,0)+' | photo/binary columns: '+Object.keys(snapDigest.blobs).length+' | changed in the live database since the snapshot: '+(drift.length?drift.join(', '):'none')+' (normal for a live system; not a backup defect)');
  for(const [f,v] of Object.entries(files))console.log('  '+f+'  '+v.bytes+' bytes  sha256 '+v.sha256.slice(0,16)+'…');
  console.log('NOT a completed backup yet: run verify, then rehearse, then seal + store the private key separately.');
}

// ---------- verify ----------
function readManifest(dir){need(fs.existsSync(path.join(dir,'MANIFEST.json')),'MANIFEST.json not found');return JSON.parse(fs.readFileSync(path.join(dir,'MANIFEST.json'),'utf8'));}
function cmd_verify(dir){
  const m=readManifest(dir);let bad=0;const sealed=fs.existsSync(path.join(dir,'SEALED.json'))?JSON.parse(fs.readFileSync(path.join(dir,'SEALED.json'),'utf8')):null;
  for(const [f,v] of Object.entries(m.files)){
    const p=path.join(dir,f);let state;
    if(fs.existsSync(p))state=fs.statSync(p).size===v.bytes&&sha(p)===v.sha256?'OK (plain)':'CHANGED';
    else if(sealed&&sealed.files[f]&&fs.existsSync(path.join(dir,f+'.enc')))state=sha(path.join(dir,f+'.enc'))===sealed.files[f].encSha256?'OK (sealed)':'CHANGED (sealed file differs)';
    else state='MISSING';
    if(!state.startsWith('OK'))bad++;console.log(state.padEnd(10)+' '+f);}
  console.log(bad?bad+' file(s) missing or changed - this backup is damaged or was altered':'all files match (this is NOT a restore test)');process.exitCode=bad?1:0;
}

// ---------- restore rehearsal (only ever a temporary LOCAL cluster this command creates itself) ----------
function cmd_rehearse(dir){
  need(PGBIN,'PGBIN is not set');
  const m=readManifest(dir);
  for(const f of ['data.dump','auth-accounts.dump']){const p=path.join(dir,f);need(fs.existsSync(p)&&sha(p)===m.files[f].sha256,f+' is missing, sealed or does not match the manifest (unseal first / the file is damaged)');}
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'manee-restore-'));const port=String(56000+Math.floor(Math.random()*900));
  const cluster=path.join(work,'pgdata');const HOST='127.0.0.1';
  const env={...cleanEnv(),PGHOST:HOST,PGPORT:port,PGUSER:'postgres',PGCONNECT_TIMEOUT:'10'};   // no inherited PG*/MANEE_* variable can point this at a real database
  let r=run(bin('initdb'),['-D',cluster,'-U','postgres','-A','trust','-E','UTF8'],env);need(r.code===0,'initdb failed');
  r=run(bin('pg_ctl'),['-D',cluster,'-o','-p '+port+' -c listen_addresses='+HOST,'-l',path.join(work,'pg.log'),'-w','start'],env,{stdio:'ignore'});need(r.code===0,'local server did not start');
  try{
    need(env.PGHOST===HOST,'restore target must be the local rehearsal server');
    run(bin('psql'),['-d','postgres','-qc','create database restored'],env);
    const denv={...env,PGDATABASE:'restored'};
    // compatibility shim for the isolated rehearsal database ONLY: Supabase roles, auth helper functions, extensions schema
    run(bin('psql'),['-q','-c',`create role anon nologin; create role authenticated nologin; create role service_role nologin; create role authenticator nologin;
      create schema if not exists auth; create schema if not exists extensions; create extension if not exists pgcrypto with schema extensions;
      create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create or replace function auth.role() returns text language sql stable as $$ select null::text $$;`],denv);
    let errText='';
    for(const f of ['data.dump','auth-accounts.dump']){const rs=run(bin('pg_restore'),['-d','restored','--no-owner','--no-privileges',path.join(dir,f)],denv);errText+=rs.err+'\n';}
    const errors=errText.split('\n').filter(l=>/error:/i.test(l));
    const got=digestOnce(denv);
    const diff=[],missing=[];let same=0;
    for(const [t,v] of Object.entries(m.snapshotDigest.tables)){if(!got.tables[t]){missing.push(t);continue;}
      got.tables[t].rows===v.rows&&got.tables[t].md5===v.md5?same++:diff.push(t);}
    const blobDiff=[];let blobBytes=0;
    for(const [k,v] of Object.entries(m.snapshotDigest.blobs)){const g=got.blobs[k];if(!g||g.md5!==v.md5||g.textBytes!==v.textBytes)blobDiff.push(k);else blobBytes+=v.textBytes;}
    console.log('pg_restore messages: '+errors.length+(errors.length?' (first ones, redacted):':''));if(errors.length)console.log(errors.slice(0,8).join('\n'));
    console.log('tables: '+Object.keys(m.snapshotDigest.tables).length+' | identical (rows + content hash): '+same+' | different: '+diff.length+' | not restored: '+missing.length);
    console.log('photo/binary columns compared: '+Object.keys(m.snapshotDigest.blobs).length+' ('+blobBytes+' text bytes identical) | different: '+blobDiff.length);
    if(diff.length)console.log('different: '+diff.join(', '));if(missing.length)console.log('not restored: '+missing.join(', '));if(blobDiff.length)console.log('photo/binary differences: '+blobDiff.join(', '));
    const ok=!diff.length&&!missing.length&&!blobDiff.length;
    console.log(ok?'RESTORE REHEARSAL PASSED (isolated local PostgreSQL; the source project was never contacted)':'RESTORE REHEARSAL DID NOT PASS - the backup is missing or damaged data');
    process.exitCode=ok?0:1;
  }finally{run(bin('pg_ctl'),['-D',cluster,'-m','immediate','stop'],env,{stdio:'ignore'});try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}}
}

// ---------- sealing (hybrid RSA-OAEP + AES-256-GCM; only the PUBLIC key is needed to create a backup) ----------
const MAGIC=Buffer.from('MANEEBK1');
export function sealBuffer(plain,pubPem){
  const key=randomBytes(32),iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',key,iv);const ct=Buffer.concat([c.update(plain),c.final()]);
  const wrapped=publicEncrypt({key:pubPem,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
  const head=Buffer.alloc(2);head.writeUInt16BE(wrapped.length);return Buffer.concat([MAGIC,head,wrapped,iv,ct,c.getAuthTag()]);
}
export function unsealBuffer(blob,privPem){
  need(blob.subarray(0,8).equals(MAGIC),'not a sealed backup file');const wl=blob.readUInt16BE(8);
  const wrapped=blob.subarray(10,10+wl),iv=blob.subarray(10+wl,22+wl),tag=blob.subarray(blob.length-16),ct=blob.subarray(22+wl,blob.length-16);
  const key=privateDecrypt({key:privPem,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},wrapped);
  const d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);return Buffer.concat([d.update(ct),d.final()]);
}
function arg(name){const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:null;}
function cmd_keygen(dir){
  need(!insideRepo(dir),'keep key files outside every git repository');fs.mkdirSync(dir,{recursive:true});
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:4096,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  need(!fs.existsSync(path.join(dir,'manee-backup-private.pem')),'a key already exists in this folder');
  fs.writeFileSync(path.join(dir,'manee-backup-public.pem'),publicKey);fs.writeFileSync(path.join(dir,'manee-backup-private.pem'),privateKey,{mode:0o600});
  const fp=sha256(createPublicKey(publicKey).export({type:'spki',format:'der'})).slice(0,32);
  console.log('public key : manee-backup-public.pem  (used to seal backups; not secret)\nprivate key: manee-backup-private.pem (needed to open a backup)\nfingerprint: '+fp+'\nStore the PRIVATE key offline and separately from the backups (e.g. a password manager attachment). Without it a sealed backup cannot be restored; anyone holding it and the backup can read the data.');
}
function cmd_seal(dir){
  const pub=arg('--pubkey');need(pub&&fs.existsSync(pub),'--pubkey <pem> is required');const pem=fs.readFileSync(pub,'utf8');
  const m=readManifest(dir);const sealed={sealedAt:new Date().toISOString(),cipher:'RSA-OAEP-SHA256 wrapped AES-256-GCM',files:{}};
  for(const f of Object.keys(m.files)){const p=path.join(dir,f);need(fs.existsSync(p)&&sha(p)===m.files[f].sha256,f+' is missing or changed - refusing to seal');
    const enc=sealBuffer(fs.readFileSync(p),pem);fs.writeFileSync(p+'.enc',enc);sealed.files[f]={encSha256:sha256(enc)};console.log('sealed '+f);}
  fs.writeFileSync(path.join(dir,'SEALED.json'),JSON.stringify(sealed,null,2));
  if(process.argv.includes('--delete-plain')){
    const key=arg('--key');need(key&&fs.existsSync(key),'--delete-plain requires --key <private pem> to prove the sealed files can be opened first');const priv=fs.readFileSync(key,'utf8');
    for(const f of Object.keys(m.files)){const back=unsealBuffer(fs.readFileSync(path.join(dir,f+'.enc')),priv);need(sha256(back)===m.files[f].sha256,'sealed '+f+' does not decrypt to the original - plain files kept');}
    for(const f of Object.keys(m.files))fs.rmSync(path.join(dir,f));console.log('plain files removed after a successful test decryption');
  }else console.log('plain files kept. Test "unseal" with the private key, then delete the plain files yourself (or re-run with --delete-plain --key).');
}
function cmd_unseal(dir){
  const key=arg('--key'),out=arg('--out');need(key&&out,'--key and --out are required');need(!insideRepo(out),'--out must be outside every git repository');
  need(!fs.existsSync(out)||fs.readdirSync(out).length===0,'--out must be an empty folder');fs.mkdirSync(out,{recursive:true});restrictAccess(out);
  const m=readManifest(dir),priv=fs.readFileSync(key,'utf8');
  for(const [f,v] of Object.entries(m.files)){const b=unsealBuffer(fs.readFileSync(path.join(dir,f+'.enc')),priv);need(sha256(b)===v.sha256,f+' decrypted but does not match the manifest');fs.writeFileSync(path.join(out,f),b);}
  fs.copyFileSync(path.join(dir,'MANIFEST.json'),path.join(out,'MANIFEST.json'));console.log('unsealed and verified against the manifest: '+out+' (delete this folder after use)');
}

// ---------- entry ----------
const isMain=process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href;
if(isMain){
  const [,,sub,a]=process.argv;
  Promise.resolve().then(()=>{
    if(sub==='backup')return cmd_backup();if(sub==='verify')return cmd_verify(a);if(sub==='rehearse')return cmd_rehearse(a);
    if(sub==='keygen')return cmd_keygen(a);if(sub==='seal')return cmd_seal(a);if(sub==='unseal')return cmd_unseal(a);
    console.error('usage: backup-run.mjs backup [--out dir] | verify <dir> | rehearse <dir> | keygen <dir> | seal <dir> --pubkey pem [--delete-plain --key pem] | unseal <dir> --key pem --out dir');process.exitCode=2;
  }).catch(e=>{console.error('ERROR: '+(e&&e.userFacing?e.message:redact(e&&e.message,SECRETS).split('\n')[0]||'unexpected failure'));process.exitCode=2;});
}
