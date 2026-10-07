// Read-only public deployment checks. Never logs in, calls a business API, or writes records.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const mime = {
  html: /text\/html/i,
  js: /(?:java|ecma)script/i,
  css: /text\/css/i,
  json: /(?:application\/json|manifest\+json)/i,
  font: /(?:font\/|application\/(?:octet-stream|x-font|font))/i,
};
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
export function validateResource(bytes, contentType, type) {
  requireValue(bytes.length > 0, 'Empty response');
  requireValue(mime[type]?.test(contentType), `Unexpected content type for ${type}`);
  const text = bytes.toString('utf8');
  if (type !== 'html') requireValue(!/^\s*(?:<!doctype html|<html)/i.test(text), 'HTML fallback returned instead of asset');
  if (type === 'js') new Script(text);
  if (type === 'json') JSON.parse(text);
  if (type === 'font') {
    const signature = bytes.subarray(0, 4).toString('hex');
    requireValue(['00010000', '4f54544f', '74746366'].includes(signature), 'Invalid font signature');
  }
  return text;
}
export function validateConfig(source, expected, portalMode) {
  // Parse the generated JSON envelope without executing downloaded JavaScript.
  const match = source.match(/^\s*window\.MANEE_CONFIG\s*=\s*Object\.freeze\((\{[\s\S]*\})\);?\s*$/);
  requireValue(match, 'Missing generated app configuration');
  const config = JSON.parse(match[1]);
  for (const key of ['environment', 'projectRef', 'supabaseUrl', 'publishableKey']) {
    requireValue(config[key] === expected[key], `Incorrect ${key}`);
  }
  requireValue(config.environment === 'production', 'Production site points to a test environment');
  requireValue((config.portalMode ?? null) === (portalMode ?? null), 'Incorrect portal mode');
}
export function validatePage(html, site) {
  const title = html.match(/<title>\s*([^<]+?)\s*<\/title>/i)?.[1];
  requireValue(title === site.title, 'Wrong app page or access wall');
  requireValue(/<script\b[^>]*src=["']\/app-config\.js["']/i.test(html), 'Missing app configuration script');
  requireValue(new RegExp(`const ${site.authFlag} = true;`).test(html), 'Production authentication is not enabled');
  let scripts = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=|application\/ld\+json|application\/json/i.test(match[1]) || !match[2].trim()) continue;
    new Script(match[2]);
    scripts++;
  }
  requireValue(scripts > 0, 'Missing application JavaScript');
}
export async function checkSite(site, expected, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const attempts = options.attempts ?? 2;
  const retryMs = options.retryMs ?? 1500;
  const origin = new URL(site.origin);
  requireValue(origin.protocol === 'https:' && origin.pathname === '/' && !origin.username && !origin.password, 'Invalid site origin');
  const checks = [];
  async function check(path, type, validate = () => {}) {
    const url = new URL(path, origin);
    requireValue(url.origin === origin.origin && path.startsWith('/') && !path.startsWith('//'), 'Cross-origin asset is not allowed');
    const started = performance.now();
    let message = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetcher(url, {
          method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
          signal: AbortSignal.timeout(12000), headers: {'Cache-Control': 'no-cache'},
        });
        requireValue(response.status === 200, `HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        requireValue(bytes.length <= 8 * 1024 * 1024, 'Unexpectedly large response');
        const text = validateResource(bytes, response.headers.get('content-type') ?? '', type);
        validate(text);
        checks.push({path, ok: true, attempts: attempt, durationMs: Math.round(performance.now() - started)});
        return;
      } catch (error) {
        message = error.message;
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, retryMs));
      }
    }
    checks.push({path, ok: false, attempts, durationMs: Math.round(performance.now() - started), error: message});
  }
  await check('/', 'html', html => validatePage(html, site));
  await check('/app-config.js', 'js', source => validateConfig(source, expected, site.portalMode));
  await check('/manifest.json', 'json', source => {
    const manifest = JSON.parse(source);
    requireValue(typeof manifest.name === 'string' && manifest.name.trim() && manifest.start_url === '/', 'Invalid app manifest');
  });
  await check('/sw.js', 'js');
  for (const asset of site.assets ?? []) await check(asset.path, asset.type);
  return {name: site.name, origin: site.origin, ok: checks.every(check => check.ok), checks};
}
async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sites = JSON.parse(readFileSync(resolve(root, 'config/public-sites.json'), 'utf8'));
  const expected = JSON.parse(readFileSync(resolve(root, 'config/environments.json'), 'utf8')).production;
  requireValue(Array.isArray(sites) && sites.length > 0, 'No public sites configured');
  const results = [];
  for (const site of sites) results.push(await checkSite(site, expected));
  const report = {checkedAt: new Date().toISOString(), scope: 'Public HTTP assets and configuration only; no authenticated business actions', ok: results.every(site => site.ok), sites: results};
  writeFileSync(resolve(root, 'monitoring-results.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = ['## Public deployment checks', '', '| Site | Path | Result | Time (ms) |', '| --- | --- | --- | --- |'];
  for (const site of results) for (const check of site.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${site.name} ${check.path} ${check.durationMs}ms${check.error ? ': ' + check.error : ''}`);
    lines.push(`| ${site.name} | ${check.path} | ${check.ok ? 'PASS' : 'FAIL'} | ${check.durationMs} |`);
  }
  lines.push('', report.scope, '');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  if (!report.ok) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {console.error(error.message); process.exitCode = 1;});
}
