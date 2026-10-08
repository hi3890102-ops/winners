// Read-only public deployment checks. Never logs in, calls a business API, or writes records.
import { readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { Script } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { incidentKey, normalizeFailure, createIncidentState, validateIncidentState, advanceIncidents } from './public-monitor-incidents.mjs';

const mime = {
  html: /text\/html/i,
  js: /(?:java|ecma)script/i,
  css: /text\/css/i,
  json: /(?:application\/json|manifest\+json)/i,
  font: /(?:font\/|application\/(?:octet-stream|x-font|font))/i,
};
function requireValue(condition, message, monitorReason) {
  if (!condition) throw Object.assign(new Error(message), { monitorReason });
}
function parseWithReason(parse, source, monitorReason) {
  try { return parse(source); }
  catch (error) { error.monitorReason = monitorReason; throw error; }
}
export function validateResource(bytes, contentType, type) {
  requireValue(bytes.length > 0, 'Empty response', 'response:empty');
  requireValue(mime[type]?.test(contentType), `Unexpected content type for ${type}`, `content-type:${type}`);
  const text = bytes.toString('utf8');
  if (type !== 'html') requireValue(!/^\s*(?:<!doctype html|<html)/i.test(text), 'HTML fallback returned instead of asset', 'response:html-fallback');
  if (type === 'js') parseWithReason(source => new Script(source), text, 'javascript:syntax');
  if (type === 'json') parseWithReason(JSON.parse, text, 'json:syntax');
  if (type === 'font') {
    const signature = bytes.subarray(0, 4).toString('hex');
    requireValue(['00010000', '4f54544f', '74746366'].includes(signature), 'Invalid font signature', 'font:signature');
  }
  return text;
}
export function validateConfig(source, expected, portalMode) {
  // Parse the generated JSON envelope without executing downloaded JavaScript.
  const match = source.match(/^\s*window\.MANEE_CONFIG\s*=\s*Object\.freeze\((\{[\s\S]*\})\);?\s*$/);
  requireValue(match, 'Missing generated app configuration', 'config:missing');
  const config = parseWithReason(JSON.parse, match[1], 'config:json');
  for (const key of ['environment', 'projectRef', 'supabaseUrl', 'publishableKey']) {
    requireValue(config[key] === expected[key], `Incorrect ${key}`, `config:${key.toLowerCase()}`);
  }
  requireValue(config.environment === 'production', 'Production site points to a test environment', 'config:environment');
  requireValue((config.portalMode ?? null) === (portalMode ?? null), 'Incorrect portal mode', 'config:portal-mode');
}
export function validatePage(html, site) {
  const title = html.match(/<title>\s*([^<]+?)\s*<\/title>/i)?.[1];
  requireValue(title === site.title, 'Wrong app page or access wall', 'page:title');
  requireValue(/<script\b[^>]*src=["']\/app-config\.js["']/i.test(html), 'Missing app configuration script', 'page:config-script');
  requireValue(new RegExp(`const ${site.authFlag} = true;`).test(html), 'Production authentication is not enabled', 'page:authentication');
  let scripts = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=|application\/ld\+json|application\/json/i.test(match[1]) || !match[2].trim()) continue;
    parseWithReason(source => new Script(source), match[2], 'javascript:syntax');
    scripts++;
  }
  requireValue(scripts > 0, 'Missing application JavaScript', 'page:javascript-missing');
}
export async function checkSite(site, expected, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const attempts = options.attempts ?? 2;
  const retryMs = options.retryMs ?? 1500;
  const origin = new URL(site.origin);
  requireValue(origin.protocol === 'https:' && origin.pathname === '/' && !origin.search && !origin.hash && !origin.username && !origin.password, 'Invalid site origin');
  const checks = [];
  async function check(path, type, validate = () => {}) {
    const url = new URL(path, origin);
    requireValue(url.origin === origin.origin && path.startsWith('/') && !path.startsWith('//'), 'Cross-origin asset is not allowed');
    const started = performance.now();
    let message = '';
    let failureReason;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetcher(url, {
          method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
          signal: AbortSignal.timeout(12000), headers: {'Cache-Control': 'no-cache'},
        });
        requireValue(response.status === 200, `HTTP ${response.status}`, `http:${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        requireValue(bytes.length <= 8 * 1024 * 1024, 'Unexpectedly large response', 'response:too-large');
        const text = validateResource(bytes, response.headers.get('content-type') ?? '', type);
        validate(text);
        checks.push({path, ok: true, attempts: attempt, durationMs: Math.round(performance.now() - started)});
        return;
      } catch (error) {
        message = error.message;
        failureReason = normalizeFailure(error);
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
    checks.push({path, ok: false, attempts, durationMs: Math.round(performance.now() - started), error: message, failureReason,
      incidentKey: incidentKey(site.origin, path, failureReason)});
  }
  await check('/', 'html', html => validatePage(html, site));
  await check('/app-config.js', 'js', source => validateConfig(source, expected, site.portalMode));
  await check('/manifest.json', 'json', source => {
    const manifest = JSON.parse(source);
    requireValue(typeof manifest?.name === 'string' && manifest.name.trim() && manifest.start_url === '/', 'Invalid app manifest', 'manifest:invalid');
  });
  await check('/sw.js', 'js');
  for (const asset of site.assets ?? []) await check(asset.path, asset.type);
  return {name: site.name, origin: site.origin, ok: checks.every(check => check.ok), checks};
}
export async function runMonitor(options = {}) {
  const root = options.root ?? fileURLToPath(new URL('../', import.meta.url));
  const env = options.env ?? process.env;
  // Standalone/release checks are stateless and cannot publish incident events.
  const managed = env.MONITOR_MANAGED === 'true';
  const statePath = resolve(root, 'monitoring-state.json');
  if (managed) rmSync(statePath, { force: true });
  const sites = JSON.parse(readFileSync(resolve(root, 'config/public-sites.json'), 'utf8'));
  const expected = JSON.parse(readFileSync(resolve(root, 'config/environments.json'), 'utf8')).production;
  requireValue(Array.isArray(sites) && sites.length > 0, 'No public sites configured');
  const results = [];
  for (const site of sites) results.push(await checkSite(site, expected, options));
  const report = {schemaVersion: 2, checkedAt: options.checkedAt ?? new Date().toISOString(), scope: 'Public HTTP assets and configuration only; no authenticated business actions', ok: results.every(site => site.ok), sites: results,
    incidentTracking: { status: managed ? 'unavailable' : 'disabled' }, incidents: [], notifications: []};
  if (managed) {
    try {
      const run = { id: env.GITHUB_RUN_ID, attempt: Number(env.GITHUB_RUN_ATTEMPT) };
      requireValue(/^\d+$/.test(run.id ?? '') && Number.isSafeInteger(run.attempt) && run.attempt > 0, 'Missing Actions run identity');
      let previous;
      if (env.MONITOR_STATE_MODE === 'initialized') {
        requireValue(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.MONITOR_INITIALIZE === 'true', 'State initialization requires an explicit manual dispatch');
        previous = createIncidentState(`${env.GITHUB_REPOSITORY}:${run.id}:${run.attempt}`);
      } else {
        requireValue(env.MONITOR_STATE_MODE === 'restored', 'Previous state unavailable; no incident events emitted');
        previous = validateIncidentState(JSON.parse(readFileSync(resolve(root, env.MONITOR_STATE_PATH ?? 'previous-monitor/monitoring-state.json'), 'utf8')),
          { id: env.MONITOR_SOURCE_RUN_ID, attempt: Number(env.MONITOR_SOURCE_RUN_ATTEMPT) });
      }
      const next = advanceIncidents(previous, results, report.checkedAt, run);
      report.incidentTracking = { status: env.MONITOR_STATE_MODE, lineage: next.state.lineage, generation: next.state.generation,
        previousCheckedAt: previous.checkedAt, sourceArtifactId: env.MONITOR_SOURCE_ARTIFACT_ID ?? null, run,
        publication: 'Only the state checkpoint artifact commits these events; diagnostic results alone do not authorize notifications' };
      report.incidents = next.incidents;
      report.notifications = next.notifications;
      writeFileSync(statePath, JSON.stringify(next.state, null, 2) + '\n');
    } catch (error) {
      // Keep the public check evidence, but never silently reset/downgrade the state chain.
      report.incidentTracking = { status: 'unavailable', error: error.message, notificationsSuppressed: true };
      report.incidents = [];
      report.notifications = [];
      rmSync(statePath, { force: true });
    }
  }
  writeFileSync(resolve(root, 'monitoring-results.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = ['## Public deployment checks', '', '| Site | Path | Result | Time (ms) |', '| --- | --- | --- | --- |'];
  for (const site of results) for (const check of site.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${site.name} ${check.path} ${check.durationMs}ms${check.error ? ': ' + check.error : ''}`);
    lines.push(`| ${site.name} | ${check.path} | ${check.ok ? 'PASS' : 'FAIL'} | ${check.durationMs} |`);
  }
  lines.push('', report.scope, '');
  lines.push(`Incident tracking: ${report.incidentTracking.status}. Events are eligible only after checkpoint upload.`, '', '| Incident ID | Transition | Notify |', '| --- | --- | --- |');
  for (const incident of report.incidents) lines.push(`| ${incident.id} | ${incident.transition} | ${incident.shouldNotify} |`);
  if (report.incidentTracking.error) lines.push('', report.incidentTracking.error);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  // The scheduled workflow evaluates alerts AFTER durable checkpoint upload.
  return { report, exitCode: managed ? Number(report.incidentTracking.status === 'unavailable') : Number(!report.ok) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMonitor().then(({ exitCode }) => { process.exitCode = exitCode; }).catch(error => {console.error(error.message); process.exitCode = 1;});
}
