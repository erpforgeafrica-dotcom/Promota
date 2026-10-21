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
import * as payouts from '../api/payouts.mjs';

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

/**
 * Deliver one data redemption and record the TRUE outcome.
 *
 * The rules, in order:
 *   pending  -> the order is in flight at one provider. PARK it as
 *               'processing'. Never fail over, never re-purchase.
 *   unknown  -> the transport died mid-flight, so we do not know whether the
 *               bundle landed. PARK it and let the recheck pass decide.
 *               Re-sending here could buy a second bundle.
 *   retryable-> the provider EXPLICITLY rejected the request (throttled, 5xx),
 *               so nothing was bought and a retry of the same provider is
 *               safe. THROW so the outbox re-queues the event.
 *   refused  -> no provider could serve it. Mark it failed AND return the
 *               points, because the promoter was charged for nothing.
 *   delivered-> fulfilled, attributed to the provider that actually delivered.
 */
async function fulfilDataRedemption({ redemptionId, profileId, network, planCode, phone }) {
  const r = await data.deliver({ network, phone, planCode, reference: redemptionId });

  if (r.pending && !r.ok) {
    await sb.update('redemptions', `id=eq.${redemptionId}`, {
      state: 'processing',
      provider: r.provider,
      provider_ref: r.providerRef ?? redemptionId,
      failure_reason: null,
      updated_at: new Date().toISOString(),
    });
    return { delivered: false, retryable: false, note: `delivery pending at ${r.provider}; parked as processing` };
  }

  if (!r.ok && r.unknown) {
    await sb.update('redemptions', `id=eq.${redemptionId}`, {
      state: 'processing',
      provider: r.provider || null,
      provider_ref: r.providerRef ?? redemptionId,
      failure_reason: `the provider outcome is UNKNOWN (${String(r.error || '').slice(0, 200)}); not re-purchasing`,
      updated_at: new Date().toISOString(),
    });
    return { delivered: false, retryable: false, note: `delivery outcome unknown at ${r.provider}; parked as processing` };
  }

  if (!r.ok && r.retryable) {
    // The provider refused outright, so nothing was bought. Re-queue.
    throw new Error(`data delivery for ${redemptionId} was refused and is retryable: ${String(r.error || '').slice(0, 160)}`);
  }

  if (!r.ok) {
    await sb.update('redemptions', `id=eq.${redemptionId}`, {
      state: 'failed',
      failure_reason: String(r.error || 'no provider could serve this redemption').slice(0, 300),
      updated_at: new Date().toISOString(),
    });
    await payouts.reverseRedemptionPoints(redemptionId, 'no data provider could deliver the bundle');
    return { delivered: false, retryable: false, note: 'delivery refused by every provider; the points were returned' };
  }

  await sb.update('redemptions', `id=eq.${redemptionId}`, {
    state: 'fulfilled',
    // The provider that ACTUALLY delivered, not a generic label: the audit
    // trail has to name the counterparty.
    provider: r.provider,
    provider_ref: r.providerRef,
    updated_at: new Date().toISOString(),
  });
  return { delivered: true, note: `delivered by ${r.provider}` };
}

/** The owner-set naira value of one point, in basis points of a naira. */
async function cashRateBp() {
  const rows = await sb.select('settings', 'key=eq.redemption.cash_rate_bp&select=value');
  const bp = Number(rows?.[0]?.value?.v);
  return Number.isFinite(bp) && bp > 0 ? bp : 0;
}

/**
 * Pay a cash redemption, or park it honestly.
 *
 * The transfer is REQUESTED here and CONFIRMED by the provider's webhook.
 * Until then the redemption stays 'processing' and nothing claims the money
 * moved. The reference is derived from the redemption id, so a retry cannot
 * move money twice.
 *
 * A redemption with no VERIFIED payout account is parked with the reason
 * visible to the promoter. The reconcile pass retries it once an account
 * exists — that is why this is a helper and not inline code.
 */
async function payCashRedemption({ redemptionId, profileId }) {
  const row = (await sb.select('redemptions', `id=eq.${redemptionId}&select=id,points_spent,state`))?.[0];
  if (!row) return { delivered: false, retryable: false, note: 'the redemption row no longer exists' };

  const park = async (reason) => {
    await sb.update('redemptions', `id=eq.${redemptionId}`, {
      state: 'processing',
      provider: 'flutterwave',
      failure_reason: reason,
      updated_at: new Date().toISOString(),
    });
    return { delivered: false, retryable: false, note: `cash payout parked: ${reason}` };
  };

  const account = await payouts.loadVerifiedPayoutAccount(profileId);
  if (!account) {
    return park('no verified payout account is on file yet — add a bank account on the payout-account tab');
  }
  if (account.ok === false) {
    return park(account.reason || 'the saved payout account could not be read');
  }

  const rateBp = await cashRateBp();
  if (!rateBp) {
    return park('the naira rate for points is not set (settings.redemption.cash_rate_bp)');
  }

  const amountNaira = Math.floor((Number(row.points_spent) || 0) * rateBp / 10000);
  if (!(amountNaira > 0)) {
    return park('the points do not convert to a payable naira amount');
  }

  let transfer;
  try {
    transfer = await flw.createTransfer({
      reference: `red-${redemptionId}`,
      amount: amountNaira,
      accountNumber: account.accountNumber,
      accountBank: account.bankCode,
      beneficiaryName: account.accountName,
      narration: 'Promota cash redemption',
    });
  } catch (e) {
    // The transfer was not confirmed. Re-queue the event so it is tried
    // again with the SAME reference (the provider dedupes on it).
    throw new Error(`cash transfer for ${redemptionId} did not go through: ${String(e.message || e).slice(0, 160)}`);
  }

  // The transfer is REQUESTED, not confirmed. The redemption stays
  // 'processing' until the provider confirms it and the webhook settles it.
  await sb.update('redemptions', `id=eq.${redemptionId}`, {
    state: 'processing',
    provider: 'flutterwave',
    provider_ref: String(transfer.transferId || `red-${redemptionId}`),
    failure_reason: null,
    updated_at: new Date().toISOString(),
  });
  return {
    delivered: false,
    retryable: false,
    note: `cash transfer ${transfer.transferId || 'requested'} for ₦${amountNaira.toLocaleString('en-NG')} — awaiting provider confirmation`,
  };
}

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
   * data -> deliver through the failover matrix. The outcome decides the
   *        state, and NOTHING is fulfilled without a provider confirmation.
   * cash -> needs a VERIFIED payout account and an owner-set naira rate.
   */
  'redemption.requested': async (p) => {
    if (p.kind === 'data') {
      const st = data.status();
      if (!st.ready) {
        // The provider is not configured at all. The points stay debited and
        // the redemption is parked as failed with the reason — the promoter
        // can see what happened and an operator can retry.
        await sb.update('redemptions', `id=eq.${p.redemption_id}`, {
          state: 'failed',
          failure_reason: st.reason.slice(0, 300),
          updated_at: new Date().toISOString(),
        });
        await payouts.reverseRedemptionPoints(p.redemption_id, 'no data provider was configured to deliver the bundle');
        return { delivered: true, note: 'data provider not configured; the points were returned' };
      }
      const profile = await sb.select('profiles', `id=eq.${p.profile_id}&select=phone_e164`);
      const phone = profile?.[0]?.phone_e164;
      return fulfilDataRedemption({
        redemptionId: p.redemption_id,
        profileId: p.profile_id,
        network: p.network,
        planCode: p.plan_code ?? null,
        phone,
      });
    }

    // ---- cash: a real transfer, or an honest park -------------------------
    return payCashRedemption({ redemptionId: p.redemption_id, profileId: p.profile_id });
  },

  /** Task auto-approved by the DB sweeper; the points move with it. */
  'task.auto_approved': async (p) => ({ delivered: true, note: `task ${p.task_id} auto-approved` }),

  /**
   * Perfect-month login reward. The POINTS were already paid inside
   * checkin(); this event only carries the free data bundle. When the
   * aggregator is not configured the reward is logged as skipped rather
   * than retried forever — the month's points stay paid, and the note is
   * the audit trail.
   *
   * The bundle has no redemption row of its own, so the outcome has to be
   * carried by the event itself: delivered, not-delivered-and-retryable, or
   * not-delivered-and-not-retryable. An UNKNOWN outcome is NEVER retried:
   * the provider may already have sent the bundle, and a second send would
   * hand the promoter two.
   */
  'login.perfect_month': async (p) => {
    const mb = Number(p.mb) || 0;
    if (!mb) return { delivered: true, note: `no data reward configured for ${p.month}; points already paid` };
    const st = data.status();
    if (!st.ready) {
      return { delivered: true, note: `data aggregator not configured (${st.reason}); ${p.month} reward logged only` };
    }
    // Never invent a plan: only a catalogue entry that matches the reward
    // size can ship. Until one exists the reward stays a ledger fact.
    const plan = data.plans().find(pl => Number(pl.mb) === mb);
    if (!plan) return { delivered: true, note: `no catalogue plan for ${mb}MB; ${p.month} reward logged only` };
    const profile = await sb.select('profiles', `id=eq.${p.profile_id}&select=phone_e164,network`);
    const phone = profile?.[0]?.phone_e164;
    if (!phone) return { delivered: true, note: `no phone on file for the ${p.month} data reward; logged only` };
    const r = await data.deliver({
      network: profile?.[0]?.network || plan.network || 'MTN',
      phone,
      planCode: plan.code,
      reference: `login:${p.month}:${p.profile_id}`,
    });
    if (r.pending && !r.ok) {
      return { delivered: false, retryable: false, note: `the ${p.month} data reward is in flight at ${r.provider}; it was not confirmed` };
    }
    if (!r.ok) {
      // A provider that rejected the request outright bought nothing, so a
      // retry is safe. An UNKNOWN outcome is not: the bundle may have gone
      // out already.
      const retryable = Boolean(r.retryable) && !r.unknown;
      return { delivered: false, retryable,
        note: `the ${p.month} data reward was not delivered: ${String(r.error || '').slice(0, 200)}` };
    }
    return { delivered: true, note: `${p.month} data reward (${mb}MB) delivered as ${plan.name || plan.code}` };
  },

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
      // Match the log: a topic with no handler is a deploy/config gap, not a
      // poison message. Marking it 'dead' silently dropped the event; leaving
      // it queued (with the attempts ceiling as the eventual backstop) means a
      // redeploy that adds the handler still drains it.
      await finish(row.id, row.attempts >= 5 ? 'dead' : 'queued', 'no handler registered for this topic');
      failCount++;
      continue;
    }
    try {
      const outcome = (await handler(row.payload || {})) || {};
      if (outcome.delivered === false) {
        // The handler reported that it did NOT deliver. Marking this outbox
        // row 'delivered' would claim work that did not happen, so it either
        // goes back on the queue (retryable) or is recorded as dead with the
        // reason — never as a success.
        const retryable = outcome.retryable !== false && row.attempts < 5;
        await finish(row.id, retryable ? 'queued' : 'dead',
          outcome.note || 'the handler reported that it did not deliver');
        failCount++;
        log(`topic ${row.topic} did not deliver:`, String(outcome.note || '').slice(0, 160));
        continue;
      }
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

/**
 * Resolve redemptions that are parked as 'processing'.
 *
 * A bundle that was in flight when the worker parked it is still in flight,
 * and nothing else would ever look at it again: the points would stay
 * debited and the redemption would sit in 'processing' forever. This pass
 * asks the provider where the order ended:
 *
 *   delivered -> the redemption is fulfilled, attributed to that provider
 *   pending   -> still in flight; it stays parked
 *   failed    -> the provider says the order failed, so the next provider is
 *                tried with the SAME reference. If none can serve it, the
 *                redemption fails and the points come back.
 *
 * The recheck interval is enforced with the row's own updated_at, so the
 * backoff survives a restart instead of living only in memory.
 */
const RECHECK_MINUTES = Number(process.env.PENDING_RECHECK_MINUTES || 3);

export async function reconcilePending() {
  const st = data.status();
  if (!st.ready) return { checked: 0, settled: 0, failed: 0, skipped: 'no data provider is configured' };

  const cutoff = new Date(Date.now() - RECHECK_MINUTES * 60000).toISOString();
  const rows = await sb.select(
    'redemptions',
    `state=eq.processing&provider=not.is.null&updated_at=lt.${encodeURIComponent(cutoff)}`
    + `&select=id,profile_id,network,plan_code,provider,provider_ref,points_spent&limit=25`
  );

  let settled = 0;
  let failed = 0;
  let checked = 0;
  for (const row of rows || []) {
    checked++;

    // A cash redemption parked for want of a payout account is resolved here,
    // not by the data path: the promoter may have added one since.
    if (row.provider === 'flutterwave') {
      try {
        await payCashRedemption({ redemptionId: row.id, profileId: row.profile_id });
      } catch (e) {
        failed++;
        log(`cash payout retry for ${row.id} failed:`, String(e.message).slice(0, 160));
      }
      continue;
    }

    const res = await data.recheck({
      provider: row.provider,
      providerRef: row.provider_ref,
      reference: row.id,
    });

    if (res.ok) {
      await sb.update('redemptions', `id=eq.${row.id}`, {
        state: 'fulfilled',
        provider: res.provider || row.provider,
        provider_ref: res.providerRef || row.provider_ref,
        updated_at: new Date().toISOString(),
      });
      settled++;
      continue;
    }

    if (res.pending) {
      // Still in flight. Touch updated_at so the next look is one interval
      // away, and record what the provider said.
      await sb.update('redemptions', `id=eq.${row.id}`, {
        failure_reason: `still in flight at ${row.provider} (${res.status || 'pending'})`,
        updated_at: new Date().toISOString(),
      });
      continue;
    }

    if (!res.failover) {
      // The provider cannot say anything conclusive. Leave it parked and
      // visible rather than guessing.
      await sb.update('redemptions', `id=eq.${row.id}`, {
        failure_reason: `the provider could not confirm the order: ${String(res.error || '').slice(0, 200)}`,
        updated_at: new Date().toISOString(),
      });
      continue;
    }

    // The provider says the order failed. Try the next provider with the
    // SAME reference; if none can serve it, the redemption fails and the
    // points are returned.
    const profile = await sb.select('profiles', `id=eq.${row.profile_id}&select=phone_e164`);
    try {
      const outcome = await fulfilDataRedemption({
        redemptionId: row.id,
        profileId: row.profile_id,
        network: row.network,
        planCode: row.plan_code ?? null,
        phone: profile?.[0]?.phone_e164,
      });
      if (outcome.delivered === false) failed++;
    } catch (e) {
      failed++;
      log(`re-delivery for ${row.id} failed:`, String(e.message).slice(0, 160));
    }
  }
  return { checked, settled, failed };
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
    try { await reconcilePending(); } catch (e) { log('reconcile error:', String(e.message).slice(0, 160)); }
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