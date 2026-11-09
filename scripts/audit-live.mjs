#!/usr/bin/env node
/**
 * audit-live.mjs — full route-matrix probe against a running Promota.
 *
 *   node scripts/audit-live.mjs [baseUrl]        (default https://promota.click)
 *
 * For every route in api/routes.mjs it answers one question: *does the route
 * behave, for every identity that can reach it?* An identity is anonymous, a
 * promoter and each staff role that exists in `profiles`. A route is a DEFECT
 * when it
 *   - answers 5xx for any identity (a crash is never an answer), or
 *   - answers 2xx to an anonymous caller on a route that needs a session, or
 *   - answers 2xx to a promoter on a staff-only route, or
 *   - answers 404/405 for a route that is in the table (wiring drift).
 *
 * Everything else is a legitimate answer and is reported, not judged
 * ("sign in required" 401, "not found" for an unknown id, validation 400).
 *
 * Credentials: reads .env in the repo root (never printed) and mints a
 * short-lived session per staff role from `profiles` over PostgREST. It never
 * writes to the database.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issue } from '../api/session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ env */
function loadDotEnv() {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      if (k && !process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    }
  } catch { /* no .env — rely on the ambient environment */ }
}
loadDotEnv();

const BASE = (process.argv[2] || 'https://promota.click').replace(/\/+$/, '');
const SUPA = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '');

/* --------------------------------------------------------------- matrix */
/* `auth`: who must be refused. `expectAuth`: the route needs a session.
 * `body`: a minimal payload; an authenticated 400 here still proves the route
 * is wired and validating rather than silently empty. */
const ROUTES = [
  { m: 'GET', p: '/healthz', auth: false },
  { m: 'GET', p: '/api/plans', auth: false },
  { m: 'GET', p: '/api/blog', auth: false },
  { m: 'GET', p: '/api/blog/does-not-exist', auth: false, expect404: true },
  { m: 'POST', p: '/api/auth/otp/request', auth: false, body: { phone: '+2348000000000' } },
  { m: 'POST', p: '/api/auth/otp/verify', auth: false, body: { phone: '+2348000000000', pinId: 'x', pin: '0000' } },
  { m: 'POST', p: '/api/webhooks/flutterwave', auth: false, body: {} },

  { m: 'GET', p: '/api/me', auth: true },
  { m: 'GET', p: '/api/tasks', auth: true },
  { m: 'GET', p: '/api/tasks/mine', auth: true },
  { m: 'GET', p: '/api/policy', auth: true },
  { m: 'POST', p: '/api/policy/ack', auth: true, body: {} },
  { m: 'POST', p: '/api/redeem', auth: true, body: {} },
  { m: 'GET', p: '/api/referrals', auth: true },
  { m: 'GET', p: '/api/mining/status', auth: true },
  { m: 'GET', p: '/api/mining/traces', auth: true },
  { m: 'GET', p: '/api/zapia/status', auth: true },
  { m: 'GET', p: '/api/zapia/candidates', auth: true },
  { m: 'GET', p: '/api/social/status', auth: true },
  { m: 'POST', p: '/api/social/connect', auth: true, body: {} },
  { m: 'POST', p: '/api/social/test', auth: true, body: {} },

  { m: 'POST', p: '/api/v1/campaigns', auth: true, body: {} },
  { m: 'POST', p: '/api/v1/campaign-owners', auth: true, body: {} },
  { m: 'GET', p: '/api/v1/campaign-owner', auth: true },
  { m: 'GET', p: '/api/v1/business/campaigns', auth: true },
  { m: 'POST', p: '/api/v1/kyc/basic', auth: true, body: {} },
  { m: 'POST', p: '/api/v1/kyc/identity', auth: true, body: {} },
  { m: 'GET', p: '/api/v1/kyc/payout-account', auth: true },
  { m: 'POST', p: '/api/v1/kyc/payout-account', auth: true, body: {} },

  { m: 'GET', p: '/api/v1/promoter/earnings', auth: true },
  { m: 'GET', p: '/api/v1/promoter/referrals', auth: true },
  { m: 'GET', p: '/api/v1/promoter/payouts', auth: true },
  { m: 'GET', p: '/api/v1/checkin', auth: true },
  { m: 'POST', p: '/api/v1/checkin', auth: true, mutating: true },

  { m: 'GET', p: '/api/v1/promotion/cards', auth: true },
  { m: 'POST', p: '/api/v1/promotion/cards', auth: true, body: {} },
  { m: 'GET', p: '/api/v1/promotion/cards/mine', auth: true },
  { m: 'GET', p: '/api/v1/promotion/pairs', auth: true },
  { m: 'POST', p: '/api/v1/promotion/pairs', auth: true, body: {} },

  { m: 'GET', p: '/api/admin/stats', auth: true, staff: true },
  { m: 'GET', p: '/api/admin/users', auth: true, staff: true },
  { m: 'GET', p: '/api/admin/tasks', auth: true, staff: true },
  { m: 'GET', p: '/api/admin/campaigns', auth: true, staff: true },
  { m: 'POST', p: '/api/admin/campaigns', auth: true, staff: true, body: {} },
  { m: 'GET', p: '/api/admin/campaign/owners', auth: true, staff: true },
  { m: 'GET', p: '/api/admin/kyc', auth: true, staff: true },
  { m: 'GET', p: '/api/admin/plugins', auth: true, staff: true },
  { m: 'GET', p: '/api/admin/settings', auth: true, staff: true },
  { m: 'POST', p: '/api/admin/settings', auth: true, staff: true, body: {} },
  { m: 'GET', p: '/api/admin/audit', auth: true, staff: true },
  { m: 'GET', p: '/api/v1/admin/promotion/cards', auth: true, staff: true },
  { m: 'GET', p: '/api/v1/admin/promotion/deliveries', auth: true, staff: true },
  { m: 'POST', p: '/api/v1/admin/promotion/expire', auth: true, staff: true, mutating: true },
];

/* ------------------------------------------------------------ identities */
async function loadIdentities() {
  const ids = [{ name: 'anonymous', token: null, role: 'anonymous' }];
  if (!SUPA || !KEY) return ids;
  const res = await fetch(
    `${SUPA}/rest/v1/profiles?select=id,role,state&state=eq.active&order=created_at.asc&limit=200`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
  );
  if (!res.ok) return ids;
  const rows = await res.json();
  if (!Array.isArray(rows)) return ids;
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.role)) continue;
    seen.add(row.role);
    ids.push({ name: row.role, role: row.role, id: row.id, token: issue(row.id, { role: row.role }) });
  }
  return ids;
}

/* ------------------------------------------------------------------ probe */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(route, identity) {
  const headers = { Accept: 'application/json' };
  let body;
  if (route.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(route.body);
  }
  if (identity.token) headers.Authorization = `Bearer ${identity.token}`;
  let res, text = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      res = await fetch(`${BASE}${route.p}`, {
        method: route.m, headers, body, signal: AbortSignal.timeout(20000),
      });
      text = await res.text();
    } catch (e) {
      return { status: 0, note: `network: ${String(e.message || e).slice(0, 60)}` };
    }
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
  }
  if (res.status === 429) return { status: 429, note: 'rate limited even after retries' };
  let note = '';
  try {
    const j = JSON.parse(text);
    note = String(j.error || j.message || j.note || (j.ok === true ? 'ok' : '') || '').slice(0, 70);
    if (!note) note = Array.isArray(j) ? `array(${j.length})` : Object.keys(j).slice(0, 4).join(',');
  } catch {
    note = text.slice(0, 60).replace(/\s+/g, ' ');
  }
  return { status: res.status, note };
}

/** The roles that may reach a `staff: true` route (api/admin.mjs requireAdmin). */
const STAFF_ROLES = ['admin', 'owner', 'support', 'finance'];

function verdict(route, identity, result) {
  const s = result.status;
  if (s === 0) return { v: 'FAIL', why: 'network' };
  if (s === 429) return { v: 'SKIP', why: 'rate limited — unverified' };
  if (s >= 500) return { v: 'FAIL', why: 'server error' };

  // A route that must 404 is judged the same way for EVERY identity. Checking
  // this only for `anonymous` made the audit report a defect for an
  // authenticated caller on a slug that legitimately does not exist.
  if (route.expect404) {
    return s === 404
      ? { v: 'PASS', why: 'expected 404' }
      : { v: 'FAIL', why: `expected 404, got ${s}` };
  }

  if (route.auth && s >= 200 && s < 300) {
    // A session-required route must never answer 2xx without a session, and a
    // staff route must never answer 2xx to a non-staff role (promoter,
    // business, partner). Anything else reaching 2xx is the security defect.
    if (identity.role === 'anonymous') return { v: 'FAIL', why: 'anonymous allowed' };
    if (route.staff && !STAFF_ROLES.includes(identity.role)) {
      return { v: 'FAIL', why: `${identity.role} reached a staff route` };
    }
  }
  if (s === 404 || s === 405) return { v: 'FAIL', why: 'route missing' };
  return { v: 'PASS', why: '' };
}

/* ------------------------------------------------------------------- run */
const identities = await loadIdentities();
if (identities.length === 1) {
  console.log('  NOTE  no service credential or no profiles — staff roles will be UNVERIFIED');
}
console.log(`\n  Promota live route audit — ${BASE}`);
console.log(`  identities: ${identities.map((i) => i.name).join(', ')}\n`);

const rows = [];
for (const route of ROUTES) {
  for (const identity of identities) {
    if (route.mutating && identity.role !== 'anonymous') {
      rows.push({ route: `${route.m} ${route.p}`, who: identity.name, status: '—', note: 'not called: mutating route', v: 'SKIP', why: '' });
      continue;
    }
    const result = await probe(route, identity);
    const v = verdict(route, identity, result);
    rows.push({ route: `${route.m} ${route.p}`, who: identity.name, ...result, ...v });
    await sleep(400); // be a polite client; the server rate-limits on purpose
  }
}

const width = Math.max(...rows.map((r) => r.route.length));
const fails = rows.filter((r) => r.v === 'FAIL');
for (const r of rows) {
  const mark = r.v === 'FAIL' ? 'FAIL' : r.v === 'SKIP' ? 'SKIP' : 'PASS';
  console.log(`  ${mark}  ${r.route.padEnd(width)}  ${String(r.who).padEnd(10)}  ${String(r.status).padEnd(4)}  ${r.note}${r.why ? `   <- ${r.why}` : ''}`);
}

const skips = rows.filter((r) => r.v === 'SKIP').length;
console.log(`\n  ${rows.length - fails.length - skips} PASS   ${fails.length} FAIL   ${skips} SKIP`);
console.log(`  ROUTE AUDIT: ${fails.length === 0 ? 'PASS' : 'FAIL'}`);
process.exitCode = fails.length === 0 ? 0 : 1;
