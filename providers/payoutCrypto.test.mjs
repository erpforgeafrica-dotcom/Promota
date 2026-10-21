#!/usr/bin/env node
/**
 * payoutCrypto.test.mjs — tests for the AES-256-GCM envelope.
 *
 * The migration promised "AES-256-GCM ciphertext, produced by the app layer"
 * while the repo contained no cipher at all. This file proves the promise is
 * now backed by code, and — more importantly — that the module FAILS CLOSED:
 * with no key material it refuses to encrypt rather than storing plaintext.
 *
 * No real key is used and no ciphertext is printed.
 */
import * as crypto from './payoutCrypto.mjs';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const envSave = { ...process.env };
function envReset() {
  for (const k of Object.keys(envSave)) process.env[k] = envSave[k];
  for (const k of ['PAYOUT_ENCRYPTION_KEY', 'SESSION_SECRET']) delete process.env[k];
  crypto.resetKeyCache();
}

/* ------------------------------------------------------ with a dedicated key */
function caseDedicatedKey() {
  envReset();
  process.env.PAYOUT_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes, hex
  crypto.resetKeyCache();

  check('a configured key reports configured', crypto.configured() === true);
  check('the key source is the dedicated variable',
    crypto.keySource() === 'PAYOUT_ENCRYPTION_KEY', crypto.keySource());

  const plain = '0123456789';
  const sealed = crypto.encrypt(plain);
  check('the envelope carries a version prefix', String(sealed).startsWith('v1.'), String(sealed).slice(0, 8));
  check('the envelope has four parts', String(sealed).split('.').length === 4);
  check('the clear number is not in the envelope', !String(sealed).includes(plain));

  const opened = crypto.decrypt(sealed);
  check('the round trip returns the original', opened === plain);

  // A different key must NOT open the envelope.
  process.env.PAYOUT_ENCRYPTION_KEY = 'b'.repeat(64);
  crypto.resetKeyCache();
  let threw = false;
  try { crypto.decrypt(sealed); } catch { threw = true; }
  check('a different key cannot decrypt', threw === true);
}

/* ---------------------------------------------------------- tamper detection */
function caseTamper() {
  envReset();
  process.env.PAYOUT_ENCRYPTION_KEY = 'c'.repeat(64);
  crypto.resetKeyCache();

  const sealed = crypto.encrypt('0123456789');
  const parts = sealed.split('.');

  // Flip a byte of the ciphertext body.
  const body = Buffer.from(parts[3], 'base64');
  body[0] = body[0] ^ 0xff;
  const tampered = [parts[0], parts[1], parts[2], body.toString('base64')].join('.');
  let threw = false;
  try { crypto.decrypt(tampered); } catch { threw = true; }
  check('a tampered body fails to decrypt', threw === true);

  // A malformed envelope must fail loudly, not return an empty string.
  threw = false;
  try { crypto.decrypt('not-an-envelope'); } catch { threw = true; }
  check('a malformed envelope fails loudly', threw === true);

  threw = false;
  try { crypto.decrypt(''); } catch { threw = true; }
  check('an empty envelope fails loudly', threw === true);
}

/* ------------------------------------------------------- the HKDF fallback */
function caseFallback() {
  envReset();
  delete process.env.PAYOUT_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = 'a-session-secret-long-enough-to-use';
  crypto.resetKeyCache();

  check('the fallback key makes the module configured', crypto.configured() === true);
  check('the fallback key source is reported', crypto.keySource() === 'hkdf(session_secret)',
    crypto.keySource());

  const sealed = crypto.encrypt('0123456789');
  check('the fallback encrypts and decrypts', crypto.decrypt(sealed) === '0123456789');

  // A different session secret must not open it.
  process.env.SESSION_SECRET = 'a-different-session-secret-entirely!!';
  crypto.resetKeyCache();
  let threw = false;
  try { crypto.decrypt(sealed); } catch { threw = true; }
  check('a rotated session secret cannot decrypt', threw === true);
}

/* ------------------------------------------------------------- fails closed */
function caseFailsClosed() {
  envReset();
  delete process.env.PAYOUT_ENCRYPTION_KEY;
  delete process.env.SESSION_SECRET;
  crypto.resetKeyCache();

  check('with no key the module is not configured', crypto.configured() === false);

  let threw = false;
  try { crypto.encrypt('0123456789'); } catch { threw = true; }
  check('with no key encryption refuses rather than storing plaintext', threw === true);

  threw = false;
  try { crypto.decrypt('v1.a.b.c'); } catch { threw = true; }
  check('with no key decryption refuses', threw === true);
}

/* -------------------------------------------------------------------- last4 */
function caseLast4() {
  check('last4 takes the final four digits', crypto.last4('0123456789') === '6789');
  check('last4 ignores formatting', crypto.last4('0123 456 789') === '6789');
  check('last4 of a short number is empty', crypto.last4('123') === '');
  check('last4 of nothing is empty', crypto.last4('') === '');
}

(async () => {
  try {
    caseDedicatedKey();
    caseTamper();
    caseFallback();
    caseFailsClosed();
    caseLast4();
  } catch (e) {
    fail++;
    console.error('  FAIL  unhandled in test runner', String(e && e.stack || e).split('\n')[0]);
  }
  envReset();
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
})();
