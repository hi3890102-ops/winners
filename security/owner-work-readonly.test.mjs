// The owner-home "매장별 오늘 근무" card must stay a read-only lookup: only SELECTs on shifts, attendance and crew, no writes, no RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('// ---------- owner home: "매장별 오늘 근무" (read-only) ----------');
const end=html.indexOf('  function renderOwnerHome(){');
const block=html.slice(start,end);
test('owner work block exists', ()=>{ assert.ok(start>0&&end>start&&block.length>3000); });
test('owner work code only reads', ()=>{
  assert.deepEqual(block.match(/\.(insert|update|delete|upsert|rpc)\(/g)||[],[]);
  const tables=[...block.matchAll(/db\.from\("([a-z_]+)"\)/g)].map(m=>m[1]).sort();
  assert.deepEqual(tables,['attendance','crew','shifts']);
  assert.equal((block.match(/db\.from\(/g)||[]).length,3);
  for(const m of block.matchAll(/db\.from\("[a-z_]+"\)\.select\("([^"]*)"\)/g)) assert.ok(!/(phone|bank|resident|\*)/.test(m[1]),'no personal columns: '+m[1]);
});
test('uses a fresh clock, not the page-level frozen now', ()=>{
  assert.ok(!/[^a-zA-Z.]now\./.test(block.replace(/\/\/.*$/gm,'')));
  assert.ok(block.includes('new Date()'));
});
test('timer and visibility handling exist; sign-out replaces the per-account state', ()=>{
  assert.ok(block.includes('setInterval')&&block.includes('clearInterval')&&block.includes('visibilitychange'));
  assert.ok(block.includes('if(!ownerWorkActive()){ ownerWorkStopTimer();'));   // the timer stops itself when home is not visible / not an owner
  const clear=html.slice(html.indexOf('function clearStaffAuthView(){'),html.indexOf('function clearStaffAuthView(){')+900);
  assert.ok(clear.includes('state.ownerWork={')&&clear.includes('inflight:0'));   // per-account state (incl. the in-flight flag) is replaced
});
