import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function resolveIdentityBody(){
  const start = html.indexOf('  async function resolveIdentity(){');
  assert.notEqual(start, -1, 'resolveIdentity not found');
  const end = html.indexOf('  async function becomeHq()', start);
  assert.notEqual(end, -1, 'resolveIdentity end marker not found');
  return html.slice(start, end);
}

test('refresh rehydrates store settings before staff home loads', () => {
  const body = resolveIdentityBody();
  assert.match(body, /select\('id,name,lat,lng,manager_dashboard_enabled,business_day_cutoff_hour'\)/);
  assert.match(body, /state\.storeManagerDashboardMap\[state\.store\] = !!storeRow\.manager_dashboard_enabled/);
  assert.match(body, /state\.storeLocationMap\[state\.store\]/);
  assert.match(body, /state\.storeCutoffMap\[state\.store\]/);
  assert.ok(
    body.indexOf('state.storeManagerDashboardMap[state.store]') < body.indexOf('await loadStaffHome(state.store, state.myCrewId)'),
    'store settings must be restored before staff home renders'
  );
});

test('manager home summary condition remains independent from sales access', () => {
  const marker = 'if(person.isManager && managerDashboardEnabled(state.store)){';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, 'manager summary condition not found');
  assert.doesNotMatch(marker, /salesAccess|sales_access/);
});
