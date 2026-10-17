/**
 * mining.mjs — real task/process mining over the mining_task_stages view.
 *
 * mining/status + mining/traces return counts and traces derived FROM THE
 * LEDGER TABLES, not from static stubs: stage counts, stage medians, funnel
 * drop-off and the heaviest stage. Admin surfaces order the evidence;
 * promoter pipeline mirrors it for the caller.
 */
import * as session from './session.mjs';
import * as sb from './supabase.mjs';

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400) => ({ status, body: { error: message } });

const OPEN_STATES = ['assigned', 'submitted', 'checking', 'held'];

async function requireSession(req) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return null;
  const rows = await sb.select('profiles', `id=eq.${claims.sub}&select=id,state,role`);
  const profile = rows?.[0];
  if (!profile || profile.state !== 'active') return null;
  return { ...claims, role: profile.role, state: profile.state };
}

async function requireAdmin(req, roles = ['admin', 'owner']) {
  const auth = await requireSession(req);
  if (!auth) return { error: fail('sign in required', 401) };
  if (!roles.includes(auth.role)) return { error: fail('admin access required', 403) };
  return { auth };
}

const hoursBetween = (a, b) => {
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d / 3600000 : null;
};

const median = (rows) => {
  const v = rows.filter((r) => r != null && isFinite(r)).sort((x, y) => x - y);
  if (!v.length) return null;
  return v[Math.floor((v.length - 1) / 2)];
};

const avg = (rows) => {
  const v = rows.filter((r) => r != null && isFinite(r));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/**
 * GET /api/mining/status (admin/admin-gated? no — signed-in promoter sees own
 * counters we ALSO mirror on /api/v1/promoter/pipeline; admins get platform).
 */
export async function statusFor(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const isAdmin = ['admin', 'owner', 'support', 'finance'].includes(auth.role);
  const rows = await sb.select('mining_task_stages', isAdmin
    ? 'select=*&order=last_update.desc&limit=5000'
    : `assigned_to=eq.${auth.sub}&select=*&limit=500`);

  const byState = {};
  const byAction = {};
  const byPlatform = {};
  for (const t of rows) {
    byState[t.state] = (byState[t.state] || 0) + 1;
    byAction[t.action_type] = (byAction[t.action_type] || 0) + 1;
    byPlatform[t.campaign_platform] = (byPlatform[t.campaign_platform] || 0) + 1;
  }

  const claimed = rows.filter((t) => t.assigned_at);
  const submitted = rows.filter((t) => t.submitted_at);
  const decided = rows.filter((t) => ['approved', 'rejected'].includes(t.state) && t.decided_at);

  const claimToSubmit = submitted.length;
  const sendToApprove = Number(
    submitted.length ? (submitted.filter((t) => !['rejected'].includes(t.state)).length / submitted.length) : 0
  );

  const timings = {
    claimHours: { median: r1(median(claimed.map((t) => hoursBetween(t.created_at, t.assigned_at)))), avg: r1(avg(claimed.map((t) => hoursBetween(t.created_at, t.assigned_at)))) },
    submitHours: { median: r1(median(claimed.map((t) => hoursBetween(t.assigned_at, t.submitted_at)))), avg: r1(avg(claimed.map((t) => hoursBetween(t.assigned_at, t.submitted_at)))) },
    reviewHours: { median: r1(median(decided.map((t) => hoursBetween(t.submitted_at, t.decided_at)))), avg: r1(avg(decided.map((t) => hoursBetween(t.submitted_at, t.decided_at)))) },
  };

  const stages = [
    { stage: 'claim', h: timings.claimHours.median },
    { stage: 'submit', h: timings.submitHours.median },
    { stage: 'review', h: timings.reviewHours.median },
  ].filter((s) => s.h != null);

  const slowest = stages.length ? [...stages].sort((a, b) => b.h - a.h)[0] : null;

  return ok({
    active: true,
    lastRun: new Date().toISOString(),
    scope: isAdmin ? 'platform' : 'promoter',
    counts: {
      total: rows.length,
      open: rows.filter((t) => OPEN_STATES.includes(t.state)).length,
      byState,
      byAction,
      byPlatform,
    },
    funnel: {
      claimedTotal: claimed.length,
      submitted: claimToSubmit,
      submittedRate: claimed.length ? claimToSubmit / claimed.length : 0,
      approveRate: sendToApprove == null ? null : sendToApprove,
      submittedFail: rows.filter((t) => ['expired', 'cancelled'].includes(t.state)).length,
    },
    stageMedianHours: timings,
    bottleneck: slowest ? { stage: slowest.stage, medianHours: slowest.h } : null,
  });
}

/**
 * GET /api/mining/traces — per-task sequence, newest first. Admin sees all,
 * a promoter gets their own rows only.
 */
export async function tracesFor(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const isAdmin = ['admin', 'owner', 'support', 'finance'].includes(auth.role);
  const rows = await sb.select('mining_task_stages', isAdmin
    ? 'select=*&order=last_update.desc&limit=200'
    : `assigned_to=eq.${auth.sub}&order=last_update.desc&limit=50`);

  const traces = rows.map((t) => {
    const steps = [];
    if (t.created_at) steps.push({ at: t.created_at, stage: 'draft' });
    if (t.assigned_at) steps.push({ at: t.assigned_at, stage: 'claimed' });
    if (t.submitted_at) steps.push({ at: t.submitted_at, stage: 'submitted', views: t.latest_views ?? null });
    if (t.decided_at) steps.push({ at: t.decided_at, stage: t.state });
    return {
      taskId: t.task_id,
      campaignId: t.campaign_id,
      platform: t.campaign_platform,
      action: t.action_type,
      state: t.state,
      steps,
    };
  });

  return ok({ traces });
}

/** GET /api/v1/promoter/pipeline — the caller's own mining view. */
export async function promoterPipeline(req) {
  return statusFor(req);
}
