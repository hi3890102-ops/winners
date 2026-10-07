// Public, unauthenticated browser checks only. No form submission or business writes.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const sites = JSON.parse(readFileSync('config/public-sites.json', 'utf8'));
mkdirSync('browser-results', { recursive: true });
const results = [];
const browser = await chromium.launch();
try {
  for (const [siteIndex, site] of sites.entries()) {
    const origin = new URL(site.origin);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password) throw new Error('Invalid configured public origin');
    for (const width of [375, 430, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      const result = { site: site.name, width, ok: false, pageErrors: 0, failedResources: 0 };
      page.on('pageerror', () => { result.pageErrors++; });
      page.on('response', response => {
        if (new URL(response.url()).origin === origin.origin && response.status() >= 400) result.failedResources++;
      });
      page.on('requestfailed', request => {
        if (new URL(request.url()).origin === origin.origin) result.failedResources++;
      });
      try {
        const response = await page.goto(origin.href, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(2000);
        const metrics = await page.evaluate(() => ({
          textLength: document.body.innerText.trim().length,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
          visibleControls: [...document.querySelectorAll('button,input,a')].filter(el => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          }).length,
        }));
        result.httpOk = response?.status() === 200;
        result.titleOk = (await page.title()) === site.title;
        result.sameOrigin = new URL(page.url()).origin === origin.origin;
        result.contentOk = metrics.textLength > 20 && metrics.visibleControls > 0;
        result.noOverflow = !metrics.overflow;
        result.ok = result.httpOk && result.titleOk && result.sameOrigin && result.contentOk && result.noOverflow && result.pageErrors === 0 && result.failedResources === 0;
        await page.screenshot({ path: 'browser-results/site-' + siteIndex + '-' + width + '.png', fullPage: true });
      } catch {
        result.error = 'Browser navigation or rendering failed; inspect workflow and public screenshot';
      } finally {
        results.push(result);
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
const report = { checkedAt: new Date().toISOString(), scope: 'Public login-before-authentication rendering only; no login, attendance, payroll or business writes', ok: results.length > 0 && results.every(r => r.ok), results };
writeFileSync('browser-results/report.json', JSON.stringify(report, null, 2));
for (const r of results) console.log((r.ok ? 'PASS' : 'FAIL') + ' ' + r.site + ' width=' + r.width + ' pageErrors=' + r.pageErrors + ' failedResources=' + r.failedResources);
if (!report.ok) process.exitCode = 1;
