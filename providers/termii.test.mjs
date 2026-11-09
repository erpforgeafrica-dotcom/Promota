#!/usr/bin/env node
/**
 * termii.test.mjs — adversarial tests for the Termii adapter.
 *
 * The stub below models the ONE live behaviour that broke OTP in production on
 * 2026-11-09: Termii POST endpoints answer 401 "A valid API key is required"
 * when `api_key` is only in the query string, and accept it in the JSON body.
 * Every other detail (the full send-token contract, the digits-only number,
 * `country_code` on the number-insight call) is pinned here too, so a future
 * "cleanup" cannot quietly re-break sign-in — OTP is the only login path.
 *
 * No network is touched; no key value appears in a failure message.
 */
import * as termii from './termii.mjs';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const envSave = { ...process.env };
const MANAGED = ['TERMII_API_KEY', 'TERMII_BASE_URL', 'TERMII_SENDER_ID', 'TERMII_OTP_CHANNEL',
  'TERMII_DEFAULT_COUNTRY_CODE'];
function env(set = {}) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, set);
}
function envReset() {
  for (const k of MANAGED) delete process.env[k];
  for (const k of Object.keys(envSave)) process.env[k] = envSave[k];
}

const KEY = 'tl_test_key_value';
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const text = (status, body) => new Response(body, { status });

/** Print a captured request without ever echoing the key value. */
function redact(call) {
  if (!call) return 'no call';
  const body = call.body ? { ...call.body, api_key: call.body.api_key ? '***' : undefined } : null;
  return `${call.method} ${call.path} ${JSON.stringify(body)}`;
}

/**
 * Installs a fetch stub and returns the call log.
 * handler({ path, method, query, body, call }) -> Response
 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    const call = {
      url: String(url),
      path: u.pathname.replace(/^\/api\//, ''),
      method,
      query: Object.fromEntries(u.searchParams),
      body,
      headers: init.headers || {},
    };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

/** The live auth rule: a write is authenticated by its BODY key, not the query. */
function termiiAuth(call) {
  const presented = call.method === 'GET' ? call.query.api_key : call.body?.api_key;
  return presented === KEY;
}
const unauthorized = () => json(401, { message: 'A valid API key is required' });

/* ------------------------------------------------------ case: no key at all */
async function caseUnconfigured() {
  env();
  const calls = stubFetch(() => json(200, { balance: 1 }));
  check('no key → configured() is false', termii.configured() === false);
  let err = null;
  try { await termii.balance(); } catch (e) { err = e; }
  check('no key → a call refuses instead of firing', err !== null && /TERMII_API_KEY is not configured/.test(err.message),
    err && err.message);
  check('no key → no http was fired', calls.length === 0, `calls=${calls.length}`);
}

/* --------------------------------------------- case: GET authenticates by query */
async function caseBalance() {
  env({ TERMII_API_KEY: KEY });
  const calls = stubFetch((call) => (termiiAuth(call)
    ? json(200, { balance: '30.0000', currency: 'NGN' })
    : unauthorized()));
  const b = await termii.balance();
  check('balance → numeric balance + currency', b.balance === 30 && b.currency === 'NGN', JSON.stringify(b));
  check('balance → GET get-balance', calls.length === 1 && calls[0].method === 'GET'
    && calls[0].path === 'get-balance', redact(calls[0]));
  check('balance → key travels in the query, no body', calls[0].query.api_key === KEY && calls[0].body === null,
    `body=${calls[0].body}`);
  envReset();
}

/* --------------------------------- case: sendOtp carries the full documented contract */
async function caseSendOtpContract() {
  env({ TERMII_API_KEY: KEY });
  const calls = stubFetch((call) => (termiiAuth(call)
    ? json(200, { pin_id: 'PIN-1' })
    : unauthorized()));                                    // strict, live-accurate stub

  const r = await termii.sendOtp({ to: '+234 803 000 1733', pin: '7319' });
  check('sendOtp → succeeds against a body-key-only API', r.pinId === 'PIN-1', JSON.stringify(r));
  check('sendOtp → returns the 5-minute ttl', r.expiresInMinutes === 5, String(r.expiresInMinutes));

  const c = calls[0];
  check('sendOtp → POST sms/otp/send', c && c.method === 'POST' && c.path === 'sms/otp/send', redact(c));
  check('sendOtp → api_key in the JSON body (the production bug)', c && c.body.api_key === KEY, redact(c));
  check('sendOtp → recipient is bare international digits', c && c.body.to === '2348030001733', c && c.body.to);
  check('sendOtp → message_type NUMERIC', c && c.body.message_type === 'NUMERIC', c && c.body.message_type);
  check('sendOtp → default sender id', c && c.body.from === 'Promota', c && c.body.from);
  check('sendOtp → dnd channel by default', c && c.body.channel === 'dnd', c && c.body.channel);
  check('sendOtp → pin_attempts 3', c && c.body.pin_attempts === 3, String(c && c.body.pin_attempts));
  check('sendOtp → pin_time_to_live 5', c && c.body.pin_time_to_live === 5, String(c && c.body.pin_time_to_live));
  check('sendOtp → pin_length matches the 4-digit seed', c && c.body.pin_length === 4, String(c && c.body.pin_length));
  check('sendOtp → placeholder matches pin_length', c && c.body.pin_placeholder === '< 1111 >',
    c && c.body.pin_placeholder);
  check('sendOtp → the caller-generated pin is sent', c && c.body.pin === '7319', c && c.body.pin);
  check('sendOtp → message text carries the placeholder',
    c && /< 1111 >/.test(c.body.message_text) && /5 minutes/.test(c.body.message_text), c && c.body.message_text);
  check('sendOtp → pin_type NUMERIC', c && c.body.pin_type === 'NUMERIC', c && c.body.pin_type);
  envReset();
}

/* ------------------------------------------------- case: env overrides + fallbacks */
async function caseSendOtpOverrides() {
  env({ TERMII_API_KEY: KEY, TERMII_SENDER_ID: 'PromotaLive', TERMII_OTP_CHANNEL: 'whatsapp' });
  const calls = stubFetch((call) => (termiiAuth(call)
    ? json(200, { pin_id_str: 'PIN-STR' })
    : unauthorized()));
  const r = await termii.sendOtp({ to: '08030001733', pin: '000000' });
  check('sendOtp → pin_id_str is accepted', r.pinId === 'PIN-STR', JSON.stringify(r));
  check('sendOtp → env sender id wins', calls[0].body.from === 'PromotaLive', calls[0].body.from);
  check('sendOtp → env channel wins', calls[0].body.channel === 'whatsapp', calls[0].body.channel);
  check('sendOtp → a 6-digit pin sets pin_length 6', calls[0].body.pin_length === 6,
    String(calls[0].body.pin_length));
  check('sendOtp → placeholder tracks 6 digits', calls[0].body.pin_placeholder === '< 111111 >',
    calls[0].body.pin_placeholder);

  // An unrecognised seed must not invent a length Termii would reject.
  calls.length = 0;
  const r2 = await termii.sendOtp({ to: '0803', pin: 'ab' });
  check('sendOtp → no usable pin falls back to pin_length 4', calls[0].body.pin_length === 4,
    String(calls[0].body.pin_length));
  check('sendOtp → no digits means no pin field', calls[0].body.pin === undefined, String(calls[0].body.pin));
  check('sendOtp → pin_id fallback chain still resolves', r2.pinId === 'PIN-STR', JSON.stringify(r2));
  envReset();
}

/* ---------------------------------------- case: a 2xx with no pin_id is a failure */
async function caseSendOtpNoPinId() {
  env({ TERMII_API_KEY: KEY });
  stubFetch(() => json(200, { message: 'ok' }));
  let err = null;
  try { await termii.sendOtp({ to: '+2348030001733', pin: '1234' }); } catch (e) { err = e; }
  check('sendOtp → 2xx without pin_id throws (cannot ever verify)', err !== null
    && /no pin_id/.test(err.message), err && err.message);
  envReset();
}

/* ------------------------------------------------------ case: verify semantics */
async function caseVerify() {
  env({ TERMII_API_KEY: KEY });

  const calls = stubFetch((call) => {
    if (!termiiAuth(call)) return unauthorized();
    return json(200, { pin_id: call.body.pin_id, status: call.body.pin === '1111' ? 'SUCCESS' : 'INVALID' });
  });
  check('verify → SUCCESS resolves true', await termii.verifyOtp({ pinId: 'P-1', pin: '1111' }) === true);
  check('verify → INVALID resolves false, not an error',
    await termii.verifyOtp({ pinId: 'P-1', pin: '2222' }) === false);
  const v = calls[0];
  check('verify → POST api_key + pin_id + pin', v && v.method === 'POST' && v.path === 'sms/otp/verify'
    && v.body.api_key === KEY && v.body.pin_id === 'P-1' && v.body.pin === '1111', redact(v));

  // Termii reports an unknown/expired token as a 4xx. That is "no", not "down".
  stubFetch(() => json(404, { message: 'Token not found' }));
  check('verify → 404 Token not found resolves false',
    await termii.verifyOtp({ pinId: 'P-9', pin: '1234' }) === false);

  stubFetch(() => json(400, { message: 'Token expired' }));
  check('verify → expired token resolves false',
    await termii.verifyOtp({ pinId: 'P-9', pin: '1234' }) === false);

  // An auth/outage fault must NOT be swallowed as "wrong PIN" — that is how a
  // broken key became a silent sign-in failure before.
  stubFetch(() => unauthorized());
  let authErr = null;
  try { await termii.verifyOtp({ pinId: 'P-1', pin: '1111' }); } catch (e) { authErr = e; }
  check('verify → 401 auth fault throws (never a silent false)', authErr !== null
    && /A valid API key is required/.test(authErr.message), authErr && authErr.message);

  stubFetch(() => json(500, { message: 'upstream boom' }));
  let outageErr = null;
  try { await termii.verifyOtp({ pinId: 'P-1', pin: '1111' }); } catch (e) { outageErr = e; }
  check('verify → 5xx outage throws', outageErr !== null && /upstream boom/.test(outageErr.message),
    outageErr && outageErr.message);

  stubFetch(() => json(200, { verified: true }));
  check('verify → { verified:true } also resolves true',
    await termii.verifyOtp({ pinId: 'P-1', pin: '1111' }) === true);
  envReset();
}

/* ------------------------------------------------- case: number intelligence */
async function caseLookupNumber() {
  env({ TERMII_API_KEY: KEY });
  let calls = stubFetch(() => json(200, { operator: 'MTN Nigeria' }));
  check('lookup → MTN mapped', (await termii.lookupNumber('+2348030001733')).network === 'MTN');
  check('lookup → phone_number in the query', calls[0].query.phone_number === '+2348030001733',
    calls[0].query.phone_number);
  check('lookup → country_code defaults to NG', calls[0].query.country_code === 'NG',
    String(calls[0].query.country_code));

  env({ TERMII_API_KEY: KEY, TERMII_DEFAULT_COUNTRY_CODE: 'GH' });
  calls = stubFetch(() => json(200, { data: { carrier: 'GLO' } }));
  const g = await termii.lookupNumber('+2338030001733');
  check('lookup → country_code env override is sent', calls[0].query.country_code === 'GH',
    String(calls[0].query.country_code));
  check('lookup → nested carrier mapped', g.network === 'GLO', JSON.stringify(g));

  stubFetch(() => json(200, { operator: 'Airtel Nigeria' }));
  check('lookup → AIRTEL mapped', (await termii.lookupNumber('+2348030001733')).network === 'AIRTEL');

  stubFetch(() => json(200, { operator: 'Smile Comms' }));
  const unk = await termii.lookupNumber('+2348030001733');
  check('lookup → unknown operator keeps the raw name', unk.network === null && unk.raw === 'SMILE COMMS',
    JSON.stringify(unk));

  stubFetch(() => { throw new TypeError('fetch failed'); });
  check('lookup → a network fault never blocks signup',
    JSON.stringify(await termii.lookupNumber('+2348030001733')) === '{"network":null}');
  envReset();
}

/* ----------------------------------------------------------- case: plain SMS */
async function caseSendSms() {
  env({ TERMII_API_KEY: KEY });
  const calls = stubFetch((call) => (termiiAuth(call)
    ? json(200, { message_id_str: 'MSG-7', balance: 24.5 })
    : unauthorized()));
  const r = await termii.sendSms({ to: '+234 803 000 1733', message: 'Your data is on the way.' });
  check('sendSms → message id returned', r.messageId === 'MSG-7', JSON.stringify(r));
  const c = calls[0];
  check('sendSms → POST sms/send', c && c.method === 'POST' && c.path === 'sms/send', redact(c));
  check('sendSms → api_key in the body', c && c.body.api_key === KEY, redact(c));
  check('sendSms → recipient is bare international digits', c && c.body.to === '2348030001733', c && c.body.to);
  check('sendSms → plain generic contract', c && c.body.type === 'plain' && c.body.channel === 'generic'
    && c.body.sms === 'Your data is on the way.' && c.body.from === 'Promota', redact(c));
  envReset();
}

/* --------------------------------- case: errors are honest and never leak the key */
async function caseErrorSurface() {
  env({ TERMII_API_KEY: KEY });
  stubFetch(() => json(400, { message: 'Invalid sender id' }));
  let err = null;
  try { await termii.sendSms({ to: '+2348030001733', message: 'hi' }); } catch (e) { err = e; }
  check('error → names the route and the provider message', err !== null
    && err.message === 'termii sms/send: Invalid sender id', err && err.message);
  check('error → never echoes the api key', err !== null && !err.message.includes(KEY), 'key leaked');

  stubFetch(() => text(502, '<!-- gateway -->'));
  let raw = null;
  try { await termii.balance(); } catch (e) { raw = e; }
  check('error → a non-JSON body still yields a message', raw !== null && /^termii get-balance: /.test(raw.message),
    raw && raw.message);
  check('error → the query-string key is not in the message', raw !== null && !raw.message.includes(KEY));

  envReset();
}

/* ----------------------------------------- case: the stub actually models the bug
   If this case ever fails, the OTP cases above stopped proving anything: the
   live API rejects a POST whose key is only in the query string. */
async function caseStubModelsLiveRule() {
  const calls = stubFetch((call) => (termiiAuth(call) ? json(200, { pin_id: 'X' }) : unauthorized()));
  await fetch('https://api.ng.termii.com/api/sms/otp/send?api_key=' + KEY, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_type: 'NUMERIC' }),
  });
  const r = calls[0];
  check('stub models live auth → query-only POST is rejected', r && termiiAuth(r) === false, redact(r));
  envReset();
}

(async () => {
  try {
    await caseUnconfigured();
    await caseBalance();
    await caseSendOtpContract();
    await caseSendOtpOverrides();
    await caseSendOtpNoPinId();
    await caseVerify();
    await caseLookupNumber();
    await caseSendSms();
    await caseErrorSurface();
    await caseStubModelsLiveRule();
  } catch (e) {
    fail++;
    console.error('  FAIL  unhandled in test runner', String(e && e.stack || e).split('\n')[0]);
  }
  envReset();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
})();
