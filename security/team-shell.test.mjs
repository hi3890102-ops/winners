// Staff / manager shell: fixed menus, no mockup-only code, no new writes in the shell itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const a=html.indexOf('// ---------- 직원·매니저 앱 (team shell) ----------'),b=html.indexOf('  function renderStaffApp(){');
const block=html.slice(a,b);
test('team shell block exists and has the agreed menus', ()=>{
  assert.ok(a>0&&b>a);
  for(const l of ['"홈"','"내 근무"','"업무"','"공지"','"내 정보"','"직원"','"매출"','"운영"','"더보기"']) assert.ok(block.includes(l),'menu '+l);
});
test('no mockup-only code or fake saves in the team shell', ()=>{
  assert.ok(!/_maneePreview|역할 전환|예시 데이터|실제 저장 안 됨/.test(html));
  assert.deepEqual(block.match(/\.(insert|update|delete|upsert)\(/g)||[],[]);
});
test('team shell styles are scoped, legacy elements only restyled under .team-ui', ()=>{
  const css=readFileSync(new URL('../owner-ui.css',import.meta.url),'utf8');
  assert.ok(/\.team-ui \.staff-back/.test(css)&&!/^\.owner-ui \.staff-back/m.test(css));
});
