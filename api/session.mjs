/**
 * session.mjs — passwordless session issuance and verification.
 *
 * WHY A SIGNED TOKEN AND NOT SUPABASE AUTH
 * profiles.id references auth.users(id), so a real Supabase Auth user must
 * exist. Supabase's own phone OTP is bound to Twilio/MessageBird, not to
 * Termii, and its JWTs can only be minted with the project's JWT secret, which
 * we do not hold (we hold the secret API key, which is not the JWT secret).
 *
 * So: Termii proves the phone; this module issues a signed, expiring,
 * stateless session. It is verified on every request AND cross-checked against
 * profiles.state, so suspending or banning a user takes effect immediately
 * rather than at token expiry. That is the property that matters here — a
 * stateless token is only safe while the account-state check runs each time.
 *
 * KNOWN LIMITATION, stated not hidden: tokens cannot be revoked before expiry
 * except by changing account state or rotating SESSION_SECRET. A 12-hour
 * lifetime keeps that window small. If per-token revocation becomes necessary,
 * add a sessions table and check it here.
 *
 * Zero dependencies: HMAC-SHA256 via node:crypto.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

function secret() {
  const s = (process.env.SESSION_SECRET || '').trim();
  if (!s) throw new Error('SESSION_SECRET is not configured');
  return s;
}

export function configured() {
  return Boolean((process.env.SESSION_SECRET || '').trim());
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payloadB64) {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

/** Mint a session token for a profile. */
export function issue(profileId, { role = 'promoter' } = {}) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'PROMOTA' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64u(JSON.stringify({
    sub: profileId,
    role,
    iat: now,
    exp: now + TTL_HOURS * 3600,
    jti: randomBytes(9).toString('base64url'),
  }));
  const payload = `${header}.${body}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify signature and expiry. Returns the claims, or null.
 * Signature is compared in constant time.
 */
export function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(parts[2]);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }

  const now = Math.floor(Date.now() / 1000);
  if (!claims?.exp || claims.exp <= now) return null;
  if (!claims?.sub) return null;
  return claims;
}

/** Pull the bearer token out of an Authorization header. */
export function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return m ? m[1].trim() : null;
}

/** OTP codes are short-lived and single-use; kept out of logs and URLs. */
export function newOtp() {
  // cryptographically random, not Math.random
  const n = randomBytes(4).readUInt32BE(0) % 10000;
  return String(n).padStart(4, '0');
}