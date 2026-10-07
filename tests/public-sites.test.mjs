import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSite, validateConfig, validateResource, validatePage } from '../scripts/check-public-sites.mjs';

const expected = {environment:'production', projectRef:'test-project', supabaseUrl:'https://test-project.supabase.co', publishableKey:'sb_publishable_test'};
const site = {name:'Fixture', origin:'https://fixture.invalid', title:'매니', authFlag:'MANEE_STAFF_AUTH_ENABLED'};
const html = '<title>매니</title><script src="/app-config.js"></script><script>const MANEE_STAFF_AUTH_ENABLED = true;</script>';
const config = c => `window.MANEE_CONFIG = Object.freeze(${JSON.stringify(c)});\n`;
const fixtures = {
  '/': [html, 'text/html'],
  '/app-config.js': [config(expected), 'text/javascript'],
  '/manifest.json': [JSON.stringify({name:'매니', start_url:'/'}), 'application/manifest+json'],
  '/sw.js': ['self.addEventListener("fetch", () => {});', 'application/javascript'],
};
function fixtureFetch(overrides = {}, calls = []) {
  return async (url, options) => {
    calls.push({url, options});
    const [body, type, status = 200] = overrides[url.pathname] ?? fixtures[url.pathname];
    return new Response(body, {status, headers:{'content-type':type}});
  };
}
test('healthy public check uses only unauthenticated GETs on the configured origin', async () => {
  const calls = [];
  const result = await checkSite(site, expected, {fetcher:fixtureFetch({}, calls), attempts:1});
  assert.equal(result.ok, true);
  assert.equal(calls.length, 4);
  for (const {url, options} of calls) {
    assert.equal(url.origin, site.origin);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, undefined);
  }
});
test('an HTTP failure is retried and does not hide the other resource results', async () => {
  const calls = [];
  const result = await checkSite(site, expected, {fetcher:fixtureFetch({'/':['unavailable','text/plain',503]}, calls), attempts:2, retryMs:0});
  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 4);
  assert.equal(result.checks[0].attempts, 2);
  assert.match(result.checks[0].error, /503/);
  assert.equal(calls.length, 5);
});
test('network exceptions become failed checks instead of a successful empty report', async () => {
  const result = await checkSite(site, expected, {fetcher:async()=>{throw Error('offline');}, attempts:1});
  assert.equal(result.ok, false);
  assert.equal(result.checks.filter(x=>!x.ok).length, 4);
});
test('a staging backend or wrong portal cannot pass a production check', () => {
  assert.throws(()=>validateConfig(config({...expected, environment:'staging'}), expected), /environment/);
  assert.throws(()=>validateConfig(config({...expected, projectRef:'other'}), expected), /projectRef/);
  assert.throws(()=>validateConfig(config({...expected, portalMode:'hq'}), expected, 'franchise'), /portal mode/);
  validateConfig(config({...expected, portalMode:'hq'}), expected, 'hq');
});
test('configuration cannot execute injected JavaScript', () => {
  assert.throws(()=>validateConfig(config(expected)+'throw new Error("executed");', expected), /configuration/);
});
test('200 access walls and broken inline scripts fail the page check', () => {
  assert.throws(()=>validatePage('<title>Sign in</title>', site), /Wrong app/);
  assert.throws(()=>validatePage(html.replace('= true;', '= false;'), site), /authentication/);
  assert.throws(()=>validatePage(html+'<script>const broken = ;</script>', site), SyntaxError);
});
test('HTML fallbacks, malformed JSON and fake fonts fail asset validation', () => {
  assert.throws(()=>validateResource(Buffer.from('<!doctype html>'), 'application/javascript', 'js'), /HTML fallback/);
  assert.throws(()=>validateResource(Buffer.from('{}'), 'text/html', 'json'), /content type/);
  assert.throws(()=>validateResource(Buffer.from('{'), 'application/json', 'json'), SyntaxError);
  assert.throws(()=>validateResource(Buffer.from('fake'), 'font/ttf', 'font'), /font signature/);
});
test('configured external assets are rejected before any external request', async () => {
  const calls = [];
  await assert.rejects(checkSite({...site, assets:[{path:'//other.invalid/a.js', type:'js'}]}, expected, {fetcher:fixtureFetch({}, calls), attempts:1}), /Cross-origin/);
  assert.equal(calls.length, 4);
});
