/**
 * sms.mjs — one switch for the SMS/OTP provider.
 *
 * The API and the admin probe talk to this module, never to a vendor adapter
 * directly, so replacing a gateway is one environment change instead of a
 * codebase-wide edit. Today there are two adapters:
 *
 *   bulksms  providers/bulksms.mjs  — BulkSMS Nigeria (current)
 *   termii   providers/termii.mjs   — retained for carrier lookup, and as a
 *                                     fallback if BulkSMS is rolled back
 *
 * Selection, in order:
 *   1. SMS_PROVIDER=bulksms | termii  (explicit, wins)
 *   2. whichever adapter has a credential configured
 *   3. none -> configured() is false and every send refuses loudly
 *
 * The two adapters agree on the public shape: `sendOtp` returns `pinId` and
 * `verifyOtp` takes `pinId` + `pin` (+ `to`, which BulkSMS binds into the
 * signed challenge and Termii ignores). That is what lets the route table and
 * the browser stay unchanged.
 */
import * as bulksms from './bulksms.mjs';
import * as termii from './termii.mjs';

/** Which provider will be used right now. */
export function provider() {
  const forced = (process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (forced === 'bulksms' || forced === 'termii') return forced;
  if (bulksms.configured()) return 'bulksms';
  if (termii.configured()) return 'termii';
  return 'none';
}

export function configured() {
  // Not merely "a provider was chosen": a forced SMS_PROVIDER with no
  // credential must read as unconfigured so the route answers 503 "not
  // configured" instead of a 502 that blames the gateway for our env.
  const p = provider();
  if (p === 'bulksms') return bulksms.configured();
  if (p === 'termii') return termii.configured();
  return false;
}

function impl() {
  const p = provider();
  if (p === 'bulksms') return bulksms;
  if (p === 'termii') return termii;
  throw new Error('no SMS provider is configured (set BULKSMS_API_TOKEN or TERMII_API_KEY)');
}

export function balance() {
  return impl().balance();
}

export function sendOtp(opts) {
  return impl().sendOtp(opts);
}

export function verifyOtp(opts) {
  return impl().verifyOtp(opts);
}

export function sendSms(opts) {
  return impl().sendSms(opts);
}

/**
 * Carrier lookup. This is NOT an SMS capability: BulkSMS Nigeria does not
 * document a number-intelligence endpoint, so Termii is used when it is
 * configured. Without it this returns { network: null } rather than guessing
 * from the number prefix — under number portability a prefix no longer proves
 * the current carrier, and data-bundle routing is a money path.
 */
export async function lookupNumber(e164) {
  if (termii.configured()) return termii.lookupNumber(e164);
  return { network: null };
}
