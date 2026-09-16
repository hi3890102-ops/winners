import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function sliceFunction(name, nextMarker){
  const start = html.indexOf(`  async function ${name}(`) >= 0
    ? html.indexOf(`  async function ${name}(`)
    : html.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = html.indexOf(nextMarker, start);
  assert.notEqual(end, -1, `${name} end marker not found`);
  return html.slice(start, end);
}

test('legacy staff join hydrates manager summary, location and cutoff store settings', () => {
  const body = sliceFunction('tryJoinCode', '  function switchUser()');
  assert.match(body, /stores\(id,name,lat,lng,manager_dashboard_enabled,business_day_cutoff_hour\)/);
  assert.match(body, /state\.storeLocationMap\[store\]/);
  assert.match(body, /state\.storeManagerDashboardMap\[store\] = !!data\.stores\.manager_dashboard_enabled/);
  assert.match(body, /state\.storeCutoffMap\[store\]/);
  assert.ok(body.indexOf('state.storeManagerDashboardMap[store]') < body.indexOf('await loadStaffHome(store, crewObj.id)'), 'summary setting must be hydrated before staff home renders');
});

test('manager home summary does not require sales_access', () => {
  const start = html.indexOf('    if(person.isManager && managerDashboardEnabled(state.store)){');
  assert.notEqual(start, -1, 'manager summary condition not found');
  const condition = html.slice(start, html.indexOf('{', start) + 1);
  assert.doesNotMatch(condition, /salesAccess|sales_access/);

  const state = { store: '테스트매장', storeManagerDashboardMap: { '테스트매장': true } };
  const person = { isManager: true, salesAccess: false };
  const managerDashboardEnabled = store => !!state.storeManagerDashboardMap[store];
  assert.equal(person.isManager && managerDashboardEnabled(state.store), true);
});
