/**
 * promotion.mjs -- "Promote You": members promote each other.
 *
 * A member publishes a promo card for themselves. Two members agree to
 * promote each other; each delivers one disclosed post on their own channel;
 * an admin approves each side; both are paid in points, and the pair earns a
 * mutual bonus only when BOTH sides have delivered approved work.
 *
 * Handlers are thin on purpose (same law as routes.mjs): they validate shape,
 * call a Postgres function, and return a status. Every rule that can be
 * broken lives in 0020_mutual_promotion.sql -- self-promotion, duplicate
 * pairs, the wrong accepter, promoting your own card, the caps, the deadline,
 * idempotent points and the audit trail. A caller cannot reach around them
 * because the API passes its own verified session id, never a client id.
 *
 * Points are minted only inside review_promo_delivery(); this file never adds
 * or computes a point value.
 */
import * as sb from './supabase.mjs';
import * as session from './session.mjs';

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400, extra = {}) => ({ status, body: { error: message, ...extra } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set(['business', 'creator', 'person', 'cause']);
const PLATFORMS = new Set([
  'instagram', 'tiktok', 'x', 'facebook', 'youtube',
  'whatsapp', 'telegram', 'linkedin', 'other',
]);
// The app speaks hashtags; the database stores the enum value.
const DISCLOSURES = new Map([
  ['ad', 'ad'], ['#ad', 'ad'],
  ['sponsored', 'sponsored'], ['#sponsored', 'sponsored'],
  ['paid_partnership', 'paid_partnership'], ['paid partnership', 'paid_partnership'],
]);

function str(value, max) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function httpsUrl(value, max = 500) {
  const raw = str(value, max);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Same gate as promoter.mjs: signature + a live, active profile. */
async function requireSession(req) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return null;
  const rows = await sb.select('profiles', `id=eq.${claims.sub}&select=id,state,role,kyc_tier`);
  const profile = rows?.[0];
  if (!profile || profile.state !== 'active') return null;
  return { ...claims, role: profile.role, state: profile.state, kycTier: profile.kyc_tier };
}

/** Admin gate for moderation -- the same roles admin.mjs accepts. */
async function requireAdmin(req, roles = ['admin', 'owner', 'support']) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return { error: fail('sign in required', 401) };
  const rows = await sb.select('profiles', `id=eq.${claims.sub}&select=id,role,state`);
  const profile = rows?.[0];
  if (!profile || profile.state !== 'active') return { error: fail('sign in required', 401) };
  if (!roles.includes(profile.role)) return { error: fail('admin access required', 403) };
  return { auth: { sub: claims.sub, role: profile.role } };
}

/**
 * Turn a Postgres refusal into an HTTP status without leaking SQL detail.
 * The function prefix sb.rpc() adds is stripped so the member reads the rule,
 * not the name of the function that enforced it.
 */
function dbFailure(e, fn) {
  const raw = String(e?.message || e);
  const message = raw.replace(new RegExp(`^${fn}:\\s*`), '').split('\n')[0].slice(0, 300);
  if (/not found/i.test(message)) return fail(message, 404);
  if (/permission|privilege|not part of|only the invited|own promotion card/i.test(message)) {
    return fail(message, 403);
  }
  return fail(message, 409);
}

function query(req) {
  try { return new URL(req.url || '/', 'http://localhost').searchParams; }
  catch { return new URLSearchParams(); }
}

function intParam(sp, name, def, min, max) {
  const n = Number(sp.get(name));
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  return Math.min(max, Math.max(min, i));
}

/* ------------------------------------------------------------- promoter */

/** GET /api/v1/promotion/cards -- active cards from other members. */
export async function listCards(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const sp = query(req);
  const category = str(sp.get('category'), 40);
  const city = str(sp.get('city'), 80);
  const limit = intParam(sp, 'limit', 30, 1, 50);

  let filter = `state=eq.active&owner_id=neq.${auth.sub}`
    + '&select=id,owner_id,kind,title,summary,link_url,media_url,category,city,state_code,created_at'
    + `&order=created_at.desc&limit=${limit}`;
  if (category) filter += `&category=eq.${encodeURIComponent(category)}`;
  if (city) filter += `&city=eq.${encodeURIComponent(city)}`;

  const rows = await sb.select('promo_cards', filter);
  return ok({
    cards: (rows || []).map(r => ({
      id: r.id,
      ownerId: r.owner_id,
      kind: r.kind,
      title: r.title,
      summary: r.summary,
      linkUrl: r.link_url,
      mediaUrl: r.media_url,
      category: r.category,
      city: r.city,
      stateCode: r.state_code,
      createdAt: r.created_at,
    })),
  });
}

/** POST /api/v1/promotion/cards -- publish your own card for review. */
export async function createCard(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const b = req.body || {};
  const kind = str(b.kind, 20) || 'person';
  if (!KINDS.has(kind)) return fail('kind must be business, creator, person or cause');

  const title = str(b.title, 120);
  const summary = str(b.summary, 600);
  const linkUrl = httpsUrl(b.linkUrl);
  const mediaUrl = b.mediaUrl ? httpsUrl(b.mediaUrl) : null;

  if (title.length < 3) return fail('a title of at least 3 characters is required');
  if (summary.length < 10) return fail('a summary of at least 10 characters is required');
  if (!linkUrl) return fail('an https link is required');
  if (b.mediaUrl && !mediaUrl) return fail('the media URL must be an https link');

  const row = {
    owner_id: auth.sub,
    kind,
    state: 'review',
    title,
    summary,
    link_url: linkUrl,
    media_url: mediaUrl,
    category: str(b.category, 40) || null,
    city: str(b.city, 80) || null,
    state_code: str(b.stateCode, 40) || null,
    disclosure_required: b.disclosureRequired !== false,
  };

  let inserted;
  try {
    inserted = await sb.insert('promo_cards', row);
  } catch (e) {
    // the trigger's messages are written for the member; a duplicate link is
    // the one case PostgREST answers with a raw constraint name
    const raw = String(e?.message || e);
    if (/duplicate key|unique/i.test(raw)) return fail('you already have a card with that link');
    return dbFailure(e, 'promo_cards');
  }
  const card = Array.isArray(inserted) ? inserted[0] : inserted;
  return ok({ id: card?.id, state: card?.state || 'review' }, 201);
}

/** GET /api/v1/promotion/cards/mine */
export async function myCards(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select('promo_cards',
    `owner_id=eq.${auth.sub}`
    + '&select=id,kind,state,title,summary,link_url,media_url,category,city,state_code,moderation_note,approved_at,created_at'
    + '&order=created_at.desc&limit=50');

  return ok({
    cards: (rows || []).map(r => ({
      id: r.id,
      kind: r.kind,
      state: r.state,
      title: r.title,
      summary: r.summary,
      linkUrl: r.link_url,
      mediaUrl: r.media_url,
      category: r.category,
      city: r.city,
      stateCode: r.state_code,
      moderationNote: r.moderation_note,
      approvedAt: r.approved_at,
      createdAt: r.created_at,
    })),
  });
}

/** GET /api/v1/promotion/pairs -- my pairs, both sides and their deliveries. */
export async function myPairs(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select('promo_pairs',
    `or=(profile_a.eq.${auth.sub},profile_b.eq.${auth.sub})`
    + '&select=id,card_a_id,card_b_id,profile_a,profile_b,state,proposed_by,accepted_at,delivery_deadline,completed_at,created_at'
    + '&order=created_at.desc&limit=50');
  const pairs = rows || [];
  if (!pairs.length) return ok({ pairs: [] });

  const cardIds = [...new Set(pairs.flatMap(p => [p.card_a_id, p.card_b_id]))];
  const pairIds = pairs.map(p => p.id);
  const [cards, deliveries] = await Promise.all([
    sb.select('promo_cards',
      `id=in.(${cardIds.join(',')})&select=id,owner_id,kind,title,summary,link_url,media_url,category,city`),
    sb.select('promo_deliveries',
      `pair_id=in.(${pairIds.join(',')})`
      + '&select=id,pair_id,profile_id,card_id,platform,post_url,disclosure,state,points_awarded,reject_reason,created_at'),
  ]);

  const cardById = new Map((cards || []).map(c => [c.id, c]));
  const deliveriesByPair = new Map();
  for (const d of deliveries || []) {
    if (!deliveriesByPair.has(d.pair_id)) deliveriesByPair.set(d.pair_id, []);
    deliveriesByPair.get(d.pair_id).push(d);
  }

  return ok({
    pairs: pairs.map(p => {
      const meIsA = p.profile_a === auth.sub;
      const myCardId = meIsA ? p.card_a_id : p.card_b_id;
      const partnerCardId = meIsA ? p.card_b_id : p.card_a_id;
      const partnerId = meIsA ? p.profile_b : p.profile_a;
      const mine = cardById.get(myCardId) || null;
      const partner = cardById.get(partnerCardId) || null;
      return {
        id: p.id,
        state: p.state,
        role: meIsA ? 'proposer' : 'invitee',
        proposedByMe: p.proposed_by === auth.sub,
        partnerId,
        myCard: mine && {
          id: mine.id, kind: mine.kind, title: mine.title, summary: mine.summary,
          linkUrl: mine.link_url, mediaUrl: mine.media_url,
        },
        partnerCard: partner && {
          id: partner.id, kind: partner.kind, title: partner.title, summary: partner.summary,
          linkUrl: partner.link_url, mediaUrl: partner.media_url,
        },
        acceptedAt: p.accepted_at,
        deliveryDeadline: p.delivery_deadline,
        completedAt: p.completed_at,
        createdAt: p.created_at,
        deliveries: (deliveriesByPair.get(p.id) || []).map(d => ({
          id: d.id,
          profileId: d.profile_id,
          mine: d.profile_id === auth.sub,
          platform: d.platform,
          postUrl: d.post_url,
          disclosure: d.disclosure,
          state: d.state,
          points: d.points_awarded,
          rejectReason: d.reject_reason,
          createdAt: d.created_at,
        })),
      };
    }),
  });
}

/** POST /api/v1/promotion/pairs  { selfCardId, partnerCardId } */
export async function proposePair(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const selfCardId = String(req.body?.selfCardId || '');
  const partnerCardId = String(req.body?.partnerCardId || '');
  if (!UUID_RE.test(selfCardId)) return fail('your card id is required');
  if (!UUID_RE.test(partnerCardId)) return fail('the partner card id is required');

  try {
    const id = await sb.rpc('propose_promo_pair', {
      p_actor: auth.sub,
      p_self_card: selfCardId,
      p_partner_card: partnerCardId,
    });
    return ok({ id, state: 'proposed' }, 201);
  } catch (e) {
    return dbFailure(e, 'propose_promo_pair');
  }
}

/** POST /api/v1/promotion/pairs/:id/accept */
export async function acceptPair(req, params) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a pair id is required');

  try {
    await sb.rpc('accept_promo_pair', { p_pair: id, p_actor: auth.sub });
    return ok({ id, state: 'active' });
  } catch (e) {
    return dbFailure(e, 'accept_promo_pair');
  }
}

/** POST /api/v1/promotion/pairs/:id/deliver  { platform, postUrl, disclosure, evidence } */
export async function submitDelivery(req, params) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a pair id is required');

  const platform = str(req.body?.platform, 20).toLowerCase();
  const postUrl = httpsUrl(req.body?.postUrl);
  const disclosure = DISCLOSURES.get(str(req.body?.disclosure, 30).toLowerCase());

  if (!PLATFORMS.has(platform)) return fail('choose a supported platform');
  if (!postUrl) return fail('the post URL must be an https link');
  if (!disclosure) return fail('a disclosure is required (#ad, #sponsored or paid partnership)');

  const evidence = req.body?.evidence;
  if (evidence != null && (typeof evidence !== 'object' || Array.isArray(evidence))) {
    return fail('evidence must be an object');
  }
  if (evidence && JSON.stringify(evidence).length > 4000) {
    return fail('evidence is too large');
  }

  try {
    const deliveryId = await sb.rpc('submit_promo_delivery', {
      p_pair: id,
      p_actor: auth.sub,
      p_platform: platform,
      p_post_url: postUrl,
      p_disclosure: disclosure,
      p_evidence: evidence || {},
    });
    return ok({ id: deliveryId, state: 'submitted' }, 201);
  } catch (e) {
    return dbFailure(e, 'submit_promo_delivery');
  }
}

/* ---------------------------------------------------------------- admin */

/** GET /api/v1/admin/promotion/cards?state=review */
export async function adminListCards(req) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const sp = query(req);
  const state = str(sp.get('state'), 20) || 'review';
  if (!['draft', 'review', 'active', 'paused', 'closed', 'rejected'].includes(state)) {
    return fail('unknown card state');
  }
  const limit = intParam(sp, 'limit', 50, 1, 100);

  const rows = await sb.select('promo_cards',
    `state=eq.${state}`
    + '&select=id,owner_id,kind,state,title,summary,link_url,media_url,category,city,state_code,created_at'
    + `&order=created_at.asc&limit=${limit}`);
  return ok({ cards: rows || [] });
}

/** POST /api/v1/admin/promotion/cards/:id/review  { approve, note } */
export async function adminReviewCard(req, params) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a card id is required');
  if (typeof req.body?.approve !== 'boolean') return fail('approve must be true or false');
  const note = str(req.body?.note, 300) || null;

  try {
    const state = await sb.rpc('review_promo_card', {
      p_card: id,
      p_actor: gate.auth.sub,
      p_approve: req.body.approve,
      p_note: note,
    });
    return ok({ id, state });
  } catch (e) {
    return dbFailure(e, 'review_promo_card');
  }
}

/** GET /api/v1/admin/promotion/deliveries?state=submitted */
export async function adminListDeliveries(req) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const sp = query(req);
  const state = str(sp.get('state'), 20) || 'submitted';
  if (!['submitted', 'approved', 'rejected'].includes(state)) {
    return fail('unknown delivery state');
  }
  const limit = intParam(sp, 'limit', 50, 1, 100);

  const rows = await sb.select('promo_deliveries',
    `state=eq.${state}`
    + '&select=id,pair_id,profile_id,card_id,platform,post_url,disclosure,evidence,state,points_awarded,reject_reason,created_at'
    + `&order=created_at.asc&limit=${limit}`);
  return ok({ deliveries: rows || [] });
}

/** POST /api/v1/admin/promotion/deliveries/:id/review  { approve, reason } */
export async function adminReviewDelivery(req, params) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  const id = String(params?.id || '');
  if (!UUID_RE.test(id)) return fail('a delivery id is required');
  if (typeof req.body?.approve !== 'boolean') return fail('approve must be true or false');
  const reason = str(req.body?.reason, 300) || null;

  if (!req.body.approve && (!reason || reason.length < 3)) {
    return fail('a rejection needs a reason of at least 3 characters');
  }

  try {
    const result = await sb.rpc('review_promo_delivery', {
      p_delivery: id,
      p_actor: gate.auth.sub,
      p_approve: req.body.approve,
      p_reason: reason,
    });
    return ok(result);
  } catch (e) {
    return dbFailure(e, 'review_promo_delivery');
  }
}

/** POST /api/v1/admin/promotion/expire -- housekeeping sweep. */
export async function adminExpirePairs(req) {
  const gate = await requireAdmin(req);
  if (gate.error) return gate.error;

  try {
    const expired = await sb.rpc('expire_promo_pairs', {});
    return ok({ expired });
  } catch (e) {
    return dbFailure(e, 'expire_promo_pairs');
  }
}
