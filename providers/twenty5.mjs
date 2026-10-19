/**
 * twenty5.mjs — Twenty5.io adapter (Provider A: data / airtime / WhatsApp / SMS / OTP).
 *
 * Spec: https://twenty5.io/assets/twenty5-spec.json (server https://api.twenty5.io/v1).
 * Every request carries `Authorization: Bearer pk_xxx.sk_secret_xxx` — the public and
 * secret key CONCATENATED WITH A DOT. The dashboard hands out the two halves
 * separately, so the secret alone gets 401 "Missing or malformed API key" (verified
 * live 2026-10-18).
 *
 * Conventions (from the spec):
 *   - response envelope { message, success, data } — 422 is Laravel { message, errors }
 *   - money is integers in KOBO everywhere, EXCEPT the airtime send body (whole naira)
 *   - key prefix decides mode: pk_test_ = test ledger, pk_live_ = real dispatch
 *
 * Result contract (normalised for dataManager.mjs):
 *   { kind: 'delivered', providerRef, deliveredAt }
 *   { kind: 'pending',   providerRef, status }
 *   { kind: 'failed',    retryable, failover, unknown, error }
 *     - failover  true → a DIFFERENT provider may try the same reference
 *     - unknown   true → transport blown mid-flight; outcome UNKNOWN: no failover
 */
const BASE = (process.env.TWENTY5_BASE_URL || 'https://api.twenty5.io/v1').replace(/\/+$/, '');

/** Compose the Bearer token. Accepts a full pair pasted into either var. */
export function bearer() {
  const raw = (process.env.TWENTY5_API_KEY || '').trim();
  if (!raw) return null;
  if (raw.includes('.')) return raw; // full pair already
  const pk = (process.env.TWENTY5_PUBLIC_KEY || '').trim();
  if (pk.includes('.')) return pk; // pair stored in the other var
  if (pk && raw.startsWith('sk_')) return `${pk}.${raw}`; // halves concatenated here
  return null;
}

export function mode() {
  const t = bearer();
  if (!t) return null;
  if (t.startsWith('pk_live')) return 'live';
  if (t.startsWith('pk_test')) return 'test';
  return 'unknown';
}

export function configured() {
  return Boolean(bearer());
}

export function status() {
  if (!configured()) {
    return {
      ready: false,
      provider: 'twenty5',
      reason: 'Twenty5 key incomplete: Bearer must be pk_test_xxx.sk_secret_xxx — '
        + 'set both halves or paste the full pair (401 verified live with the secret alone).',
    };
  }
  return { ready: true, provider: 'twenty5', mode: mode() };
}

/* ----------------------------------------------------------------- wire layer */

/**
 * One authenticated call. Throws ApiError { status, message, payload } so the
 * adapters can classify. The Authorization header is never logged or echoed.
 */
async function call(fetchFn, path, { method = 'GET', body } = {}) {
  const auth = bearer();
  if (!auth) throw Object.assign(new Error('Twenty5 key not configured'), { status: 0 });
  let res;
  try {
    res = await fetchFn(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw Object.assign(new Error(`twenty5 transport: ${String(e.message || e).slice(0, 120)}`),
      { status: 'network', unknown: true });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    throw Object.assign(
      new Error((json?.message || text.slice(0, 200) || `HTTP ${res.status}`).slice(0, 200)),
      { status: res.status, payload: json }
    );
  }
  return json;
}

/* ------------------------------------------------------------ messaging APIs */
/** WhatsApp/SMS/OTP stay here for later wiring; data delivery is the live path. */
export async function sendWhatsApp({ recipient, message }, deps = {}) {
  const j = await call(deps.fetchFn || globalThis.fetch, '/whatsapp/send',
    { method: 'POST', body: { recipient, message } });
  return j?.data ?? j;
}

export async function sendSms({ recipients, message, routeType = 'auto' }, deps = {}) {
  const j = await call(deps.fetchFn || globalThis.fetch, '/sms/send',
    { method: 'POST', body: { recipients, message, route_type: routeType } });
  return j?.data ?? j;
}

export async function sendOtp({ recipient, channel = 'whatsapp', managed = false, otpLength = 6,
  template = 'generic' }, deps = {}) {
  const j = await call(deps.fetchFn || globalThis.fetch, `/otp/${channel}/send`,
    { method: 'POST', body: { recipient, managed, otp_length: otpLength, template } });
  return j?.data ?? j;
}

export async function verifyOtp({ otpId, otp }, deps = {}) {
  const j = await call(deps.fetchFn || globalThis.fetch, '/otp/verify',
    { method: 'POST', body: { otp_id: otpId, otp } });
  return j?.data ?? j;
}

/* --------------------------------------------------------------- plan lookup */
/**
 * Live catalogue (verified live 2026-10-18): GET /data/plans?network=mtn
 * returns { data:{ plans:[{ code, description, amount, value, duration }] } }.
 * Live payload uses NAIRA integers for catalogue amount (spec's "kobo everywhere"
 * does not hold here) and a "36000 MB" value string — both kept as parsed.
 * A plan's `code` is handed verbatim to /data/send as plan_code.
 */
export async function refreshPlans(deps = {}) {
  const nets = ['mtn', 'glo', 'airtel', '9mobile'];
  const f = deps.fetchFn || globalThis.fetch;
  const out = [];
  for (const net of nets) {
    try {
      const j = await call(f, `/data/plans?network=${net}`);
      for (const p of j?.data?.plans ?? []) {
        const mb = Number(String(p.value || '').match(/(\d[\d\s]*)\s*MB/i)?.[1]?.replace(/\s|0*(?=MB)/g, '')) || null;
        out.push({
          code: String(p.code),
          name: String(p.description || p.code),
          mb,
          network: net.toUpperCase(),
          priceNaira: Number(p.amount) || null,
          duration: String(p.duration ?? ''),
          provider: 'twenty5',
        });
      }
    } catch { /* one network down must not hide the rest */ }
  }
  return out;
}

/* ------------------------------------------------------------------ delivery */
export async function deliver({ network, phone, planCode, reference }, deps = {}) {
  const t = bearer();
  if (!t) return { kind: 'failed', retryable: false, failover: true,
    error: 'twenty5 key not configured' };
  if (!phone) return { kind: 'failed', retryable: false, failover: false,
    error: 'destination phone is required' };
  if (!planCode) return { kind: 'failed', retryable: false, failover: false,
    error: 'planCode is required' };

  try {
    const j = await call(deps.fetchFn || globalThis.fetch, '/data/send', {
      method: 'POST',
      body: { recipient: phone, plan_code: planCode },
    });
    const d = j?.data ?? {};
    const st = String(d.status || '').toLowerCase();
    if (st === 'sent' || st === 'delivered') {
      return { kind: 'delivered', providerRef: String(d.data_id ?? reference), deliveredAt: new Date().toISOString() };
    }
    return { kind: 'pending', providerRef: String(d.data_id ?? reference), status: st || 'pending' };
  } catch (e) {
    const s = e.status;
    if (s === 'network') {
      // Outcome UNKNOWN — manager must NOT failover blindly (reward-doc rule).
      return { kind: 'failed', retryable: true, failover: false, unknown: true, error: e.message };
    }
    if (s === 402) {
      return { kind: 'failed', retryable: false, failover: true, error: `twenty5 wallet: ${e.message}` };
    }
    if (s === 429) {
      return { kind: 'failed', retryable: true, failover: false, error: `twenty5 throttled: ${e.message}` };
    }
    if (s === 422) {
      // Bad plan/validation this provider cannot serve → let another provider try.
      return { kind: 'failed', retryable: false, failover: true, error: `twenty5 validation: ${e.message}` };
    }
    return { kind: 'failed', retryable: true, failover: false, error: `twenty5 HTTP ${s}: ${e.message}` };
  }
}

/** Where is the order now? GET /data/{id} — pending resolution for the worker. */
export async function recheck(reference, providerRef, deps = {}) {
  const id = String(providerRef || reference);
  try {
    const j = await call(deps.fetchFn || globalThis.fetch, `/data/${id}`);
    const d = j?.data ?? {};
    const st = String(d.status || '').toLowerCase();
    if (st === 'sent' || st === 'delivered') {
      return { kind: 'delivered', providerRef: id, deliveredAt: new Date().toISOString() };
    }
    if (st === 'failed') return { kind: 'failed', retryable: false, failover: true,
      error: 'twenty5 reported the order failed (wallet auto-refund applies)' };
    return { kind: 'pending', providerRef: id, status: st || 'pending' };
  } catch (e) {
    if (e.status === 404) {
      // Invisible is NOT failed: fresh orders can be unqueryable for a while.
      // Only an explicit provider-side 'failed' status above may trigger
      // failover — 404 here stays parked so a still-completing order can
      // never cause a double purchase.
      return { kind: 'pending', providerRef: id, status: 'not-found-yet' };
    }
    return { kind: 'pending', providerRef: id, status: 'unknown' };
  }
}
