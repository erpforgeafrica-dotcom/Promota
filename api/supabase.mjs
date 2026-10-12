/**
 * supabase.mjs — PostgREST client for the API layer.
 *
 * The API is the TRUSTED path: it holds the service-role key and is the only
 * writer of money-adjacent rows. The browser never gets that key — it holds
 * the publishable key and is stopped by RLS, exactly as db/live.proof.mjs
 * proves.
 *
 * Business rules are NOT implemented here. They live in Postgres (migration
 * 0008: points_balance, level_for, redeem_points, award_task_points) so the
 * database remains the single place an invariant can be enforced and so the
 * PGlite test suite can prove them without a server. This module only moves
 * arguments and reads rows.
 */

const URL_BASE = (process.env.SUPABASE_URL || '').trim();
const SERVICE_KEY = (process.env.SUPABASE_SECRET_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

export function configured() {
  return Boolean(URL_BASE && SERVICE_KEY);
}

export function isConfigured() {
  return configured();
}

function require_() {
  if (!URL_BASE) throw new Error('SUPABASE_URL is not configured');
  if (!SERVICE_KEY) throw new Error('SUPABASE_SECRET_KEY (service role) is not configured');
}

function headers(extra = {}) {
  require_();
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'content-type': 'application/json',
    ...extra,
  };
}

/** POST an RPC. Returns the parsed body; throws with the server's own message. */
export async function rpc(fn, params = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body?.message || body?.hint || body || `HTTP ${res.status}`;
    throw new Error(`${fn}: ${String(msg).slice(0, 300)}`);
  }
  return body;
}

/** GET rows from a table. `query` is the PostgREST querystring. */
export async function select(table, query = '') {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}${query ? `?${query}` : ''}`, {
    method: 'GET',
    headers: headers(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* keep text */ }
    throw new Error(`${table}: ${String(msg).slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : [];
}

/** INSERT a row, returning the inserted rows. */
export async function insert(table, row, { returning = 'representation' } = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ Prefer: `return=${returning}` }),
    body: JSON.stringify(row),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* keep text */ }
    throw new Error(`${table} insert: ${String(msg).slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : [];
}

/** PATCH rows matching `query`. */
export async function update(table, query, patch) {
  const res = await fetch(`${URL_BASE}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* keep text */ }
    throw new Error(`${table} update: ${String(msg).slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : [];
}

/** A profile plus its level and points, in one round trip where possible. */
export async function promoterSnapshot(profileId) {
  const [profile] = await select(
    'profiles',
    `id=eq.${profileId}&select=id,display_name,phone_e164,network,state,role,kyc_tier,phone_verified_at,age_verified_at`
  );
  if (!profile) return null;

  const [balance, level, cashOk, referrals] = await Promise.all([
    rpc('points_balance', { p_profile: profileId }),
    rpc('level_for', { p_profile: profileId }),
    rpc('cash_unlocked', { p_profile: profileId }),
    rpc('qualified_referral_count', { p_profile: profileId }),
  ]);

  const nextRows = await select(
    'levels',
    `level=gt.${Number(level) || 1}&order=level.asc&limit=1`
  );

  return {
    profile: {
      id: profile.id,
      displayName: profile.display_name,
      phone: profile.phone_e164,
      network: profile.network,
      state: profile.state,
      role: profile.role,
      kycTier: profile.kyc_tier,
      phoneVerified: Boolean(profile.phone_verified_at),
      ageVerified: Boolean(profile.age_verified_at),
    },
    points: Number(balance ?? 0),
    level: Number(level ?? 1),
    cashUnlocked: cashOk === true,
    qualifiedReferrals: Number(referrals ?? 0),
    nextLevel: nextRows[0]
      ? {
          level: nextRows[0].level,
          label: nextRows[0].label,
          pointsRequired: nextRows[0].points_required,
          minReferrals: nextRows[0].min_referrals,
          pointsNeeded: Math.max(0, nextRows[0].points_required - Number(balance ?? 0)),
          referralsNeeded: Math.max(0, nextRows[0].min_referrals - Number(referrals ?? 0)),
        }
      : null,
  };
}