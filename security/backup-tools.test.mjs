import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {REQUIRED_TABLES,parseCsv,initFolder,verifyFolder,checkDbDigest,diffTables,formatDiff} from './backup-tools.mjs';
const SECRET='SYNTHETIC-SECRET-VALUE-9f3';
const md5=s=>createHash('md5').update(s).digest('hex');
function rowsOf(t){return t==='public.vendors'?0:t==='public.crew'?3:2;}
function csvFor(t,n=rowsOf(t),secret=SECRET){return 'id,note,secret\n'+Array.from({length:n},(_,i)=>i+',"line one\nline two, ""quoted""",'+secret+i).join('\n')+(n?'\n':'');}
// A complete, valid export folder (digest.csv + one CSV per required table [+ digest-after.csv]).
function makeBackup(o={}){
  const d=mkdtempSync(join(tmpdir(),'manee-backup-'));
  const tables=o.tables||REQUIRED_TABLES;
  const digest='t,n,h\n'+tables.map(t=>t+','+(o.counts?.[t]??rowsOf(t))+','+md5(t+(o.hashSalt||''))).join('\n')+'\n';
  writeFileSync(join(d,'digest.csv'),o.digest??digest);
  for(const t of tables)if(!(o.skipFile||[]).includes(t))writeFileSync(join(d,t+'.csv'),o.files?.[t]??csvFor(t));
  if(o.after!==undefined)writeFileSync(join(d,'digest-after.csv'),o.after===true?digest:o.after);
  return d;
}
const done=d=>rmSync(d,{recursive:true,force:true});
const noValues=text=>{assert.equal(text.includes(SECRET),false);};

test('CSV parser handles quotes, doubled quotes, commas, CRLF and multi-line cells',()=>{
  const rows=parseCsv('﻿id,note\r\n1,"line one\nline two, with ""quotes"""\r\n2,plain\r\n');
  assert.deepEqual(rows,[['id','note'],['1','line one\nline two, with "quotes"'],['2','plain']]);
  assert.deepEqual(parseCsv('a,b\n,\n'),[['a','b'],['','']]);
});

// ---------- R4: the first backup ("init") ----------
test('R4: init rejects a digest that has only a header (nothing to check)',()=>{
  const d=makeBackup({digest:'t,n,h\n'});
  try{const r=initFolder(d);assert.equal(r.ok,false);assert.match(r.report,/header but no rows/);assert.equal(existsSync(join(d,'BACKUP_MANIFEST.json')),false);}finally{done(d);}
});
test('R4: init rejects a missing digest.csv and a digest without the t,n,h columns',()=>{
  const d=mkdtempSync(join(tmpdir(),'manee-backup-'));
  try{assert.equal(initFolder(d).ok,false);writeFileSync(join(d,'digest.csv'),'a,b\n1,2\n');assert.match(initFolder(d).report,/needs the columns t, n and h/);}finally{done(d);}
});
test('R4: init rejects a digest that omits required tables',()=>{
  const d=makeBackup({tables:REQUIRED_TABLES.slice(0,-3)});
  try{const r=initFolder(d);assert.equal(r.ok,false);for(const t of REQUIRED_TABLES.slice(-3))assert.match(r.report,new RegExp('required table missing: '+t.replace('.','\\.')));}finally{done(d);}
});
test('R4: init rejects duplicated and unexpected tables, bad counts and bad hashes',()=>{
  const base='t,n,h\n'+REQUIRED_TABLES.map(t=>t+','+rowsOf(t)+','+md5(t)).join('\n')+'\n';
  for(const [bad,pattern] of [[base+'public.crew,3,'+md5('x')+'\n',/listed more than once: public\.crew/],[base+'public.owner_requests,1,'+md5('y')+'\n',/unexpected table: public\.owner_requests/],
    [base.replace('public.crew,3,','public.crew,three,'),/public\.crew has an invalid row count/],[base.replace(md5('public.crew'),'nothex'),/public\.crew has an invalid hash/]]){
    const d=makeBackup({digest:bad});
    try{const r=initFolder(d);assert.equal(r.ok,false);assert.match(r.report,pattern);}finally{done(d);}
  }
});
test('R4: init rejects a missing CSV and a wrong row count',()=>{
  const d=makeBackup({skipFile:['public.shifts'],counts:{'public.crew':5}});
  try{const r=initFolder(d);assert.equal(r.ok,false);assert.match(r.report,/public\.shifts: file public\.shifts\.csv is missing/);assert.match(r.report,/public\.crew: expected 5 rows, file has 3/);}finally{done(d);}
});
test('R4: a valid first backup writes the baseline manifest (per-file SHA-256) and says exactly what was and was not checked',()=>{
  const d=makeBackup({after:true});
  try{
    const r=initFolder(d);assert.equal(r.ok,true,r.report);
    const m=JSON.parse(readFileSync(join(d,'BACKUP_MANIFEST.json'),'utf8'));
    assert.equal(Object.keys(m.files).length,REQUIRED_TABLES.length);
    assert.equal(m.files['public.crew'].sha256,createHash('sha256').update(csvFor('public.crew')).digest('hex'));
    assert.equal(m.checks.database_unchanged_while_exporting,'verified');
    assert.equal(m.checks.csv_content_equals_database,'not_checked');assert.equal(m.checks.restorable,'not_checked');
    assert.match(r.report,/NOT CHECKED: that each CSV's content equals the database content/);assert.match(r.report,/NOT CHECKED: that the data can be restored/);
    noValues(r.report);assert.equal(/recoverable/i.test(r.report.replace(/restore rehearsal/g,'')),false);
  }finally{done(d);}
});
test('R4: without digest-after.csv the first backup is accepted but "no change while exporting" is reported as NOT VERIFIED',()=>{
  const d=makeBackup();
  try{const r=initFolder(d);assert.equal(r.ok,true);assert.match(r.report,/NOT VERIFIED - digest-after\.csv not provided/);assert.equal(JSON.parse(readFileSync(join(d,'BACKUP_MANIFEST.json'),'utf8')).checks.database_unchanged_while_exporting,'not_verified');}finally{done(d);}
});
test('R4: data that changed while exporting (digest before != after) is rejected',()=>{
  const d=makeBackup({after:'t,n,h\n'+REQUIRED_TABLES.map(t=>t+','+rowsOf(t)+','+md5(t+(t==='public.crew'?'changed':''))).join('\n')+'\n'});
  try{const r=initFolder(d);assert.equal(r.ok,false);assert.match(r.report,/database changed while you were exporting[\s\S]*public\.crew/);assert.equal(existsSync(join(d,'BACKUP_MANIFEST.json')),false);}finally{done(d);}
});
test('R4: the baseline is preserved - init refuses to run again and never rewrites the manifest',()=>{
  const d=makeBackup();
  try{
    assert.equal(initFolder(d).ok,true);const before=readFileSync(join(d,'BACKUP_MANIFEST.json'),'utf8');
    writeFileSync(join(d,'public.crew.csv'),csvFor('public.crew',3,'CHANGED'));
    const again=initFolder(d);assert.equal(again.ok,false);assert.match(again.report,/REFUSED/);
    assert.equal(readFileSync(join(d,'BACKUP_MANIFEST.json'),'utf8'),before,'the baseline manifest must be untouched');
  }finally{done(d);}
});

// ---------- R4: later integrity checks ("verify") ----------
test('R4: verify without a baseline proves nothing and fails',()=>{
  const d=makeBackup();try{const r=verifyFolder(d);assert.equal(r.ok,false);assert.match(r.report,/NO BASELINE/);}finally{done(d);}
});
test('R4: verify passes for untouched files, keeps the baseline byte-identical and writes a NEW log each time',()=>{
  const d=makeBackup();
  try{
    initFolder(d);const manifest=readFileSync(join(d,'BACKUP_MANIFEST.json'),'utf8');
    const first=verifyFolder(d);assert.equal(first.ok,true,first.report);
    assert.equal(readFileSync(join(d,'BACKUP_MANIFEST.json'),'utf8'),manifest);
    const logs=readdirSync(d).filter(f=>/^(INIT|VERIFY)_LOG_/.test(f));assert.ok(logs.some(f=>f.startsWith('INIT_LOG_')));assert.ok(logs.some(f=>f.startsWith('VERIFY_LOG_')));
    assert.match(first.report,/unchanged since the baseline \(SHA-256 and row counts\)\. Nothing more is claimed/);assert.match(first.report,/NOT CHECKED: that the data can be restored/);
    noValues(first.report);
  }finally{done(d);}
});
test('R4 (review scenario): same row count but a changed value is caught by the baseline hash, and the baseline is not overwritten',()=>{
  const d=makeBackup();
  try{
    initFolder(d);const manifest=readFileSync(join(d,'BACKUP_MANIFEST.json'),'utf8');
    writeFileSync(join(d,'public.crew.csv'),csvFor('public.crew',3,'TAMPERED'));      // still 3 data rows
    const r=verifyFolder(d);assert.equal(r.ok,false);
    assert.match(r.report,/public\.crew: file content changed since the baseline \(SHA-256 differs\)/);
    assert.equal(/row count changed/.test(r.report),false,'the row count is the same; only the hash catches it');
    assert.equal(readFileSync(join(d,'BACKUP_MANIFEST.json'),'utf8'),manifest);noValues(r.report);
  }finally{done(d);}
});
test('R4: verify fails for a changed row count, a deleted file and a modified digest.csv',()=>{
  const d=makeBackup();
  try{
    initFolder(d);
    writeFileSync(join(d,'public.stores.csv'),csvFor('public.stores',1));rmSync(join(d,'public.vendors.csv'));writeFileSync(join(d,'digest.csv'),readFileSync(join(d,'digest.csv'),'utf8')+'\n');
    const r=verifyFolder(d);assert.equal(r.ok,false);
    assert.match(r.report,/public\.stores: row count changed since the baseline \(2 -> 1\)/);assert.match(r.report,/public\.vendors: file public\.vendors\.csv is missing/);assert.match(r.report,/digest\.csv changed since the baseline/);
  }finally{done(d);}
});
test('R4: creating a fresh log is never treated as proof that the earlier files are unchanged',()=>{
  const d=makeBackup();
  try{initFolder(d);verifyFolder(d);writeFileSync(join(d,'public.crew.csv'),csvFor('public.crew',3,'LATER-CHANGE'));assert.equal(verifyFolder(d).ok,false);}finally{done(d);}
});
test('R4: db-check compares the database digest NOW with the digest saved at backup time (database state only)',()=>{
  const d=makeBackup();
  try{
    initFolder(d);
    writeFileSync(join(d,'now-same.csv'),readFileSync(join(d,'digest.csv')));
    const same=checkDbDigest(d,join(d,'now-same.csv'));assert.equal(same.ok,true);assert.match(same.report,/database digest is unchanged since the backup was made/);assert.match(same.report,/cannot say the CSV files equal the database/);
    writeFileSync(join(d,'now-diff.csv'),'t,n,h\n'+REQUIRED_TABLES.map(t=>t+','+(t==='public.crew'?4:rowsOf(t))+','+md5(t+(t==='public.crew'?'z':''))).join('\n')+'\n');
    const diff=checkDbDigest(d,join(d,'now-diff.csv'));assert.equal(diff.ok,false);assert.match(diff.report,/differs from the state at backup time for: public\.crew/);
  }finally{done(d);}
});

// ---------- after an incident ----------
test('diff: lists removed, added and changed rows with column NAMES only, never values',()=>{
  const before='id,name,wage,bank\n1,Kim,10000,'+SECRET+'\n2,Lee,12000,x\n3,Park,9000,y\n';
  const after='id,name,wage,bank\n1,Kim,99999,'+SECRET+'-changed\n3,Park,9000,y\n4,New,1,z\n';
  const d=diffTables(before,after,['id']);
  assert.deepEqual(d.removed,['2']);assert.deepEqual(d.added,['4']);
  assert.deepEqual(d.changed,[{key:'1',columns:['wage','bank']}]);
  const text=formatDiff(d,'before.csv','after.csv');
  assert.equal(text.includes(SECRET),false);assert.equal(text.includes('99999'),false);
  assert.match(text,/1 -> wage, bank/);assert.match(text,/Nothing was changed anywhere/);assert.match(text,/cannot tell NULL from an empty string/);
});
test('diff: identical exports produce no candidates; composite keys and mismatched key columns are handled',()=>{
  const csv='a,b,v\n1,x,p\n1,y,q\n';
  const d=diffTables(csv,csv,['a','b']);assert.equal(d.changed.length+d.removed.length+d.added.length,0);
  assert.throws(()=>diffTables(csv,csv,['nope']),/key column missing/);
  assert.equal(diffTables('id\n1\n1\n','id\n1\n',['id']).duplicateKeys.length,1);
});
