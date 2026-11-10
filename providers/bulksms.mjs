/**
 * bulksms.mjs — BulkSMS Nigeria adapter: SMS send, balance, and a local OTP
 * challenge.
 *
 * SCOPE, stated plainly:
 * BulkSMS Nigeria is a straightforward SMS gateway. It sends messages and
 * reports a balance. It does NOT issue an OTP handle and it has NO verify
 * endpoint — the documented v2 surface is `POST /sms`, `GET /balance`,
 * delivery reports, transactions and sender IDs. That matters: Termii's
 * contract returned a `pin_id` and checked the code for us. Here the check has
 * to happen on our side.
 *
 * So `sendOtp` sends the code and returns a signed challenge token, and
 * `verifyOtp` checks the code against that token:
 *   - the challenge is HMAC-SHA256 over `nonce.recipient.pin`, keyed by
 *     OTP_SECRET (falling back to SESSION_SECRET), so a 4-digit code cannot be
 *     reversed out of the token without the secret;
 *   - the recipient is part of the signed payload input, so a code issued for
 *     one number cannot be redeemed against another;
 *   - the expiry is inside the signed body, so a client cannot extend it.
 * There is therefore no schema change: sign-in keeps working on the current
 * database.
 *
 * KNOWN LIMITATION, stated not hidden: failed-attempt counting lives in this
 * process (see `attempts`). It is exact for one Node process — which is how
 * Promota is deployed — but a restart clears it and it is not shared between
 * instances. Move it to a table if the app is ever run multi-instance.
 *
 * Transport note (developers.bulksmsnigeria.com, read 2026-11-09): the
 * recommended auth is `Authorization: Bearer <token>`; a custom `api_token`
 * header, a query parameter and a JSON body field also work. We use the
 * recommended header. Sandbox lives at /api/sandbox/v2 and sends no real SMS.
 *
 * Zero dependencies on purpose: this file ships inside the node:22-alpine
 * image which runs no `npm install`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PROD_BASE = 'https://www.bulksmsnigeria.com/api/v2';
const SANDBOX_BASE = 'https://www.bulksmsnigeria.com/api/sandbox/v2';

/** Resolved per call so a test (or a restart with new env) can switch cleanly. */
function base() {
  const override = (process.env.BULKSMS_BASE_URL || '').trim();
  if (override) return override.replace(/\/+$/, '');
  const sandbox = /^(1|true|yes|on)$/i.test((process.env.BULKSMS_SANDBOX || '').trim());
  return sandbox ? SANDBOX_BASE : PROD_BASE;
}

function token() {
  const t = (process.env.BULKSMS_API_TOKEN || process.env.BULKSMS_API_KEY || '').trim();
  if (!t) throw new Error('BULKSMS_API_TOKEN is not configured');
  return t;
}

export function configured() {
  return Boolean((process.env.BULKSMS_API_TOKEN || process.env.BULKSMS_API_KEY || '').trim());
}

export function sandbox() {
  return /^(1|true|yes|on)$/i.test((process.env.BULKSMS_SANDBOX || '').trim());
}

/**
 * BulkSMS wants international digits. `+234 803 000 0000`, `2348030000000` and
 * the local `08030000000` must all reach the API as `2348030000000` — a local
 * form sent as-is is billed and delivered as a different number.
 */
export function msisdn(to) {
  const d = String(to ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) return '234' + d.slice(1);
  return d;
}

function sender(senderId) {
  // Documented maximum is 11 characters; a longer id is rejected by the API.
  return String(senderId || process.env.BULKSMS_SENDER_ID || 'Promota').trim().slice(0, 11);
}

async function call(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }

  // Success is the documented code, not merely a 2xx: a gateway can answer 200
  // with status:"error" and a BSNG code.
  const code = String(json?.code ?? '');
  const failed = !res.ok || (json?.status && String(json.status).toLowerCase() !== 'success');
  if (failed) {
    const reason = json?.error?.message || json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    const label = code ? `${code}: ${reason}` : reason;
    // Never include the token or the URL query in the message.
    throw new Error(`bulksms ${path}: ${label}`);
  }
  return json ?? {};
}

/** Wallet balance. Used by the admin plugin probe and /healthz. */
export async function balance() {
  const r = await call('/balance');
  return {
    balance: Number(r?.data?.balance ?? 0),
    currency: r?.data?.currency || 'NGN',
    formatted: r?.data?.formatted || null,
    sandbox: sandbox(),
  };
}

/**
 * Send an SMS. `to` may be one number or a comma-separated list; a list is
 * normalised to international digits and sent in a single request.
 */
export async function sendSms({ to, message, senderId, gateway, unicode = false, callbackUrl, customerReference }) {
  const list = String(to ?? '').split(',').map(msisdn).filter(Boolean);
  if (list.length === 0) throw new Error('bulksms: no recipient number');
  if (!message || !String(message).trim()) throw new Error('bulksms: message body is empty');

  const payload = {
    from: sender(senderId),
    to: list.join(','),
    body: String(message),
  };
  const gw = gateway || process.env.BULKSMS_GATEWAY || 'direct-refund';
  if (gw) payload.gateway = gw;
  if (unicode) payload.unicode = true;
  const cb = callbackUrl || process.env.BULKSMS_CALLBACK_URL;
  if (cb) payload.callback_url = cb;
  if (customerReference) payload.customer_reference = customerReference;

  const r = await call('/sms', { method: 'POST', body: payload });
  const d = r?.data || {};
  return {
    messageId: d.message_id ?? null,
    cost: d.cost ?? null,
    currency: d.currency || 'NGN',
    recipients: d.recipients_count ?? list.length,
    gatewayUsed: d.gateway_used ?? null,
    requestedGateway: d.requested_gateway ?? payload.gateway ?? null,
    routeNotice: d.route_notice ?? null,
    skipped: d.skipped_recipients ?? [],
    sandbox: d.sandbox_mode === true || sandbox(),
  };
}

/* ------------------------------------------------------------ OTP challenge */

const PREFIX = 'bs1';
const DEFAULT_TTL_SECONDS = 300;
const MAX_ATTEMPTS = 5;

/** In-process failed-attempt ledger: nonce -> { fails, exp }. See KNOWN LIMITATION. */
const attempts = new Map();

function otpSecret() {
  const s = (process.env.OTP_SECRET || process.env.SESSION_SECRET || '').trim();
  if (!s) throw new Error('OTP_SECRET or SESSION_SECRET must be configured before an OTP can be issued');
  return s;
}

function ttlSeconds() {
  const n = Number(process.env.BULKSMS_OTP_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  return Number.isFinite(n) && n >= 60 && n <= 900 ? Math.floor(n) : DEFAULT_TTL_SECONDS;
}

/**
 * HMAC over `<signed payload>.<recipient>.<pin>`.
 *
 * The encoded payload is part of the input on purpose: it carries the nonce and
 * the expiry, so signing only the nonce would let a client rewrite `e` and hand
 * itself a longer-lived code. The pin is never stored or sent back.
 */
function mac(body, to, pin) {
  return createHmac('sha256', otpSecret())
    .update(`${body}.${msisdn(to)}.${String(pin ?? '').trim()}`)
    .digest('base64url');
}

function pruneLedger(now) {
  if (attempts.size < 5000) return;
  for (const [k, v] of attempts) if (!v || v.exp <= now) attempts.delete(k);
}

function sameBitString(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Send a one-time code and return `pinId`: a self-contained signed challenge.
 * The field name is kept because the client and `/api/auth/otp/verify` already
 * speak `pinId`; with BulkSMS it is our token, not a provider handle.
 */
export async function sendOtp({ to, pin, senderId, gateway }) {
  const code = String(pin ?? '').replace(/\D/g, '');
  if (code.length < 4 || code.length > 8) throw new Error('bulksms: the OTP must be 4-8 digits');

  const ttl = ttlSeconds();
  const minutes = Math.max(1, Math.round(ttl / 60));
  const sent = await sendSms({
    to,
    senderId,
    // direct-refund (the default) is used on purpose: the documented corporate
    // route SKIPS recipients whose network is not approved for it, which would
    // silently fail to deliver a login code. A skipped code is worse than a
    // cheaper one.
    gateway: gateway || process.env.BULKSMS_OTP_GATEWAY || 'direct-refund',
    message: `Your Promota code is ${code}. It expires in ${minutes} minutes. Do not share it.`,
  });

  const nonce = randomBytes(12).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const body = Buffer.from(JSON.stringify({ v: 1, n: nonce, e: exp })).toString('base64url');
  const pinId = `${PREFIX}.${body}.${mac(body, to, code)}`;

  pruneLedger(Math.floor(Date.now() / 1000));
  attempts.delete(nonce);
  return { pinId, expiresInMinutes: minutes, messageId: sent.messageId, sandbox: sent.sandbox };
}

/**
 * Check a code against its challenge. A wrong, expired, already-locked or
 * tampered challenge is a refusal (false) — never an outage. A missing signing
 * secret throws, because that is a deployment fault, not a wrong code.
 */
export async function verifyOtp({ pinId, pin, to }) {
  const raw = String(pinId || '');
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return false; }
  if (!payload || payload.v !== 1 || typeof payload.n !== 'string' || typeof payload.e !== 'number') return false;

  const now = Math.floor(Date.now() / 1000);
  if (payload.e <= now) return false;

  const ledger = attempts.get(payload.n);
  if (ledger && ledger.fails >= MAX_ATTEMPTS) return false;

  const expected = mac(parts[1], to, pin);
  if (!sameBitString(expected, parts[2])) {
    const prev = ledger && ledger.exp === payload.e ? ledger.fails : 0;
    attempts.set(payload.n, { fails: prev + 1, exp: payload.e });
    return false;
  }

  attempts.delete(payload.n);
  return true;
}

/** Test/introspection hook: how many failures a live challenge has recorded. */
export function failedAttempts(pinId) {
  const parts = String(pinId || '').split('.');
  if (parts.length !== 3) return 0;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return attempts.get(p?.n)?.fails ?? 0;
  } catch { return 0; }
}
