/**
 * business.mjs — the self-serve creation + verification surface.
 *
 * What lives here:
 *   1. campaign-owner verification (individual or business). A profile cannot
 *      create a campaign before its campaign_owners row is VERIFIED by an
 *      admin — this is the "verify both businesses and individuals" gate.
 *   2. POST /api/v1/campaigns — a verified owner submits a campaign in
 *      'review' state with its draft tasks (the engagement actions:
 *      post/like/comment/follow/subscribe/repost/share/view/join_channel).
 *      Nothing goes live here and no money moves; the admin confirm + escrow
 *      funding guard does that, exactly as 0001 core enforces.
 *   3. promoter payout KYC: basic (legal name + bank last4 -> tier t1) and
 *      identity (NIN/BVN -> HMAC-only store + age 18+ gate -> admin can
 *      promote to t2). The raw identity number is NEVER stored or logged.
 *
 * All money/points business rules stay in the database migrations; this
 * module only validates arguments and moves rows.
 */
import * as session from './session.mjs';
import * as sb from './supabase.mjs';
import crypto from 'node:crypto';

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400, extra = {}) => ({ status, body: { error: message, ...extra } });

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Delivery actions Promota may sell.
 *
 * Paid likes, comments, follows, subscribes, views, channel joins and
 * shared-link reposts are prohibited engagement on Meta, TikTok, YouTube,
 * X and LinkedIn, and FTC 16 CFR Part 465 bans buying or selling fake
 * social-media indicators. The database gate in 0018 enforces the same
 * list; this constant exists so the API can refuse with a clear message
 * before the insert is attempted.
 */
export const CAMPAIGN_ACTIONS = ['post', 'repost', 'share', 'review'];

/** The only delivery classes the product may sell. */
export const TASK_POLICY = {
  post: 'content',
  repost: 'distribution',
  share: 'distribution',
  review: 'review',
};

/** Actions that are refused outright. Kept named so the refusal is honest. */
export const PROHIBITED_ACTIONS = [
  'like', 'comment', 'follow', 'subscribe', 'view', 'join_channel',
];

/** Must equal current_task_policy_version() in migration 0018. */
export const TASK_POLICY_VERSION = '2026-10-26';

const ACTION_LABELS = {
  post: 'Original post',
  repost: 'Brand content post',
  share: 'Brand content post',
  review: 'Verified-purchase review',
};

const DISCLOSURE_RE = /^#[A-Za-z0-9_]{2,30}$/;

/** Campaign objective: the business intent behind the campaign. 'repost'
 *  pays through the rated-repost flow: a reviewer scores the submission
 *  1-5 and a rating below repost.min_rating_full scales the payout. */
const OBJECTIVES = ['click', 'signup', 'code', 'api_post', 'repost'];

const PLATFORMS = ['whatsapp', 'telegram', 'x', 'instagram', 'tiktok', 'facebook', 'youtube', 'other'];

async function requireSession(req) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return null;
  const rows = await sb.select('profiles', `id=eq.${claims.sub}&select=id,state,role`);
  const profile = rows?.[0];
  if (!profile || profile.state !== 'active') return null;
  return { ...claims, role: profile.role, state: profile.state };
}

function trim(v, max = 240) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

function httpUrl(v, max = 500) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  return s.slice(0, max);
}

function num(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

const mapOwner = (o) => ({
  id: o.id,
  kind: o.kind,
  displayName: o.display_name,
  businessName: o.business_name,
  businessReg: o.business_reg,
  website: o.website,
  contact: o.contact,
  verificationState: o.verification_state,
  verificationNote: o.verification_note,
  verifiedAt: o.verified_at,
  createdAt: o.created_at,
});

const mapTaskInput = (t) => {
  const actionType = t.action_type ?? t.actionType ?? 'post';
  return {
    caption: t.caption,
    trackedLink: t.tracked_link ?? t.trackedLink ?? null,
    disclosureTag: t.disclosure_tag ?? t.disclosureTag ?? null,
    actionType,
    policyClass: t.policy_class ?? t.policyClass ?? TASK_POLICY[actionType] ?? null,
    attributionCode: t.attribution_code ?? t.attributionCode ?? null,
    releaseAt: t.release_at ?? t.releaseAt ?? null,
    verifiedPurchaseRequired: t.review_verified_purchase ?? t.verifiedPurchase ?? false,
    points: t.points_awarded ?? t.points ?? null,
    rewardMinor: t.reward_minor ?? t.rewardMinor ?? null,
    viewsRequired: t.views_required ?? t.viewsRequired ?? null,
  };
};

/* ------------------------------------------------- campaign-owner verification */

/**
 * POST /api/v1/campaign-owners — submit (or update a still-pending) owner
 * verification request. A VERIFIED owner cannot un-verify themselves here.
 */
export async function submitCampaignOwner(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const b = req.body || {};
  const kind = String(b.kind || '').toLowerCase();
  if (!['individual', 'business'].includes(kind)) {
    return fail('kind must be "individual" or "business"');
  }
  const displayName = trim(b.displayName, 120);
  const contact = trim(b.contact, 160);
  if (!displayName) return fail('a display name is required');
  if (!contact) return fail('a contact (phone/email/social handle) is required');

  const businessName = trim(b.businessName, 200);
  const businessReg = trim(b.businessReg, 60);
  const website = httpUrl(b.website);
  if (kind === 'business' && !businessName) return fail('a business name is required');
  if (kind === 'individual' && businessName) {
    return fail('an individual owner must not carry a business name', 400);
  }

  const [existing] = await sb.select(
    'campaign_owners',
    `profile_id=eq.${auth.sub}&select=id,verification_state`
  );

  const patch = {
    kind,
    display_name: displayName,
    business_name: businessName,
    business_reg: kind === 'business' ? businessReg : null,
    website,
    contact,
    verification_state: 'pending',
    verification_note: null,
    verified_at: null,
    reviewer_id: null,
    updated_at: new Date().toISOString(),
  };

  let rows;
  try {
    if (existing) {
      if (existing.verification_state === 'verified') {
        return fail('your owner record is already verified', 409);
      }
      rows = await sb.update('campaign_owners', `profile_id=eq.${auth.sub}`, patch);
    } else {
      rows = await sb.insert('campaign_owners', { profile_id: auth.sub, ...patch });
    }
  } catch (e) {
    const m = String(e.message || e);
    if (/business_named|campaign_owners_/.test(m)) return fail(`verification refused: ${m.slice(0, 160)}`);
    throw e;
  }

  return ok({ owner: mapOwner(rows?.[0] || { ...patch, id: null, created_at: null }) }, 201);
}

/** GET /api/v1/campaign-owner — this profile's owner row (or none). */
export async function getMineOwner(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const [owner] = await sb.select('campaign_owners', `profile_id=eq.${auth.sub}&select=*`);
  return ok({ owner: owner ? mapOwner(owner) : null });
}

/* -------------------------------------------------- self-serve campaign create */

/**
 * POST /api/v1/campaigns — create campaign (state 'review') + its draft
 * tasks in one shot. Requires a VERIFIED campaign owner. Tasks are created
 * 'draft' and only become claimable once the campaign is LIVE after admin
 * confirm + escrow funding.
 */
export async function createCampaignSelfServe(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const [owner] = await sb.select(
    'campaign_owners',
    `profile_id=eq.${auth.sub}&select=id,verification_state,kind,display_name,business_name`
  );
  if (!owner || owner.verification_state !== 'verified') {
    return fail('campaign owner verification is required first', 403);
  }

  const b = req.body || {};
  const title = trim(b.title, 200);
  const platform = trim(b.platform, 60);
  const objective = trim(b.objective, 30);
  const brief = trim(b.brief, 2000);
  if (!title) return fail('a campaign title is required');
  if (!platform) return fail('a platform is required');
  if (!OBJECTIVES.includes(objective)) return fail(`objective must be one of: ${OBJECTIVES.join(', ')}`);

  const budgetMinor = num(b.budgetMinor);
  const pricePerOutcomeMinor = num(b.pricePerOutcomeMinor);
  if (!budgetMinor || budgetMinor <= 0) return fail('budgetMinor must be a positive whole number of kobo');
  if (!pricePerOutcomeMinor || pricePerOutcomeMinor <= 0) {
    return fail('pricePerOutcomeMinor must be a positive whole number of kobo');
  }
  const promoterShareBp = num(b.promoterShareBp) ?? 7000;
  const fraudReserveBp = num(b.fraudReserveBp) ?? 500;
  const marginFloorBp = num(b.marginFloorBp) ?? 0;
  const holdHours = num(b.holdHours) ?? 72;
  const autoPausePct = num(b.autoPausePct) ?? 90;
  if (!(promoterShareBp >= 0 && promoterShareBp <= 10000)) return fail('promoterShareBp must be 0..10000');
  if (!(fraudReserveBp >= 0 && fraudReserveBp <= 10000)) return fail('fraudReserveBp must be 0..10000');
  if (!(marginFloorBp >= 0 && marginFloorBp <= 10000)) return fail('marginFloorBp must be 0..10000');
  if (promoterShareBp + fraudReserveBp > 10000) return fail('promoterShareBp + fraudReserveBp cannot exceed 10000');
  if (!(holdHours >= 48 && holdHours <= 72)) return fail('holdHours must be 48..72');
  if (!(autoPausePct >= 50 && autoPausePct <= 100)) return fail('autoPausePct must be 50..100');

  const taskList = Array.isArray(b.tasks) ? b.tasks : [];
  if (!taskList.length || taskList.length > 10) {
    return fail('a campaign needs 1..10 tasks');
  }
  const cleaned = taskList.map((t) => {
    const caption = trim(t?.caption, 300);
    const trackedLink = httpUrl(t?.trackedLink);
    const actionType = trim(t?.actionType, 24) || 'post';
    const points = num(t?.points);
    const viewsRequired = num(t?.viewsRequired);
    const disclosureTag = trim(t?.disclosureTag, 40) || '#ad';
    const releaseRaw = String(t?.releaseAt ?? '').trim();
    const releaseAt = releaseRaw ? new Date(releaseRaw) : null;
    return {
      caption,
      trackedLink,
      actionType,
      disclosureTag,
      points: points && points > 0 ? points : null,
      viewsRequired: viewsRequired != null ? Math.min(viewsRequired, 2_000_000_000) : null,
      verifiedPurchase: t?.verifiedPurchase === true,
      releaseAt: releaseAt && !Number.isNaN(releaseAt.getTime()) ? releaseAt.toISOString() : null,
    };
  });
  for (const t of cleaned) {
    if (!t.caption) return fail('every task needs a caption');
    if (!t.trackedLink) return fail('every task needs a tracked link (https)');
    if (PROHIBITED_ACTIONS.includes(t.actionType)) {
      return fail(
        `"${t.actionType}" is not offered. Paid likes, comments, follows, subscribes, views, `
        + 'paid sharing of a specific post or link, and channel joins are prohibited '
        + 'engagement on every platform we serve. '
        + `Use one of: ${CAMPAIGN_ACTIONS.join(', ')}.`,
        422,
      );
    }
    if (!CAMPAIGN_ACTIONS.includes(t.actionType)) {
      return fail(`task actionType must be one of: ${CAMPAIGN_ACTIONS.join(', ')}`);
    }
    if (!DISCLOSURE_RE.test(t.disclosureTag)) {
      return fail('disclosureTag must be a single tag such as #ad or #sponsored');
    }
    if (t.actionType === 'review' && !t.verifiedPurchase) {
      return fail('a review task requires verifiedPurchase: true — the creator must have received the product', 422);
    }
    if (t.points && t.points > 100000) return fail('a task cannot pay more than 100000 points');
  }

  let campaign;
  try {
    [campaign] = await sb.insert('campaigns', {
      owner_id: auth.sub,
      title,
      brief,
      platform,
      objective,
      state: 'review',
      budget_minor: budgetMinor,
      price_per_outcome_minor: pricePerOutcomeMinor,
      promoter_share_bp: promoterShareBp,
      fraud_reserve_bp: fraudReserveBp,
      margin_floor_bp: marginFloorBp,
      hold_hours: holdHours,
      auto_pause_pct: autoPausePct,
    });
  } catch (e) {
    const m = String(e.message || e);
    if (/margin below floor|share_sane|budget_minor|price_per_outcome/.test(m)) {
      return fail(`campaign refused: ${m.slice(0, 160)}`);
    }
    throw e;
  }
  if (!campaign) return fail('campaign was not created', 500);

  await sb.insert('tasks', cleaned.map((t) => ({
    campaign_id: campaign.id,
    state: 'draft',
    caption: t.caption,
    tracked_link: t.trackedLink,
    disclosure_tag: t.disclosureTag,
    action_type: t.actionType,
    policy_class: TASK_POLICY[t.actionType],
    policy_version: TASK_POLICY_VERSION,
    review_verified_purchase: t.verifiedPurchase,
    release_at: t.releaseAt || new Date().toISOString(),
    points_awarded: t.points,
    reward_minor: pricePerOutcomeMinor,
    views_required: t.viewsRequired,
  })));

  return ok({
    campaign: {
      id: campaign.id,
      title: campaign.title,
      state: campaign.state,
      platform: campaign.platform,
      objective: campaign.objective,
      budgetMinor: campaign.budget_minor,
      owner: owner.display_name,
    },
    tasks: cleaned.map(mapTaskInput),
    nextStep: 'await admin confirm, then fund escrow before it can go live',
  }, 201);
}

/* ------------------------------------------------------------ task policy */

/**
 * GET /api/policy — the delivery policy the dashboard renders and the
 * version a creator must acknowledge before claim_task() will assign work.
 */
export async function getTaskPolicy(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select('profiles', `id=eq.${auth.sub}&select=policy_ack_version,policy_ack_at`);
  const profile = rows?.[0] || {};

  return ok({
    version: TASK_POLICY_VERSION,
    acknowledged: profile.policy_ack_version === TASK_POLICY_VERSION,
    acknowledgedAt: profile.policy_ack_at || null,
    allowedActions: CAMPAIGN_ACTIONS.map((value) => ({
      value,
      policyClass: TASK_POLICY[value],
      label: ACTION_LABELS[value],
    })),
    prohibitedActions: PROHIBITED_ACTIONS,
    rules: [
      'Paid content must be disclosed with the campaign tag and the platform branded-content toggle where the platform has one.',
      'Never post the same link in bulk: each task carries its own attribution code.',
      'A review is only offered for a product the creator actually received, and the payment never depends on it being positive.',
      'No passwords, no automation, no scraping, no platform credentials — ever.',
    ],
  });
}

/** POST /api/policy/ack { version } — recorded once per policy version. */
export async function ackTaskPolicy(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const version = String(req.body?.version ?? '').trim();
  if (version !== TASK_POLICY_VERSION) {
    return fail(`the current policy is version ${TASK_POLICY_VERSION}; reload before acknowledging`, 409, {
      version: TASK_POLICY_VERSION,
    });
  }

  try {
    await sb.rpc('ack_task_policy', { p_profile: auth.sub, p_version: version });
  } catch (e) {
    return fail(`acknowledgement refused: ${String(e.message || e).slice(0, 160)}`, 400);
  }

  return ok({ acknowledged: true, version, acknowledgedAt: new Date().toISOString() });
}

/* ------------------------------------------------------------------ kyc */

/** POST /api/v1/kyc/basic — legal name + bank last4 -> payout-ready tier t1. */
export async function kycBasic(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const b = req.body || {};
  const legalName = trim(b.legalName, 120);
  const bankName = trim(b.bankName, 120);
  const bankLast4 = String(b.bankLast4 ?? '').trim();
  if (!legalName || !/^[A-Za-z][A-Za-z .'-]{1,119}$/.test(legalName)) {
    return fail('a legal full name is required');
  }
  if (!bankName) return fail('a bank name is required');
  if (!/^[0-9]{4}$/.test(bankLast4)) return fail('bank account must be the LAST 4 digits only');

  await sb.update('profiles', `id=eq.${auth.sub}`, {
    legal_name: legalName,
    bank_name: bankName,
    bank_last4: bankLast4,
    updated_at: new Date().toISOString(),
  });

  const [profile] = await sb.select('profiles', `id=eq.${auth.sub}&select=kyc_tier`);
  return ok({ kycTier: profile?.kyc_tier || 't1', bankLast4 }, 200);
}

/**
 * POST /api/v1/kyc/identity — NIN or BVN. Stored as an HMAC fingerprint
 * ONLY (identity_ref), never as a raw number; DOB drives the 18+ gate.
 */
export async function kycIdentity(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const b = req.body || {};
  const idType = String(b.idType || '').toUpperCase();
  const idValue = String(b.idValue ?? '').trim();
  const dob = String(b.dob || '').trim();

  if (!['NIN', 'BVN'].includes(idType)) return fail('idType must be NIN or BVN');
  if (!/^[0-9]{11}$/.test(idValue)) return fail('a NIN or BVN is 11 digits');
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dob)) return fail('date of birth must be YYYY-MM-DD');

  const born = Date.parse(dob);
  if (Number.isNaN(born)) return fail('date of birth must be YYYY-MM-DD');
  const eighteen = Date.now() - 18 * 365.25 * 24 * 3600 * 1000;
  if (born > eighteen) return fail('you must be 18 or older for identity KYC', 403);

  const secret = (process.env.SESSION_SECRET || '').trim();
  if (!secret) return fail('identity store is not configured', 503);

  const fingerprint = crypto
    .createHmac('sha256', secret)
    .update(`${idType}:${idValue}`)
    .digest('hex');

  await sb.update('profiles', `id=eq.${auth.sub}`, {
    identity_ref: `hmac-sha256:${fingerprint}`,
    age_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const [profile] = await sb.select('profiles', `id=eq.${auth.sub}&select=kyc_tier`);
  return ok({
    kycTier: profile?.kyc_tier || 't1',
    identity: `hmac:${fingerprint.slice(0, 8)}…`,
    ageVerified: true,
  }, 200);
}
