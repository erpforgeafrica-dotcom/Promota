/**
 * checkin.mjs — the daily login reward surface.
 *
 *   POST /api/v1/checkin        — performs today's check-in. Idempotent: a
 *                                 replay on the same Lagos day returns the
 *                                 same "already" answer and pays nothing.
 *   GET  /api/v1/checkin        — today's status for the dashboard card.
 *
 * Every award the user sees here is written BY THE DATABASE (checkin.sql
 * / login_status.sql): the ledger insert, the outbox event and the streak
 * maths happen inside one SQL function, so a duplicate HTTP call can never
 * double-pay and a crash cannot leave a half-paid streak.
 */
import * as session from './session.mjs';
import * as sb from './supabase.mjs';

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400) => ({ status, body: { error: message } });

/** Same gate the stricter admin surface uses: token + live active profile. */
async function requireSession(req) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return null;
  const rows = await sb.select('profiles', `id=eq.${claims.sub}&select=id,state`);
  const profile = rows?.[0];
  if (!profile || profile.state !== 'active') return null;
  return { sub: claims.sub };
}

/** POST /api/v1/checkin */
export async function checkin(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  try {
    const res = await sb.rpc('checkin', { p_profile: auth.sub });
    const already = Boolean(res?.already);
    return ok(res || { already: true }, already ? 200 : 201);
  } catch (e) {
    return fail(`check-in refused: ${String(e.message).slice(0, 140)}`, 500);
  }
}

/** GET /api/v1/checkin */
export async function checkinStatus(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  try {
    const res = await sb.rpc('login_status', { p_profile: auth.sub });
    return ok(res || { lagosDay: null, checkedInToday: false, streak: 0, checkedThisMonth: [] });
  } catch (e) {
    return fail(`status refused: ${String(e.message).slice(0, 140)}`, 500);
  }
}
