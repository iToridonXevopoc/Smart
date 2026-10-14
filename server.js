require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const USER = process.env.TRAX_USERNAME;
const PASS = process.env.TRAX_PASSWORD;
const BASE = process.env.TRAX_BASE || 'https://smart-prod.trax-cloud.com';
const PORT = parseInt(process.env.PORT || '3000');
const HEADLESS = process.env.HEADLESS !== 'false';
const DASH_URL = `${BASE}/leader-dashboard/dashboard`;
// SLA in minutes per project. Any project not listed here gets DEFAULT_SLA (24 hours).
const SLA_MAP = {
  cbcdairyil: 20,
  inbevci: 15,
  inbevnl: 15,
  marsbh: 15,
  marskw: 15,
  marsom: 15,
  marsqa: 15,
  marsuae: 15,
  risparkwinede: 15,
  straussdryil: 15,
  straussfritolayil: 60,
  straussil: 15,
  tevade: 20,
  tevapl: 20,
  tevaru: 20,
};
const DEFAULT_SLA = 24 * 60;
const getSla = name => SLA_MAP[name] ?? DEFAULT_SLA;

if (!USER || !PASS) { console.error('Set TRAX_USERNAME and TRAX_PASSWORD in .env'); process.exit(1); }

const ALLOWED_TASK_TYPES = ['voting_engine', 'stitching', 'validation', 'voting'];
const SLA_TYPES = ['validation', 'stitching'];

let browser, context, page;
let loggingIn = null;
let loggedIn = false;
const startTimes = new Map();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fmt = s => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
class AuthError extends Error {}


// ---------- Login ----------
async function login() {
  if (loggingIn) return loggingIn;
  loggingIn = (async () => {
    log('Logging in...');
    loggedIn = false;
    if (page) await page.close().catch(() => {});
    page = await context.newPage();
    await page.goto(DASH_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="password"]', { timeout: 20000 }).catch(() => {});
    const pass = await page.$('input[type="password"]');
    if (pass) {
      const user = await page.$(
        'input[type="email"], input[name*="user" i], input[name*="email" i], input[id*="user" i], input[id*="email" i], input[type="text"]'
      );
      if (!user) throw new Error('Username field not found');
      await user.fill(USER);
      await pass.fill(PASS);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.click('button[type="submit"], input[type="submit"]').catch(async () => {
          await page.getByRole('button', { name: /log\s?in|sign\s?in/i }).click();
        }),
      ]);
      await page.waitForTimeout(4000);
    }
    const stillLogin = await page.$('input[type="password"]');
    if (stillLogin) {
      await page.screenshot({ path: 'login-failed.png' }).catch(() => {});
      throw new Error('Login failed (password field still visible). Check login-failed.png (MFA/captcha/wrong password?)');
    }
    loggedIn = true;
    log('Login OK');
  })().finally(() => { loggingIn = null; });
  return loggingIn;
}

// ---------- Trax fetch ----------
async function fetchOnce(project) {
  const r = await context.request.get(`${BASE}/api/team-leader/${project}/lockedTasks`, {
    timeout: 12000, headers: { Accept: 'application/json' },
  });
  const status = r.status();
  const ct = r.headers()['content-type'] || '';
  if (status === 401) throw new AuthError('session expired (401)');
  if (status === 403) throw new Error('no access to this project (403)');
  if (status === 404) throw new Error('project not found (404)');
  if (!r.ok()) throw new Error(`Trax returned HTTP ${status}`);
  const text = await r.text();
  if (!text.trim()) return [];
  if (!ct.includes('json') && text.trim().startsWith('<')) throw new AuthError('got login page instead of data');
  try { const j = JSON.parse(text); return Array.isArray(j) ? j : []; }
  catch (e) { throw new Error('Trax returned invalid JSON'); }
}

async function fetchProject(project) {
  if (!loggedIn) await login();
  try {
    return await fetchOnce(project);
  } catch (e) {
    if (e instanceof AuthError) { await login(); return await fetchOnce(project); }
    throw e;
  }
}

// ---------- Processing ----------
function processRows(raw, project, slaMins) {
  const now = Date.now();
  const live = new Set();
  const rows = [];
  for (const td of raw) {
    if (!ALLOWED_TASK_TYPES.includes(td.taskType)) continue;
    if (!td.lockedBy || td.lockedBy === 'undefined' || td.lockedBy === 'N/A') continue;
    const key = `${project}|${td.lockedBy}_${td.taskType}_${td.objectId}_${td.uuid}`;
    live.add(key);
    if (!startTimes.has(key)) startTimes.set(key, td.pullDate ? new Date(td.pullDate).getTime() : now);
    const dur = Math.floor((now - startTimes.get(key)) / 1000);
    const created = td.insertDate ? new Date(td.insertDate).getTime() : now;
    const tracked = SLA_TYPES.includes(td.taskType);
    const remaining = tracked ? slaMins * 60 - Math.floor((now - created) / 1000) : null;
    rows.push({
      email: td.lockedBy, taskType: td.taskType, project, objectId: td.objectId || 'N/A',
      durationSeconds: dur, duration: fmt(dur),
      remainingSeconds: remaining, slaMinutes: tracked ? slaMins : null,
      created: new Date(created).toISOString(),
    });
  }
  for (const k of startTimes.keys()) if (k.startsWith(project + '|') && !live.has(k)) startTimes.delete(k);
  return rows;
}

// ---------- HTTP ----------
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.url === '/' || req.url === '/dashboard') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
    }
    if (req.url === '/health') return res.end(JSON.stringify({ loggedIn }));
    if (req.url.startsWith('/project/')) {
      const u = new URL(req.url, 'http://localhost');
      const name = decodeURIComponent(u.pathname.slice('/project/'.length)).trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,60}$/.test(name)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Invalid project name' })); }
      const sla = getSla(name);
      const raw = await fetchProject(name);
      return res.end(JSON.stringify({ project: name, sla, updatedAt: new Date().toISOString(), tasks: processRows(raw, name, sla) }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'Route not found: ' + req.url + ' (make sure you are running the latest server.js and restarted it)' }));
  } catch (e) {
    log('Request error:', req.url, e.message);
    res.statusCode = 502; res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => log(`Open http://localhost:${PORT}`));

// ---------- Start ----------
(async () => {
  browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  context = await browser.newContext();
  for (let i = 0; i < 5; i++) {
    try { await login(); break; } catch (e) { log(e.message); if (i === 4) process.exit(1); await new Promise(r => setTimeout(r, 10000)); }
  }
  setInterval(() => page && page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {}), 10 * 60 * 1000);
})();

process.on('SIGINT', async () => { await browser?.close(); process.exit(0); });