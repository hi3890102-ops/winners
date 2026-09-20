#!/usr/bin/env node
// Local helper for the personal (off-database) data export described in
// security/new-staff-self-profile-runbook.md §3. It never connects to a network and NEVER prints cell values.
//
// What each command proves (and what it does not):
//   init   <folder>   FIRST backup only. Requires digest.csv to list EXACTLY the required tables, checks every CSV
//                     exists and its data-row count matches the digest, and (if digest-after.csv is present) that the
//                     database did not change while you exported. Then writes BACKUP_MANIFEST.json: the BASELINE with the
//                     SHA-256 of every file. It refuses to run if a manifest already exists, so the baseline is preserved.
//   verify <folder>   LATER integrity check. Compares every file against the baseline manifest (SHA-256, row count) and
//                     the list against the required tables. It never rewrites the manifest and writes a NEW dated log.
//                     It proves the FILES are unchanged since init. It does not prove the files matched the database in
//                     the first place, and it does not prove the data can be restored.
//   db-check <folder> <digest-now.csv>
//                     Compares a digest you ran against the database NOW with the digest saved at backup time.
//                     It proves whether the DATABASE still equals what was exported (or which tables changed).
//   diff <before.csv> <after.csv> [--key id[,col2]] [--out report.txt]
//                     After an incident: lists rows added/removed/changed by key with changed COLUMN NAMES only.
//
// NOT proven by any command: that a CSV's content equals the database content (Postgres row text and CSV are different
// formats, so the digest hash cannot be compared with the file), and that the data is restorable (needs a restore rehearsal).
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const REQUIRED_TABLES=['public.stores','public.crew','public.crew_pay_adjustments','public.profiles','public.store_memberships','public.attendance','public.attendance_edit_requests','public.shifts','public.fixed_schedules','public.sales_reports','public.sales_report_photos','public.expense_entries','public.fixed_expenses','public.vendors','private.staff_link_requests','private.staff_access_events','private.store_staff_code_history','auth.users_identity_map'];
export const MANIFEST_NAME='BACKUP_MANIFEST.json';

export function parseCsv(input){
  const text=input.charCodeAt(0)===0xFEFF?input.slice(1):input;
  const rows=[];let row=[],field='',quoted=false,touched=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else quoted=false;}
      else field+=c;
    }else if(c==='"'){quoted=true;touched=true;}
    else if(c===','){row.push(field);field='';touched=true;}
    else if(c==='\n'||c==='\r'){
      if(c==='\r'&&text[i+1]==='\n')i++;
      if(touched||field!==''||row.length){row.push(field);rows.push(row);}
      row=[];field='';touched=false;
    }else{field+=c;touched=true;}
  }
  if(touched||field!==''||row.length){row.push(field);rows.push(row);}
  return rows;
}
const sha256=buf=>createHash('sha256').update(buf).digest('hex');
const stamp=()=>new Date().toISOString().replace(/[-:]/g,'').replace(/\..+/,'');

// Reads a digest CSV (t,n,h) and validates it against the required table list. Returns rows and problems.
export function readDigest(path,label='digest.csv'){
  const problems=[],rows=[];
  if(!existsSync(path))return {rows,problems:[label+' is missing']};
  const parsed=parseCsv(readFileSync(path,'utf8'));
  const head=(parsed[0]||[]).map(x=>x.trim().toLowerCase());
  const ti=head.indexOf('t'),ni=head.indexOf('n'),hi=head.indexOf('h');
  if(ti<0||ni<0||hi<0)return {rows,problems:[label+' needs the columns t, n and h']};
  const body=parsed.slice(1);
  if(body.length===0)problems.push(label+' has a header but no rows: there is nothing to check (the required '+REQUIRED_TABLES.length+' tables are missing)');
  const seen=new Map();
  for(const r of body){
    const t=(r[ti]||'').trim(),n=(r[ni]||'').trim(),h=(r[hi]||'').trim().toLowerCase();
    if(seen.has(t))problems.push(label+': table listed more than once: '+t);
    seen.set(t,true);
    if(!REQUIRED_TABLES.includes(t))problems.push(label+': unexpected table: '+t);
    if(!/^(0|[1-9][0-9]*)$/.test(n))problems.push(label+': '+t+' has an invalid row count');
    if(!/^[0-9a-f]{32}$/.test(h))problems.push(label+': '+t+' has an invalid hash (expected 32 hex characters)');
    rows.push({t,n:Number(n),h});
  }
  for(const t of REQUIRED_TABLES)if(!seen.has(t))problems.push(label+': required table missing: '+t);
  return {rows,problems};
}
function dataRows(buf){return Math.max(parseCsv(buf.toString('utf8')).length-1,0);}
function tail(lines,problems){return [...lines,'',problems.length?'PROBLEMS ('+problems.length+'):':'No problems found in the checks listed above.',...problems.map(p=>' - '+p),''].join('\n');}
const NOT_CHECKED=['NOT CHECKED: that each CSV\'s content equals the database content (formats differ, so the digest hash cannot be compared with a file).','NOT CHECKED: that the data can be restored (needs a restore rehearsal, runbook section 3.3).'];

export function initFolder(folder){
  const dir=resolve(folder),problems=[],lines=[];
  const manifestPath=join(dir,MANIFEST_NAME);
  if(existsSync(manifestPath))return {ok:false,checks:{},problems:['a baseline manifest already exists and is preserved; run "verify" instead (delete nothing, overwrite nothing)'],report:'REFUSED: '+MANIFEST_NAME+' already exists in '+dir+'. The baseline is never overwritten. Use "verify".\n'};
  const digestPath=join(dir,'digest.csv'),afterPath=join(dir,'digest-after.csv');
  const digest=readDigest(digestPath);problems.push(...digest.problems);
  const files={};
  if(!digest.problems.length){
    for(const r of digest.rows){
      const file=join(dir,r.t+'.csv');
      if(!existsSync(file)){problems.push(r.t+': file '+r.t+'.csv is missing');continue;}
      const buf=readFileSync(file),rows=dataRows(buf);
      if(rows!==r.n)problems.push(r.t+': expected '+r.n+' rows, file has '+rows);
      files[r.t]={rows,bytes:statSync(file).size,sha256:sha256(buf),digest_n:r.n,digest_h:r.h};
    }
  }
  let consistency='not_verified';
  if(existsSync(afterPath)){
    const after=readDigest(afterPath,'digest-after.csv');problems.push(...after.problems);
    if(!after.problems.length&&!digest.problems.length){
      const changed=digest.rows.filter(r=>{const a=after.rows.find(x=>x.t===r.t);return !a||a.n!==r.n||a.h!==r.h;}).map(r=>r.t);
      if(changed.length)problems.push('the database changed while you were exporting (digest before != digest after) for: '+changed.join(', ')+'. Export again.');
      else consistency='verified';
    }
  }
  const checks={listComplete:!digest.problems.length,rowCounts:!problems.some(p=>/expected \d+ rows|is missing/.test(p)),snapshotConsistency:consistency};
  lines.push('FIRST BACKUP CHECK (list, row counts, file hashes) - NOT a restore verification','generated '+new Date().toISOString(),'',
    'required tables listed exactly once: '+(checks.listComplete?'yes':'NO'),
    'every file exists and its row count matches the digest: '+(problems.some(p=>/expected \d+ rows|file .* is missing/.test(p))?'NO':(digest.problems.length?'not evaluated':'yes')),
    'database unchanged while exporting (digest-after.csv): '+(consistency==='verified'?'verified':(existsSync(afterPath)?'CHANGED':'NOT VERIFIED - digest-after.csv not provided; run the digest again after the last export')),
    ...NOT_CHECKED);
  if(!digest.problems.length){lines.push('',['table','digest_rows','file_rows','sha256','bytes'].join('\t'));for(const [t,f] of Object.entries(files))lines.push([t,f.digest_n,f.rows,f.sha256,f.bytes].join('\t'));}
  if(problems.length){const report=tail(lines,problems)+'No baseline manifest was written because problems were found.\n';return {ok:false,checks,problems,report};}
  const manifest={created_at:new Date().toISOString(),tool:'backup-tools.mjs',required_tables:REQUIRED_TABLES,digest_csv_sha256:sha256(readFileSync(digestPath)),
    digest_after_csv_sha256:existsSync(afterPath)?sha256(readFileSync(afterPath)):null,
    checks:{required_tables_listed:true,row_counts_match_digest:true,database_unchanged_while_exporting:consistency,csv_content_equals_database:'not_checked',restorable:'not_checked'},files};
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  const report=tail(lines,problems)+'Baseline written to '+MANIFEST_NAME+' (kept; later runs only compare against it).\n';
  writeFileSync(join(dir,'INIT_LOG_'+stamp()+'.txt'),report);
  return {ok:true,checks,problems,report,manifest};
}

export function verifyFolder(folder){
  const dir=resolve(folder),problems=[],lines=[];
  const manifestPath=join(dir,MANIFEST_NAME);
  if(!existsSync(manifestPath))return {ok:false,checks:{},problems:['no baseline manifest: run "init" once for the first backup'],report:'NO BASELINE: '+MANIFEST_NAME+' is missing in '+dir+'. Run "init" for a first backup; a verify without a baseline proves nothing.\n'};
  let manifest;try{manifest=JSON.parse(readFileSync(manifestPath,'utf8'));}catch(e){return {ok:false,checks:{},problems:['manifest is unreadable'],report:'ERROR: '+MANIFEST_NAME+' is not valid JSON.\n'};}
  const files=manifest.files||{};
  const missingList=REQUIRED_TABLES.filter(t=>!files[t]);
  if(missingList.length)problems.push('the baseline does not list required table(s): '+missingList.join(', '));
  const digestPath=join(dir,'digest.csv');
  if(!existsSync(digestPath))problems.push('digest.csv is missing');
  else if(sha256(readFileSync(digestPath))!==manifest.digest_csv_sha256)problems.push('digest.csv changed since the baseline');
  lines.push('INTEGRITY CHECK against the baseline manifest (files only) - NOT a restore verification','generated '+new Date().toISOString(),'baseline created '+manifest.created_at,'',['table','baseline_rows','file_rows','sha256_matches_baseline'].join('\t'));
  for(const t of REQUIRED_TABLES){
    const b=files[t];if(!b)continue;
    const file=join(dir,t+'.csv');
    if(!existsSync(file)){problems.push(t+': file '+t+'.csv is missing');lines.push([t,b.rows,'-','MISSING'].join('\t'));continue;}
    const buf=readFileSync(file),rows=dataRows(buf),same=sha256(buf)===b.sha256;
    if(!same)problems.push(t+': file content changed since the baseline (SHA-256 differs)');
    if(rows!==b.rows)problems.push(t+': row count changed since the baseline ('+b.rows+' -> '+rows+')');
    lines.push([t,b.rows,rows,same?'yes':'NO'].join('\t'));
  }
  const checks={listComplete:!missingList.length,filesUnchanged:!problems.some(p=>/changed since|missing/.test(p))};
  lines.push('',...NOT_CHECKED);
  const report=tail(lines,problems)+(problems.length?'':'Result: the files are unchanged since the baseline (SHA-256 and row counts). Nothing more is claimed.\n');
  writeFileSync(join(dir,'VERIFY_LOG_'+stamp()+'.txt'),report);   // a NEW log each run; the baseline is never touched
  return {ok:problems.length===0,checks,problems,report};
}

export function checkDbDigest(folder,nowPath){
  const dir=resolve(folder),problems=[];
  const manifestPath=join(dir,MANIFEST_NAME);
  if(!existsSync(manifestPath))return {ok:false,problems:['no baseline manifest'],report:'NO BASELINE: run "init" first.\n'};
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  const now=readDigest(nowPath,basename(nowPath));problems.push(...now.problems);
  const changed=[];
  if(!now.problems.length)for(const t of REQUIRED_TABLES){const b=manifest.files[t],c=now.rows.find(r=>r.t===t);if(!b||!c||b.digest_n!==c.n||b.digest_h!==c.h)changed.push(t);}
  if(changed.length)problems.push('the database differs from the state at backup time for: '+changed.join(', '));
  const lines=['DATABASE vs BACKUP-TIME digest (database state only)','generated '+new Date().toISOString(),'',
    'The digest hash covers database rows. It says whether the DATABASE still equals what was exported; it cannot say the CSV files equal the database.',...NOT_CHECKED];
  return {ok:problems.length===0,problems,changed,report:tail(lines,problems)+(problems.length?'':'Result: the database digest is unchanged since the backup was made.\n')};
}

export function diffTables(beforeText,afterText,keyColumns=['id']){
  const b=parseCsv(beforeText),a=parseCsv(afterText);
  if(!b.length||!a.length)throw new Error('empty CSV');
  const bh=b[0],ah=a[0];
  const cols=bh.filter(c=>ah.includes(c)),onlyBefore=bh.filter(c=>!ah.includes(c)),onlyAfter=ah.filter(c=>!bh.includes(c));
  for(const k of keyColumns)if(!bh.includes(k)||!ah.includes(k))throw new Error('key column missing: '+k);
  const keyOf=(head,row)=>keyColumns.map(k=>row[head.indexOf(k)]).join('|');
  const index=(head,rows)=>{const m=new Map(),dup=[];for(const r of rows.slice(1)){const k=keyOf(head,r);if(m.has(k))dup.push(k);m.set(k,r);}return {m,dup};};
  const B=index(bh,b),A=index(ah,a);
  const removed=[...B.m.keys()].filter(k=>!A.m.has(k)),added=[...A.m.keys()].filter(k=>!B.m.has(k));
  const changed=[];
  for(const [k,br] of B.m){
    const ar=A.m.get(k);if(!ar)continue;
    const diffCols=cols.filter(c=>br[bh.indexOf(c)]!==ar[ah.indexOf(c)]);
    if(diffCols.length)changed.push({key:k,columns:diffCols});
  }
  return {removed,added,changed,onlyBefore,onlyAfter,duplicateKeys:[...new Set([...B.dup,...A.dup])],rowsBefore:B.m.size,rowsAfter:A.m.size};
}
export function formatDiff(d,beforeName,afterName){
  const L=['TARGETED-RESTORE CANDIDATES (keys and column names only; no values)','before: '+beforeName,'after:  '+afterName,'',
    'rows before: '+d.rowsBefore+' | rows after: '+d.rowsAfter,
    'removed since backup: '+d.removed.length+' | added since backup: '+d.added.length+' | changed: '+d.changed.length];
  if(d.onlyBefore.length)L.push('columns only in the backup: '+d.onlyBefore.join(', '));
  if(d.onlyAfter.length)L.push('columns only in the current export: '+d.onlyAfter.join(', '));
  if(d.duplicateKeys.length)L.push('WARNING duplicate keys (results unreliable): '+d.duplicateKeys.length);
  if(d.removed.length){L.push('','REMOVED (present in backup, missing now):',...d.removed.map(k=>' - '+k));}
  if(d.changed.length){L.push('','CHANGED (key -> columns whose value differs):',...d.changed.map(c=>' - '+c.key+' -> '+c.columns.join(', ')));}
  if(d.added.length){L.push('','ADDED since the backup (normally legitimate new data; not restore candidates):',...d.added.map(k=>' - '+k));}
  L.push('','Nothing was changed anywhere. Restoring a row or column needs a separate approval that names the key and columns,',
    'a saved copy of the CURRENT values first, and a transaction whose row count is checked before commit.',
    'The backup cannot tell NULL from an empty string: check the column definition before restoring such cells.','');
  return L.join('\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [cmd,...rest]=process.argv.slice(2);
  const opt=n=>{const i=rest.indexOf('--'+n);return i>=0?rest[i+1]:null;};
  try{
    if((cmd==='init'||cmd==='verify')&&rest[0]){const r=(cmd==='init'?initFolder:verifyFolder)(rest[0]);console.log(r.report);process.exit(r.ok?0:1);}
    else if(cmd==='db-check'&&rest[0]&&rest[1]){const r=checkDbDigest(rest[0],rest[1]);console.log(r.report);process.exit(r.ok?0:1);}
    else if(cmd==='diff'&&rest[0]&&rest[1]){
      const d=diffTables(readFileSync(rest[0],'utf8'),readFileSync(rest[1],'utf8'),(opt('key')||'id').split(','));
      const report=formatDiff(d,basename(rest[0]),basename(rest[1]));
      if(opt('out'))writeFileSync(opt('out'),report);
      console.log(report);process.exit(0);
    }else{console.error('usage:\n  node security/backup-tools.mjs init <folder>        (first backup only; writes the baseline manifest)\n  node security/backup-tools.mjs verify <folder>      (later integrity check against the baseline)\n  node security/backup-tools.mjs db-check <folder> <digest-now.csv>\n  node security/backup-tools.mjs diff <before.csv> <after.csv> [--key id[,col2]] [--out report.txt]');process.exit(2);}
  }catch(e){console.error('ERROR: '+e.message);process.exit(2);}
}
