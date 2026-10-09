import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(mobile, '..');
const environment = process.argv[2];
if (!['staging', 'production'].includes(environment)) {
  throw new Error('Specify staging or production explicitly.');
}
const environments = JSON.parse(readFileSync(resolve(root, 'config/environments.json'), 'utf8'));
const config = environments[environment];
if (config.environment !== environment || !/^[a-z]{20}$/.test(config.projectRef) ||
    config.supabaseUrl !== `https://${config.projectRef}.supabase.co` ||
    !config.publishableKey.startsWith('sb_publishable_') ||
    environments.staging.projectRef === environments.production.projectRef) {
  throw new Error('Invalid or shared backend configuration.');
}
const publicSites = JSON.parse(readFileSync(resolve(root, 'config/public-sites.json'), 'utf8'));
const publicOrigin = new URL(publicSites[0].origin).origin;
if (!publicOrigin.startsWith('https://')) throw new Error('Public origin must use HTTPS.');
let html = readFileSync(resolve(root, 'index.html'), 'utf8');
function replaceOnce(before, after) {
  if (html.split(before).length !== 2) throw new Error(`Review mobile build anchor: ${before}`);
  html = html.replace(before, after);
}
replaceOnce('const MANEE_STAFF_AUTH_ENABLED = MANEE_IS_STAGING;',
  'const MANEE_STAFF_AUTH_ENABLED = true; // Native builds always require staff Auth.');
replaceOnce('<script src="/app-config.js"></script>',
  '<script src="/app-config.js"></script>\n<script src="/native.js"></script>');
replaceOnce('<script src="https://cdn.jsdelivr.net/npm/xlsx-js-style/dist/xlsx.bundle.js"></script>',
  '<script src="/vendor/xlsx.bundle.js"></script>');
replaceOnce('<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js"></script>',
  '<script src="/vendor/supabase.js"></script>');
html = html.replaceAll('navigator.geolocation', 'window.MANEE_GEOLOCATION');
// WKWebView web push is not APNs. Avoid waiting forever for an unregistered worker.
html = html.replaceAll('"serviceWorker" in navigator', 'false /* Native push not yet integrated */');
replaceOnce("location.origin+'/'", JSON.stringify(publicOrigin + '/'));
// There is no staging Netlify service. Fail closed instead of hitting production.
const functionsOrigin = environment === 'production' ? publicOrigin : 'https://staging-services-disabled.invalid';
html = html.replaceAll('"/.netlify/functions/', '"' + functionsOrigin + '/.netlify/functions/');
const output = resolve(mobile, 'www');
rmSync(output, { recursive: true, force: true });
mkdirSync(resolve(output, 'vendor'), { recursive: true });
writeFileSync(resolve(output, 'index.html'), html);
writeFileSync(resolve(output, 'app-config.js'), 'window.MANEE_CONFIG = Object.freeze(' + JSON.stringify(config) + ');\n');
for (const asset of ['owner-ui.css', 'report-assets', 'icons', 'manifest.json']) {
  cpSync(resolve(root, asset), resolve(output, asset), { recursive: true });
}
cpSync(resolve(mobile, 'node_modules/xlsx-js-style/dist/xlsx.bundle.js'), resolve(output, 'vendor/xlsx.bundle.js'));
cpSync(resolve(mobile, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), resolve(output, 'vendor/supabase.js'));
await build({ entryPoints: [resolve(mobile, 'src/native.js')], bundle: true,
  outfile: resolve(output, 'native.js'), format: 'iife', target: 'safari15', minify: true });
writeFileSync(resolve(output, 'build-info.json'), JSON.stringify({ environment, projectRef: config.projectRef }, null, 2) + '\n');
console.log(`Prepared ${environment} native web assets (${config.projectRef}).`);
