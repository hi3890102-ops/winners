import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');

test('staff connection UI uses code only with an eight-character one-time code',()=>{
  const start=html.indexOf('  function renderStaffAuthAccount(){');
  const end=html.indexOf('  function renderOwnerStaffAccess(){',start);
  const body=html.slice(start,end);
  assert.ok(body.includes('직원 연결코드'));
  assert.ok(body.includes('maxlength="8"'));
  assert.ok(body.includes('매장명은 입력하지 않아도 돼요'));
  assert.ok(body.includes("staffAuthButton('preview-link','확인')"));
  assert.equal(body.includes('maxlength="6"'),false);
});

test('staff connection previews identity before request and request clears preview state',()=>{
  assert.ok(html.includes("staffPortal('preview',{code})"));
  assert.ok(html.includes("state.staffLinkPreview={store_name:preview.store_name,crew_name:preview.crew_name}"));
  assert.ok(html.includes("staffPortal('request',{code})"));
  assert.ok(html.includes("state.staffLinkCode=null;state.staffLinkPreview=null"));
});

test('new employee link codes use cryptographic random bytes and eight characters',()=>{
  assert.ok(html.includes('crypto.getRandomValues(bytes)'));
  assert.ok(html.includes('new Uint8Array(8)'));
  assert.ok(html.includes('STAFF_LINK_CODE_ALPHABET'));
});
