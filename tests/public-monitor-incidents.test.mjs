import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIncidentState, advanceIncidents, incidentKey, normalizeFailure, validateIncidentState, committedAlertExitCode } from '../scripts/public-monitor-incidents.mjs';
import { runMonitor, checkSite } from '../scripts/check-public-sites.mjs';
import { findPreviousCheckpoint } from '../scripts/restore-public-monitor-state.mjs';

const origin = 'https://fixture.invalid';
const time = n => new Date(Date.UTC(2026, 9, 7, 0, n * 5)).toISOString();
const run = n => ({ id: String(n), attempt: 1 });
const results = (ok, reason = 'http:503', path = '/') => [{ name: 'Fixture', origin, ok, checks: [{ path, ok, ...(ok ? {} : { failureReason: reason }) }] }];
const advance = (state, n, ok, reason, path) => advanceIncidents(state, results(ok, reason, path), time(n), run(n));
const initial = () => createIncidentState('test-history');
const reportFor = next => ({ incidentTracking: { status: 'restored' }, notifications: next.notifications, ok: false });

test('failure -> repeated failure -> recovery -> healthy -> recurrence -> repeated recurrence', () => {
  const fresh = initial();
  const first = advance(fresh, 1, false);
  assert.equal(fresh.generation, 0, 'the source checkpoint is immutable');
  const key = first.incidents[0].key;
  const id = first.incidents[0].id;
  assert.equal(first.incidents[0].transition, 'new');
  assert.equal(first.notifications.length, 1);
  assert.equal(first.state.incidents[key].consecutiveFailures, 1);
  assert.equal(committedAlertExitCode(reportFor(first), true), 1);

  const repeated = advance(first.state, 2, false);
  assert.equal(repeated.incidents[0].transition, 'ongoing');
  assert.equal(repeated.incidents[0].id, id);
  assert.equal(repeated.state.incidents[key].consecutiveFailures, 2);
  assert.deepEqual(repeated.notifications, []);
  assert.equal(committedAlertExitCode(reportFor(repeated), true), 0);
  assert.equal(committedAlertExitCode(reportFor(repeated), false), 1, 'persistence errors cannot be green');

  const recovery = advance(repeated.state, 3, true);
  assert.equal(recovery.incidents[0].transition, 'recovered');
  assert.equal(recovery.incidents[0].id, id);
  assert.equal(recovery.notifications.length, 1);
  assert.equal(recovery.state.incidents[key].recoveredAt, time(3));
  assert.equal(committedAlertExitCode(reportFor(recovery), true), 0);
  const healthy = advance(recovery.state, 4, true);
  assert.deepEqual(healthy.notifications, []);
  assert.deepEqual(healthy.incidents, []);
  assert.equal(healthy.state.incidents[key].status, 'resolved', 'resolved history must survive healthy runs');

  const recurrence = advance(healthy.state, 5, false);
  assert.equal(recurrence.incidents[0].transition, 'recurred');
  assert.equal(recurrence.incidents[0].key, key);
  assert.notEqual(recurrence.incidents[0].id, id);
  assert.notEqual(recurrence.notifications[0].eventId, first.notifications[0].eventId);
  assert.equal(recurrence.incidents[0].occurrence, 2);
  assert.equal(recurrence.incidents[0].openedAt, time(5));
  assert.equal(recurrence.incidents[0].firstSeenAt, time(1));
  assert.equal(committedAlertExitCode(reportFor(recurrence), true), 1);
  assert.equal(advance(recurrence.state, 6, false).notifications.length, 0);
});

test('keys canonicalize origins/cache-busting but distinguish site, case-sensitive path and reason', () => {
  const key = incidentKey('https://FIXTURE.invalid:443/', '/app.js?v=123#fragment', 'http:503');
  assert.equal(key, incidentKey(origin, '/app.js?v=999', 'http:503'));
  assert.notEqual(key, incidentKey('https://another.invalid', '/app.js', 'http:503'));
  assert.notEqual(key, incidentKey(origin, '/App.js', 'http:503'));
  assert.notEqual(key, incidentKey(origin, '/app.js', 'http:404'));
  assert.throws(() => incidentKey(origin, '//external.invalid/app.js', 'http:503'));
  const first = advance(initial(), 1, false);
  const renamed = results(false); renamed[0].name = 'Renamed display label';
  const next = advanceIncidents(first.state, renamed, time(2), run(2));
  assert.equal(next.incidents[0].id, first.incidents[0].id);
});

test('volatile error messages do not create new incident identities', () => {
  const a = Object.assign(new Error('fetch failed request=abc after 12001ms'), { cause: { code: 'ETIMEDOUT' } });
  const b = Object.assign(new Error('fetch failed request=xyz after 18005ms'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  assert.equal(normalizeFailure(a), 'network:timeout');
  assert.equal(normalizeFailure(a), normalizeFailure(b));
  assert.equal(normalizeFailure({ cause: { code: 'ENOTFOUND' } }), 'network:dns');
  assert.equal(normalizeFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }), 'network:tls');
  assert.equal(normalizeFailure(new Error('unknown detail 1')), normalizeFailure(new Error('other unknown detail 2')));
});

test('a missing path, removed site, or changed failure reason cannot falsely recover an incident', () => {
  const first = advance(initial(), 1, false);
  const missing = advanceIncidents(first.state, [], time(2), run(2));
  assert.equal(missing.incidents[0].transition, 'unobserved');
  assert.equal(missing.incidents[0].consecutiveFailures, 0);
  assert.equal(missing.notifications.length, 0);
  const elsewhere = advance(first.state, 2, true, undefined, '/other.js');
  assert.equal(elsewhere.notifications.length, 0);
  const different = advance(first.state, 2, false, 'network:timeout');
  assert.deepEqual(different.incidents.map(i => i.transition).sort(), ['new', 'unobserved']);
  assert.equal(different.notifications.length, 1);
  const oldAgain = advance(different.state, 3, false);
  assert.equal(oldAgain.notifications.length, 0, 'no healthy observation means no recurrence');
  assert.equal(oldAgain.incidents.find(i => i.reason === 'http:503').consecutiveFailures, 1);
  const recovery = advance(oldAgain.state, 4, true);
  assert.equal(recovery.notifications.length, 2, 'both outstanding causes recover on a successful check');
  assert.ok(recovery.notifications.every(i => i.transition === 'recovered'));
});

test('two sites with the same failing path remain independent', () => {
  const observations = [...results(false), { ...results(false)[0], name: 'Other', origin: 'https://other.invalid' }];
  const first = advanceIncidents(initial(), observations, time(1), run(1));
  assert.equal(new Set(first.notifications.map(i => i.key)).size, 2);
  observations[1].checks = [{ path: '/', ok: true }];
  const second = advanceIncidents(first.state, observations, time(2), run(2));
  assert.equal(second.notifications.length, 1);
  assert.equal(second.notifications[0].origin, 'https://other.invalid');
  assert.equal(second.notifications[0].transition, 'recovered');
});

test('corrupt, incompatible, mismatched and out-of-order states are rejected', () => {
  const first = advance(initial(), 1, false).state;
  for (const change of [s => s.schemaVersion++, s => s.scope = 'another-scope', s => s.generation = -1,
    s => s.incidents = [], s => Object.values(s.incidents)[0].id = 'forged',
    s => Object.values(s.incidents)[0].status = 'healthy', s => Object.values(s.incidents)[0].occurrence = 0]) {
    const broken = structuredClone(first); change(broken);
    assert.throws(() => validateIncidentState(broken), /Invalid monitor state/);
  }
  assert.throws(() => validateIncidentState(first, run(999)), /binding/);
  assert.throws(() => advance(first, 0, false), /chronology/);
  const reset = advance(createIncidentState('intentional-reset'), 1, false);
  assert.notEqual(reset.incidents[0].id, Object.values(first.incidents)[0].id);
});

const expected = { environment: 'production', projectRef: 'fixture', supabaseUrl: 'https://fixture.invalid', publishableKey: 'fixture-public' };
const site = { name: 'Fixture', origin, title: '매니', authFlag: 'MANEE_STAFF_AUTH_ENABLED' };
const fixtures = {
  '/': ['<title>매니</title><script src="/app-config.js"></script><script>const MANEE_STAFF_AUTH_ENABLED = true;</script>', 'text/html'],
  '/app-config.js': [`window.MANEE_CONFIG = Object.freeze(${JSON.stringify(expected)});`, 'text/javascript'],
  '/manifest.json': ['{"name":"매니","start_url":"/"}', 'application/json'],
  '/sw.js': ['self.addEventListener("fetch", () => {});', 'application/javascript'],
};
const fetcher = (failure, calls = []) => async (url, options) => {
  calls.push({ url, options });
  const [body, type] = fixtures[url.pathname];
  return new Response(body, { status: failure && url.pathname === '/' ? 503 : 200, headers: { 'content-type': type } });
};

test('real monitor round-trips JSON checkpoints across failures, recovery, recurrence and rerun', async t => {
  const root = mkdtempSync(join(tmpdir(), 'public-monitor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'config')); mkdirSync(join(root, 'previous-monitor'));
  writeFileSync(join(root, 'config/public-sites.json'), JSON.stringify([site]));
  writeFileSync(join(root, 'config/environments.json'), JSON.stringify({ production: expected }));
  const calls = [];
  const env = { MONITOR_MANAGED: 'true', MONITOR_STATE_MODE: 'initialized', MONITOR_INITIALIZE: 'true', GITHUB_REPOSITORY: 'fixture/repo', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1' };
  const events = [];
  for (const [index, failure] of [true, true, false, true, true].entries()) {
    const n = index + 1;
    env.GITHUB_RUN_ID = String(n);
    const { report, exitCode } = await runMonitor({ root, env, fetcher: fetcher(failure, calls), attempts: 1, checkedAt: time(n) });
    assert.equal(exitCode, 0, 'managed mode defers site alerts until persistence');
    assert.equal(report.ok, !failure);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'monitoring-results.json'))), report);
    events.push(report.incidents[0].transition);
    writeFileSync(join(root, 'previous-monitor/monitoring-state.json'), readFileSync(join(root, 'monitoring-state.json')));
    env.MONITOR_STATE_MODE = 'restored'; env.MONITOR_SOURCE_RUN_ID = String(n); env.MONITOR_SOURCE_RUN_ATTEMPT = '1';
  }
  assert.deepEqual(events, ['new', 'ongoing', 'recovered', 'recurred', 'ongoing']);
  // Rerunning an OLD run consumes the newest checkpoint, not its own old result.
  env.GITHUB_RUN_ID = '1'; env.GITHUB_RUN_ATTEMPT = '2';
  const rerun = await runMonitor({ root, env, fetcher: fetcher(true), attempts: 1, checkedAt: time(6) });
  assert.equal(rerun.report.incidents[0].transition, 'ongoing');
  assert.equal(rerun.report.notifications.length, 0);
  for (const { url, options } of calls) {
    assert.equal(url.origin, origin); assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
  }
  // Missing/corrupt state does not stop HTTP evidence collection or reset history.
  for (const content of [null, '{broken', JSON.stringify({ schemaVersion: 999 })]) {
    if (content === null) rmSync(join(root, 'previous-monitor/monitoring-state.json'));
    else writeFileSync(join(root, 'previous-monitor/monitoring-state.json'), content);
    const failed = await runMonitor({ root, env, fetcher: fetcher(true), attempts: 1, checkedAt: time(7) });
    assert.equal(failed.exitCode, 1); assert.equal(failed.report.sites[0].checks.length, 4);
    assert.equal(failed.report.incidentTracking.status, 'unavailable');
    assert.deepEqual(failed.report.notifications, []); assert.equal(existsSync(join(root, 'monitoring-state.json')), false);
  }
  const standalone = await runMonitor({ root, env: {}, fetcher: fetcher(true), attempts: 1 });
  assert.equal(standalone.exitCode, 1); assert.equal(standalone.report.incidentTracking.status, 'disabled');
  assert.equal(standalone.report.sites[0].checks[0].incidentKey, incidentKey(origin, '/', 'http:503'));
  assert.deepEqual(standalone.report.notifications, []);
});

test('normalization uses semantic failure codes from the checker, and successful retries emit no incident', async () => {
  for (const [path, body, type, reason] of [
    ['/sw.js', 'const x = ;', 'application/javascript', 'javascript:syntax'],
    ['/manifest.json', '{', 'application/json', 'json:syntax'],
    ['/sw.js', '<html>fallback', 'application/javascript', 'response:html-fallback'],
    ['/sw.js', 'hello', 'text/html', 'content-type:js'],
    ['/', '<title>wall</title>', 'text/html', 'page:title'],
  ]) {
    const checked = await checkSite(site, expected, { attempts: 1, fetcher: async (url, opts) => url.pathname === path
      ? new Response(body, { headers: { 'content-type': type } }) : fetcher(false)(url, opts) });
    assert.equal(checked.checks.find(c => c.path === path).failureReason, reason);
    assert.equal(checked.checks.find(c => c.path === path).incidentKey, incidentKey(origin, path, reason));
  }
  let calls = 0;
  const checked = await checkSite(site, expected, { attempts: 2, retryMs: 0, fetcher: (url, opts) => fetcher(calls++ === 0)(url, opts) });
  assert.equal(checked.ok, true); assert.equal(checked.checks[0].attempts, 2);
  assert.deepEqual(advanceIncidents(initial(), [checked], time(1), run(1)).notifications, []);
});

const workflowRun = (id, overrides = {}) => ({ id, workflow_id: 50, head_branch: 'main', repository: { id: 42 }, head_repository: { id: 42 }, event: 'schedule', path: '.github/workflows/monitor-public.yml', run_attempt: 1, conclusion: 'success', ...overrides });
const artifact = (id, source = id, attempt = 1, overrides = {}) => ({ id, name: `public-monitor-state-v1-${source}-${attempt}`, expired: false,
  workflow_run: { id: source, head_branch: 'main', head_repository_id: 42 }, ...overrides });
function fakeGithub(pages, runOverrides = {}) {
  const calls = [];
  return { calls, rest: { actions: {
    getWorkflowRun: async ({ run_id }) => { calls.push(['run', String(run_id)]); return { data: workflowRun(Number(run_id), runOverrides[run_id]) }; },
    listArtifactsForRepo: async ({ page }) => { calls.push(['page', page]); return { data: { artifacts: pages[page - 1] ?? [] } }; },
  } } };
}
const lookup = (github, overrides = {}) => findPreviousCheckpoint({ github, owner: 'fixture', repo: 'repo', runId: 100, attempt: 1, branch: 'main', ...overrides });

test('restore chooses newest artifact even from a failed run or old run rerun', async () => {
  const github = fakeGithub([[artifact(10, 95), artifact(11, 20, 2)]], { 20: { conclusion: 'failure', run_attempt: 2 } });
  assert.deepEqual(await lookup(github), { mode: 'restored', artifactId: '11', runId: '20', attempt: 2 });
  const sameRun = fakeGithub([[artifact(12, 100, 1)]], { 100: { run_attempt: 2 } });
  assert.equal((await lookup(sameRun, { attempt: 2 })).artifactId, '12');
});

test('restore paginates, rejects untrusted sources and does not depend on job success', async () => {
  const ignored = Array.from({ length: 100 }, (_, n) => artifact(2000 + n, 99, 1, { name: 'some-other-artifact' }));
  const github = fakeGithub([ignored, [artifact(19, 99), artifact(18, 98), artifact(17, 97), artifact(16, 96)]], {
    99: { workflow_id: 999 }, 98: { event: 'pull_request' }, 97: { head_branch: 'feature' }, 96: { conclusion: 'failure' },
  });
  assert.equal((await lookup(github)).runId, '96');
  assert.ok(github.calls.some(([type, page]) => type === 'page' && page === 2));
});

test('missing, expired and API failures fail closed; initialization must be explicit', async () => {
  await assert.rejects(lookup(fakeGithub([[]])), /No incident checkpoint/);
  await assert.rejects(lookup(fakeGithub([[]]), { initialize: true }), /No incident checkpoint/);
  assert.deepEqual(await lookup(fakeGithub([[]], { 100: { event: 'workflow_dispatch' } }), { initialize: true }), { mode: 'initialized' });
  const existing = fakeGithub([[artifact(9)]], { 100: { event: 'workflow_dispatch' } });
  assert.equal((await lookup(existing, { initialize: true })).mode, 'restored', 'initialization never resets an existing checkpoint');
  await assert.rejects(lookup(fakeGithub([[artifact(10, 10, 1, { expired: true }), artifact(9)]])), /expired/);
  const denied = fakeGithub([[]]); denied.rest.actions.listArtifactsForRepo = async () => { throw new Error('HTTP 403'); };
  await assert.rejects(lookup(denied, { initialize: true }), /403/);
  await assert.rejects(lookup(fakeGithub([[]], { 100: { head_branch: 'feature' } })), /default-branch/);
});
