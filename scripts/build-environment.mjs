import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const context = process.env.CONTEXT;
const environment = context === 'production' ? 'production' :
  ['deploy-preview','branch-deploy','dev'].includes(context) ? 'staging' : null;
if (!environment) throw new Error('Unknown build context. Set CONTEXT explicitly; no production fallback is allowed.');
if (environment === 'production' && process.env.BRANCH && process.env.BRANCH !== 'main') {
  throw new Error('Only main may produce a production build.');
}
const all = JSON.parse(readFileSync(resolve(root,'config/environments.json'),'utf8'));
const config = all[environment];
if (!config || config.environment !== environment || !/^[a-z]{20}$/.test(config.projectRef) ||
    config.supabaseUrl !== `https://${config.projectRef}.supabase.co` ||
    !config.publishableKey?.startsWith('sb_publishable_')) throw new Error('Invalid backend configuration.');
if (all.staging.projectRef === all.production.projectRef || all.staging.publishableKey === all.production.publishableKey) {
  throw new Error('Staging must have a separate project and public key.');
}
const output = resolve(root,'dist');
rmSync(output,{recursive:true,force:true});
mkdirSync(output,{recursive:true});
const html = readFileSync(resolve(root,'index.html'),'utf8');
if (!html.includes('src="/app-config.js"') || html.includes(all.production.supabaseUrl) ||
    html.includes(all.production.publishableKey)) throw new Error('Canonical HTML still contains a production connection.');
writeFileSync(resolve(output,'index.html'),html);
writeFileSync(resolve(output,'app-config.js'),'window.MANEE_CONFIG = Object.freeze('+JSON.stringify(config)+');\n');
const manifest = JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
if (environment === 'staging') { manifest.name = '매니 테스트'; manifest.short_name = '매니 테스트'; }
writeFileSync(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
let sw = readFileSync(resolve(root,'sw.js'),'utf8');
if (environment === 'staging') {
  const anchor = 'self.addEventListener("push", (event) => {';
  if (sw.split(anchor).length !== 2) throw new Error('Review service-worker push handler before building.');
  sw = sw.replace(anchor,anchor+'\n  // MANEE_STAGING_SW: ignore subscriptions created before backend separation.\n  return;');
}
writeFileSync(resolve(output,'sw.js'),sw);
if (existsSync(resolve(root,'icons'))) cpSync(resolve(root,'icons'),resolve(output,'icons'),{recursive:true});
mkdirSync(resolve(root,'netlify/functions/lib'),{recursive:true});
writeFileSync(resolve(root,'netlify/functions/lib/manee-environment.json'),JSON.stringify({
  environment, projectRef:config.projectRef, externalServicesEnabled:environment === 'production',
},null,2)+'\n');
console.log(JSON.stringify({environment,projectRef:config.projectRef,publish:'dist',externalServicesEnabled:environment === 'production'}));
