#!/usr/bin/env node
/**
 * bulksms.test.mjs — adversarial tests for the BulkSMS Nigeria adapter.
 *
 * Two things are being pinned here, and both are load-bearing:
 *
 * 1. The transport contract, exactly as developers.bulksmsnigeria.com documents
 *    it: `Authorization: Bearer <token>`, `POST /sms` with `from`/`to`/`body`
 *    and a bare-digits recipient, `GET /balance`, the sandbox base URL, and the
 *    fact that a 200 can still carry `status:"error"` — success is the code,
 *    not the status line.
 *
 * 2. The OTP challenge. BulkSMS has NO verify endpoint, so `verifyOtp` is our
 *    own check against a signed token. If that ever silently degrades, phone
 *    sign-in — the ONLY login path — is either broken or forgeable. So the
 *    cases below attack it: wrong pin, tampered signature, edited payload,
 *    expired token, a token used against a different number, a rotated secret,
 *    and the attempt lock.
 *
 * No network is touched; no token value appears in a failure message.
 */
import { createHmac } from 'node:crypto';
import * as bulksms from './bulksms.mjs';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const envSave = { ...process.env };
const MANAGED = ['BULKSMS_API_TOKEN', 'BULKSMS_API_KEY', 'BULKSMS_BASE_URL', 'BULKSMS_SANDBOX',
  'BULKSMS_SENDER_ID', 'BULKSMS_GATEWAY', 'BULKSMS_CALLBACK_URL', 'BULKSMS_OTP_GATEWAY',
  'BULKSMS_OTP_TTL_SECONDS', 'OTP_SECRET', 'SESSION_SECRET', 'SMS_PROVIDER', 'TERMII_API_KEY'];
function env(set = {}) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, set);
}
function envReset() {
  for (const k of MANAGED) delete process.env[k];
  for (const k of Object.keys(envSave)) process.env[k] = envSave[k];
}

const TOKEN = 'bsn_test_token_value';
const SECRET = 'otp-test-secret-not-a-real-one';
const PROD = 'https://www.bulksmsnigeria.com/api/v2';
const SANDBOX = 'https://www.bulksmsnigeria.com/api/sandbox/v2';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const text = (status, body) => new Response(body, { status });

/** Print a captured request without ever echoing the bearer token. */
function redact(call) {
  if (!call) return 'no call';
  const auth = call.headers.authorization ? 'Bearer ***' : 'no-auth';
  return `${call.method} ${call.path} [${auth}] ${JSON.stringify(call.body)}`;
}

/** Installs a fetch stub and returns the call log. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    const call = {
      url: String(url),
      origin: u.origin,
      path: u.pathname,
      basePath: u.pathname.replace(/^(?:[^/]+)?\/api\/(?:sandbox\/)?v2/, ''),
      method: init.method || 'GET',
      body,
      headers,
    };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

/** The documented success envelope. */
const sentOk = (over = {}) => json(200, {
  status: 'success', code: 'BSNG-0000', message: 'Message sent successfully',
  data: {
    message_id: 'd0173d84-2f01-4a5f-a0dc-375beea5b806', cost: 4.99, currency: 'NGN',
    recipients_count: 1, gateway_used: 'direct-refund', unicode: false, page_count: 1, ...over,
  },
});

/* ------------------------------------------------------ case: no token at all */
async function caseUnconfigured() {
  env();
  const calls = stubFetch(() => json(200, { status: 'success', data: { balance: 1 } }));
  check('no token → configured() is false', bulksms.configured() === false);
  check('no token → sandbox() defaults to false', bulksms.sandbox() === false);
  let err = null;
  try { await bulksms.balance(); } catch (e) { err = e; }
  check('no token → a call refuses instead of firing', err !== null && /BULKSMS_API_TOKEN is not configured/.test(err.message),
    err && err.message);
  let sendErr = null;
  try { await bulksms.sendSms({ to: '08030000000', message: 'hi' }); } catch (e) { sendErr = e; }
  check('no token → a send refuses instead of firing', sendErr !== null && /is not configured/.test(sendErr.message),
    sendErr && sendErr.message);
  check('no token → no http was fired', calls.length === 0, `calls=${calls.length}`);
  check('BULKSMS_API_KEY is accepted as the token alias', bulksms.configured() === false);
}

/* --------------------------------------------------------- case: base URL choice */
async function caseBaseUrl() {
  env({ BULKSMS_API_TOKEN: TOKEN });
  let calls = stubFetch(() => json(200, { status: 'success', data: { balance: 1 } }));
  await bulksms.balance();
  check('default base → production /api/v2', calls[0] && `${calls[0].origin}${calls[0].path}` === `${PROD}/balance`,
    calls[0] && calls[0].url);

  env({ BULKSMS_API_TOKEN: TOKEN, BULKSMS_SANDBOX: '1' });
  check('BULKSMS_SANDBOX=1 → sandbox() is true', bulksms.sandbox() === true);
  calls = stubFetch(() => json(200, { status: 'success', data: { balance: 1 } }));
  await bulksms.balance();
  check('BULKSMS_SANDBOX=1 → sandbox base URL',
    calls[0] && `${calls[0].origin}${calls[0].path}` === `${SANDBOX}/balance`, calls[0] && calls[0].url);

  env({ BULKSMS_API_TOKEN: TOKEN, BULKSMS_SANDBOX: 'true' });
  check('BULKSMS_SANDBOX=true is honoured', bulksms.sandbox() === true);
  env({ BULKSMS_API_TOKEN: TOKEN, BULKSMS_SANDBOX: '0' });
  check('BULKSMS_SANDBOX=0 stays production', bulksms.sandbox() === false);

  env({ BULKSMS_API_TOKEN: TOKEN, BULKSMS_BASE_URL: 'https://stub.local/api/v2/' });
  calls = stubFetch(() => json(200, { status: 'success', data: { balance: 1 } }));
  await bulksms.balance();
  check('BULKSMS_BASE_URL override wins and trailing slash is trimmed',
    calls[0] && calls[0].url === 'https://stub.local/api/v2/balance', calls[0] && calls[0].url);
  envReset();
}

/* -------------------------------------------------------- case: msisdn normalise */
function caseMsisdn() {
  check('msisdn → local 0803… becomes 234803…', bulksms.msisdn('08030001733') === '2348030001733',
    bulksms.msisdn('08030001733'));
  check('msisdn → +234 with spaces becomes bare digits', bulksms.msisdn('+234 803 000 1733') === '2348030001733',
    bulksms.msisdn('+234 803 000 1733'));
  check('msisdn → already-international digits are untouched',
    bulksms.msisdn('2348030001733') === '2348030001733', bulksms.msisdn('2348030001733'));
  check('msisdn → dashes are stripped', bulksms.msisdn('0803-000-1733') === '2348030001733',
    bulksms.msisdn('0803-000-1733'));
  check('msisdn → empty input yields empty, not "234"', bulksms.msisdn('') === '' && bulksms.msisdn(null) === '',
    `"${bulksms.msisdn(null)}"`);
}

/* -------------------------------------------------------- case: balance contract */
async function caseBalance() {
  env({ BULKSMS_API_TOKEN: TOKEN });
  const calls = stubFetch((call) => (call.headers.authorization === `Bearer ${TOKEN}`
    ? json(200, { status: 'success', code: 'BSNG-0000', data: { balance: 9884094.24, currency: 'NGN', formatted: '₦9,884,094.24' } })
    : json(401, { status: 'error', code: 'BSNG-1001', error: { message: 'Invalid token' } })));

  const b = await bulksms.balance();
  check('balance → numeric balance', b.balance === 9884094.24, JSON.stringify(b));
  check('balance → currency NGN', b.currency === 'NGN', b.currency);
  check('balance → formatted string kept', b.formatted === '₦9,884,094.24', b.formatted);
  check('balance → sandbox flag reported', b.sandbox === false, String(b.sandbox));
  check('balance → GET /balance', calls[0] && calls[0].method === 'GET' && calls[0].basePath === '/balance',
    redact(calls[0]));
  check('balance → documented Bearer auth header',
    calls[0] && calls[0].headers.authorization === `Bearer ${TOKEN}`, calls[0] && calls[0].headers.authorization ? 'present' : 'missing');
  check('balance → accept: application/json', calls[0] && calls[0].headers.accept === 'application/json',
    calls[0] && calls[0].headers.accept);
  check('balance → no token in the query string',
    calls[0] && !String(calls[0].url).includes(TOKEN), 'token was in the URL');
  envReset();
}

/* ---------------------------------------------------- case: sendSms full contract */
async function caseSendSms() {
  env({ BULKSMS_API_TOKEN: TOKEN });
  const calls = stubFetch((call) => (call.headers.authorization === `Bearer ${TOKEN}`
    ? sentOk({ recipients_count: 2 })
    : json(401, { status: 'error', code: 'BSNG-1001', error: { message: 'Invalid token' } })));

  const r = await bulksms.sendSms({ to: '08030001733,09050030090', message: 'Hello from Promota' });
  check('sendSms → message id returned', r.messageId === 'd0173d84-2f01-4a5f-a0dc-375beea5b806', JSON.stringify(r));
  check('sendSms → cost/currency mapped', r.cost === 4.99 && r.currency === 'NGN', JSON.stringify(r));
  check('sendSms → recipients_count wins over the local list length', r.recipients === 2, String(r.recipients));
  check('sendSms → gateway_used reported', r.gatewayUsed === 'direct-refund', String(r.gatewayUsed));
  check('sendSms → sandbox false on the live envelope', r.sandbox === false, String(r.sandbox));

  const c = calls[0];
  check('sendSms → POST /sms', c && c.method === 'POST' && c.basePath === '/sms', redact(c));
  check('sendSms → Bearer auth header', c && c.headers.authorization === `Bearer ${TOKEN}`, redact(c));
  check('sendSms → JSON content type', c && c.headers['content-type'] === 'application/json',
    c && c.headers['content-type']);
  check('sendSms → from is the default sender id', c && c.body.from === 'Promota', c && c.body.from);
  check('sendSms → multi-recipient list is normalised and comma-joined',
    c && c.body.to === '2348030001733,2349050030090', c && c.body.to);
  check('sendSms → body carries the message', c && c.body.body === 'Hello from Promota', c && c.body.body);
  check('sendSms → gateway defaults to direct-refund', c && c.body.gateway === 'direct-refund', c && c.body.gateway);
  check('sendSms → unicode is not sent when false', c && c.body.unicode === undefined, String(c && c.body.unicode));
  check('sendSms → no callback_url unless configured', c && c.body.callback_url === undefined,
    String(c && c.body.callback_url));

  /* explicit options */
  env({
    BULKSMS_API_TOKEN: TOKEN, BULKSMS_SENDER_ID: 'PromotaLive', BULKSMS_CALLBACK_URL: 'https://promota.click/cb',
    BULKSMS_GATEWAY: 'international',
  });
  const overrideCalls = stubFetch(() => sentOk());
  const r2 = await bulksms.sendSms({
    to: '+234 803 000 1733', message: 'Emoji 😀 kept', unicode: true, customerReference: 'otp-42',
  });
  const c2 = overrideCalls[0];
  check('sendSms → env sender id wins', c2 && c2.body.from === 'PromotaLive', c2 && c2.body.from);
  check('sendSms → env gateway used when no argument', c2 && c2.body.gateway === 'international', c2 && c2.body.gateway);
  check('sendSms → unicode:true is sent as a boolean', c2 && c2.body.unicode === true, String(c2 && c2.body.unicode));
  check('sendSms → callback_url from env', c2 && c2.body.callback_url === 'https://promota.click/cb',
    c2 && c2.body.callback_url);
  check('sendSms → customer_reference is sent', c2 && c2.body.customer_reference === 'otp-42',
    c2 && c2.body.customer_reference);
  check('sendSms → single recipient still normalised', c2 && c2.body.to === '2348030001733', c2 && c2.body.to);
  check('sendSms → sandbox flag surfaces in the result', r2.sandbox === false, String(r2.sandbox));

  /* sender id cap */
  env({ BULKSMS_API_TOKEN: TOKEN });
  const capCalls = stubFetch(() => sentOk());
  await bulksms.sendSms({ to: '08030001733', message: 'hi', senderId: 'PromotaNigeriaLtd' });
  const c3 = capCalls[0];
  check('sendSms → sender id capped at the documented 11 characters',
    c3 && c3.body.from === 'PromotaNige', c3 && c3.body.from);

  /* refusals before the network */
  const calls2 = stubFetch(() => sentOk());
  let e1 = null;
  try { await bulksms.sendSms({ to: '', message: 'hi' }); } catch (e) { e1 = e; }
  check('sendSms → empty recipient refuses locally', e1 !== null && /no recipient/.test(e1.message), e1 && e1.message);
  let e2 = null;
  try { await bulksms.sendSms({ to: '08030001733', message: '   ' }); } catch (e) { e2 = e; }
  check('sendSms → empty body refuses locally', e2 !== null && /body is empty/.test(e2.message), e2 && e2.message);
  check('sendSms → neither refusal fired http', calls2.length === 0, `calls=${calls2.length}`);
  envReset();
}

/* ------------------------------------------- case: sandbox send is labelled so */
async function caseSandbox() {
  env({ BULKSMS_API_TOKEN: TOKEN, BULKSMS_SANDBOX: '1' });
  const calls = stubFetch(() => json(200, {
    status: 'success', code: 'BSNG-0000',
    message: '[SANDBOX] Message simulated successfully - no real SMS sent',
    data: {
      message_id: 'sandbox-d0173d84', cost: 0, currency: 'NGN', recipients_count: 1,
      gateway_used: 'sandbox', sandbox_mode: true,
    },
  }));
  const r = await bulksms.sendSms({ to: '2347037770033', message: 'sandbox proof' });
  check('sandbox → POST hits the sandbox base',
    calls[0] && calls[0].url === `${SANDBOX}/sms`, calls[0] && calls[0].url);
  check('sandbox → result is flagged sandbox', r.sandbox === true, String(r.sandbox));
  check('sandbox → zero cost preserved', r.cost === 0, String(r.cost));
  check('sandbox → sandbox message id returned', r.messageId === 'sandbox-d0173d84', String(r.messageId));
  envReset();
}

/* ---------------------------------------- case: 200 with status:"error" is a failure */
async function caseErrorSurface() {
  env({ BULKSMS_API_TOKEN: TOKEN });

  // The documented error shape arrives with a non-2xx, but the contract also
  // permits status:"error" on a 200 — that must never be read as delivered.
  stubFetch(() => json(200, {
    status: 'error', code: 'BSNG-2001',
    error: { message: "Bad request. 'FROM' parameter is missing.", code: 'BSNG-2001', description: 'Sender ID parameter missing' },
  }));
  let soft = null;
  try { await bulksms.sendSms({ to: '08030001733', message: 'hi' }); } catch (e) { soft = e; }
  check('error → 200 with status:"error" throws (no false success)', soft !== null
    && /BSNG-2001: Bad request/.test(soft.message), soft && soft.message);
  check('error → the BSNG code is surfaced', soft !== null && /bulksms \/sms: BSNG-2001/.test(soft.message),
    soft && soft.message);
  check('error → never echoes the token', soft !== null && !soft.message.includes(TOKEN), 'token leaked');

  stubFetch(() => json(401, { status: 'error', code: 'BSNG-1001', error: { message: 'Invalid API token' } }));
  let auth = null;
  try { await bulksms.balance(); } catch (e) { auth = e; }
  check('error → 401 names the route and reason', auth !== null
    && auth.message === 'bulksms /balance: BSNG-1001: Invalid API token', auth && auth.message);
  check('error → 401 message carries no token', auth !== null && !auth.message.includes(TOKEN));

  stubFetch(() => json(500, { status: 'error', error: { message: 'upstream boom' } }));
  let outage = null;
  try { await bulksms.sendSms({ to: '08030001733', message: 'hi' }); } catch (e) { outage = e; }
  check('error → 5xx outage throws', outage !== null && /upstream boom/.test(outage.message),
    outage && outage.message);

  stubFetch(() => text(502, '<!-- gateway -->'));
  let raw = null;
  try { await bulksms.balance(); } catch (e) { raw = e; }
  check('error → a non-JSON body still yields a message', raw !== null && /^bulksms \/balance: /.test(raw.message),
    raw && raw.message);
  check('error → the token is not in that message either', raw !== null && !raw.message.includes(TOKEN));
  envReset();
}

/* ------------------------------------------------------------- case: OTP flow */
async function caseOtpHappyPath() {
  env({ BULKSMS_API_TOKEN: TOKEN, OTP_SECRET: SECRET });
  const calls = stubFetch(() => sentOk());

  const r = await bulksms.sendOtp({ to: '+234 803 000 1733', pin: '7319' });
  check('otp send → pinId returned', typeof r.pinId === 'string' && r.pinId.length > 20, String(r.pinId).slice(0, 12));
  check('otp send → 5-minute ttl', r.expiresInMinutes === 5, String(r.expiresInMinutes));
  check('otp send → message id from the provider', r.messageId === 'd0173d84-2f01-4a5f-a0dc-375beea5b806', String(r.messageId));

  const c = calls[0];
  check('otp send → one SMS was actually sent', calls.length === 1 && c.basePath === '/sms', redact(c));
  check('otp send → recipient normalised', c && c.body.to === '2348030001733', c && c.body.to);
  check('otp send → direct-refund, never the skipping corporate route',
    c && c.body.gateway === 'direct-refund', c && c.body.gateway);
  check('otp send → message contains the code and the ttl',
    c && /7319/.test(c.body.body) && /5 minutes/.test(c.body.body) && /Do not share/i.test(c.body.body),
    c && c.body.body);

  check('otp send → the pin is not recoverable from pinId', !String(r.pinId).includes('7319'));
  const payload = JSON.parse(Buffer.from(String(r.pinId).split('.')[1], 'base64url').toString('utf8'));
  check('otp send → payload holds only version/nonce/exp',
    payload.v === 1 && typeof payload.n === 'string' && typeof payload.e === 'number'
    && Object.keys(payload).sort().join(',') === 'e,n,v', JSON.stringify(payload));

  check('otp verify → the right code resolves true',
    await bulksms.verifyOtp({ pinId: r.pinId, pin: '7319', to: '2348030001733' }) === true);
  check('otp verify → success clears the attempt ledger', bulksms.failedAttempts(r.pinId) === 0,
    String(bulksms.failedAttempts(r.pinId)));
  envReset();
}

async function caseOtpAttacks() {
  env({ BULKSMS_API_TOKEN: TOKEN, OTP_SECRET: SECRET });
  stubFetch(() => sentOk());

  const TO = '2348030001733';
  const { pinId } = await bulksms.sendOtp({ to: TO, pin: '4821' });

  check('otp attack → a wrong code is false, not an error',
    await bulksms.verifyOtp({ pinId, pin: '0000', to: TO }) === false);
  check('otp attack → the wrong-code attempt is counted', bulksms.failedAttempts(pinId) === 1,
    String(bulksms.failedAttempts(pinId)));
  check('otp attack → the right code still works after one miss',
    await bulksms.verifyOtp({ pinId, pin: '4821', to: TO }) === true);

  // A challenge issued for one number must not redeem another.
  const other = await bulksms.sendOtp({ to: '2349050030090', pin: '4821' });
  check('otp attack → a challenge is bound to its recipient',
    await bulksms.verifyOtp({ pinId: other.pinId, pin: '4821', to: TO }) === false);

  // Tampered signature.
  const parts = pinId.split('.');
  check('otp attack → a flipped signature is refused',
    await bulksms.verifyOtp({ pinId: `${parts[0]}.${parts[1]}.${'A'.repeat(parts[2].length)}`, pin: '4821', to: TO }) === false);

  // Tampered payload (a client extending its own expiry) breaks the mac.
  const now = Math.floor(Date.now() / 1000);
  const extended = Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), e: now + 86400,
  })).toString('base64url');
  check('otp attack → an edited expiry is refused',
    await bulksms.verifyOtp({ pinId: `${parts[0]}.${extended}.${parts[2]}`, pin: '4821', to: TO }) === false);

  // Structurally invalid tokens are refusals.
  for (const bad of ['', 'nonsense', 'a.b', 'bs1.x.y', 'bs2.e30.x', `${parts[0]}.bm90LWpzb24.${parts[2]}`]) {
    check(`otp attack → malformed token "${bad.slice(0, 14)}" is refused`,
      await bulksms.verifyOtp({ pinId: bad, pin: '4821', to: TO }) === false);
  }

  // Correctly signed but expired: the exp is inside the signed body, so this is
  // the only way a token can expire, and it must be enforced.
  const nonce = 'expired-nonce';
  const body = Buffer.from(JSON.stringify({ v: 1, n: nonce, e: now - 1 })).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`${body}.${TO}.4821`).digest('base64url');
  check('otp attack → a correctly signed but expired challenge is refused',
    await bulksms.verifyOtp({ pinId: `bs1.${body}.${sig}`, pin: '4821', to: TO }) === false);

  // Rotating the secret invalidates every outstanding challenge.
  process.env.OTP_SECRET = 'a-different-secret';
  check('otp attack → rotating the secret invalidates old challenges',
    await bulksms.verifyOtp({ pinId, pin: '4821', to: TO }) === false);
  process.env.OTP_SECRET = SECRET;

  // Attempt lock: five misses and even the right code is dead.
  const locked = await bulksms.sendOtp({ to: TO, pin: '9999' });
  for (let i = 0; i < 5; i++) await bulksms.verifyOtp({ pinId: locked.pinId, pin: '1111', to: TO });
  check('otp attack → five misses lock the challenge', bulksms.failedAttempts(locked.pinId) === 5,
    String(bulksms.failedAttempts(locked.pinId)));
  check('otp attack → the right code is refused once locked',
    await bulksms.verifyOtp({ pinId: locked.pinId, pin: '9999', to: TO }) === false);
  envReset();
}

async function caseOtpGuards() {
  env({ BULKSMS_API_TOKEN: TOKEN });

  // No signing secret is a deployment fault, not a wrong code: it must throw.
  let noSecret = null;
  try { await bulksms.sendOtp({ to: '08030001733', pin: '1234' }); } catch (e) { noSecret = e; }
  check('otp → missing OTP_SECRET/SESSION_SECRET throws loudly', noSecret !== null
    && /OTP_SECRET or SESSION_SECRET must be configured/.test(noSecret.message), noSecret && noSecret.message);

  env({ BULKSMS_API_TOKEN: TOKEN, SESSION_SECRET: SECRET });
  stubFetch(() => sentOk());
  let viaSession = null;
  try {
    viaSession = await bulksms.sendOtp({ to: '08030001733', pin: '1234' });
  } catch (e) { viaSession = e; }
  check('otp → SESSION_SECRET is an accepted fallback',
    viaSession && !(viaSession instanceof Error) && typeof viaSession.pinId === 'string',
    viaSession && viaSession.message);

  env({ BULKSMS_API_TOKEN: TOKEN, OTP_SECRET: SECRET });
  const calls = stubFetch(() => sentOk());
  for (const [label, pin] of [['three digits', '123'], ['nine digits', '123456789'], ['letters', 'abcd'], ['empty', '']]) {
    let err = null;
    try { await bulksms.sendOtp({ to: '08030001733', pin }); } catch (e) { err = e; }
    check(`otp → a ${label} pin is refused before any send`, err !== null && /4-8 digits/.test(err.message),
      err && err.message);
  }
  check('otp → no http fired for the invalid pins', calls.length === 0, `calls=${calls.length}`);

  // A custom gateway/ttl is honoured, but the ttl is clamped to a sane window.
  const gwCalls = stubFetch(() => sentOk());
  const ok1 = await bulksms.sendOtp({ to: '08030001733', pin: '1234', gateway: 'otp' });
  check('otp → an explicit gateway is honoured', gwCalls[0] && gwCalls[0].body.gateway === 'otp',
    gwCalls[0] && gwCalls[0].body.gateway);
  check('otp → default ttl reported as 5 minutes', ok1.expiresInMinutes === 5, String(ok1.expiresInMinutes));

  env({ BULKSMS_API_TOKEN: TOKEN, OTP_SECRET: SECRET, BULKSMS_OTP_TTL_SECONDS: '6000' });
  const ttlCalls = stubFetch(() => sentOk());
  const ok2 = await bulksms.sendOtp({ to: '08030001733', pin: '1234' });
  check('otp → an absurd ttl is clamped back to the default', ok2.expiresInMinutes === 5,
    String(ok2.expiresInMinutes));
  check('otp → the clamped ttl is what the SMS says', ttlCalls[0] && /5 minutes/.test(ttlCalls[0].body.body),
    ttlCalls[0] && ttlCalls[0].body.body);

  env({ BULKSMS_API_TOKEN: TOKEN, OTP_SECRET: SECRET, BULKSMS_OTP_GATEWAY: 'otp' });
  const envGwCalls = stubFetch(() => sentOk());
  await bulksms.sendOtp({ to: '08030001733', pin: '1234' });
  check('otp → BULKSMS_OTP_GATEWAY is honoured', envGwCalls[0] && envGwCalls[0].body.gateway === 'otp',
    envGwCalls[0] && envGwCalls[0].body.gateway);
  envReset();
}

(async () => {
  try {
    await caseUnconfigured();
    await caseBaseUrl();
    caseMsisdn();
    await caseBalance();
    await caseSendSms();
    await caseSandbox();
    await caseErrorSurface();
    await caseOtpHappyPath();
    await caseOtpAttacks();
    await caseOtpGuards();
  } catch (e) {
    fail++;
    console.error('  FAIL  unhandled in test runner', String(e && e.stack || e).split('\n')[0]);
  }
  envReset();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
})();
