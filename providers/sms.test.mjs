#!/usr/bin/env node
/**
 * sms.test.mjs — the provider switch that the OTP route depends on.
 *
 * The route table calls `providers/sms.mjs` and never a vendor adapter, so the
 * selection rules are launch-critical: choosing the wrong adapter (or silently
 * choosing "none") changes which vendor sends the login code. These cases pin
 * the precedence, the loud refusal when nothing is configured, and the fact
 * that carrier lookup stays best-effort rather than blocking a signup.
 *
 * Small on purpose — the vendor contracts are pinned in
 * providers/bulksms.test.mjs and providers/termii.test.mjs.
 */
import * as sms from './sms.mjs';
import * as bulksms from './bulksms.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const envSave = { ...process.env };
const MANAGED = ['BULKSMS_API_TOKEN', 'BULKSMS_API_KEY', 'BULKSMS_BASE_URL', 'BULKSMS_SANDBOX',
  'BULKSMS_SENDER_ID', 'BULKSMS_OTP_GATEWAY', 'BULKSMS_OTP_TTL_SECONDS', 'OTP_SECRET', 'SESSION_SECRET',
  'SMS_PROVIDER', 'TERMII_API_KEY', 'TERMII_BASE_URL', 'TERMII_SENDER_ID'];
function env(set = {}) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, set);
}
function envReset() {
  for (const k of MANAGED) delete process.env[k];
  for (const k of Object.keys(envSave)) process.env[k] = envSave[k];
}

const BS = 'bsn_test_token_value';
const TM = 'tl_test_key_value';
const SECRET = 'otp-test-secret-not-a-real-one';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});
const sentOk = () => json(200, {
  status: 'success', code: 'BSNG-0000',
  data: { message_id: 'MSG-1', cost: 4.99, currency: 'NGN', recipients_count: 1, gateway_used: 'direct-refund' },
});

/** Capture the URL of every fetch so the selected vendor is observable. */
function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return sentOk();
  };
  return calls;
}

/* ------------------------------------------------------- case: nothing configured */
function caseNone() {
  env();
  check('no credentials → provider() is "none"', sms.provider() === 'none', sms.provider());
  check('no credentials → configured() is false', sms.configured() === false);
  let err = null;
  try { sms.sendSms({ to: '08030001733', message: 'hi' }); } catch (e) { err = e; }
  check('no credentials → a send refuses with an actionable message', err !== null
    && /no SMS provider is configured/.test(err.message), err && err.message);
  check('no credentials → the message names both env vars', err !== null
    && /BULKSMS_API_TOKEN/.test(err.message) && /TERMII_API_KEY/.test(err.message), err && err.message);
}

/* ---------------------------------------------------------- case: precedence rules */
async function casePrecedence() {
  env({ BULKSMS_API_TOKEN: BS });
  check('BulkSMS token only → bulksms is selected', sms.provider() === 'bulksms', sms.provider());

  env({ TERMII_API_KEY: TM });
  check('Termii key only → termii is selected', sms.provider() === 'termii', sms.provider());

  // Both present: BulkSMS wins — it is the owner-selected provider, and a stray
  // TERMII_API_KEY left over from the old setup must not hijack sign-in.
  env({ BULKSMS_API_TOKEN: BS, TERMII_API_KEY: TM });
  check('both configured → bulksms wins by default', sms.provider() === 'bulksms', sms.provider());

  env({ BULKSMS_API_TOKEN: BS, TERMII_API_KEY: TM, SMS_PROVIDER: 'termii' });
  check('SMS_PROVIDER=termii is an explicit rollback', sms.provider() === 'termii', sms.provider());

  env({ SMS_PROVIDER: 'bulksms' });
  check('SMS_PROVIDER=bulksms with no token is chosen but NOT configured',
    sms.provider() === 'bulksms' && sms.configured() === false, `${sms.provider()}/${sms.configured()}`);
  let forcedErr = null;
  try { await sms.sendSms({ to: '08030001733', message: 'hi' }); } catch (e) { forcedErr = e; }
  check('a forced but credential-less provider still refuses', forcedErr !== null
    && /BULKSMS_API_TOKEN is not configured/.test(forcedErr.message), forcedErr && forcedErr.message);

  env({ BULKSMS_API_TOKEN: BS, SMS_PROVIDER: 'BulkSMS' });
  check('SMS_PROVIDER is case-insensitive', sms.provider() === 'bulksms', sms.provider());

  env({ BULKSMS_API_TOKEN: BS, SMS_PROVIDER: 'twilio' });
  check('an unknown SMS_PROVIDER falls back to auto-detection', sms.provider() === 'bulksms', sms.provider());
}

/* ------------------------------------------------- case: calls reach the chosen vendor */
async function caseRouting() {
  env({ BULKSMS_API_TOKEN: BS });
  let calls = stubFetch();
  await sms.sendSms({ to: '08030001733', message: 'routed' });
  check('bulksms selected → the request goes to bulksmsnigeria',
    calls.length === 1 && /bulksmsnigeria\.com/.test(calls[0].url), calls[0] && calls[0].url);

  env({ TERMII_API_KEY: TM });
  calls = stubFetch();
  await sms.sendSms({ to: '08030001733', message: 'routed' });
  check('termii selected → the request goes to termii',
    calls.length === 1 && /termii\.com/.test(calls[0].url), calls[0] && calls[0].url);
  envReset();
}

/* ------------------------------------------- case: OTP keeps the route contract */
async function caseOtpContract() {
  env({ BULKSMS_API_TOKEN: BS, OTP_SECRET: SECRET });
  stubFetch();
  const r = await sms.sendOtp({ to: '08030001733', pin: '7319' });
  check('facade sendOtp → still returns pinId (the route and the browser rely on it)',
    typeof r.pinId === 'string' && r.pinId.startsWith('bs1.'), String(r.pinId).slice(0, 12));
  check('facade verifyOtp → accepts the pinId it just issued',
    await sms.verifyOtp({ pinId: r.pinId, pin: '7319', to: '2348030001733' }) === true);
  const second = await sms.sendOtp({ to: '08030001733', pin: '7319' });
  check('facade verifyOtp → refuses a wrong pin',
    await sms.verifyOtp({ pinId: second.pinId, pin: '0000', to: '2348030001733' }) === false);
  envReset();
}

/* ------------------------------------------------------- case: carrier lookup */
async function caseLookup() {
  env({ BULKSMS_API_TOKEN: BS });
  let calls = stubFetch();
  const noCarrier = await sms.lookupNumber('+2348030001733');
  check('lookup → BulkSMS alone yields no carrier, never a guess',
    JSON.stringify(noCarrier) === '{"network":null}', JSON.stringify(noCarrier));
  check('lookup → no request is sent when there is no lookup adapter', calls.length === 0, `calls=${calls.length}`);

  env({ BULKSMS_API_TOKEN: BS, TERMII_API_KEY: TM });
  calls = stubFetch();
  const t = await sms.lookupNumber('+2348030001733');
  check('lookup → Termii supplies the carrier when present', t && 'network' in t, JSON.stringify(t));
  check('lookup → the lookup went to Termii, not BulkSMS',
    calls.every((c) => /termii\.com/.test(c.url)), calls.map((c) => c.url).join(' | '));
  envReset();
}

/* ------------------------------------ case: the facade never leaks the credential */
async function caseNoLeak() {
  env({ BULKSMS_API_TOKEN: BS });
  stubFetch();
  const r = await sms.sendSms({ to: '08030001733', message: 'hi' });
  check('result object carries no credential', !JSON.stringify(r).includes(BS), JSON.stringify(r));
  check('provider() exposes only the vendor name', sms.provider() === 'bulksms', sms.provider());
  envReset();
}

/* -------------------------------- case: nobody bypasses the switch (static gate) */
/**
 * The whole point of this module is that a provider swap is ONE env change.
 * That promise is only true while nothing imports a vendor adapter directly,
 * so the invariant is checked here rather than trusted to review.
 *
 * Found this way for real: `api/worker.mjs` still sent notification SMS through
 * `termii.sendSms`, so switching to BulkSMS would have moved sign-in while the
 * outbox kept billing the old vendor.
 *
 * Exempt by design: the facade itself; the two adapters; the per-vendor live
 * smoke/proof scripts whose entire purpose is to exercise ONE vendor's
 * contract; and the `*.test.mjs` files that necessarily test each adapter in
 * isolation.
 */
function caseNoDirectVendorImports() {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const SCAN_DIRS = ['api', 'providers', 'scripts', '.'];
  const VENDOR_IMPORT = /from\s+['"][^'"]*\/(?:termii|bulksms)\.mjs['"]/;
  const EXEMPT = new Set([
    'providers/sms.mjs', 'providers/termii.mjs', 'providers/bulksms.mjs',
    'providers/providers.smoke.mjs', 'scripts/proof-bulksms.mjs',
  ]);

  const offenders = [];
  let scanned = 0;
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    let entries = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
      const rel = (dir === '.' ? e.name : `${dir}/${e.name}`).replace(/\\/g, '/');
      if (EXEMPT.has(rel) || rel.endsWith('.test.mjs')) continue;
      scanned++;
      const src = readFileSync(path.join(abs, e.name), 'utf8');
      if (VENDOR_IMPORT.test(src)) offenders.push(rel);
    }
  }

  check('the vendor-import scan actually looked at source files', scanned > 10, `scanned ${scanned}`);
  check('no module imports a vendor SMS adapter directly (everything goes through sms.mjs)',
    offenders.length === 0, offenders.join(', '));
}

(async () => {
  try {
    caseNone();
    await casePrecedence();
    await caseRouting();
    await caseOtpContract();
    await caseLookup();
    await caseNoLeak();
    caseNoDirectVendorImports();
  } catch (e) {
    fail++;
    console.error('  FAIL  unhandled in test runner', String(e && e.stack || e).split('\n')[0]);
  }
  envReset();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
})();
