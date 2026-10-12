/**
 * providers.smoke.mjs — live credential + adapter contract check.
 *
 * Read-only by default. It never sends an SMS, never moves money and never
 * delivers a bundle. What it proves:
 *   - each adapter is wired with a working credential
 *   - each adapter's real response shape matches what the code expects
 *   - the data adapter refuses honestly instead of faking a delivery
 *
 * Run: node providers.smoke.mjs
 * Live-SENDING checks only run when LIVE_SEND=1 is set explicitly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as termii from './termii.mjs';
import * as flw from './flutterwave.mjs';
import * as data from './data.mjs';

// adapters read process.env; load .env without printing any secret
try {
  const env = readFileSync(join(process.cwd(), '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^"|"$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* no .env — rely on ambient environment */ }

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

console.log('provider smoke (read-only)\n');

/* ------------------------------------------------------------------ termii */
check('termii adapter sees a configured key', termii.configured());
if (termii.configured()) {
  try {
    const b = await termii.balance();
    check('termii get-balance returns a numeric NGN balance',
      Number.isFinite(b.balance) && b.currency === 'NGN',
      JSON.stringify(b));
  } catch (e) {
    check('termii get-balance succeeds', false, String(e.message));
  }

  try {
    const n = await termii.lookupNumber('2348030000000');
    check('termii number lookup resolves without throwing', true, JSON.stringify(n));
  } catch (e) {
    check('termii number lookup resolves without throwing', false, String(e.message));
  }
}

/* ------------------------------------------------------------- flutterwave */
check('flutterwave adapter sees a configured secret', flw.configured());
if (flw.configured()) {
  try {
    // transfer id 1 does not exist; a JSON body (not a 401) proves auth works
    await flw.verifyTransfer(1);
    check('flutterwave authenticated a transfers lookup', true);
  } catch (e) {
    const m = String(e.message);
    const authed = /not found/i.test(m);
    check('flutterwave authenticated a transfers lookup', authed, m);
  }

  try {
    const b = await flw.banks('NG');
    check('flutterwave returns Nigerian bank codes',
      Array.isArray(b) && b.length > 0 && typeof b[0]?.code === 'string',
      `count=${Array.isArray(b) ? b.length : 'n/a'}`);
  } catch (e) {
    check('flutterwave returns Nigerian bank codes', false, String(e.message));
  }
}

/* -------------------------------------------------------------------- data */
{
  const s = data.status();
  check('data adapter reports a readiness state', typeof s.ready === 'boolean', JSON.stringify(s));
  if (!s.ready) {
    check('data adapter explains why it cannot deliver', typeof s.reason === 'string' && s.reason.length > 20);
    const d = await data.deliver({ network: 'MTN', phone: '08030000000', planCode: '1GB', reference: 'smoke-1' });
    check('data adapter REFUSES instead of faking a delivery', d.ok === false, JSON.stringify(d));
    check('the refusal is not silently retryable forever', d.retryable === false);
  } else {
    check('data adapter is configured', true, JSON.stringify(s));
  }
}

/* -------------------------------------------------------------- signatures */
{
  const secret = (process.env.FLUTTERWAVE_WEBHOOK_SECRET || '').trim();
  if (secret) {
    check('webhook rejects a missing verif-hash header',
      flw.verifyWebhookSignature('{}', '').ok === false);
    check('webhook rejects a wrong verif-hash',
      flw.verifyWebhookSignature('{}', 'wrong-hash').ok === false);
    check('webhook accepts the correct verif-hash',
      flw.verifyWebhookSignature('{}', secret).ok === true);
  } else {
    console.log('  SKIP  webhook signature checks (FLUTTERWAVE_WEBHOOK_SECRET unset)');
  }
}

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
console.log(`  PROVIDER SMOKE: ${fail === 0 ? 'ALL HOLD' : 'ATTENTION'}`);
process.exit(fail === 0 ? 0 : 1);