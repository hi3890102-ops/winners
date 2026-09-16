import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');

function section(startMarker,endMarker){
  const start=html.indexOf(startMarker);
  const end=html.indexOf(endMarker,start);
  assert.notEqual(start,-1,startMarker+' not found');
  assert.notEqual(end,-1,endMarker+' not found');
  return html.slice(start,end);
}

test('employee connection asks only for an eight-character store code',()=>{
  const body=section('  function renderStaffAuthAccount(){','  function renderOwnerStaffAccess(){');
  assert.ok(body.includes('매장 연결코드'));
  assert.ok(body.includes('maxlength="8"'));
  assert.ok(body.includes('매장명은 입력하지 않아도'));
  assert.ok(body.includes("staffAuthButton('preview-link','매장 확인')"));
  assert.equal(body.includes('직원 연결코드'),false);
  assert.equal(body.includes('crew_name'),false);
});

test('store preview confirms only the store, then sends a reusable store request',()=>{
  assert.ok(html.includes("state.staffLinkPreview={store_name:preview.store_name}"));
  assert.ok(html.includes("staffPortal('request',{code})"));
  assert.ok(html.includes('가입 요청을 보냈어요'));
  assert.equal(html.includes('이 연결코드는 사용 완료됐어요'),false);
});

test('owner sees one store code and chooses the existing employee during approval',()=>{
  const body=section('  function renderOwnerStaffAccess(){','  async function refreshOwnerStaffAccess(){');
  assert.ok(body.includes('매장 연결코드'));
  assert.ok(body.includes('store_join_code'));
  assert.ok(body.includes('available_crew'));
  assert.ok(body.includes('연결할 직원'));
  assert.ok(body.includes("staffAuthButton('regenerate-store-code','코드 재발급')"));
  assert.ok(html.includes("payload.crew_id=crewId"));
});

test('security-v2 no longer shows or generates per-employee connection codes',()=>{
  assert.ok(html.includes('if(!MANEE_STAFF_AUTH_ENABLED) html += \'<div class="crew-code-row"'));
  assert.ok(html.includes('const uniqueJoinCode = MANEE_STAFF_AUTH_ENABLED ? null : await genUniqueCode();'));
});
