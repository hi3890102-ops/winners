import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('Auth staff session restores manager dashboard, location, and business cutoff settings', () => {
  const start = html.indexOf('async function restoreManeeAuthIdentity');
  const end = html.indexOf('async function loadAuthStaffCrew', start);
  assert.ok(start >= 0 && end > start, 'restoreManeeAuthIdentity block not found');
  const body = html.slice(start, end);

  assert.match(body, /manager_dashboard_enabled/);
  assert.match(body, /state\.storeManagerDashboardMap\[selected\.store_name\]\s*=\s*!!selected\.manager_dashboard_enabled/);
  assert.match(body, /state\.storeLocationMap\[selected\.store_name\]/);
  assert.match(body, /state\.storeCutoffMap\[selected\.store_name\]\s*=\s*selected\.cutoff/);
});

test('Manager home summary does not require sales_access', () => {
  const marker = 'if(person.isManager && managerDashboardEnabled(state.store))';
  assert.ok(html.includes(marker), 'manager home summary condition changed unexpectedly');
  const pos = html.indexOf(marker);
  const nearby = html.slice(Math.max(0, pos - 120), pos + 220);
  assert.doesNotMatch(nearby, /salesAccess|sales_access/);
});

test('Staff portal session exposes manager dashboard, location, and cutoff settings', () => {
  const sql = readFileSync(new URL('./staff-auth.sql', import.meta.url), 'utf8');
  assert.match(sql, /'lat',s\.lat/);
  assert.match(sql, /'lng',s\.lng/);
  assert.match(sql, /'cutoff',s\.business_day_cutoff_hour/);
  assert.match(sql, /'manager_dashboard_enabled',s\.manager_dashboard_enabled/);
});
