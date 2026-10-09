import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(mobile, '..');
const read = path => readFileSync(resolve(mobile, path), 'utf8');
test('build isolates environments and leaves canonical web/backend sources untouched', () => {
  const canonicalPaths = ['index.html', 'netlify/functions/lib/manee-environment.json'];
  const original = canonicalPaths.map(p => readFileSync(resolve(root, p), 'utf8'));
  assert.notEqual(spawnSync(process.execPath, ['scripts/build-web.mjs'], { cwd: mobile }).status, 0);
  for (const environment of ['production', 'staging']) {
    execFileSync(process.execPath, ['scripts/build-web.mjs', environment], { cwd: mobile });
    const sandbox = { window: {} };
    vm.runInNewContext(read('www/app-config.js'), sandbox);
    assert.equal(sandbox.window.MANEE_CONFIG.environment, environment);
    const html = read('www/index.html');
    assert.match(html, /const MANEE_STAFF_AUTH_ENABLED = true/);
    assert.doesNotMatch(html, /navigator\.geolocation|location\.origin|'"serviceWorker" in navigator'/);
    assert.doesNotMatch(html, /fetch\("\/\.netlify\/functions\//);
    assert.match(html, /window\.MANEE_GEOLOCATION\.getCurrentPosition/);
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
    if (environment === 'staging') {
      assert.match(html, /https:\/\/staging-services-disabled\.invalid\/\.netlify\/functions\//);
      assert.doesNotMatch(html, /https:\/\/winners-staffapp\.netlify\.app\/\.netlify\/functions\//);
    }
    for (const asset of ['native.js', 'vendor/supabase.js', 'vendor/xlsx.bundle.js', 'report-assets/monthly-report.js']) {
      assert.ok(existsSync(resolve(mobile, 'www', asset)));
    }
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      if (match[1].trim()) new vm.Script(match[1]);
    }
  }
  canonicalPaths.forEach((p, i) => assert.equal(readFileSync(resolve(root, p), 'utf8'), original[i]));
});
