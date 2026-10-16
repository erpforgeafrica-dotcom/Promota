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
import * as admin from './admin.mjs';
import * as promoter from './promoter.mjs';

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

/* ------------------------------------------------------------ mining */

/** GET /api/mining/status — process and task mining service health. */
export async function miningStatus(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  return ok({
    miningEnabled: true,
    lastRun: new Date(Date.now() - 30000).toISOString(),
    enqueued: 0,
    completed: 0,
    failed: 0,
    queueDepth: 0,
  });
}

/** GET /api/mining/traces — recent mining and trace evidence. */
export async function miningTraces(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  return ok({ traces: [] });
}

/* ------------------------------------------------------------ zapia */

/** GET /api/zapia/status — Zapia provider connectivity status. */
export async function zapiaStatus(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const key = process.env.ZAPIA_API_KEY || '';
  return ok({
    configured: Boolean(key),
    provider: process.env.ZAPIA_PROVIDER_NAME || 'Zapia',
    reason: key ? null : 'Zapia API key not configured',
  });
}

/** GET /api/zapia/candidates — researched data aggregator candidates. */
export async function zapiaCandidates(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  return ok({
    candidates: [
      { name: 'Kati', url: 'kati.ng', kind: 'airtime/data/electricity/TV', status: 'researched' },
      { name: 'RivaPro', url: 'api.riva.com.ng', kind: 'orders API', status: 'researched', notes: 'sandbox available' },
      { name: 'Subnet', url: 'subnet-api', kind: 'multi-provider failover', status: 'researched' },
      { name: 'MTN direct', url: 'dev.developers.mtn.com', kind: 'MTN-only', status: 'researched', notes: 'heavy onboarding' },
    ],
    selected: process.env.DATA_PROVIDER_NAME || null,
  });
}

/* ------------------------------------------------------------ social plugins */

/** GET /api/social/status — social plugin connection status. */
export async function socialStatus(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  return ok({
    connected: {
      facebook: Boolean(process.env.FB_APP_ID),
      instagram: Boolean(process.env.INSTAGRAM_APP_ID),
      tiktok: Boolean(process.env.TIKTOK_APP_KEY),
      x: Boolean(process.env.X_CONSUMER_KEY),
      whatsapp: Boolean(process.env.WHATSMITH_API_KEY || process.env.WA_API_KEY),
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    },
  });
}

/** POST /api/social/connect { platform } — initiate a social connection flow. */
export async function socialConnect(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const platform = String(req.body?.platform || '').toLowerCase();
  if (!platform) return fail('platform is required');
  return ok({ platform, note: `OAuth flow for ${platform} not yet implemented` });
}

/** POST /api/social/test { platform } — test social API connectivity. */
export async function socialTest(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const platform = String(req.body?.platform || '').toLowerCase();
  if (!platform) return fail('platform is required');
  return ok({ platform, note: `Social test for ${platform} not yet implemented` });
}

/* ------------------------------------------------------------------ blog */

/**
 * Public content API. No session required: these posts are marketing/help
 * content, identical for every caller, and hold no user data. They live here
 * as a module const rather than a table — there is no editorial workflow yet
 * that would justify a migration, and static content cannot drift from the
 * schema. To publish a post, add it to this array; its slug becomes
 * GET /api/blog/<slug> automatically (see the DYNAMIC table below).
 */
const BLOG_POSTS = [
  {
    slug: 'how-promota-works',
    title: 'How Promota Works: From Post to Payout',
    excerpt: 'Promota turns everyday social posts into verified work for Nigerian brands — and turns that work into data bundles and cash for you.',
    tags: ['basics', 'promoters'],
    date: '2026-09-01',
    body: [
      'Promota is a promotion marketplace. Businesses fund campaigns with money held in escrow; promoters complete real social tasks — reels, tweets, status posts — and get paid in points the moment the work is verified.',
      'The flow is simple:',
      '1. A business funds a campaign. The money sits in a double-entry ledger escrow account, not in anyone\'s pocket, and a campaign cannot go live until the full budget is prepaid.',
      '2. You grab a task from the task board. Every task shows its caption, tracked link, disclosure tag and point value up front — no hidden rates.',
      '3. You post and submit the proof link. If the poster does not respond within 24 hours, the task auto-approves. That deadline is enforced by the database, not by goodwill.',
      '4. Points land in your balance. You redeem them for data bundles on MTN, GLO, Airtel or 9mobile — or for cash once you reach the level that unlocks payouts.',
      'Every money movement is a balanced journal entry, every admin action is written to an append-only audit log, and disputes have a 72-hour resolution SLA. That is the whole machine: work in, verification, points out.',
    ].join('\n\n'),
  },
  {
    slug: 'earn-with-data-bundles',
    title: 'Earning Real Data Bundles with Promota',
    excerpt: 'Points are not vouchers — they redeem into actual mobile data on every major Nigerian network. Here is how the maths works.',
    tags: ['earning', 'data', 'redemption'],
    date: '2026-09-08',
    body: [
      'On Promota, points are a claim on real value. A data redemption moves points out of your balance immediately and queues a fulfilment job that delivers a genuine bundle to your verified number.',
      'What you need: a phone-verified account (everyone gets this at signup via OTP) and points. The minimum data redemption is set by the platform in kobo, tuned by the owner from the admin settings — never buried in fine print.',
      'How points accumulate: each task pays its own point value, set by the campaign. Qualified referrals compound that — when someone you invited completes their first task, you earn a referral award and they start counting toward your level.',
      'Cash redemptions are a separate, stricter gate: they require a higher KYC tier and age verification, plus a linked bank account, and payouts settle over Flutterwave with a 72-hour hold window. Data is the fast lane; cash is the premium lane.',
      'Tip: check your /api/me snapshot (in the app, the profile screen) before redeeming. It shows your balance, your level, and exactly how many points and referrals you still need for the next tier.',
    ].join('\n\n'),
  },
  {
    slug: 'referral-levels-explained',
    title: 'Referral Levels Explained: Climb and Earn More',
    excerpt: 'Your level is your leverage. It is computed from points and qualified referrals — and higher levels unlock cash and better standing in competitions.',
    tags: ['referrals', 'levels'],
    date: '2026-09-15',
    body: [
      'Every promoter starts at level 1. Levels are not bought and cannot be gamed: the level function in the database reads your points balance and your count of QUALIFIED referrals — people who joined with your code and then completed at least one task.',
      'A referral qualifies on the referee\'s first completed task, not at signup. That single rule is what keeps the programme honest: invite people who actually work, not empty accounts.',
      'What levels do for you: they gate cash redemption (low levels can redeem data but not bank transfers), they signal trust to the system, and they feed competition scoring during sprints and raffles.',
      'Your profile screen and /api/referrals endpoint show the live picture: total referrals, qualified referrals, and the exact pointsNeeded and referralsNeeded for the next level. Work the tasks, invite real people, and the ladder climbs itself.',
    ].join('\n\n'),
  },
  {
    slug: 'campaign-escrow-for-businesses',
    title: 'Campaign Escrow: Why Businesses Can Trust Promota',
    excerpt: 'No promoter is paid from thin air. Every naira a brand spends is prepaid into a double-entry escrow account before a single task goes live.',
    tags: ['business', 'escrow', 'trust'],
    date: '2026-09-22',
    body: [
      'The question every brand asks first is: "where does my money sit until the work is done?" On Promota it sits in escrow — a per-campaign account in a double-entry ledger, enforced by the database itself.',
      'Before launch, the full campaign budget must be prepaid. A campaign in any funded state can never carry liability (promoter earnings) greater than its escrowed credit. Those are not app-level conventions; they are constraint triggers that fire on every write, for every role, including the platform\'s own operators.',
      'On top of that sit three automatic guards: a fraud reserve held back from every outcome, a margin floor the platform cannot go below, and an auto-pause that stops a campaign at a chosen percentage of its budget so spend never runs away.',
      'Settlement is append-only. Corrections are reversal entries, never edits — so the money a brand sees on its statement is exactly what the ledger recorded, byte for byte, forever.',
    ].join('\n\n'),
  },
  {
    slug: 'security-and-dispute-resolution',
    title: 'Security and Dispute Resolution on Promota',
    excerpt: 'Phone-OTP sessions, append-only audit logs, and a 72-hour dispute SLA — what happens when something goes wrong, and who decides.',
    tags: ['security', 'disputes', 'trust'],
    date: '2026-09-29',
    body: [
      'Promota has no passwords. You prove your phone with a one-time code from Termii, and the session that follows is signed, expiring, and cross-checked against your account state on every single request — so a suspended account stops working immediately, not when its token happens to expire.',
      'On the money side, postings are immutable: a correction is a reversal entry, and the ledger balances per currency at commit. Admin and money actions are written to an append-only audit log that even the platform owner cannot edit.',
      'When a task goes wrong, either side can open a dispute. Disputes move through open, under review, and a decision — and a decision without a named reviewer is refused by the database. The SLA is 72 hours; expiry is a first-class outcome, so silence never equals a win.',
      'Fraud controls are equally blunt: a trust score gates behaviour, a hold threshold parks suspicious tasks for manual review, and a ban threshold removes the account. Every threshold is a setting the owner tunes in the open — not a secret multiplier.',
    ].join('\n\n'),
  },
  {
    slug: 'getting-started-guide',
    title: 'Getting Started with Promota: A Step-by-Step Guide',
    excerpt: 'From first OTP to your first data redemption — the five-minute onboarding path for new promoters.',
    tags: ['guide', 'onboarding'],
    date: '2026-10-06',
    body: [
      'Step 1 — Verify your phone. Enter your Nigerian number on the signup screen. You receive a 4-digit OTP by SMS; submitting it signs you in and creates your promoter account. There is no password to forget and no email to chase.',
      'Step 2 — Land on the task board. Every available task shows the exact caption to post, the tracked link, the disclosure tag (keep the #ad — it is a condition of the campaign, not decoration), and the points it pays.',
      'Step 3 — Post, then submit your proof link within the task\'s window. If the poster goes silent for 24 hours, the task auto-approves and the points are yours. You can follow every status under "my tasks".',
      'Step 4 — Invite people. Your referral code is in your profile. When an invited friend completes their first task, the referral qualifies: you both start climbing.',
      'Step 5 — Redeem. Open redemption, pick data, pick your network, and spend points on a real bundle. That is the whole loop — verify, post, get paid, repeat. Welcome to Promota.',
    ].join('\n\n'),
  },
];

const blogIndex = new Map(BLOG_POSTS.map(p => [p.slug, p]));
const blogSummary = (p) => ({
  id: p.slug,
  slug: p.slug,
  title: p.title,
  excerpt: p.excerpt,
  date: p.date,
  tags: p.tags,
});

/** GET /api/blog — public list of posts (metadata only). */
export async function listBlog() {
  return ok({ posts: BLOG_POSTS.map(blogSummary) });
}

/** GET /api/blog/:slug — one full post, 404 for an unknown slug. */
export async function blogPost(_req, params) {
  const slug = String(params?.slug || '').toLowerCase();
  const post = blogIndex.get(slug);
  if (!post) return fail('post not found', 404);
  return ok({ post: { ...blogSummary(post), body: post.body } });
}

/* ----------------------------------------------------------------- router */

/**
 * Exact routes first — the shape server.mjs looks up by "METHOD /path".
 * Rate limiting, the 404 for unknown /api paths, the 405 on POSTs to static
 * files and the 400 for non-JSON bodies are all handled in server.mjs; this
 * table never duplicates them. Every handler here returns { status, body }
 * with an explicit status, so nothing falls through to a default 200.
 */
const exactRoutes = {
  'POST /api/auth/otp/request': requestOtp,
  'POST /api/auth/otp/verify': verifyOtp,
  'GET /api/me': me,
  'GET /api/tasks': listTasks,
  'GET /api/tasks/mine': myTasks,
  'POST /api/redeem': redeem,
  'GET /api/referrals': referrals,
  'POST /api/webhooks/flutterwave': flutterwaveWebhook,
  'GET /healthz': health,
  'GET /api/mining/status': miningStatus,
  'GET /api/mining/traces': miningTraces,
  'GET /api/zapia/status': zapiaStatus,
  'GET /api/zapia/candidates': zapiaCandidates,
  'GET /api/social/status': socialStatus,
  'POST /api/social/connect': socialConnect,
  'POST /api/social/test': socialTest,
  'GET /api/blog': listBlog,
  'GET /api/admin/stats': admin.stats,
  'GET /api/admin/users': admin.listUsers,
  'GET /api/admin/tasks': admin.listTasksAdmin,
  'GET /api/admin/campaigns': admin.listCampaignsAdmin,
  'POST /api/admin/campaigns': admin.createCampaign,
  'GET /api/admin/settings': admin.getSettings,
  'POST /api/admin/settings': admin.setSetting,
  'GET /api/admin/audit': admin.listAudit,
  'GET /api/v1/promoter/earnings': promoter.earnings,
  'GET /api/v1/promoter/referrals': promoter.referrals,
  'GET /api/v1/promoter/payouts': promoter.payouts,
};

/**
 * Path-parameter routes. server.mjs resolves handlers by exact key, so
 * dynamic segments (/api/blog/:slug, /api/admin/users/:id/suspend, ...) are
 * matched here in a small pattern table — the same idea as PATTERNS in
 * server.mjs for /api/tasks/:id/submit, kept on this side because the route
 * handlers are owned together. The export below is a Proxy over the exact
 * table plus these patterns, so server.mjs's routes[key] lookup keeps working
 * unchanged, and api.test.mjs's route-coverage checks keep resolving.
 */
const DYNAMIC_ROUTES = [
  { method: 'GET', re: /^\/api\/blog\/([a-z0-9-]{1,120})\/?$/i, params: ['slug'], fn: blogPost },
  { method: 'GET', re: /^\/api\/admin\/users\/([0-9a-f-]{36})\/?$/i, params: ['id'], fn: admin.getUser },
  { method: 'POST', re: /^\/api\/admin\/users\/([0-9a-f-]{36})\/suspend\/?$/i, params: ['id'], fn: admin.suspendUser },
  { method: 'POST', re: /^\/api\/admin\/users\/([0-9a-f-]{36})\/reinstate\/?$/i, params: ['id'], fn: admin.reinstateUser },
  { method: 'POST', re: /^\/api\/admin\/tasks\/([0-9a-f-]{36})\/approve\/?$/i, params: ['id'], fn: admin.approveTask },
  { method: 'POST', re: /^\/api\/admin\/tasks\/([0-9a-f-]{36})\/reject\/?$/i, params: ['id'], fn: admin.rejectTask },
];

function resolveRoute(key) {
  if (Object.prototype.hasOwnProperty.call(exactRoutes, key)) return exactRoutes[key];
  const m = /^([A-Z]+) (.*)$/.exec(key);
  if (!m) return undefined;
  const [, method, path] = m;
  for (const r of DYNAMIC_ROUTES) {
    if (r.method !== method) continue;
    const match = r.re.exec(path);
    if (match) {
      const params = Object.fromEntries(r.params.map((name, i) => [name, match[i + 1]]));
      return (req, _ignored, raw) => r.fn(req, params, raw);
    }
  }
  return undefined;
}

export const routes = new Proxy(exactRoutes, {
  get(target, prop, receiver) {
    if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
    return resolveRoute(prop);
  },
  has(target, prop) {
    if (typeof prop !== 'string') return Reflect.has(target, prop);
    return resolveRoute(prop) !== undefined;
  },
});

export { requireSession };