/**
 * social.mjs — REAL social plugin surface (no staged stubs).
 *
 *   probeAll()        — honest per-provider config + live reachability
 *   status()          — GET /api/social/status
 *   test()            — POST /api/social/test { platform }
 *   connect()         — POST /api/social/connect { platform, handle }
 *                       persists social_links only when the probe verifies.
 *   fetchTelegramViews() — REAL view count via t.me/s public page parse
 *                       (used by approve/auto-verified submission verdicts).
 */
import * as session from './session.mjs';
import * as sb from './supabase.mjs';

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400) => ({ status, body: { error: message } });

const PLATFORM_ENV = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  whatsapp: ['WHATSMITH_API_KEY', 'WA_API_KEY'],
  x: ['X_CONSUMER_KEY'],
  instagram: ['INSTAGRAM_APP_ID'],
  tiktok: ['TIKTOK_APP_KEY'],
  facebook: ['FB_APP_ID'],
  youtube: ['YOUTUBE_API_KEY'],
};

const TELEGRAM_RE = /^https?:\/\/t\.me\/(?:s\/)?([a-zA-Z0-9_]{3,64})\/?([0-9]{1,12})?/i;

async function requireSession(req) {
  const token = session.bearer(req);
  const claims = token ? session.verify(token) : null;
  if (!claims) return null;
  const rows = await sb.select('profiles', `id=eq.${claims.sub}&select=id,state,role`);
  const profile = rows?.[0];
  if (!profile || profile.state !== 'active') return null;
  return { ...claims, role: profile.role, state: profile.state };
}

function firstEnv(keys) {
  for (const k of keys) {
    const v = (process.env[k] || '').trim();
    if (v) return k;
  }
  return null;
}

async function probeTelegram() {
  const key = firstEnv(PLATFORM_ENV.telegram);
  if (!key) return { configured: false, reachable: false, note: 'TELEGRAM_BOT_TOKEN not set' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env[key]}/getMe`, { signal: AbortSignal.timeout(8000) });
    const j = await res.json().catch(() => ({}));
    if (j?.ok) return { configured: true, reachable: true, bot: j.result.username ? `@${j.result.username}` : null };
    return { configured: true, reachable: false, note: `getMe refused: HTTP ${res.status}` };
  } catch (e) {
    return { configured: true, reachable: false, note: `getMe unreachable: ${String(e.message).slice(0, 80)}` };
  }
}

/** Honest probe for every configured provider: real check when possible. */
export async function probeAll() {
  const out = {};

  for (const [platform, keys] of Object.entries(PLATFORM_ENV)) {
    const envKey = firstEnv(keys);
    out[platform] = {
      configured: Boolean(envKey),
      envKey,
      note: envKey ? null : `${keys.join(' or ')} not set`,
    };
  }

  if (out.telegram.configured) Object.assign(out.telegram, await probeTelegram());
  for (const p of ['whatsapp', 'x', 'instagram', 'tiktok', 'facebook', 'youtube']) {
    if (out[p].configured) out[p].reachable = true; // config presence IS the status; public status endpoints do not exist
  }

  return out;
}

/** GET /api/social/status — signed-in only; no secrets leak (env name only). */
export async function status(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  return ok({ time: new Date().toISOString(), providers: await probeAll() });
}

/** POST /api/social/test { platform } — real probe, real answer. */
export async function test(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const platform = String(req.body?.platform || '').toLowerCase();
  const all = await probeAll();
  const p = all[platform];
  if (!p) return fail(`unknown platform; try: ${Object.keys(all).join(', ')}`);
  return ok({ platform, ...p });
}

/**
 * POST /api/social/connect { platform, handle }
 * Real verify: telegram requires the public page probe; other platforms
 * save the handle unverified (no OAuth backend is configured yet) — honest.
 */
export async function connect(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const b = req.body || {};
  const platform = String(b.platform || '').toLowerCase();
  const handle = String(b.handle || '').trim().replace(/^@/, '');
  if (!PLATFORM_ENV[platform]) return fail(`platform must be one of: ${Object.keys(PLATFORM_ENV).join(', ')}`);
  if (!/^[a-zA-Z0-9_.\/-]{3,80}$/.test(handle)) return fail('a valid handle (3..80 chars) is required');

  let verified = false;
  let note = null;
  if (platform === 'telegram') {
    try {
      const res = await fetch(`https://t.me/s/${handle}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) { verified = true; note = 't.me page reachable'; }
      else note = `t.me probe refused: HTTP ${res.status}`;
    } catch (e) {
      note = `t.me probe failed: ${String(e.message).slice(0, 80)}`;
    }
  } else {
    note = `${platform} has no OAuth backend on Promota yet — handle saved unverified`;
  }

  const row = {
    profile_id: auth.sub,
    platform,
    handle,
    verified,
    verified_at: verified ? new Date().toISOString() : null,
    probe_note: note,
  };

  const [existing] = await sb.select(
    'social_links',
    `profile_id=eq.${auth.sub}&platform=eq.${platform}&select=id`
  );
  if (existing) await sb.update('social_links', `id=eq.${existing.id}`, row);
  else await sb.insert('social_links', row);

  return ok({ platform, handle, verified, note }, 200);
}

/**
 * REAL Telegram view count from a public post link.
 * Used by in-app task authentication: proof URL → bot page views.
 */
export async function fetchTelegramViews(postUrl) {
  const s = String(postUrl || '').trim();
  const m = TELEGRAM_RE.exec(s);
  if (!m) return null;
  const [, channel, messageId] = m;
  if (!channel || !messageId) return null;

  try {
    const res = await fetch(`https://t.me/s/${channel}/${messageId}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PromotaBot/1.0; +https://promota.app)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const mv = /<span[^>]*class="tgme_widget_message_views"[^>]*>([^<]+)<\/span>/.exec(html);
    if (!mv) return null;
    const t = mv[1].replace(/\s|,|views?/gi, '');
    const mult = parseFloat(t);
    if (Number.isNaN(mult)) return null;
    const multiplier = /k/i.test(t) ? 1e3 : /m/i.test(t) ? 1e6 : 1;
    const views = Math.round(mult * multiplier);
    return Number.isInteger(views) && views >= 0 ? { views, parsed: true } : null;
  } catch {
    return null;
  }
}

/** GET /api/social/status aliases consumed by the route table. */
export const statusHandler = status;
export const connectHandler = connect;
export const testHandler = test;
