const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- CONFIG ----------
// Railway Variables set karoth ewa use wenawa, nathnam methana thiyena values use wenawa.
const USER = process.env.TRAX_USERNAME || 'thevidu@gssintl.biz';
const PASS = process.env.TRAX_PASSWORD || '202561208202690Ts@@@@';
const BASE = process.env.TRAX_BASE || 'https://smart-prod.trax-cloud.com';
const PORT = parseInt(process.env.PORT || '3000');
const HEADLESS = process.env.HEADLESS !== 'false';
const ADMIN_KEY = process.env.ACCESS_TOKEN || '';   // needed only for /admin/cookie
const INITIAL_COOKIE = process.env.TRAX_COOKIE || ''; // optional: session cookie pushed from outside
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

if (!USER || !PASS) { console.error('Trax username/password missing'); process.exit(1); }

const ALLOWED_TASK_TYPES = ['voting_engine', 'stitching', 'validation', 'voting'];
const SLA_TYPES = ['validation', 'stitching'];

let cookieHeader = INITIAL_COOKIE;
let loggingIn = null;
let lastError = null;
const startTimes = new Map();

const log = (...a) => console.log(new Date().toISOString(), ...a);
const fmt = s => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
class AuthError extends Error {}

// ---------- Login (browser is opened ONLY while logging in, then closed to free RAM) ----------
async function browserLogin() {
  log('Logging in (browser)...');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer',
      '--disable-extensions', '--disable-background-networking', '--no-zygote',
      '--renderer-process-limit=1', '--js-flags=--max-old-space-size=256',
    ],
  });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route =>
      ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue());
    const page = await context.newPage();
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
    if (await page.$('input[type="password"]')) {
      throw new Error('Login failed (password field still visible). MFA/captcha/wrong password? Use get-cookie.js as a fallback.');
    }
    const cookies = await context.cookies();
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    lastError = null;
    log('Login OK, cookies:', cookies.length);
  } finally {
    await browser.close().catch(() => {});
  }
}

function login() {
  if (loggingIn) return loggingIn;
  loggingIn = browserLogin()
    .catch(e => { lastError = e.message; throw e; })
    .finally(() => { loggingIn = null; });
  return loggingIn;
}

// ---------- Trax fetch (plain HTTP with the session cookie, no browser) ----------
async function fetchOnce(project) {
  if (!cookieHeader) throw new AuthError('no session cookie yet');
  const r = await fetch(`${BASE}/api/team-leader/${project}/lockedTasks`, {
    headers: { Accept: 'application/json', Cookie: cookieHeader },
    redirect: 'manual',
    signal: AbortSignal.timeout(12000),
  });
  const status = r.status;
  const ct = r.headers.get('content-type') || '';
  if (status === 401 || (status >= 300 && status < 400)) throw new AuthError(`session expired (${status})`);
  if (status === 403) throw new Error('no access to this project (403)');
  if (status === 404) throw new Error('project not found (404)');
  if (!r.ok) throw new Error(`Trax returned HTTP ${status}`);
  const text = await r.text();
  if (!text.trim()) return [];
  if (!ct.includes('json') && text.trim().startsWith('<')) throw new AuthError('got login page instead of data');
  try { const j = JSON.parse(text); return Array.isArray(j) ? j : []; }
  catch (e) { throw new Error('Trax returned invalid JSON'); }
}

async function fetchProject(project) {
  try {
    return await fetchOnce(project);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    try { await login(); }
    catch (le) { throw new Error('Login problem: ' + le.message); }
    return await fetchOnce(project);
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
    if (req.url === '/health') return res.end(JSON.stringify({ loggedIn: !!cookieHeader, lastError }));
    if (req.url === '/admin/cookie' && req.method === 'POST') {
      if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Unauthorized' })); }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 20000) break; }
      const c = (JSON.parse(body || '{}').cookie || '').trim();
      if (!c) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'cookie missing' })); }
      cookieHeader = c; lastError = null;
      log('Cookie updated via /admin/cookie');
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.url.startsWith('/project/')) {
      const u = new URL(req.url, 'http://localhost');
      const name = decodeURIComponent(u.pathname.slice('/project/'.length)).trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,60}$/.test(name)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Invalid project name' })); }
      const sla = getSla(name);
      const raw = await fetchProject(name);
      return res.end(JSON.stringify({ project: name, sla, updatedAt: new Date().toISOString(), tasks: processRows(raw, name, sla) }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: 'Route not found: ' + req.url }));
  } catch (e) {
    log('Request error:', req.url, e.message);
    res.statusCode = 502; res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, '0.0.0.0', () => log(`Server running on port ${PORT} (build v3)`));

// ---------- Start ----------
// Server stays alive even if login fails; the first request (or /admin/cookie) retries.
if (!cookieHeader) login().catch(e => log('Initial login failed:', e.message));
