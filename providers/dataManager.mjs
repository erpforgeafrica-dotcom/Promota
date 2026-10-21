/**
 * dataManager.mjs — multi-provider data-reward manager (the reward doc's matrix).
 *
 * Providers (each with the same normalised deliver/recheck contract):
 *   twenty5 (A, tests allowed, test-mode key) → vtung (B, reseller wallet) → legacy
 *   DATA star PROVIDER / Kati adapter (kept as the landing spot the original code shipped).
 *
 * Failover rules (from the reward doc, enforced — not advisory):
 *   1. PENDING        → NEVER switch providers on the same redemption in this pass;
 *                       return `pending` and let recheck()/requery resolve it later.
 *   2. TIMEOUT=UNKNOWN→ transport died mid-flight: we do NOT know whether the bundle
 *                       landed, so no provider switch, just mark retryable and let the
 *                       outbox loop retry the SAME provider.
 *   3. REJECTED/JUDGED→ wallet empty, plan unsupported, explicit failure → try the
 *                       next provider with the SAME internal reference.
 *   4. SUCCESS        → never retried, never failed over, provider attributed.
 *
 * Every attempt reuses one internal reference (the redemption id) for idempotency.
 */
import * as twenty5 from './twenty5.mjs';
import * as vtung from './vtung.mjs';

/* ------------------------------------------------------- legacy generic port */

function legacyConfigured() {
  return Boolean(
    (process.env.DATA_PROVIDER_API_KEY || '').trim()
      && (process.env.DATA_PROVIDER_BASE_URL || '').trim()
  );
}

/* A provider only counts as DELIVERED when it says so. Anything else is
   pending (in flight, resolve with recheck) or failed. A bare 2xx is NOT
   proof: the old adapter reported "delivered" for any 2xx and then fell back
   to OUR OWN reference as the provider reference, which made an unconfirmed
   order look confirmed to the database (redemptions_fulfilled_has_ref). */
const DELIVERED_STATUS = /^(sent|delivered|completed|complete|success|successful|paid|fulfilled)$/;
const PENDING_STATUS = /^(pending|processing|submitted|queued|initiated|accepted|in_progress|inprogress)$/;

async function legacyDeliver({ network, phone, planCode, reference }, deps = {}) {
  const base = (process.env.DATA_PROVIDER_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.DATA_PROVIDER_API_KEY;
  const f = deps.fetchFn || globalThis.fetch;
  try {
    const res = await f(`${base}/v1/quote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'data', network, phone, plan: planCode, reference }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    if (!res.ok) {
      // 402/422 = the provider rejected the order outright: another provider
      // may serve it. 429/5xx = the outcome is UNKNOWN (the order may have
      // landed), so we must NOT switch providers and re-buy the same bundle.
      const rejected = res.status === 402 || res.status === 422;
      return { kind: 'failed', retryable: !rejected && res.status !== 402 && res.status !== 422,
        failover: rejected, unknown: !rejected,
        error: json?.message || text.slice(0, 200) || `HTTP ${res.status}` };
    }

    const status = String(json?.status ?? json?.state ?? json?.data?.status ?? '').trim().toLowerCase();
    const providerRef = json?.id ?? json?.reference ?? json?.data?.id ?? json?.data?.reference ?? '';
    const okFlag = json?.success ?? json?.data?.success;

    if (status && DELIVERED_STATUS.test(status)) {
      if (!providerRef) {
        return { kind: 'failed', retryable: false, failover: false,
          error: 'provider reported delivery but returned no provider reference, so it cannot be audited' };
      }
      return { kind: 'delivered', providerRef: String(providerRef),
        deliveredAt: String(json?.delivered_at ?? json?.data?.delivered_at ?? new Date().toISOString()) };
    }
    if (status && PENDING_STATUS.test(status)) {
      return { kind: 'pending', providerRef: String(providerRef || ''), status };
    }
    if (okFlag === true && providerRef) {
      return { kind: 'delivered', providerRef: String(providerRef),
        deliveredAt: String(json?.delivered_at ?? json?.data?.delivered_at ?? new Date().toISOString()) };
    }
    // 2xx with no explicit success signal: the order may still be in flight.
    // Park it — a recheck decides later. We never claim delivery we did not see.
    return { kind: 'pending', providerRef: String(providerRef || ''),
      status: status || 'unconfirmed',
      note: 'provider returned 2xx without an explicit delivery confirmation; parked for recheck' };
  } catch (e) {
    return { kind: 'failed', retryable: true, failover: false, unknown: true,
      error: String(e.message || e).slice(0, 200) };
  }
}

/* ------------------------------------------------------------------ registry */

const order = () => {
  const env = (process.env.DATA_PROVIDER_ORDER || 'twenty5,vtung').toLowerCase();
  const names = env.split(',').map((s) => s.trim()).filter(Boolean);
  // The legacy adapter is the last resort, never twice: a duplicated name
  // would attempt the same provider twice in one pass.
  if (legacyConfigured() && !names.includes('generic')) names.push('generic');
  return [...new Set(names)];
};

const registry = {
  twenty5: {
    name: 'twenty5', deliver: twenty5.deliver, recheck: twenty5.recheck,
    restore: twenty5.refreshPlans, status: twenty5.status,
  },
  vtung: {
    name: 'vtung', deliver: vtung.deliver, recheck: vtung.recheck,
    restore: vtung.refreshPlans, status: vtung.status,
  },
  generic: {
    name: () => process.env.DATA_PROVIDER_NAME || 'kati',
    deliver: legacyDeliver, recheck: null, restore: null,
    status: legacyConfigured,
  },
};

function adapterOf(n) {
  const a = registry[n];
  if (!a) return null;
  // name may be a literal or a getter (the legacy adapter reads its env label)
  const name = typeof a.name === 'function' ? a.name() : a.name;
  return { ...a, name };
}

/** Names in DATA_PROVIDER_ORDER that no adapter answers to. Never throws. */
function unknownNames(list) {
  return list.filter((n) => !registry[n]);
}

/* ------------------------------------------------------------------ status() */

export function anyConfigured() {
  return order().length > 0;
}

/**
 * Aggregate status for /healthz + kati-style init. ready when at least one
 * provider is configured. reason names the unavailable ones.
 */
export function status() {
  const list = order();
  if (!list.length) {
    return {
      ready: false,
      provider: null,
      reason: 'no data provider configured: set TWENTY5_PUBLIC_KEY(+TWENTY5_API_KEY) '
        + 'or VTU_USERNAME/VTU_PASSWORD, or the legacy DATA_PROVIDER_* pair.',
    };
  }
  const detail = list.map((n) => {
    const a = adapterOf(n);
    if (!a) return { provider: n, ready: false, reason: 'unknown provider name in DATA_PROVIDER_ORDER' };
    const s = a.status();
    return { provider: typeof s.provider === 'string' ? s.provider : n, ready: Boolean(s.ready || s === true), reason: s.reason || null };
  });
  const unknown = unknownNames(list);
  const firstReady = detail.find((d) => d.ready);
  return firstReady
    ? { ready: true, provider: firstReady.provider, detail, unknown }
    : { ready: false, provider: null, reason: detail.map((d) => `${d.provider}: ${d.reason}`).join(' | ').slice(0, 300), detail, unknown };
}

/* ------------------------------------------------------------------- plans() */

let planCache = [];

/** Merged catalogue from every provider that reported one. Empty until warmed. */
export function plans() {
  const byKey = new Map();
  for (const p of planCache) {
    const key = `${p.provider}:${p.code}:${p.mb || ''}`;
    if (!byKey.has(key)) byKey.set(key, p);
  }
  return [...byKey.values()];
}

/** Non-invented + never-throwing background refresh: every 15 min, first run ASAP. */
let planTimer = null;
export function refreshPlansNow(deps = {}) {
  const jobs = order().map(async (n) => {
    const a = adapterOf(n);
    if (!a || !a.restore) return [];
    try { return await a.restore(deps); }
    catch { return []; }
  });
  return Promise.allSettled(jobs).then((results) => {
    const rows = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (rows.length) planCache = rows;
    return plans();
  });
}

function warmPlans() {
  if (planTimer) return;
  refreshPlansNow().catch(() => {});
  planTimer = setInterval(() => { refreshPlansNow().catch(() => {}); }, 15 * 60 * 1000);
  if (typeof planTimer.unref === 'function') planTimer.unref();
}
warmPlans();

/* ----------------------------------------------------------------- deliver() */

/**
 * One redemption, one stable reference, ordered attempts with the matrix above.
 * Worker-facing shape (unchanged API, richer fields):
 *   { ok:true,  provider, providerRef, deliveredAt }
 *   { ok:false, pending:true, provider, providerRef, retryable:true, error:null }
 *   { ok:false, retryable, error, provider }
 */
export async function deliver(spec, deps = {}) {
  const { network, phone, planCode, reference } = spec || {};
  const list = order();
  if (!list.length) {
    return {
      ok: false,
      retryable: false,
      error: 'no data aggregator is configured, so no bundle can be delivered. '
        + 'The redemption stays reversible and the points are not lost.',
    };
  }
  if (!network) return { ok: false, retryable: false, error: 'network is required' };
  if (!phone) return { ok: false, retryable: false, error: 'destination phone is required' };
  if (!planCode) return { ok: false, retryable: false, error: 'planCode is required' };

  let lastError = null;
  let lastProvider = null;
  for (const n of list) {
    const a = adapterOf(n);
    if (!a) {
      // A typo in DATA_PROVIDER_ORDER used to throw and kill every redemption.
      lastError = `unknown provider "${n}" in DATA_PROVIDER_ORDER`;
      continue;
    }
    const s = a.status();
    if (!(s === true || s?.ready)) continue; // unconfigured provider is skipped silently
    lastProvider = a.name;
    const r = await a.deliver({ network, phone, planCode, reference }, deps);

    if (r.kind === 'delivered') {
      return { ok: true, provider: a.name, providerRef: r.providerRef, deliveredAt: r.deliveredAt };
    }
    if (r.kind === 'pending') {
      // Matrix rule 1: parked mid-air, no failover this pass.
      return {
        ok: false,
        pending: true,
        provider: a.name,
        providerRef: r.providerRef,
        retryable: true,
        error: null,
        note: `delivery in flight at ${a.name} (${r.status}); resolve via recheck, not a re-purchase`,
      };
    }
    // failed:
    lastError = r.error;
    if (r.failover) continue; // Matrix rule 3: rejected here, try the next provider.
    if (r.unknown) lastError = `${r.error} (outcome UNKNOWN — no provider switch)`;
    return {
      ok: false,
      retryable: Boolean(r.retryable),
      error: lastError,          // the UNKNOWN marker must survive to the caller
      provider: a.name,
      unknown: Boolean(r.unknown),
    };
  }
  const dotted = lastError ? ` Last error (${lastProvider || 'none'}): ${lastError}` : '';
  return { ok: false, retryable: false, provider: lastProvider,
    error: `no capable data provider could serve this redemption.${dotted}` };
}

/* ----------------------------------------------------------------- recheck() */

/**
 * Ask a specific provider where a pending order ended. providerName defaults to
 * whatever status() reports first. manager never invents an adapter.
 */
export async function recheck({ provider, providerRef, reference }, deps = {}) {
  const n = provider || (order())[0];
  const a = adapterOf(n);
  if (!a || !a.recheck) {
    return { ok: false, retryable: false, error: `provider "${n}" has no recheck/requery` };
  }
  const r = await a.recheck(String(reference ?? providerRef ?? ''), String(providerRef ?? ''), deps)
    .then((x) => (x.kind === 'delivered'
      ? { ok: true, provider: a.name, providerRef: x.providerRef, deliveredAt: x.deliveredAt }
      : x.kind === 'pending'
        ? { ok: false, pending: true, provider: a.name, providerRef: x.providerRef, status: x.status }
        : { ok: false, retryable: Boolean(x.retryable), failover: Boolean(x.failover),
            error: x.error, provider: a.name }));
  return r;
}
