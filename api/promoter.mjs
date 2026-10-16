/**
 * promoter.mjs — self-service read surface for signed-in promoters.
 *
 * Three endpoints, all session-authenticated, all scoped to the caller:
 *   GET /api/v1/promoter/earnings  — points balance + own point entries
 *   GET /api/v1/promoter/referrals — referrals the caller made
 *   GET /api/v1/promoter/payouts   — the caller's own payouts + redemptions
 *
 * A promoter sees ONLY their own rows. The caller id comes from the
 * verified session (cross-checked against profiles.state, so a suspended
 * account stops immediately) and is interpolated server-side into every
 * filter — the client supplies no id at all, so there is nothing to forge.
 * This matches the RLS policies (point_entries_own_read, referrals_own_read,
 * payouts_own / redemptions_own_read): defense in depth, API filter + RLS.
 *
 * Zero dependencies: Node built-ins only, via session.mjs + supabase.mjs.
 */
import * as sb from './supabase.mjs';
import * as session from './session.mjs';

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400, extra = {}) => ({ status, body: { error: message, ...extra } });

/**
 * Session gate, mirroring requireSession() in routes.mjs: a valid signature
 * is not enough — the profile is re-read so suspension takes effect at once.
 * Returns the auth claims, or null when the caller is not signed in.
 */
async function requireSession(req) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return null;
  const rows = await sb.select('profiles', `id=eq.${claims.sub}&select=id,state,role`);
  const profile = rows?.[0];
  if (!profile) return null;
  if (profile.state !== 'active') return null;
  return { ...claims, role: profile.role, state: profile.state };
}

/**
 * GET /api/v1/promoter/earnings — the caller's points balance, derived as a
 * sum (never a stored column), plus their own recent point entries.
 */
export async function earnings(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select(
    'point_entries',
    `profile_id=eq.${auth.sub}&select=kind,points,task_id,memo,created_at`
    + '&order=created_at.desc&limit=200'
  );

  const earned = rows.filter(r => Number(r.points) > 0).reduce((n, r) => n + Number(r.points), 0);
  const spent = rows.filter(r => Number(r.points) < 0).reduce((n, r) => n + Math.abs(Number(r.points)), 0);

  return ok({
    balance: earned - spent,
    earned,
    spent,
    entries: rows.map(r => ({
      kind: r.kind,
      points: r.points,
      taskId: r.task_id,
      memo: r.memo,
      createdAt: r.created_at,
    })),
  });
}

/**
 * GET /api/v1/promoter/referrals — referrals the caller made, newest first.
 * A referral qualifies only when the referee completes a first task.
 */
export async function referrals(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select(
    'referrals',
    `referrer_id=eq.${auth.sub}&select=id,created_at,qualified_at,points_awarded`
    + '&order=created_at.desc&limit=100'
  );

  return ok({
    total: rows.length,
    qualified: rows.filter(r => r.qualified_at !== null).length,
    referrals: rows.map(r => ({
      id: r.id,
      joinedAt: r.created_at,
      qualifiedAt: r.qualified_at,
      pointsAwarded: r.points_awarded,
    })),
  });
}

/**
 * GET /api/v1/promoter/payouts — the caller's own ledger payouts plus their
 * own points redemptions (data/cash), newest first. Both lists are filtered
 * server-side by the session id.
 */
export async function payouts(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const [payoutRows, redemptionRows] = await Promise.all([
    sb.select(
      'payouts',
      `promoter_id=eq.${auth.sub}&select=id,kind,amount_minor,currency,status,provider_ref,hold_until,created_at,settled_at`
      + '&order=created_at.desc&limit=100'
    ),
    sb.select(
      'redemptions',
      `profile_id=eq.${auth.sub}&select=id,kind,points_spent,value_minor,network,state,provider_ref,created_at`
      + '&order=created_at.desc&limit=100'
    ),
  ]);

  return ok({
    payouts: payoutRows.map(p => ({
      id: p.id,
      kind: p.kind,
      amountMinor: p.amount_minor,
      currency: p.currency,
      status: p.status,
      providerRef: p.provider_ref,
      holdUntil: p.hold_until,
      createdAt: p.created_at,
      settledAt: p.settled_at,
    })),
    redemptions: redemptionRows.map(r => ({
      id: r.id,
      kind: r.kind,
      pointsSpent: r.points_spent,
      valueMinor: r.value_minor,
      network: r.network,
      state: r.state,
      providerRef: r.provider_ref,
      createdAt: r.created_at,
    })),
  });
}
