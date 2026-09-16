import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('  function renderOwnerStaffAccess(){');
const end=html.indexOf('  async function refreshOwnerStaffAccess(){',start);
const owner=html.slice(start,end);
const handler=html.slice(html.indexOf('  async function handleStaffAuthClick'),html.indexOf('  // BEGIN MANEE_ACCOUNT_RECOVERY'));

test('new employee approval is the primary path and does not require an existing crew selection',()=>{
  assert.ok(owner.includes("staffAuthButton('approve-new','신규 직원으로 승인'"));
  assert.ok(owner.includes('직원기록을 새로 생성'));
  assert.equal(owner.includes("'approve-new' disabled"),false);
  assert.ok(handler.includes("staffPortal('approve_new',{request_id:button.dataset.requestId})"));
});
test('existing employee linking remains explicitly marked as a temporary conversion path',()=>{
  assert.ok(owner.includes('기존 직원기록 연결'));
  assert.ok(owner.includes('기존 직원 전환용'));
  assert.ok(owner.includes("staffAuthButton('approve','기존 기록 연결'"));
});
test('existing-record approval still requires a selected crew but new approval does not',()=>{
  assert.ok(handler.includes("if(action==='approve'){"));
  assert.ok(handler.includes("showToast('연결할 기존 직원을 먼저 선택해 주세요.')"));
  assert.ok(handler.includes("action==='approve-new'"));
});
test('staff-facing copy no longer implies an existing employee record is mandatory',()=>{
  const staff=html.slice(html.indexOf('  function renderStaffAuthAccount(){'),start);
  assert.ok(staff.includes('신규 직원으로 등록되거나 기존 직원기록과 연결'));
  assert.equal(staff.includes('기존 직원 기록을 선택해 승인하면'),false);
});
