/**
 * payoutCrypto.mjs — real AES-256-GCM encryption for payout account details.
 *
 * WHY THIS FILE EXISTS
 * db/migrations/0016_money_flows.sql stores a promoter's bank account number
 * as ciphertext, and the UI promises "your account number is encrypted on our
 * side and never shown back to you". Until now that promise was DOCUMENTATION
 * ONLY: there was no cipher anywhere in the repo, so any writer would have had
 * to store the clear number and call it encrypted. This module is the missing
 * half — the ciphertext column now has a real producer.
 *
 * FORMAT
 *   v1.<iv_b64>.<tag_b64>.<ciphertext_b64>
 * The version prefix lets a future scheme change be detected instead of
 * silently mis-decrypting. GCM's auth tag is stored, so a tampered row fails
 * to decrypt rather than returning garbage.
 *
 * KEY HANDLING
 *   Primary   : PAYOUT_ENCRYPTION_KEY (64 hex chars, or base64 of 32 bytes).
 *   Fallback  : HKDF-SHA256 derived from SESSION_SECRET, with a fixed salt and
 *               an application-specific info string. This exists so the
 *               feature works on a fresh deploy with no extra configuration,
 *               while keeping the key in a separate HKDF "slot" rather than
 *               reusing the session key directly.
 *   The key never leaves this module and is never logged.
 *
 * FAIL-CLOSED
 *   If no key material is available, configured() is false and the API refuses
 *   to store an account rather than storing it in the clear.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';
const HKDF_SALT = 'promota/payout-account/v1';
const HKDF_INFO = 'aes-256-gcm-key';

/* --------------------------------------------------------------- key material */

let cachedKey = null;
let cachedSource = null;

/** Interpret an env-supplied key as exactly 32 bytes. null when unusable. */
function keyFromEnv(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  try {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
  } catch { /* not base64 */ }
  return null;
}

function resolveKey() {
  if (cachedKey) return cachedKey;
  const direct = keyFromEnv(process.env.PAYOUT_ENCRYPTION_KEY);
  if (direct) {
    cachedKey = direct;
    cachedSource = 'PAYOUT_ENCRYPTION_KEY';
    return cachedKey;
  }
  const session = String(process.env.SESSION_SECRET || '').trim();
  if (session.length >= 16) {
    cachedKey = Buffer.from(hkdfSync('sha256', Buffer.from(session, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), 32));
    cachedSource = 'hkdf(session_secret)';
    return cachedKey;
  }
  return null;
}

/** True when account details can be encrypted. False => the API refuses to store. */
export function configured() {
  return Boolean(resolveKey());
}

/** Where the key came from. Safe to expose on /healthz (no key material). */
export function keySource() {
  resolveKey();
  return cachedSource;
}

/** Test hook: drop the cached key so a new env value is picked up. */
export function resetKeyCache() {
  cachedKey = null;
  cachedSource = null;
}

/* ------------------------------------------------------------------ envelope */

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(String(s), 'base64');

/**
 * Encrypt a string. Returns the versioned envelope. Throws when no key is
 * available — the caller must never fall back to storing plaintext.
 */
export function encrypt(plaintext) {
  const key = resolveKey();
  if (!key) throw new Error('payout encryption is not configured');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${b64(iv)}.${b64(tag)}.${b64(body)}`;
}

/**
 * Decrypt an envelope. Throws on a malformed, tampered or wrong-key payload:
 * a silent empty string would look like "no account number on file" and hide
 * a real decryption failure.
 */
export function decrypt(envelope) {
  const key = resolveKey();
  if (!key) throw new Error('payout encryption is not configured');
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('payout ciphertext is malformed');
  }
  const iv = unb64(parts[1]);
  const tag = unb64(parts[2]);
  const body = unb64(parts[3]);
  if (iv.length !== IV_BYTES) throw new Error('payout ciphertext is malformed');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(body), decipher.final()]);
  return out.toString('utf8');
}

/**
 * Last four digits, for display only. This is deliberately NOT derived from
 * the ciphertext — it is stored in the clear on the row so the promoter can
 * recognise their own account without the server decrypting on every read.
 */
export function last4(accountNumber) {
  const s = String(accountNumber || '').replace(/\D/g, '');
  return s.length >= 4 ? s.slice(-4) : '';
}

/** Constant-time compare for short secrets (e.g. a resolved account name). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}
