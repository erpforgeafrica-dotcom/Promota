/**
 * termii.mjs — Termii adapter: phone OTP, sender id, and number intelligence.
 *
 * SCOPE, stated plainly so nobody builds on a wrong assumption:
 * Termii is a MESSAGING and OTP provider. It does NOT sell or deliver mobile
 * data bundles. Verified against the live key on 2026-10-08:
 *   GET /api/get-balance -> 200 {"balance":30.0000,"currency":"NGN",...}
 * Data fulfillment lives in ./data.mjs and needs a separate aggregator.
 *
 * Auth note: Termii takes `api_key` in the request BODY on every POST and in
 * the query string on GET. A header returns 401 even with a valid key. The
 * query-string form ALSO returns 401 on POST ("A valid API key is required"),
 * verified live on 2026-11-09 — that is why every write puts the key in the
 * body here.
 *
 * Zero dependencies on purpose: this file ships inside the node:22-alpine
 * image which runs no `npm install`.
 */

const BASE = process.env.TERMII_BASE_URL || 'https://api.ng.termii.com';

export function configured() {
  return Boolean(process.env.TERMII_API_KEY);
}

function key() {
  const k = (process.env.TERMII_API_KEY || '').trim();
  if (!k) throw new Error('TERMII_API_KEY is not configured');
  return k;
}

/**
 * Termii wants the international number as bare digits: no '+', no spaces.
 * `+234 803 000 0000` and `+2348030000000` must reach the API identically, or a
 * write fails with "Invalid phone number" after the wallet has been charged.
 */
function msisdn(to) {
  return String(to ?? '').replace(/\D/g, '');
}

async function call(path, { method = 'GET', body = null } = {}) {
  const isWrite = method !== 'GET';
  // Live-verified 2026-11-09: POSTs are rejected with 401 when the key is only
  // in the query string, so writes carry it in the JSON body.
  const payload = isWrite ? { api_key: key(), ...(body || {}) } : null;
  const url = `${BASE}/api/${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key())}`;
  const res = await fetch(url, {
    method,
    headers: payload ? { 'content-type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = json?.message || json?.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`termii ${path}: ${msg}`);
  }
  return json ?? {};
}

/** Wallet balance. Used by /healthz so a drained SMS wallet is visible. */
export async function balance() {
  const b = await call('get-balance');
  return { balance: Number(b.balance ?? 0), currency: b.currency || 'NGN' };
}

/**
 * Send a one-time PIN. Returns the pin_id Termii uses to verify it.
 * pin_type: 'numeric' | 'alphnumeric'
 *
 * The documented contract (developers.termii.com/send-token, read 2026-11-09)
 * requires the full field set below and an international number WITHOUT the
 * leading '+'. Sending four ad-hoc fields returned 401/400 on the live key.
 * `pin` is kept because the caller generates the code; Termii accepts it, and
 * the message text carries the placeholder for the case where it is generated
 * provider-side instead.
 */
export async function sendOtp({ to, pin, senderId }) {
  const digits = String(pin ?? '').replace(/\D/g, '');
  const pinLength = digits.length >= 4 && digits.length <= 8 ? digits.length : 4;
  const placeholder = `< ${'1'.repeat(pinLength)} >`;
  const body = {
    message_type: 'NUMERIC',
    to: msisdn(to),
    from: senderId || process.env.TERMII_SENDER_ID || 'Promota',
    channel: process.env.TERMII_OTP_CHANNEL || 'dnd',
    pin_attempts: 3,
    pin_time_to_live: 5,
    pin_length: pinLength,
    pin_placeholder: placeholder,
    message_text: `Your Promota code is ${placeholder}. It expires in 5 minutes. Do not share it.`,
    pin_type: 'NUMERIC',
  };
  if (digits) body.pin = digits;
  const r = await call('sms/otp/send', { method: 'POST', body });
  // Termii returns pin_id (some routes call it pin_id_str)
  const pinId = r.pin_id ?? r.pin_id_str ?? r.data?.pin_id ?? null;
  if (!pinId) throw new Error('termii otp send returned no pin_id');
  return { pinId: String(pinId), expiresInMinutes: 5 };
}

/**
 * Verify a PIN. Termii returns { status: 'SUCCESS' | 'INVALID' | ... }.
 * An invalid PIN is a normal outcome, not a provider fault, so it resolves to
 * false instead of throwing.
 */
export async function verifyOtp({ pinId, pin }) {
  let r;
  try {
    r = await call('sms/otp/verify', { method: 'POST', body: { pin_id: pinId, pin } });
  } catch (e) {
    // Termii signals a wrong/expired PIN as a 4xx; that is "not verified",
    // not an outage, so we must not surface it as an error.
    if (/invalid|expired|not found|incorrect/i.test(String(e.message))) return false;
    throw e;
  }
  const status = String(r.status ?? r.data?.status ?? '').toUpperCase();
  return status === 'SUCCESS' || r.verified === true;
}

/**
 * Number intelligence: which network, and is the line reachable?
 * Used to route a data bundle to the right carrier and to refuse known-dead
 * numbers before a payout is attempted. Falls back to { network: null } rather
 * than throwing, because network detection must never block a signup.
 */
export async function lookupNumber(phoneE164) {
  try {
    const cc = process.env.TERMII_DEFAULT_COUNTRY_CODE || 'NG';
    const r = await call(
      `insight/number/query?phone_number=${encodeURIComponent(phoneE164)}`
      + `&country_code=${encodeURIComponent(cc)}`
    );
    const raw = String(
      r.operator ?? r.carrier ?? r.network ?? r.data?.operator ?? r.data?.carrier ?? ''
    ).toUpperCase();
    const map = [
      [/MTN|MTNOMNI/i, 'MTN'],
      [/GLO|GLOBACOM/i, 'GLO'],
      [/AIRTEL/i, 'AIRTEL'],
      [/9MOBILE|NINE MOBILE|9MOBILE/i, '9MOBILE'],
    ];
    for (const [re, name] of map) if (re.test(raw)) return { network: name };
    return { network: null, raw };
  } catch {
    return { network: null };
  }
}

/** Generic SMS, used for "your redemption is on the way" notices. */
export async function sendSms({ to, message, senderId }) {
  const from = senderId || process.env.TERMII_SENDER_ID || 'Promota';
  const r = await call('sms/send', {
    method: 'POST',
    body: { to: msisdn(to), from, sms: message, type: 'plain', channel: 'generic' },
  });
  return { messageId: r.message_id_str ?? r.message_id ?? null, balance: r.balance ?? null };
}