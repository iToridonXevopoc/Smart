// Fallback helper: run this on YOUR PC if login from Railway fails (captcha / MFA / blocked IP).
// 1) npm i playwright && npx playwright install chromium
// 2) set env vars (PowerShell example):
//      $env:RAILWAY_URL="https://smart-production-bda4.up.railway.app"
//      $env:ADMIN_KEY="<same value as ACCESS_TOKEN on Railway>"
// 3) node get-cookie.js
// A browser window opens. Log in (solve captcha/MFA if asked). The cookie is sent to Railway automatically.
const { chromium } = require('playwright');

const USER = process.env.TRAX_USERNAME || 'thevidu@gssintl.biz';
const PASS = process.env.TRAX_PASSWORD || '202561208202690Ts@@@@';
const BASE = process.env.TRAX_BASE || 'https://smart-prod.trax-cloud.com';
const RAILWAY_URL = process.env.RAILWAY_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/leader-dashboard/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="password"]', { timeout: 20000 }).catch(() => {});
  const pass = await page.$('input[type="password"]');
  if (pass) {
    const user = await page.$('input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="text"]');
    if (user) await user.fill(USER);
    await pass.fill(PASS);
    await page.click('button[type="submit"], input[type="submit"]').catch(() => {});
  }
  console.log('Waiting for login to finish (solve captcha/MFA in the window if needed)...');
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline && (await page.$('input[type="password"]'))) await page.waitForTimeout(1000);
  await page.waitForTimeout(3000);
  const cookie = (await context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  await browser.close();

  if (RAILWAY_URL && ADMIN_KEY) {
    const r = await fetch(RAILWAY_URL + '/admin/cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ cookie }),
    });
    console.log('Sent to Railway:', r.status, await r.text());
  } else {
    console.log('\nRAILWAY_URL / ADMIN_KEY not set. Put this in Railway Variables as TRAX_COOKIE:\n');
    console.log(cookie);
  }
})();
