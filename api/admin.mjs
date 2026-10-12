/**
 * admin.mjs — the small amount of privileged server work the API must do.
 *
 * Split out of routes.mjs so the one operation that mints auth.users (and
 * therefore needs the service role against Supabase's auth schema) is obvious
 * in review rather than buried in a handler.
 *
 * Only ONE function here creates a user, and it is only reachable from a
 * verified Termii OTP. There is no password path and no email path.
 */

const AUTH_URL = (process.env.SUPABASE_URL || '').trim();
const SERVICE_KEY = (process.env.SUPABASE_SECRET_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

async function adminPost(path, body) {
  if (!AUTH_URL || !SERVICE_KEY) throw new Error('Supabase admin credentials are not configured');
  const res = await fetch(`${AUTH_URL}/auth/v1/admin/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = json?.msg || json?.message || json?.error_description || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`auth admin ${path}: ${msg}`);
  }
  return json;
}

/**
 * Create an auth user keyed by phone, plus the matching profiles row.
 * The profile is created 'active' because reaching here means the owner proved
 * control of the number by OTP. age_verified_at stays null: 18+ is a separate
 * gate that cash redemption enforces.
 */
export async function createUser({ userId, phoneE164, network = null }) {
  const created = await adminPost('users', {
    id: userId,
    // Supabase requires a unique identity field; the phone IS the identity here.
    phone: phoneE164,
    email: undefined,
    phone_confirm: true,          // already proven by Termii OTP
    email_confirm: false,
    user_metadata: { signup: 'phone_otp', network },
  });

  const id = created?.id || userId;

  const url = `${AUTH_URL}/rest/v1/profiles`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      id,
      role: 'promoter',
      state: 'active',
      phone_e164: phoneE164,
      phone_verified_at: new Date().toISOString(),
      network,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* keep */ }
    throw new Error(`profile insert: ${String(msg).slice(0, 200)}`);
  }

  return id;
}