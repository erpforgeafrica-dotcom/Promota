/**
 * admin.mjs — the privileged server surface.
 *
 * Two jobs live here, both deliberately out of routes.mjs so review can see
 * them in one place:
 *
 *   1. createUser() — the only operation that mints auth.users (and therefore
 *      needs the service role against Supabase's auth schema). Only reachable
 *      from a verified Termii OTP. There is no password path and no email path.
 *   2. the /api/admin/* HTTP handlers — dashboard stats, user management,
 *      task review, campaign management and platform settings. Every one of
 *      them goes through requireAdmin(): a live session AND an active
 *      admin/owner (or support, for review actions) profile row. Tokens are
 *      never trusted alone — the profile is re-read so a suspension takes
 *      effect immediately, and every mutation writes an audit_log row.
 */
import * as session from './session.mjs';
import * as sb from './supabase.mjs';

const AUTH_URL = (process.env.SUPABASE_URL || '').trim();
const SERVICE_KEY = (process.env.SUPABASE_SECRET_KEY
  || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400, extra = {}) => ({ status, body: { error: message, ...extra } });

const UUID_RE = /^[0-9a-f-]{36}$/i;
const USER_STATES = ['pending', 'active', 'suspended', 'banned'];
const APP_ROLES = ['promoter', 'business', 'partner', 'support', 'finance', 'admin', 'owner'];
const CAMPAIGN_STATES = ['draft', 'review', 'live', 'paused', 'exhausted', 'settling', 'settled', 'cancelled'];
const TASK_STATES = ['draft', 'assigned', 'submitted', 'checking', 'held', 'approved', 'rejected', 'paid', 'expired', 'cancelled'];
const OBJECTIVES = ['click', 'signup', 'code', 'api_post'];

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

/* ------------------------------------------------------------------ helpers */

/**
 * Session + role gate for every /api/admin/* handler.
 * A valid signature is not enough: the profile row is re-read so a suspended
 * or banned admin stops working immediately, and the role comes from the
 * database rather than the token claim.
 */
async function requireAdmin(req, roles = ['admin', 'owner']) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return { error: fail('sign in required', 401) };
  const rows = await sb.select('profiles', `id=eq.${claims.sub}&select=id,role,state`);
  const profile = rows?.[0];
  if (!profile || profile.state !== 'active') return { error: fail('sign in required', 401) };
  if (!roles.includes(profile.role)) return { error: fail('admin access required', 403) };
  return { auth: { sub: claims.sub, role: profile.role } };
}

/** Append-only audit row for every admin mutation. */
async function audit(auth, action, targetType, targetId, afterState) {
  await sb.insert('audit_log', {
    actor_id: auth.sub,
    actor_role: auth.role,
    action,
    target_type: targetType,
    target_id: String(targetId),
    after_state: afterState,
  });
}

function query(req) {
  try { return new URL(req.url || '/', 'http://localhost').searchParams; }
  catch { return new URLSearchParams(); }
}

function intParam(sp, name, def, min, max) {
  const n = Number(sp.get(name));
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** PostgREST ilike wildcards are `*`; strip anything that could alter the query. */
function safeSearch(q) {
  return String(q || '').replace(/[^a-zA-Z0-9 +.]/g, '').slice(0, 60);
}

const countBy = (rows, key) => rows.reduce((m, r) => {
  const k = r[key] ?? 'null';
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});

const sumBy = (rows, key) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);

const mapProfile = (p) => ({
  id: p.id,
  displayName: p.display_name,
  phone: p.phone_e164,
  role: p.role,
  state: p.state,
  network: p.network,
  kycTier: p.kyc_tier,
  trustScore: p.trust_score,
  createdAt: p.created_at,
  suspendedAt: p.suspended_at,
  suspensionReason: p.suspension_reason,
});

const mapCampaign = (c) => ({
  id: c.id,
  ownerId: c.owner_id,
  title: c.title,
  brief: c.brief,
  platform: c.platform,
  objective: c.objective,
  state: c.state,
  budgetMinor: c.budget_minor,
  spentMinor: c.spent_minor,
  currency: c.currency,
  pricePerOutcomeMinor: c.price_per_outcome_minor,
  promoterShareBp: c.promoter_share_bp,
  fraudReserveBp: c.fraud_reserve_bp,
  marginFloorBp: c.margin_floor_bp,
  holdHours: c.hold_hours,
  autoPausePct: c.auto_pause_pct,
  startsAt: c.starts_at,
  endsAt: c.ends_at,
  createdAt: c.created_at,
});

const mapTask = (t) => ({
  id: t.id,
  campaignId: t.campaign_id,
  state: t.state,
  caption: t.caption,
  trackedLink: t.tracked_link,
  disclosureTag: t.disclosure_tag,
  rewardMinor: t.reward_minor,
  points: t.points_awarded ?? null,
  assignedTo: t.assigned_to,
  proofUrl: t.proof_url,
  submittedAt: t.submitted_at,
  autoApproveAt: t.auto_approve_at,
  reviewedBy: t.reviewed_by,
  rejectionReason: t.rejection_reason,
  createdAt: t.created_at,
});

/* ------------------------------------------------------------------ stats */

/**
 * GET /api/admin/stats — totals across users, tasks, campaigns, payouts,
 * redemptions and disputes, for the admin dashboard.
 */
export async function stats(req) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const [profiles, tasks, campaigns, payouts, redemptions, disputes] = await Promise.all([
    sb.select('profiles', 'select=id,role,state&limit=10000'),
    sb.select('tasks', 'select=id,state&limit=10000'),
    sb.select('campaigns', 'select=id,state,budget_minor,spent_minor&limit=10000'),
    sb.select('payouts', 'select=id,status,amount_minor,currency&limit=10000'),
    sb.select('redemptions', 'select=id,state,kind,points_spent,value_minor&limit=10000'),
    sb.select('disputes', 'select=id,state&limit=10000'),
  ]);

  return ok({
    users: {
      total: profiles.length,
      byState: countBy(profiles, 'state'),
      byRole: countBy(profiles, 'role'),
    },
    tasks: {
      total: tasks.length,
      byState: countBy(tasks, 'state'),
    },
    campaigns: {
      total: campaigns.length,
      byState: countBy(campaigns, 'state'),
      budgetMinor: sumBy(campaigns, 'budget_minor'),
      spentMinor: sumBy(campaigns, 'spent_minor'),
    },
    payouts: {
      total: payouts.length,
      byStatus: countBy(payouts, 'status'),
      amountMinor: sumBy(payouts, 'amount_minor'),
    },
    redemptions: {
      total: redemptions.length,
      byState: countBy(redemptions, 'state'),
      pointsSpent: sumBy(redemptions, 'points_spent'),
    },
    disputes: {
      total: disputes.length,
      byState: countBy(disputes, 'state'),
    },
  });
}

/* ------------------------------------------------------------------ users */

/** GET /api/admin/users?state=&role=&q=&limit=&offset= */
export async function listUsers(req) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const sp = query(req);
  const state = USER_STATES.includes(sp.get('state')) ? sp.get('state') : null;
  const role = APP_ROLES.includes(sp.get('role')) ? sp.get('role') : null;
  const q = safeSearch(sp.get('q'));
  const limit = intParam(sp, 'limit', 50, 1, 200);
  const offset = intParam(sp, 'offset', 0, 0, 100000);

  const filters = [];
  if (state) filters.push(`state=eq.${state}`);
  if (role) filters.push(`role=eq.${role}`);
  if (q) filters.push(`or=(display_name.ilike.*${q}*,phone_e164.ilike.*${q}*)`);

  const qs = 'select=id,display_name,phone_e164,role,state,network,kyc_tier,trust_score,created_at,suspended_at,suspension_reason'
    + (filters.length ? `&${filters.join('&')}` : '')
    + `&order=created_at.desc&limit=${limit}&offset=${offset}`;

  const rows = await sb.select('profiles', qs);
  return ok({ users: rows.map(mapProfile), limit, offset });
}

/** GET /api/admin/users/:id — one user plus their recent tasks and redemptions. */
export async function getUser(req, params) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a user id is required');

  const [rows, tasks, redemptions] = await Promise.all([
    sb.select('profiles', `id=eq.${id}&select=id,display_name,phone_e164,role,state,network,kyc_tier,trust_score,created_at,phone_verified_at,age_verified_at,suspended_at,suspension_reason`),
    sb.select('tasks', `assigned_to=eq.${id}&select=id,campaign_id,state,reward_minor,points_awarded,submitted_at,created_at&order=created_at.desc&limit=10`),
    sb.select('redemptions', `profile_id=eq.${id}&select=id,kind,points_spent,value_minor,network,state,created_at&order=created_at.desc&limit=10`),
  ]);
  const profile = rows?.[0];
  if (!profile) return fail('user not found', 404);

  return ok({
    user: {
      ...mapProfile(profile),
      phoneVerified: Boolean(profile.phone_verified_at),
      ageVerified: Boolean(profile.age_verified_at),
    },
    recentTasks: tasks.map(t => ({
      id: t.id,
      campaignId: t.campaign_id,
      state: t.state,
      rewardMinor: t.reward_minor,
      points: t.points_awarded ?? null,
      submittedAt: t.submitted_at,
      createdAt: t.created_at,
    })),
    recentRedemptions: redemptions.map(r => ({
      id: r.id,
      kind: r.kind,
      pointsSpent: r.points_spent,
      valueMinor: r.value_minor,
      network: r.network,
      state: r.state,
      createdAt: r.created_at,
    })),
  });
}

/**
 * POST /api/admin/users/:id/suspend  { reason? }
 * Suspension is immediate: requireSession() re-reads profiles.state on every
 * request, so the user's live tokens stop working on the next call.
 */
export async function suspendUser(req, params) {
  const gate = await requireAdmin(req, ['admin', 'owner', 'support']);
  if (gate.error) return gate.error;
  const auth = gate.auth;

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a user id is required');
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!reason) return fail('a suspension reason is required');

  if (id === auth.sub) return fail('you cannot suspend your own account', 403);

  const [target] = await sb.select('profiles', `id=eq.${id}&select=id,role,state`);
  if (!target) return fail('user not found', 404);
  if (target.role === 'owner' && auth.role !== 'owner') {
    return fail('only an owner can suspend an owner', 403);
  }
  if (target.state === 'banned') return fail('a banned account cannot be suspended', 409);
  if (target.state === 'suspended') return fail('that account is already suspended', 409);

  const updated = await sb.update(
    'profiles',
    `id=eq.${id}&state=eq.${target.state}`,
    {
      state: 'suspended',
      suspended_at: new Date().toISOString(),
      suspension_reason: reason,
      updated_at: new Date().toISOString(),
    }
  );
  if (!updated?.length) return fail('the account changed state before we could save', 409);

  await audit(auth, 'user.suspend', 'profile', id, { state: 'suspended', reason });
  return ok({ suspended: true, id, state: 'suspended' });
}

/** POST /api/admin/users/:id/reinstate — undo a suspension. */
export async function reinstateUser(req, params) {
  const gate = await requireAdmin(req, ['admin', 'owner', 'support']);
  if (gate.error) return gate.error;
  const auth = gate.auth;

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a user id is required');

  const [target] = await sb.select('profiles', `id=eq.${id}&select=id,state`);
  if (!target) return fail('user not found', 404);
  if (target.state !== 'suspended') return fail(`a user in state "${target.state}" cannot be reinstated`, 409);

  const updated = await sb.update(
    'profiles',
    `id=eq.${id}&state=eq.suspended`,
    {
      state: 'active',
      suspended_at: null,
      suspension_reason: null,
      updated_at: new Date().toISOString(),
    }
  );
  if (!updated?.length) return fail('the account changed state before we could save', 409);

  await audit(auth, 'user.reinstate', 'profile', id, { state: 'active' });
  return ok({ reinstated: true, id, state: 'active' });
}

/* ------------------------------------------------------------------ tasks */

/** GET /api/admin/tasks?state=&campaignId=&limit= */
export async function listTasksAdmin(req) {
  const gate = await requireAdmin(req, ['admin', 'owner', 'support']);
  if (gate.error) return gate.error;

  const sp = query(req);
  const state = TASK_STATES.includes(sp.get('state')) ? sp.get('state') : null;
  const campaignId = String(sp.get('campaignId') || '');
  const limit = intParam(sp, 'limit', 50, 1, 200);

  const filters = [];
  if (state) filters.push(`state=eq.${state}`);
  if (UUID_RE.test(campaignId)) filters.push(`campaign_id=eq.${campaignId}`);

  const qs = 'select=id,campaign_id,state,caption,tracked_link,disclosure_tag,reward_minor,points_awarded,'
    + 'assigned_to,proof_url,submitted_at,auto_approve_at,reviewed_by,rejection_reason,created_at'
    + (filters.length ? `&${filters.join('&')}` : '')
    + `&order=created_at.desc&limit=${limit}`;

  const rows = await sb.select('tasks', qs);
  return ok({ tasks: rows.map(mapTask), limit });
}

/**
 * POST /api/admin/tasks/:id/approve
 * Only a submitted/checking/held task can be approved; the state machine in
 * the database refuses anything else, and we translate that to a 409.
 */
export async function approveTask(req, params) {
  const gate = await requireAdmin(req, ['admin', 'owner', 'support']);
  if (gate.error) return gate.error;
  const auth = gate.auth;

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a task id is required');

  const [task] = await sb.select('tasks', `id=eq.${id}&select=id,state`);
  if (!task) return fail('task not found', 404);
  if (!['submitted', 'checking', 'held'].includes(task.state)) {
    return fail(`a task in state "${task.state}" cannot be approved`, 409);
  }

  let updated;
  try {
    updated = await sb.update(
      'tasks',
      `id=eq.${id}&state=in.(submitted,checking,held)`,
      { state: 'approved', reviewed_by: auth.sub, updated_at: new Date().toISOString() }
    );
  } catch (e) {
    if (/illegal task transition/i.test(String(e.message))) {
      return fail('the task changed state before we could save', 409);
    }
    throw e;
  }
  if (!updated?.length) return fail('the task changed state before we could save', 409);

  await audit(auth, 'task.approve', 'task', id, { state: 'approved' });
  return ok({ approved: true, taskId: id, state: 'approved' });
}

/** POST /api/admin/tasks/:id/reject  { reason } */
export async function rejectTask(req, params) {
  const gate = await requireAdmin(req, ['admin', 'owner', 'support']);
  if (gate.error) return gate.error;
  const auth = gate.auth;

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a task id is required');
  const reason = String(req.body?.reason || '').trim().slice(0, 300);
  if (!reason) return fail('a rejection reason is required');

  const [task] = await sb.select('tasks', `id=eq.${id}&select=id,state`);
  if (!task) return fail('task not found', 404);
  if (!['submitted', 'checking', 'held'].includes(task.state)) {
    return fail(`a task in state "${task.state}" cannot be rejected`, 409);
  }

  let updated;
  try {
    updated = await sb.update(
      'tasks',
      `id=eq.${id}&state=in.(submitted,checking,held)`,
      {
        state: 'rejected',
        reviewed_by: auth.sub,
        rejection_reason: reason,
        updated_at: new Date().toISOString(),
      }
    );
  } catch (e) {
    if (/illegal task transition/i.test(String(e.message))) {
      return fail('the task changed state before we could save', 409);
    }
    throw e;
  }
  if (!updated?.length) return fail('the task changed state before we could save', 409);

  await audit(auth, 'task.reject', 'task', id, { state: 'rejected', reason });
  return ok({ rejected: true, taskId: id, state: 'rejected' });
}

/* -------------------------------------------------------------- campaigns */

/** GET /api/admin/campaigns?state=&limit= */
export async function listCampaignsAdmin(req) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const sp = query(req);
  const state = CAMPAIGN_STATES.includes(sp.get('state')) ? sp.get('state') : null;
  const limit = intParam(sp, 'limit', 50, 1, 200);

  const qs = 'select=id,owner_id,title,brief,platform,objective,state,budget_minor,spent_minor,currency,'
    + 'price_per_outcome_minor,promoter_share_bp,fraud_reserve_bp,margin_floor_bp,hold_hours,auto_pause_pct,'
    + 'starts_at,ends_at,created_at'
    + (state ? `&state=eq.${state}` : '')
    + `&order=created_at.desc&limit=${limit}`;

  const rows = await sb.select('campaigns', qs);
  return ok({ campaigns: rows.map(mapCampaign), limit });
}

/**
 * POST /api/admin/campaigns — create a campaign in draft state.
 * Going live requires escrow funding, which the database enforces; this
 * endpoint never launches anything by itself.
 */
export async function createCampaign(req) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;
  const auth = gate.auth;

  const b = req.body || {};
  const title = String(b.title || '').trim();
  const platform = String(b.platform || '').trim();
  const objective = String(b.objective || '').trim();
  const brief = b.brief == null ? null : String(b.brief).trim().slice(0, 2000);

  if (!title || title.length > 200) return fail('a campaign title of at most 200 characters is required');
  if (!platform || platform.length > 60) return fail('a platform of at most 60 characters is required');
  if (!OBJECTIVES.includes(objective)) return fail(`objective must be one of: ${OBJECTIVES.join(', ')}`);

  const budgetMinor = Number(b.budgetMinor);
  const pricePerOutcomeMinor = Number(b.pricePerOutcomeMinor);
  const promoterShareBp = Number(b.promoterShareBp);
  const fraudReserveBp = b.fraudReserveBp == null ? 500 : Number(b.fraudReserveBp);
  const marginFloorBp = Number(b.marginFloorBp);
  const holdHours = b.holdHours == null ? 72 : Number(b.holdHours);
  const autoPausePct = b.autoPausePct == null ? 90 : Number(b.autoPausePct);

  if (!Number.isInteger(budgetMinor) || budgetMinor <= 0) return fail('budgetMinor must be a positive whole number of kobo');
  if (!Number.isInteger(pricePerOutcomeMinor) || pricePerOutcomeMinor <= 0) {
    return fail('pricePerOutcomeMinor must be a positive whole number of kobo');
  }
  if (!Number.isInteger(promoterShareBp) || promoterShareBp < 0 || promoterShareBp > 10000) {
    return fail('promoterShareBp must be a whole number between 0 and 10000');
  }
  if (!Number.isInteger(fraudReserveBp) || fraudReserveBp < 0 || fraudReserveBp > 10000) {
    return fail('fraudReserveBp must be a whole number between 0 and 10000');
  }
  if (!Number.isInteger(marginFloorBp) || marginFloorBp < 0 || marginFloorBp > 10000) {
    return fail('marginFloorBp must be a whole number between 0 and 10000');
  }
  if (promoterShareBp + fraudReserveBp > 10000) {
    return fail('promoterShareBp + fraudReserveBp cannot exceed 10000');
  }
  if (!Number.isInteger(holdHours) || holdHours < 48 || holdHours > 72) {
    return fail('holdHours must be a whole number between 48 and 72');
  }
  if (!Number.isInteger(autoPausePct) || autoPausePct < 50 || autoPausePct > 100) {
    return fail('autoPausePct must be a whole number between 50 and 100');
  }

  let rows;
  try {
    rows = await sb.insert('campaigns', {
      owner_id: auth.sub,
      title,
      brief,
      platform,
      objective,
      state: 'draft',
      budget_minor: budgetMinor,
      price_per_outcome_minor: pricePerOutcomeMinor,
      promoter_share_bp: promoterShareBp,
      fraud_reserve_bp: fraudReserveBp,
      margin_floor_bp: marginFloorBp,
      hold_hours: holdHours,
      auto_pause_pct: autoPausePct,
    });
  } catch (e) {
    const m = String(e.message);
    if (/margin below floor|share_sane|budget_minor|price_per_outcome/i.test(m)) {
      return fail(`campaign refused: ${m.slice(0, 160)}`, 400);
    }
    throw e;
  }

  const campaign = rows?.[0];
  if (!campaign) return fail('campaign was not created', 500);
  await audit(auth, 'campaign.create', 'campaign', campaign.id, { state: 'draft', title });
  return ok({ campaign: mapCampaign(campaign) }, 201);
}

/* --------------------------------------------------------------- settings */

const mapSetting = (s) => ({
  key: s.key,
  value: s.value && typeof s.value === 'object' && 'v' in s.value ? s.value.v : s.value,
  valueType: s.value_type,
  label: s.label,
  group: s.group_name,
  updatedAt: s.updated_at,
});

/** GET /api/admin/settings — every owner-tunable business number. */
export async function getSettings(req) {
  const gate = await requireAdmin(req, ['admin', 'owner', 'finance']);
  if (gate.error) return gate.error;

  const rows = await sb.select('settings', 'select=key,value,value_type,label,group_name,updated_at&order=group_name.asc,key.asc&limit=500');
  return ok({ settings: rows.map(mapSetting) });
}

const SETTING_KEY_RE = /^[a-z0-9_.]{1,100}$/i;

function validateSettingValue(valueType, value) {
  switch (valueType) {
    case 'string':
      return typeof value === 'string' && value.length <= 500 ? null : 'value must be a string of at most 500 characters';
    case 'int':
      return Number.isInteger(value) ? null : 'value must be a whole number';
    case 'bool':
      return typeof value === 'boolean' ? null : 'value must be true or false';
    case 'money_minor':
      return Number.isInteger(value) && value >= 0 ? null : 'value must be a non-negative whole number of kobo';
    case 'pct_bp':
      return Number.isInteger(value) && value >= 0 && value <= 10000
        ? null : 'value must be a whole number between 0 and 10000';
    case 'json':
      return value === undefined ? null : null;
    default:
      return 'unknown setting type';
  }
}

/** POST /api/admin/settings  { key, value } — typed, validated, audited. */
export async function setSetting(req) {
  const gate = await requireAdmin(req, ['admin', 'owner', 'finance']);
  if (gate.error) return gate.error;
  const auth = gate.auth;

  const key = String(req.body?.key || '').trim();
  if (!SETTING_KEY_RE.test(key)) return fail('a settings key is required');

  const [existing] = await sb.select('settings', `key=eq.${key}&select=key,value,value_type,label,group_name,updated_at`);
  if (!existing) return fail('no such setting', 404);

  const value = req.body?.value;
  const problem = validateSettingValue(existing.value_type, value);
  if (problem) return fail(problem);

  const before = existing.value && typeof existing.value === 'object' && 'v' in existing.value
    ? existing.value.v : existing.value;

  await sb.update(
    'settings',
    `key=eq.${key}`,
    { value: { v: value }, updated_by: auth.sub, updated_at: new Date().toISOString() }
  );

  await audit(auth, 'settings.write', 'setting', key, { before, after: value });
  return ok({ updated: true, key, value });
}
