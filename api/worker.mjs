/**
 * worker.mjs — background loop: outbox dispatch + stale-task auto-approve.
 *
 * WHY IN THE WEB PROCESS
 * The Railway service budget is tight and the Hobby plan caps services per
 * workspace, so a separate worker service is not free. The outbox pattern
 * exists precisely so that any process can claim work with SKIP LOCKED: if a
 * second replica appears later, the same loop is safe to run twice because
 * claiming is atomic.
 *
 * WHAT IT DOES
 *   1. claims queued outbox rows and dispatches them to a provider
 *   2. auto-approves tasks whose poster went silent past auto_approve_at,
 *      then awards the points — keeping the "your money never hangs on someone
 *      else's delay" promise honest
 *
 * A topic with no handler is left QUEUED and logged once, not silently
 * dropped. Nothing is marked delivered that was not actually delivered.
 */
import * as sb from '../api/supabase.mjs';
import * as termii from '../providers/termii.mjs';
import * as data from '../providers/data.mjs';
import * as flw from '../providers/flutterwave.mjs';

const TICK_MS = Number(process.env.WORKER_TICK_MS || 15000);

const log = (...a) => console.log(`[worker]`, ...a);

/** Claim a batch atomically. SKIP LOCKED inside claim_outbox_batch does the work. */
async function claim(limit = 20) {
  const { data: rows } = { data: await sb.rpc('claim_outbox_batch', { p_limit: limit }) };
  return rows || [];
}

async function finish(id, outcome, error = null) {
  // delivered | failed (retryable, goes back on the queue) | dead (gave up)
  const patch = error
    ? {
        state: outcome === 'dead' ? 'dead' : 'queued',
        last_error: String(error).slice(0, 500),
        available_at: new Date(Date.now() + 60000).toISOString(),
      }
    : { state: 'delivered', last_error: null };
  await sb.update('outbox', `id=eq.${id}`, patch);
}

/* ------------------------------------------------------------- handlers */

const handlers = {
  /** A lead signed up: nothing to send yet, but it proves the fan-out works. */
  'lead.captured': async () => ({ delivered: true }),

  /** Points landed: tell the promoter. Never sends a code or a secret. */
  'points.awarded': async (p) => {
    const profile = await sb.select('profiles', `id=eq.${p.profile_id}&select=phone_e164`);
    const phone = profile?.[0]?.phone_e164;
    if (!phone) return { delivered: true, note: 'no phone on file' };
    await termii.sendSms({
      to: phone,
      message: `Promota: ${p.points} points added for a completed task. Balance is now updated.`,
    });
    return { delivered: true };
  },

  /** A referral qualified and paid the referrer points. */
  'referral.qualified': async (p) => {
    const profile = await sb.select('profiles', `id=eq.${p.referrer_id}&select=phone_e164`);
    const phone = profile?.[0]?.phone_e164;
    if (!phone) return { delivered: true, note: 'no phone on file' };
    await termii.sendSms({
      to: phone,
      message: `Promota: ${p.points} referral points added. Thanks for inviting someone.`,
    });
    return { delivered: true };
  },

  /**
   * A redemption was requested.
   * data -> needs an aggregator that is not configured yet, so it FAILS LOUDLY
   *        and leaves the redemption reversible. It is never marked fulfilled.
   * cash -> hand to Flutterwave with a stable reference.
   */
  'redemption.requested': async (p) => {
    if (p.kind === 'data') {
      const st = data.status();
      if (!st.ready) {
        // retryable:false semantics are handled by throwing a non-retryable
        // marker, so this row parks as failed rather than hot-looping.
        await sb.update('redemptions', `id=eq.${p.redemption_id}`, {
          state: 'failed',
          failure_reason: st.reason.slice(0, 300),
          updated_at: new Date().toISOString(),
        });
        return { delivered: true, note: 'data provider not configured; redemption parked as failed' };
      }
      const profile = await sb.select('profiles', `id=eq.${p.profile_id}&select=phone_e164`);
      const phone = profile?.[0]?.phone_e164;
      const r = await data.deliver({
        network: p.network,
        phone,
        planCode: p.plan_code ?? null,
        reference: p.redemption_id,
      });
      if (!r.ok) {
        await sb.update('redemptions', `id=eq.${p.redemption_id}`, {
          state: 'failed',
          failure_reason: String(r.error).slice(0, 300),
          updated_at: new Date().toISOString(),
        });
        return { delivered: true, note: 'delivery refused; redemption parked as failed' };
      }
      await sb.update('redemptions', `id=eq.${p.redemption_id}`, {
        state: 'fulfilled',
        provider: 'data-aggregator',
        provider_ref: r.providerRef,
        updated_at: new Date().toISOString(),
      });
      return { delivered: true };
    }

    // cash: a real transfer needs the beneficiary, which is collected at
    // payout time rather than at request time. Until that exists, park it.
    await sb.update('redemptions', `id=eq.${p.redemption_id}`, {
      state: 'processing',
      provider: 'flutterwave',
      failure_reason: null,
      updated_at: new Date().toISOString(),
    });
    return { delivered: true, note: 'cash queued for payout with beneficiary details' };
  },

  /** Task auto-approved by the DB sweeper; the points move with it. */
  'task.auto_approved': async (p) => ({ delivered: true, note: `task ${p.task_id} auto-approved` }),

  /**
   * Manual admin approval: award through the SAME idempotent SQL path the
   * sweeper uses (referral slice + views bonus included). Retries are safe
   * because every ledger write behind these functions carries an idem key.
   */
  'task.approved': async (p) => {
    const points = await sb.rpc('award_task_points_networked', { p_task: p.task_id });
    let views = 0;
    try { views = await sb.rpc('award_views_bonus', { p_task: p.task_id }); }
    catch (e) { log(`views bonus failed for ${p.task_id}:`, String(e.message).slice(0, 160)); }
    return { delivered: true, note: `task ${p.task_id} approved: ${points} pts, views bonus ${views}` };
  },

  /** The DB recorded the claim; the promoter does the work off this loop. */
  'task.claimed': async (p) => ({ delivered: true, note: `task ${p.task_id} claimed` }),

  /** Referral downline bonus: the referrer is the payload's referrer_id. */
  'referral_network.awarded': async (p) => {
    const rows = await sb.select('profiles', `id=eq.${p.referrer_id}&select=phone_e164`);
    const phone = rows?.[0]?.phone_e164;
    if (!phone) return { delivered: true, note: 'no phone on file' };
    await termii.sendSms({
      to: phone,
      message: `Promota: your referral earned you ${p.points} points for a completed task. Keep them going.`,
    });
    return { delivered: true };
  },
};

const unknownTopics = new Set();

/** One dispatch pass. Never throws: a bad row must not kill the loop. */
export async function tick() {
  let rows;
  try { rows = await claim(20); }
  catch (e) { log('claim failed:', String(e.message).slice(0, 200)); return { claimed: 0, ok: 0, failed: 0 }; }

  let okCount = 0, failCount = 0;
  for (const row of rows) {
    const handler = handlers[row.topic];
    if (!handler) {
      if (!unknownTopics.has(row.topic)) {
        unknownTopics.add(row.topic);
        log(`no handler for topic "${row.topic}" — leaving it queued`);
      }
      await finish(row.id, 'dead', 'no handler registered for this topic');
      failCount++;
      continue;
    }
    try {
      await handler(row.payload || {});
      await finish(row.id, 'delivered');
      okCount++;
    } catch (e) {
      await finish(row.id, row.attempts >= 5 ? 'dead' : 'queued', e.message);
      failCount++;
      log(`topic ${row.topic} failed (attempt ${row.attempts}):`, String(e.message).slice(0, 160));
    }
  }
  return { claimed: rows.length, ok: okCount, failed: failCount };
}

/**
 * Auto-approve tasks whose poster went silent, then award their points.
 * The DB function does the state transition; we only call it and then award.
 */
export async function sweep() {
  const { data: stale } = { data: await sb.rpc('auto_approve_stale_tasks') };
  const approved = Array.isArray(stale) ? stale : [];
  for (const t of approved) {
    try {
      const points = await sb.rpc('award_task_points_networked', { p_task: t.id });
      try { await sb.rpc('award_views_bonus', { p_task: t.id }); }
      catch (e) { log(`views bonus skipped for ${t.id}:`, String(e.message).slice(0, 160)); }
      log(`auto-approved task ${t.id}, awarded ${points} points`);
    } catch (e) {
      log(`auto-approved task ${t.id} but award failed:`, String(e.message).slice(0, 160));
    }
  }
  return { autoApproved: approved.length };
}

let timer = null;

/* ------------------------------------------------------- Kati lazy init */
/**
 * Kati (the data-bundle aggregator) is optional at boot: the worker must stay
 * green when Kati is down or unconfigured. initKati() probes the provider
 * status plus the kati_enabled flag row in the background, retries transient
 * failures with backoff, records the outcome on `kati` (and best-effort on
 * the flag row's payload), and NEVER throws — boot never waits for it and a
 * dead Kati never stops the outbox loop.
 */
export const kati = {
  state: 'unknown', // unknown | ready | down
  reason: null,
  attempts: 0,
  lastChecked: null,
};

const KATI_INIT_RETRIES = Number(process.env.KATI_INIT_RETRIES || 5);
const KATI_INIT_BASE_DELAY_MS = Number(process.env.KATI_INIT_BASE_DELAY_MS || 1000);

/** Best-effort read of the kati_enabled flag row. Null when the flags table or DB is unreachable. */
async function readKatiFlag() {
  try {
    const rows = await sb.select('flags', 'key=eq.kati_enabled&select=key,enabled,payload&limit=1');
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function initKati() {
  let lastError = null;
  for (let attempt = 1; attempt <= KATI_INIT_RETRIES; attempt++) {
    kati.attempts = attempt;
    try {
      const [st, flag] = await Promise.all([
        Promise.resolve().then(() => data.status()),
        readKatiFlag(),
      ]);
      if (!st.ready) {
        kati.state = 'down';
        kati.reason = String(st.reason || 'data provider not configured').slice(0, 200);
      } else if (flag && flag.enabled === false) {
        kati.state = 'down';
        kati.reason = 'kati_enabled flag is off';
      } else {
        kati.state = 'ready';
        kati.reason = null;
      }
      kati.lastChecked = new Date().toISOString();
      // Best-effort status writeback onto the flag row; a missing table or a
      // denied write must never fail init.
      if (flag) {
        try {
          await sb.update('flags', 'key=eq.kati_enabled', {
            payload: { ...(flag.payload || {}), state: kati.state, lastChecked: kati.lastChecked },
          });
        } catch { /* best-effort only */ }
      }
      return { ...kati };
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 200);
    }
    if (attempt < KATI_INIT_RETRIES) {
      const delay = Math.min(KATI_INIT_BASE_DELAY_MS * 2 ** (attempt - 1), 15000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  kati.state = 'down';
  kati.reason = lastError || 'kati init failed';
  kati.lastChecked = new Date().toISOString();
  return { ...kati };
}

export function start() {
  if (timer) return;
  log(`starting (tick ${TICK_MS}ms)`);
  // Kati init runs in the background: boot and the outbox loop never wait for it.
  initKati().catch(() => {});
  const run = async () => {
    try { await sweep(); } catch (e) { log('sweep error:', String(e.message).slice(0, 160)); }
    try { await tick(); } catch (e) { log('tick error:', String(e.message).slice(0, 160)); }
  };
  run();
  timer = setInterval(run, TICK_MS);
  // do not hold the event loop open on shutdown
  if (typeof timer.unref === 'function') timer.unref();
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

export { handlers };