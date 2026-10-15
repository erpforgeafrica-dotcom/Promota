/**
 * data.mjs — mobile data bundle adapter (MTN / Glo / Airtel / 9mobile).
 *
 * ⚠️ THIS IS THE OPEN BLOCKER. Neither of the keys we hold can deliver data:
 *   - Termii is messaging + OTP only (verified against the live key).
 *   - Flutterwave is cards + bank transfers only (verified against the live key).
 * The original audit listed "Termii, Migo, Arkesel" as data aggregators; that
 * was wrong. Termii does not resell bundles.
 *
 * So the default implementation below REFUSES rather than pretending. It never
 * fabricates a delivery, and it never marks a redemption fulfilled. A
 * redemption against this adapter fails loudly and stays reversible, which is
 * the only honest behaviour available until a real aggregator is chosen.
 *
 * TO GO LIVE: implement `deliver()` against the chosen provider's HTTP API and
 * set DATA_PROVIDER_BASE_URL / DATA_PROVIDER_API_KEY. The interface is
 * deliberately small so swapping providers touches exactly this file:
 *
 *   deliver({ network, phone, planCode, reference }) ->
 *     { ok: true, providerRef, deliveredAt }
 *     { ok: false, error, retryable: boolean }
 *
 * Candidates researched 2026-10-08 (owner decision pending):
 *   Kati        kati.ng          one JSON API for airtime/data/electricity/TV
 *   RivaPro     api.riva.com.ng  documented: POST /v1/orders, has a sandbox
 *   Subnet API                     POST /v1/data, multi-provider failover
 *   MTN direct  dev.developers.mtn.com  official, but MTN-only + heavy onboarding
 */

export function configured() {
  return Boolean(
    (process.env.DATA_PROVIDER_API_KEY || '').trim()
      && (process.env.DATA_PROVIDER_BASE_URL || '').trim()
  );
}

/** Why data cannot be delivered right now. Surfaced on /healthz. */
export function status() {
  return configured()
    ? { ready: true, provider: process.env.DATA_PROVIDER_NAME || 'Kati' }
    : {
        ready: false,
        provider: null,
        reason:
          'data aggregator not configured. Set DATA_PROVIDER_API_KEY and '
          + 'DATA_PROVIDER_BASE_URL env vars to enable Kati data delivery.',
      };
}

/** Plan catalogue. Empty until a provider is wired; never invented. */
export function plans() {
  return [];
}

/**
 * Deliver a bundle. Refuses loudly while unconfigured.
 * A redemption must never be marked fulfilled on the strength of this returning.
 */
export async function deliver({ network, phone, planCode, reference }) {
  if (!configured()) {
    return {
      ok: false,
      retryable: false,
      error:
        'no data aggregator is configured, so no bundle can be delivered. '
        + 'The redemption stays reversible and the points are not lost.',
    };
  }
  if (!network) return { ok: false, retryable: false, error: 'network is required' };
  if (!phone) return { ok: false, retryable: false, error: 'destination phone is required' };
  if (!planCode) return { ok: false, retryable: false, error: 'planCode is required' };

  const base = process.env.DATA_PROVIDER_BASE_URL;
  const apiKey = process.env.DATA_PROVIDER_API_KEY;
  try {
    const res = await fetch(`${base}/v1/quote`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      // reference is stable per redemption so a retry cannot double-deliver
      body: JSON.stringify({ service: 'data', network, phone, plan: planCode, reference }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }

    if (!res.ok) {
      // 5xx and 429 are worth another attempt later; 4xx generally is not.
      return {
        ok: false,
        retryable: res.status >= 500 || res.status === 429,
        error: json?.message || text.slice(0, 200) || `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      providerRef: String(json?.id ?? json?.reference ?? reference),
      deliveredAt: new Date().toISOString(),
    };
  } catch (e) {
    // A transport failure is worth retrying: we do not know if it landed.
    return { ok: false, retryable: true, error: String(e.message || e).slice(0, 200) };
  }
}