import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {redact,parseConn,envFor,sealBuffer,unsealBuffer} from './backup-run.mjs';
// Tests of security/backup-run.mjs. The first group needs nothing but Node. The second group runs the real pg_dump / pg_restore against a
// disposable LOCAL PostgreSQL and is skipped (reported as skipped, not as passed) unless PGBIN points to PostgreSQL 17 client+server tools.
const PGBIN=process.env.PGBIN||'';
const bin=n=>path.join(PGBIN,n+(process.platform==='win32'?'.exe':''));
const haveTools=!!PGBIN&&fs.existsSync(bin('pg_dump'))&&fs.existsSync(bin('initdb'));
const SCRIPT=new URL('./backup-run.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');

// ---------- no database needed ----------
test('redaction removes the connection string, password, user, host, supabase host names and data rows from any message',()=>{
  const c=parseConn('postgresql://postgres.abcdefghij:S3cretPw!@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres');
  const secrets=[c.password,c.user,c.host,c.db];
  const msg=['psql: error: connection to server at "aws-0-ap-northeast-2.pooler.supabase.com" failed: FATAL: password authentication failed for user "postgres.abcdefghij"',
    'postgresql://postgres.abcdefghij:S3cretPw!@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
    'pg_restore: error: COPY failed for table "crew": ERROR: invalid input',
    'COPY public.crew (id, name, phone, bank_account) FROM stdin; 1 홍길동 010-1234-5678 110-123-456789',
    'DETAIL: Failing row contains (1, 홍길동, 010-1234-5678).','Command was: COPY public.crew ...'].join('\n');
  const out=redact(msg,secrets);
  for(const bad of ['S3cretPw','abcdefghij','pooler.supabase.com','홍길동','010-1234','110-123','postgres://','postgresql://'])assert.equal(out.includes(bad),false,'leaked: '+bad);
  assert.match(out,/error/i);
});
test('the connection string becomes PG* variables for child tools (never argv) and inherited PG*/MANEE_* variables are cleared',()=>{
  process.env.PGHOST='inherited-host';process.env.DATABASE_URL='x';
  const e=envFor(parseConn('postgresql://u:p%40ss@db.example.com:6543/app?sslmode=require'));
  assert.equal(e.PGHOST,'db.example.com');assert.equal(e.PGPASSWORD,'p@ss');assert.equal(e.PGPORT,'6543');assert.equal(e.PGSSLMODE,'require');assert.equal(e.DATABASE_URL,undefined);
  delete process.env.PGHOST;delete process.env.DATABASE_URL;
});
test('sealing: round trip returns the exact bytes, the wrong key and any tampering are rejected, nothing readable is left in the sealed file',()=>{
  const a=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const b=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const plain=Buffer.from('PII-MARKER 홍길동 110-123-456789 '.repeat(5000));
  const sealed=sealBuffer(plain,a.publicKey);
  assert.equal(unsealBuffer(sealed,a.privateKey).equals(plain),true);
  assert.equal(sealed.includes(Buffer.from('PII-MARKER')),false);
  assert.throws(()=>unsealBuffer(sealed,b.privateKey));
  const t=Buffer.from(sealed);t[t.length-40]^=1;assert.throws(()=>unsealBuffer(t,a.privateKey));
});
test('the CLI refuses an output folder inside a git repository, without touching anything',()=>{
  const r=spawnSync(process.execPath,[SCRIPT,'keygen',path.join(process.cwd(),'security','_should_not_exist')],{encoding:'utf8'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/outside every git repository/);assert.equal(fs.existsSync(path.join(process.cwd(),'security','_should_not_exist')),false);
});
test('the restore command has no way to name a target: it takes only a backup folder and creates its own local server',()=>{
  const src=fs.readFileSync(SCRIPT,'utf8');
  const fn=src.slice(src.indexOf('function cmd_rehearse'),src.indexOf('// ---------- sealing'));
  assert.ok(fn.includes("const HOST='127.0.0.1'"));assert.ok(fn.includes('need(env.PGHOST===HOST'));
  assert.equal(/MANEE_DB_URL|parseConn\(|process\.env\.PG/.test(fn),false,'the rehearsal never reads the source connection');
  assert.equal(/pg_restore[^\n]*(-h|--host|postgres:\/\/)/.test(fn),false);
});

// ---------- real PostgreSQL tools on a disposable local server ----------
function pg(){
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'manee-bkt-'));const port=String(57000+Math.floor(Math.random()*900));
  const env={...process.env};for(const k of Object.keys(env))if(/^PG|^MANEE_/.test(k))delete env[k];Object.assign(env,{PGHOST:'127.0.0.1',PGPORT:port,PGUSER:'postgres'});
  assert.equal(spawnSync(bin('initdb'),['-D',path.join(work,'d'),'-U','postgres','-A','trust','-E','UTF8'],{env}).status,0);
  assert.equal(spawnSync(bin('pg_ctl'),['-D',path.join(work,'d'),'-o','-p '+port+' -c listen_addresses=127.0.0.1 -c timezone=Pacific/Auckland','-l',path.join(work,'l'),'-w','start'],{env,stdio:'ignore'}).status,0);
  const psql=(db,sql)=>{const r=spawnSync(bin('psql'),['-d',db,'-qAt','-v','ON_ERROR_STOP=1','-c',sql],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  psql('postgres','create database src');
  const seed=`create schema auth;create schema private;create extension pgcrypto;
   create table auth.users(id uuid primary key,email text,encrypted_password text);create table auth.sessions(id uuid primary key,note text);
   create table public.stores(id uuid primary key default gen_random_uuid(),name text,food_ratio_threshold numeric(5,2),created_at timestamptz default now());
   create table public.crew(id uuid primary key default gen_random_uuid(),name text,phone text,bank_account text);
   create table public.attendance(id serial primary key,crew_id uuid,day date);
   create table public.sales_reports(id uuid primary key default gen_random_uuid(),total_sales int,receipt_photos jsonb,settlement_photos jsonb);
   create table public.checklist_checks(id serial primary key,item text);
   create table private.staff_link_requests(id serial primary key,note text);
   insert into auth.users select gen_random_uuid(),'synthetic'||g||'@example.invalid',crypt('x'||g,gen_salt('bf')) from generate_series(1,40) g;
   insert into auth.sessions select gen_random_uuid(),'volatile' from generate_series(1,5);
   insert into public.stores(name,food_ratio_threshold) select 'store '||g,case when g%4=0 then 37.5 end from generate_series(1,20) g;
   insert into public.crew(name,phone,bank_account) select 'crew '||g,'000-'||g,'bank-'||g from generate_series(1,60) g;
   insert into public.attendance(crew_id,day) select id,current_date-g from public.crew,generate_series(1,5) g;
   insert into public.sales_reports(total_sales,receipt_photos,settlement_photos) select 1000+g,jsonb_build_array(jsonb_build_object('data',repeat(md5(g::text||'a'),8000))),jsonb_build_array(jsonb_build_object('data',repeat(md5(g::text||'b'),8000))) from generate_series(1,30) g;
   insert into public.checklist_checks(item) select 'i'||g from generate_series(1,50) g;insert into private.staff_link_requests(note) select 'n'||g from generate_series(1,10) g;`;
  psql('src',seed);
  return {work,port,env,psql,url:'postgresql://postgres:SecretPw123@127.0.0.1:'+port+'/src',stop(){spawnSync(bin('pg_ctl'),['-D',path.join(work,'d'),'-m','immediate','stop'],{env,stdio:'ignore'});try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}}};
}
function cli(args,extraEnv,srv){
  return new Promise(resolve=>{
    const env={...process.env,PGBIN,MANEE_ENV:'unit-test',...extraEnv};
    const child=spawn(process.execPath,[SCRIPT,...args],{env});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    child.on('close',code=>resolve({code,out,err}));
  });
}
const skip=!haveTools&&'PGBIN (PostgreSQL 17 tools) not set';
test('backup of a live database: complete coverage, one consistent snapshot, live changes are reported as drift (not as damage), photos restore identically',{skip},async()=>{
  const s=pg();const out=path.join(s.work,'backup');
  try{
    // a writer keeps changing the source while the backup runs
    let stop=false;const writer=(async()=>{while(!stop){spawnSync(bin('psql'),['-d','src','-qAt','-c',"insert into public.attendance(crew_id,day) select id,current_date+ (random()*100)::int from public.crew limit 3; update public.sales_reports set total_sales=total_sales+1 where id=(select id from public.sales_reports limit 1)"],{env:s.env});await new Promise(r=>setTimeout(r,60));}})();
    const b=await cli(['backup','--out',out],{MANEE_DB_URL:s.url});stop=true;await writer;
    assert.equal(b.code,0,b.err+b.out);assert.equal(b.out.includes('SecretPw123'),false);assert.match(b.out,/NOT a completed backup yet/);
    const m=JSON.parse(fs.readFileSync(path.join(out,'MANIFEST.json'),'utf8'));
    assert.equal(m.consistentSnapshot,true);
    // coverage = every public/private table + the two auth account tables; everything else is listed as excluded with a reason
    assert.deepEqual([...m.coverage.includedTables].sort(),['auth.identities'.replace('auth.identities','auth.users'),'private.staff_link_requests','public.attendance','public.checklist_checks','public.crew','public.sales_reports','public.stores'].sort());
    assert.ok(m.coverage.excludedTables.some(t=>t.table==='auth.sessions'&&/not needed/.test(t.reason)));
    assert.deepEqual(m.coverage.photoAndBinaryColumns.sort(),['public.sales_reports.receipt_photos','public.sales_reports.settlement_photos']);
    assert.ok(m.changedSinceSnapshot.length>0,'the live writer must show up as drift');
    assert.equal(b.out.includes('not a backup defect'),true);
    const v=await cli(['verify',out],{});assert.equal(v.code,0);
    const r=await cli(['rehearse',out],{MANEE_DB_URL:'postgresql://nobody:nothing@203.0.113.1:5432/x',PGHOST:'203.0.113.1'});   // unreachable "source": the rehearsal must not need or use it
    assert.equal(r.code,0,r.err+r.out);assert.match(r.out,/RESTORE REHEARSAL PASSED/);assert.match(r.out,/photo\/binary columns compared: 2/);assert.match(r.out,/different: 0/);
    assert.equal(/203\.0\.113\.1|nothing/.test(r.out+r.err),false);
    // the source is unchanged by the backup/rehearsal except by the writer: no restored objects, no extra database, no extra connections left
    assert.equal(s.psql('postgres',"select count(*) from pg_database where datname='restored'"),'0');
  }finally{s.stop();}
});
test('damage is detected: a flipped byte and a deleted file are reported by verify, and the rehearsal refuses to run on a damaged backup',{skip},async()=>{
  const s=pg();const out=path.join(s.work,'backup');
  try{
    assert.equal((await cli(['backup','--out',out],{MANEE_DB_URL:s.url})).code,0);
    const dump=path.join(out,'data.dump');const good=fs.readFileSync(dump);
    const bad=Buffer.from(good);bad[Math.floor(bad.length/2)]^=0xff;fs.writeFileSync(dump,bad);
    let v=await cli(['verify',out],{});assert.notEqual(v.code,0);assert.match(v.out,/CHANGED\s+data\.dump/);
    let r=await cli(['rehearse',out],{});assert.notEqual(r.code,0);assert.match(r.err,/does not match the manifest/);
    fs.writeFileSync(dump,good);fs.rmSync(path.join(out,'auth-accounts.dump'));
    v=await cli(['verify',out],{});assert.notEqual(v.code,0);assert.match(v.out,/MISSING\s+auth-accounts\.dump/);
  }finally{s.stop();}
});
test('failures never print the connection string, password, user, host or data: wrong password, refused connection, invalid URI',{skip},async()=>{
  const s=pg();
  try{
    const bads=['postgresql://postgres:WrongPw999@127.0.0.1:'+s.port+'/nodb','postgresql://leakuser:LeakPw777@127.0.0.1:1/src','not-a-uri-with-LeakPw555'];
    for(const url of bads){
      const r=await cli(['backup','--out',path.join(s.work,'x'+Math.random())],{MANEE_DB_URL:url});
      assert.notEqual(r.code,0);const all=r.out+r.err;
      for(const bad of ['WrongPw999','LeakPw777','LeakPw555','leakuser','postgresql://'])assert.equal(all.includes(bad),false,'leaked '+bad+' in: '+all);
    }
  }finally{s.stop();}
});
test('seal + unseal on a real backup: the sealed folder holds no readable data, unseal verifies against the manifest, the rehearsal passes on the unsealed copy',{skip},async()=>{
  const s=pg();const out=path.join(s.work,'backup'),keys=path.join(s.work,'keys'),plain=path.join(s.work,'plain');
  try{
    assert.equal((await cli(['backup','--out',out],{MANEE_DB_URL:s.url})).code,0);
    // keygen refuses folders inside a repo; the test folder is in the OS temp directory
    assert.equal((await cli(['keygen',keys],{})).code,0);
    assert.equal((await cli(['seal',out,'--pubkey',path.join(keys,'manee-backup-public.pem'),'--delete-plain','--key',path.join(keys,'manee-backup-private.pem')],{})).code,0);
    assert.deepEqual(fs.readdirSync(out).sort(),['MANIFEST.json','SEALED.json','auth-accounts.dump.enc','data.dump.enc','definitions.sql.enc']);
    for(const f of fs.readdirSync(out).filter(x=>x.endsWith('.enc')))assert.equal(fs.readFileSync(path.join(out,f)).includes(Buffer.from('synthetic1@example.invalid')),false);
    assert.equal((await cli(['verify',out],{})).code,0);
    assert.equal((await cli(['unseal',out,'--key',path.join(keys,'manee-backup-private.pem'),'--out',plain],{})).code,0);
    const r=await cli(['rehearse',plain],{});assert.equal(r.code,0,r.err+r.out);assert.match(r.out,/PASSED/);
    // damaged sealed file is caught by verify
    const enc=path.join(out,'data.dump.enc');const b=fs.readFileSync(enc);b[b.length-50]^=1;fs.writeFileSync(enc,b);
    assert.notEqual((await cli(['verify',out],{})).code,0);
  }finally{s.stop();}
});

// ---------- separate-password mode: the raw password reaches the connection tool unchanged ----------
const NASTY = `P@ss:w/o#r?d%41%&+=!'"$\ <>[]{}|;,~\`^ x`;   // every URI-special character, a literal %41, quotes, backslash, backtick, space
function pgWithPassword(pw){
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'manee-pw-'));const port=String(58000+Math.floor(Math.random()*900));
  const clean={...process.env};for(const k of Object.keys(clean))if(/^PG|^MANEE_/.test(k))delete clean[k];
  fs.writeFileSync(path.join(work,'pw.txt'),pw);
  assert.equal(spawnSync(bin('initdb'),['-D',path.join(work,'d'),'-U','postgres','-A','scram-sha-256','--pwfile='+path.join(work,'pw.txt'),'-E','UTF8'],{env:clean}).status,0);
  assert.equal(spawnSync(bin('pg_ctl'),['-D',path.join(work,'d'),'-o','-p '+port+' -c listen_addresses=127.0.0.1','-l',path.join(work,'l'),'-w','start'],{env:clean,stdio:'ignore'}).status,0);
  const env={...clean,PGHOST:'127.0.0.1',PGPORT:port,PGUSER:'postgres',PGPASSWORD:pw};
  const psql=(db,sql)=>{const r=spawnSync(bin('psql'),['-d',db,'-qAt','-v','ON_ERROR_STOP=1','-c',sql],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  psql('postgres','create database src');
  psql('src',"create table public.crew(id serial primary key,name text,phone text); insert into public.crew(name,phone) select 'crew '||g,'000-'||g from generate_series(1,30) g; create schema private; create table private.t(id int); create schema auth; create table auth.users(id uuid primary key, email text); create table auth.identities(id uuid primary key, user_id uuid)");
  return {work,port,stop(){spawnSync(bin('pg_ctl'),['-D',path.join(work,'d'),'-m','immediate','stop'],{env:clean,stdio:'ignore'});try{fs.rmSync(work,{recursive:true,force:true});}catch(e){}}};
}
test('a password with every special character is passed unchanged (no URI, no encoding): backup and rehearsal succeed',{skip},async()=>{
  const s=pgWithPassword(NASTY);const out=path.join(s.work,'bk');
  try{
    const b=await cli(['backup','--out',out],{MANEE_DB_HOST:'127.0.0.1',MANEE_DB_PORT:s.port,MANEE_DB_USER:'postgres',MANEE_DB_PASSWORD:NASTY,MANEE_DB_NAME:'src'});
    assert.equal(b.code,0,b.err+b.out);for(const bad of ['P@ss','w/o#r','%41'])assert.equal((b.out+b.err).includes(bad),false,'leaked '+bad);
    const r=await cli(['rehearse',out],{});assert.equal(r.code,0,r.err+r.out);assert.match(r.out,/PASSED/);
  }finally{s.stop();}
});
test('a wrong special-character password fails cleanly and neither the right nor the wrong password (raw or percent-encoded) appears in any output',{skip},async()=>{
  const s=pgWithPassword(NASTY);const wrong=NASTY.replace('x','y');
  try{
    const b=await cli(['backup','--out',path.join(s.work,'bk2')],{MANEE_DB_HOST:'127.0.0.1',MANEE_DB_PORT:s.port,MANEE_DB_USER:'postgres',MANEE_DB_PASSWORD:wrong,MANEE_DB_NAME:'src'});
    assert.notEqual(b.code,0);const all=b.out+b.err;
    for(const t of [NASTY,wrong,encodeURIComponent(NASTY),encodeURIComponent(wrong),'P@ss','w/o#r','%41','password authentication failed for user "postgres"'])assert.equal(all.includes(t),false,'leaked: '+t);
    assert.match(all,/ERROR/);
  }finally{s.stop();}
});
