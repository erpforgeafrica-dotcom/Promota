/**
 * vtung.mjs — VTU.ng adapter (Provider B: reseller data/airtime, API v2).
 *
 * Doc: C:\Users\pc\.config\opencode\rewardapi.txt (full API v2 v2.0, July 2025).
 *   - auth  POST https://vtu.ng/wp-json/jwt-auth/v1/token {username,password}
 *           → { token } Bearer; 7-day expiry; ONLY the latest token stays active.
 *   - base  https://vtu.ng/wp-json/api/v2/  (GET balance, GET variations/data?service_id=mtn,
 *           POST data {request_id,phone,service_id,variation_id}, POST requery {request_id})
 *   - request_id ≤50 chars, idempotent (duplicate within 3 minutes → 409 lockout)
 *   - statuses: initiated-api/processing-api/queued-api/pending → in-flight;
 *               completed-api → paid out; refunded/failed/cancelled → dead
 *   - webhook: X-Signature = HMAC-SHA256(raw body, user PIN) — verify both encodings.
 *
 * Result contract: same normalised kinds as twenty5.mjs.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const BASE = (process.env.VTU_BASE_URL || 'https://vtu.ng/wp-json/api/v2').replace(/\/+$/, '');
const AUTH_URL = process.env.VTU_AUTH_URL || 'https://vtu.ng/wp-json/jwt-auth/v1/token';

export const SERVICE_IDS = { MTN: 'mtn', GLO: 'glo', AIRTEL: 'airtel', '9MOBILE': '9mobile', SMILE: 'smile' };

/** Test/ops hook: drop the cached JWT so the next call re-authenticates. */
export function resetAuth() { cached = { token: null, expiry: 0 }; }

export function configured() {
  return Boolean((process.env.VTU_USERNAME || '').trim() && (process.env.VTU_PASSWORD || '').trim());
}

export function status() {
  if (!configured()) {
    return { ready: false, provider: 'vtung',
      reason: 'VTU.ng reseller credentials not set (VTU_USERNAME / VTU_PASSWORD).' };
  }
  return { ready: true, provider: 'vtung' };
}

/* ------------------------------------------------------------------ JWT login */

let cached = { token: null, expiry: 0 };

async function login(deps) {
  const username = (process.env.VTU_USERNAME || '').trim();
  const password = (process.env.VTU_PASSWORD || '').trim();
  const res = await fetchFn(deps)(AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok || !j?.token) {
    throw Object.assign(new Error(`vtu.ng login HTTP ${res.status}: ${(j?.message || text.slice(0, 120))}`),
      { status: res.status });
  }
  cached = { token: j.token, expiry: Date.now() + 6 * 24 * 3600 * 1000 }; // safety margin < 7d
  return cached.token;
}

function fetchFn(deps) { return deps.fetchFn || globalThis.fetch; }

/**
 * Authenticated call; on 401 does ONE force re-login then retries (the doc's
 * "only the latest token is active" makes a rotating token the main 401 risk).
 */
async function call(deps, path, { method = 'GET', body } = {}, retried = false) {
  if (!configured()) throw Object.assign(new Error('vtu.ng not configured'), { status: 0 });
  if (Date.now() > cached.expiry) cached = { token: null, expiry: 0 };
  const token = cached.token || (await login(deps));
  let res;
  try {
    res = await fetchFn(deps)(`${BASE}/${path.replace(/^\//, '')}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw Object.assign(new Error(`vtu.ng transport: ${String(e.message || e).slice(0, 120)}`),
      { status: 'network', unknown: true });
  }
  if (res.status === 401 && !retried) {
    cached = { token: null, expiry: 0 };
    return call(deps, path, { method, body }, true);
  }
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw Object.assign(
      new Error((j?.message || text.slice(0, 200) || `HTTP ${res.status}`).slice(0, 200)),
      { status: res.status, payload: j }
    );
  }
  return j;
}

/** Wallet balance (GET /balance). Useful sanity probe before enabling delivery. */
export async function balance(deps = {}) {
  const j = await call(deps, 'balance');
  return j?.data ?? j;
}

/** Public endpoint — no auth, cacheable. Returns VTU.ng's own variation ids. */
export async function variations(serviceId, deps = {}) {
  const j = await call(deps, `variations/data?service_id=${encodeURIComponent(serviceId)}`);
  return j?.data ?? j;
}

/** VTU.ng plan catalogue (verified live 2026-10-18, no auth needed):
 *  { code:'success', data:[{ variation_id, service_name, service_id, data_plan,
 *    price, reseller_price, availability }] }. Reseller price is what our wallet
 *    pays. `Unavailable` rows are kept but flagged — deliver must refuse them. */
export async function refreshPlans(deps = {}) {
  const nets = ['mtn', 'glo', 'airtel', '9mobile'];
  const out = [];
  for (const net of nets) {
    try {
      const d = await variations(net, deps) ?? {};
      for (const v of d.data || d.variations || d || []) {
        if (v?.variation_id == null) continue;
        const mb = Number(String(v.data_plan || '').match(/(\d+(?:\.\d+)?)\s*TB/i)?.[1] * 1000000)
          || Number(String(v.data_plan || '').match(/(\d+(?:\.\d+)?)\s*GB/i)?.[1] * 1000)
          || Number(String(v.data_plan || '').match(/(\d+(?:\.\d+)?)\s*MB/i)?.[1]) || null;
        out.push({
          code: String(v.variation_id),
          name: String(v.data_plan || v.variation_id),
          mb,
          network: net.toUpperCase(),
          priceNaira: Number(v.reseller_price ?? v.price) || null,
          availability: String(v.availability ?? 'Unknown'),
          provider: 'vtung',
        });
      }
    } catch { /* one network down must not hide the rest */ }
  }
  return out;
}

/** VTU.ng examples use the LOCAL 11-digit format (08012345678), not E.164. */
export function toVtuNgPhone(phone) {
  const s = String(phone).replace(/[\s-()]/g, '');
  if (/^\+234(\d{10})$/.test(s)) return `0${s.slice(4)}`;
  if (/^234(\d{10})$/.test(s)) return `0${s.slice(3)}`;
  return s;
}

/* ------------------------------------------------------------------ delivery */
/** request_id must be ≤50 chars; keep [a-z0-9_-] so requery round-trips cleanly. */
export function makeRequestId(reference) {
  return String(reference || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 50);
}

export async function deliver({ network, phone, planCode, reference }, deps = {}) {
  if (!configured()) return { kind: 'failed', retryable: false, failover: true,
    error: 'vtu.ng credentials not configured' };
  if (!network) return { kind: 'failed', retryable: false, failover: false, error: 'network is required' };
  if (!phone) return { kind: 'failed', retryable: false, failover: false, error: 'destination phone is required' };
  if (!planCode) return { kind: 'failed', retryable: false, failover: false, error: 'planCode is required' };

  const serviceId = SERVICE_IDS[String(network).toUpperCase()];
  if (!serviceId) return { kind: 'failed', retryable: false, failover: false,
    error: `unsupported network: ${network}` };

  const request_id = makeRequestId(reference);
  try {
    const j = await call(deps, 'data', {
      method: 'POST',
      body: { request_id, phone: toVtuNgPhone(phone), service_id: serviceId, variation_id: String(planCode) },
    });
    const d = j?.data ?? j ?? {};
    const st = String(d.status || 'pending').toLowerCase();
    if (st === 'completed-api') {
      return { kind: 'delivered', providerRef: String(d.order_id ?? request_id), deliveredAt: new Date().toISOString() };
    }
    if (st === 'refunded' || st === 'failed' || st === 'cancelled' || st === 'on-hold') {
      return { kind: 'failed', retryable: false, failover: true, error: `vtu.ng ${st}: ${d.message || ''}`.trim() };
    }
    return { kind: 'pending', providerRef: String(d.order_id ?? request_id), status: st };
  } catch (e) {
    const s = e.status;
    if (s === 'network') return { kind: 'failed', retryable: true, failover: false, unknown: true, error: e.message };
    if (s === 409) return { kind: 'pending', providerRef: request_id, status: 'in-flight' }; // dup ⇒ already swarming
    if (s === 402) return { kind: 'failed', retryable: false, failover: true, error: `vtu.ng funds: ${e.message}` };
    if (s === 429) return { kind: 'failed', retryable: true, failover: false, error: `vtu.ng throttled: ${e.message}` };
    if (s === 422) return { kind: 'failed', retryable: false, failover: true, error: `vtu.ng validation: ${e.message}` };
    return { kind: 'failed', retryable: true, failover: false, error: `vtu.ng HTTP ${s}: ${e.message}` };
  }
}

/** POST /requery — the pending-resolution primitive of VTU.ng. */
export async function recheck(reference, _providerRef, deps = {}) {
  if (!configured()) return { kind: 'failed', retryable: false, failover: false,
    error: 'vtu.ng not configured (parked — unavailability is not proof the order died)' };
  try {
    const j = await call(deps, 'requery', { method: 'POST', body: { request_id: makeRequestId(reference) } });
    const d = j?.data ?? j ?? {};
    const st = String(d.status || '').toLowerCase();
    if (st === 'completed-api') return { kind: 'delivered', providerRef: String(d.order_id ?? makeRequestId(reference)),
      deliveredAt: new Date().toISOString() };
    if (st === 'refunded' || st === 'failed' || st === 'cancelled') {
      return { kind: 'failed', retryable: false, failover: true, error: `vtu.ng requery: ${st}` };
    }
    return { kind: 'pending', providerRef: String(d.order_id ?? makeRequestId(reference)), status: st || 'unknown' };
  } catch (e) {
    if (e.status === 404) {
      // requery cannot SEE it yet — same park rule as twenty5: only an
      // explicit refunded/failed/cancelled status may failover.
      return { kind: 'pending', providerRef: makeRequestId(reference), status: 'not-found-yet' };
    }
    return { kind: 'pending', providerRef: makeRequestId(reference), status: 'unknown' };
  }
}

/* ------------------------------------------------------------------- webhook */
/**
 * Verify X-Signature against HMAC-SHA256(hex) of the RAW body using the user
 * PIN. The doc pins hex; base64 accepted as a courtesy. Caller passes the
 * exact raw bytes it received — re-serialised bodies break the signature.
 */
export function verifyWebhook(rawBody, signature) {
  const pin = (process.env.VTU_USER_PIN || '').trim();
  if (!pin || !rawBody || !signature) return false;
  // One HMAC, two encodings. Calling digest() twice on the same Hash throws
  // ("Digest already called"), which made every verification fail; compute the
  // hex once and derive the base64 from the raw bytes.
  const digest = createHmac('sha256', pin).update(rawBody).digest();
  const hex = digest.toString('hex');
  const b64 = digest.toString('base64');
  const given = String(signature).trim();
  const eq = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  try { return eq(hex, given.toLowerCase()) || eq(b64, given); } catch { return false; }
}
