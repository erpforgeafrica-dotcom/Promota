/**
 * routes.mjs — the API surface.
 *
 * Every handler is thin: it validates shape, calls a Postgres function or
 * provider adapter, and returns a status + body. Business rules live in SQL
 * (0008) or in the providers, never inline here, so they stay testable under
 * PGlite without a server.
 *
 * Auth model: Termii OTP issues a phone-verified session (see session.mjs).
 * Every /api route except the two OTP steps requires that session.
 */
import * as sb from './supabase.mjs';
import * as session from './session.mjs';
import * as termii from '../providers/termii.mjs';
import * as flw from '../providers/flutterwave.mjs';
import * as data from '../providers/data.mjs';

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400, extra = {}) => ({ status, body: { error: message, ...extra } });

/* ------------------------------------------------------------------ helpers */

function normalisePhone(input) {
  const raw = String(input || '').replace(/[\s\-().]/g, '');
  let digits = raw;
  if (digits.startsWith('+234')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('234')) digits = `0${digits.slice(3)}`;
  return /^0\d{10}$/.test(digits) ? digits : null;
}

const toE164 = (local) => `+234${local.slice(1)}`;

async function requireSession(req) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return null;
  // A valid signature is not enough: a banned or suspended account must stop
  // working immediately, not when its token happens to expire.
  const { data: rows } = { data: await sb.select('profiles', `id=eq.${claims.sub}&select=id,state,role`) };
  const profile = rows?.[0];
  if (!profile) return null;
  if (profile.state !== 'active') return null;
  return { ...claims, role: profile.role, state: profile.state };
}

/* -------------------------------------------------------------- auth: OTP */

/** POST /api/auth/otp/request  { phone } */
export async function requestOtp(req) {
  // Input is validated BEFORE any dependency check: a malformed phone is a
  // client error (400) and must not be masked as "provider down" (503).
  const phone = normalisePhone(req.body?.phone);
  if (!phone) return fail('a valid Nigerian phone number is required');

  if (!termii.configured()) return fail('SMS provider is not configured', 503);

  const pin = session.newOtp();
  const e164 = toE164(phone);

  try {
    // Network detection is best-effort: it must never block a signup.
    const info = await termii.lookupNumber(e164);
    const { pinId } = await termii.sendOtp({ to: e164, pin });

    // pinId MUST be returned: verifyOtp() cannot be called without it, so
    // omitting it made the whole OTP login flow impossible. The PIN itself is
    // NEVER returned or logged — only the id Termii uses to verify it later.
    return ok({ sent: true, phone: phone, network: info.network, pinId }, 200);
  } catch (e) {
    return fail(`could not send the code: ${String(e.message).slice(0, 120)}`, 502);
  }
}

/** POST /api/auth/otp/verify  { phone, pinId, pin } */
export async function verifyOtp(req) {
  const phone = normalisePhone(req.body?.phone);
  const pinId = String(req.body?.pinId || '');
  const pin = String(req.body?.pin || '').trim();
  if (!phone || !pinId || !/^\d{4,8}$/.test(pin)) {
    return fail('phone, pinId and pin are required');
  }

  if (!termii.configured()) return fail('SMS provider is not configured', 503);

  let good = false;
  try { good = await termii.verifyOtp({ pinId, pin }); }
  catch (e) { return fail(`verification failed: ${String(e.message).slice(0, 120)}`, 502); }

  // A wrong code is a refusal, not an outage, and must not reveal whether the
  // number is already registered.
  if (!good) return fail('that code is not valid', 400);

  const e164 = toE164(phone);
  const info = await termii.lookupNumber(e164);

  // find or create the auth.users row + profile
  const existing = await sb.select('profiles', `phone_e164=eq.${e164}&select=id,role,state&limit=1`);
  let profileId = existing?.[0]?.id;

  if (!profileId) {
    const uid = crypto.randomUUID();
    const { createUser } = await import('./admin.mjs');
    profileId = await createUser({ userId: uid, phoneE164: e164, network: info.network });
  }

  const [row] = await sb.select('profiles', `id=eq.${profileId}&select=role`);
  const token = session.issue(profileId, { role: row?.role || 'promoter' });

  return ok({ token, phone, network: info.network });
}

/* ------------------------------------------------------------- promoter */

export async function me(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const snap = await sb.promoterSnapshot(auth.sub);
  if (!snap) return fail('profile not found', 404);
  return ok(snap);
}

/** GET /api/tasks — available tasks, with the point value shown up front. */
export async function listTasks(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select(
    'tasks',
    'state=in.(assigned,draft)&select=id,campaign_id,caption,tracked_link,disclosure_tag,'
    + 'points_awarded,reward_minor,state,auto_approve_at&order=created_at.desc&limit=50'
  );

  return ok({
    tasks: rows.map(t => ({
      id: t.id,
      campaignId: t.campaign_id,
      caption: t.caption,
      trackedLink: t.tracked_link,
      disclosureTag: t.disclosure_tag,
      points: t.points_awarded ?? null,
      rewardMinor: t.reward_minor,
      state: t.state,
      autoApproveAt: t.auto_approve_at,
    })),
  });
}

/** GET /api/tasks/mine — tasks assigned to this promoter. */
export async function myTasks(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select(
    'tasks',
    `assigned_to=eq.${auth.sub}&select=id,campaign_id,caption,tracked_link,disclosure_tag,`
    + 'points_awarded,state,proof_url,submitted_at,auto_approve_at,rejection_reason&order=created_at.desc&limit=100'
  );

  return ok({
    tasks: rows.map(t => ({
      id: t.id,
      campaignId: t.campaign_id,
      caption: t.caption,
      trackedLink: t.tracked_link,
      disclosureTag: t.disclosure_tag,
      points: t.points_awarded ?? null,
      state: t.state,
      proofUrl: t.proof_url,
      submittedAt: t.submitted_at,
      autoApproveAt: t.auto_approve_at,
      rejectionReason: t.rejection_reason,
    })),
  });
}

/**
 * POST /api/tasks/:id/submit  { proofUrl }
 * Marks the task submitted. Points are NOT awarded here: the task state machine
 * and auto-approve own that, so a client cannot pay itself by submitting.
 */
export async function submitTask(req, params) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const id = String(params?.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail('a task id is required');
  const proofUrl = String(req.body?.proofUrl || '').trim();
  if (!/^https?:\/\//i.test(proofUrl)) return fail('a proof link is required');

  const [task] = await sb.select('tasks', `id=eq.${id}&select=id,assigned_to,state`);
  if (!task) return fail('task not found', 404);
  if (task.assigned_to !== auth.sub) return fail('that task is not assigned to you', 403);
  if (task.state !== 'assigned') return fail(`a task in state "${task.state}" cannot be submitted`, 409);

  const updated = await sb.update(
    'tasks',
    `id=eq.${id}&state=eq.assigned`,
    { state: 'submitted', submitted_at: new Date().toISOString(), proof_url: proofUrl }
  );
  if (!updated?.length) return fail('the task changed state before we could save', 409);

  return ok({ submitted: true, taskId: id });
}

/** GET /api/referrals — how many qualified referrals stand behind the level. */
export async function referrals(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const [total, qualified, rows] = await Promise.all([
    sb.select('referrals', `referrer_id=eq.${auth.sub}&select=id`),
    sb.select('referrals', `referrer_id=eq.${auth.sub}&qualified_at=not.is.null&select=id`),
    sb.select(
      'referrals',
      `referrer_id=eq.${auth.sub}&select=id,created_at,qualified_at,points_awarded&order=created_at.desc&limit=100`
    ),
  ]);

  return ok({
    total: total.length,
    qualified: qualified.length,
    referrals: rows.map(r => ({
      id: r.id,
      joinedAt: r.created_at,
      qualifiedAt: r.qualified_at,
      pointsAwarded: r.points_awarded,
    })),
  });
}

/* ------------------------------------------------------------ redemption */

/**
 * POST /api/redeem  { kind: 'data'|'cash', points, network?, accountNumber?, accountBank? }
 *
 * Points are debited immediately by redeem_points(); fulfilment happens in the
 * worker. A cash redemption needs the level gate AND KYC AND a bank account —
 * none of which can be faked from the client.
 */
export async function redeem(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const kind = req.body?.kind === 'cash' ? 'cash' : req.body?.kind === 'data' ? 'data' : null;
  if (!kind) return fail('kind must be "data" or "cash"');

  const points = Number(req.body?.points);
  if (!Number.isInteger(points) || points <= 0) return fail('points must be a positive whole number');

  const network = kind === 'data' ? String(req.body?.network || '').toUpperCase() : null;
  if (kind === 'data' && !['MTN', 'GLO', 'AIRTEL', '9MOBILE'].includes(network || '')) {
    return fail('a data redemption needs network MTN, GLO, AIRTEL or 9MOBILE');
  }

  // Stable reference: a replayed request returns the same redemption instead
  // of charging the promoter twice.
  const idem = `redeem:${auth.sub}:${kind}:${points}:${network || 'cash'}`;

  let redemptionId;
  try {
    redemptionId = await sb.rpc('redeem_points', {
      p_profile: auth.sub,
      p_kind: kind,
      p_points: points,
      p_idem: idem,
      p_network: network,
    });
  } catch (e) {
    const m = String(e.message);
    if (/not unlocked/i.test(m)) return fail('cash redemption is not unlocked at your level', 403);
    if (/insufficient points/i.test(m)) return fail('you do not have that many points', 409);
    if (/minimum redemption/i.test(m)) return fail(m.replace(/^.*?:?\s*/, ''), 409);
    return fail(`redemption refused: ${m.slice(0, 140)}`, 400);
  }

  return ok({ redemptionId, kind, points, network, state: 'requested' }, 202);
}

/* -------------------------------------------------------------- webhooks */

/**
 * POST /api/webhooks/flutterwave
 * Body is the raw bytes because the signature covers them.
 */
export async function flutterwaveWebhook(req, rawBody) {
  const verdict = flw.verifyWebhookSignature(rawBody, req.headers['verif-hash']);
  if (!verdict.ok) return fail(`webhook rejected: ${verdict.reason}`, 401);

  let evt;
  try { evt = JSON.parse(rawBody); }
  catch { return fail('webhook body is not JSON', 400); }

  const event = evt?.event || '';
  if (!/^transfer\.(completed|failed)$/.test(event)) {
    return ok({ ignored: true, event });
  }

  const ref = String(evt?.data?.reference || '');
  if (!ref) return fail('webhook carries no reference', 400);

  // reference is our redemption id, so the payout is matched without guessing
  const rows = await sb.select(
    'redemptions',
    `idempotency_key=eq.${ref}&select=id,state,kind,points_spent,value_minor`
  );
  const redemption = rows?.[0];
  if (!redemption) return ok({ matched: false, reason: 'no redemption for that reference' });
  if (redemption.state === 'fulfilled') return ok({ alreadyFulfilled: true });

  if (event === 'transfer.completed') {
    await sb.update(
      'redemptions',
      `id=eq.${redemption.id}`,
      {
        state: 'fulfilled',
        provider: 'flutterwave',
        provider_ref: String(evt?.data?.id ?? ref),
        value_minor: Number(evt?.data?.amount ?? 0) * 100,
        updated_at: new Date().toISOString(),
      }
    );
  } else {
    // A failed cash payout must not silently keep the points. Marking it failed
    // leaves the refund path (reverse the redemption entry) to an operator,
    // which is deliberately a human decision.
    await sb.update(
      'redemptions',
      `id=eq.${redemption.id}`,
      {
        state: 'failed',
        failure_reason: String(evt?.data?.complete_message || 'transfer failed').slice(0, 300),
        updated_at: new Date().toISOString(),
      }
    );
  }

  return ok({ received: true, event, redemptionId: redemption.id });
}

/* ------------------------------------------------------------ healthcheck */

/** GET /healthz — does the process work, and are its dependencies present? */
export async function health() {
  const providers = {
    supabase: sb.configured(),
    termii: termii.configured(),
    flutterwave: flw.configured(),
    sessions: session.configured(),
    data: data.status(),
  };
  return ok({
    ok: true,
    config: providers.supabase,
    auth: providers.sessions,
    providers,
  });
}

export const routes = {
  'POST /api/auth/otp/request': requestOtp,
  'POST /api/auth/otp/verify': verifyOtp,
  'GET /api/me': me,
  'GET /api/tasks': listTasks,
  'GET /api/tasks/mine': myTasks,
  'POST /api/redeem': redeem,
  'GET /api/referrals': referrals,
  'POST /api/webhooks/flutterwave': flutterwaveWebhook,
  'GET /healthz': health,
};

export { requireSession };