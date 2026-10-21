/**
 * payouts.mjs — the two money paths that had no surface.
 *
 *   MONEY OUT  A promoter's beneficiary account. The account number is
 *              encrypted (AES-256-GCM, providers/payoutCrypto.mjs) before it
 *              is written, and it is NEVER returned by any endpoint. The
 *              browser only ever sees the last four digits.
 *
 *   MONEY IN   A business funding a campaign. A payment intent row carries
 *              the reference WE issued, the amount requested and the amount
 *              actually settled. The escrow is credited only from a webhook
 *              whose transfer was re-verified against the provider, never
 *              from the webhook body.
 *
 * The rules this module exists to hold:
 *   1. A payout account is stored ONLY as ciphertext. If the encryption key
 *      is missing the save is refused — never downgraded to plaintext.
 *   2. An account is "verified" only when the bank's account-resolve
 *      confirmed the name matches. Otherwise it is stored with a
 *      failure_reason and can never be paid out.
 *   3. A payment intent is an intent, not a receipt. The row starts
 *      'pending' and only a verified provider callback may settle it.
 */
import * as session from './session.mjs';
import * as sb from './supabase.mjs';
import * as flw from '../providers/flutterwave.mjs';
import * as payoutCrypto from '../providers/payoutCrypto.mjs';
import crypto from 'node:crypto';

const ok = (body, status = 200) => ({ status, body });
const fail = (message, status = 400, extra = {}) => ({ status, body: { error: message, ...extra } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Loose name comparison: case, spacing and punctuation do not matter. */
function namesMatch(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return Boolean(norm(a)) && norm(a) === norm(b);
}

/** Append-only audit trail for a money-adjacent action. */
async function audit(actorId, actorRole, action, targetType, targetId, after) {
  try {
    await sb.insert('audit_log', {
      actor_id: actorId,
      actor_role: actorRole,
      action,
      target_type: targetType,
      target_id: targetId,
      after_state: after,
    });
  } catch { /* an audit write must never fail the action it records */ }
}

/* ------------------------------------------------------- money out: the account */

/**
 * GET /api/v1/kyc/payout-account — the caller's payout account state.
 *
 * The response NEVER carries the account number. It carries the bank name,
 * the last four digits, the name the promoter claimed, and whether the bank
 * confirmed it. The row itself is read through the service key because the
 * verification state lives there; the ciphertext is never forwarded.
 */
export async function getPayoutAccount(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select(
    'payout_accounts',
    `profile_id=eq.${auth.sub}&select=bank_name,bank_code,account_last4,claimed_name,legal_name,verified_at,failure_reason,created_at,updated_at`
  );
  const row = rows?.[0];
  if (!row) {
    return ok({ set: false, bankName: null, last4: null, accountName: null, verifiedAt: null, failureReason: null });
  }
  return ok({
    set: true,
    bankName: row.bank_name || null,
    bankCode: row.bank_code || null,
    last4: row.account_last4 || null,
    accountName: row.claimed_name || null,
    legalName: row.legal_name || null,
    verifiedAt: row.verified_at || null,
    failureReason: row.failure_reason || null,
    updatedAt: row.updated_at || null,
  });
}

/**
 * POST /api/v1/kyc/payout-account — save (or replace) the caller's account.
 *
 * The number is encrypted here and never leaves the server in the clear. The
 * bank is asked to resolve the number; only a matching name marks the row
 * verified. A mismatch or an unreachable bank stores the row with a
 * failure_reason so it is visible and cannot be paid out.
 */
export async function savePayoutAccount(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  // Fail closed: without a key there is no safe place to put the number.
  if (!payoutCrypto.configured()) {
    return fail(
      'payout account storage is not configured on this deployment, so nothing was saved. '
      + 'The operator must set PAYOUT_ENCRYPTION_KEY before accounts can be stored.',
      503
    );
  }

  const b = req.body || {};
  const legalName = trim(b.legalName, 120);
  const bankName = trim(b.bankName, 120);
  const bankCode = trim(b.bankCode, 6);
  const accountName = trim(b.accountName, 120);
  const accountNumber = String(b.accountNumber || '').replace(/\D/g, '');

  if (!legalName) return fail('your legal name is required');
  if (!bankName) return fail('your bank name is required');
  if (!/^\d{3}$/.test(String(bankCode || ''))) return fail('the bank code must be 3 digits, for example 058');
  if (!/^\d{10}$/.test(accountNumber)) return fail('the account number must be 10 digits');
  if (!accountName) return fail('the account name on the bank is required');

  let verifiedAt = null;
  let failureReason = null;
  let resolvedName = null;

  if (!flw.configured()) {
    failureReason = 'account verification is not configured on this deployment, so the account is saved unverified';
  } else {
    try {
      const resolved = await flw.resolveAccount({ accountNumber, bankCode });
      resolvedName = resolved.accountName;
      if (!resolvedName) {
        failureReason = 'the bank did not return an account name for that number';
      } else if (!namesMatch(resolvedName, accountName)) {
        failureReason = `the account name at the bank is "${resolvedName}", which does not match the name you gave`;
      } else {
        verifiedAt = new Date().toISOString();
      }
    } catch (e) {
      failureReason = `the bank account could not be verified: ${String(e.message || e).slice(0, 160)}`;
    }
  }

  const row = {
    profile_id: auth.sub,
    bank_code: bankCode,
    bank_name: bankName,
    account_number_enc: payoutCrypto.encrypt(accountNumber),
    account_name_enc: payoutCrypto.encrypt(resolvedName || accountName),
    account_last4: payoutCrypto.last4(accountNumber),
    claimed_name: accountName,
    legal_name: legalName,
    verified_at: verifiedAt,
    failure_reason: failureReason,
    updated_at: new Date().toISOString(),
  };

  // One row per promoter (unique on profile_id): update when it exists.
  const existing = await sb.select('payout_accounts', `profile_id=eq.${auth.sub}&select=id`);
  let id = existing?.[0]?.id || null;
  if (id) {
    await sb.update('payout_accounts', `id=eq.${id}`, row);
  } else {
    const inserted = await sb.insert('payout_accounts', row);
    id = inserted?.[0]?.id || null;
  }

  await audit(auth.sub, auth.role, 'payout_account.saved', 'payout_account', id, {
    bankCode,
    last4: row.account_last4,
    verified: Boolean(verifiedAt),
    failureReason,
  });

  return ok({
    ok: true,
    set: true,
    last4: row.account_last4,
    verified: Boolean(verifiedAt),
    failureReason,
  });
}

/**
 * Load a promoter's VERIFIED account for the payout worker.
 *
 * Returns null when there is no account, when it was never verified, or when
 * the ciphertext cannot be decrypted (a rotated key). A caller that gets null
 * must not pay out.
 */
export async function loadVerifiedPayoutAccount(profileId) {
  if (!profileId) return null;
  const rows = await sb.select(
    'payout_accounts',
    `profile_id=eq.${profileId}&select=bank_code,bank_name,account_number_enc,account_last4,claimed_name,legal_name,verified_at,failure_reason`
  );
  const row = rows?.[0];
  if (!row) return null;
  if (!row.verified_at) return null;
  let accountNumber;
  try {
    accountNumber = payoutCrypto.decrypt(row.account_number_enc);
  } catch (e) {
    // A key rotation makes old ciphertext unreadable. That is a REAL failure,
    // so it is reported rather than silently treated as "no account".
    return {
      ok: false,
      reason: `the saved account could not be decrypted: ${String(e.message || e).slice(0, 120)}`,
    };
  }
  if (!/^\d{10}$/.test(String(accountNumber || ''))) {
    return { ok: false, reason: 'the decrypted account number is not a 10-digit number' };
  }
  return {
    ok: true,
    bankCode: row.bank_code,
    bankName: row.bank_name,
    accountNumber,
    accountName: row.claimed_name,
    legalName: row.legal_name,
    verifiedAt: row.verified_at,
  };
}

/* ------------------------------------------------------- money in: the campaign */

/** GET /api/v1/business/campaigns — the caller's own campaigns. */
export async function listBusinessCampaigns(req) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);

  const rows = await sb.select(
    'campaigns',
    `owner_id=eq.${auth.sub}&select=id,title,brief,platform,objective,state,budget_minor,price_per_outcome_minor,promoter_share_bp,fraud_reserve_bp,margin_floor_bp,hold_hours,auto_pause_pct,created_at,updated_at&order=created_at.desc`
  );
  return ok({
    campaigns: (rows || []).map((c) => ({
      id: c.id,
      title: c.title,
      brief: c.brief,
      platform: c.platform,
      objective: c.objective,
      state: c.state,
      budgetMinor: c.budget_minor ?? null,
      pricePerOutcomeMinor: c.price_per_outcome_minor ?? null,
      promoterShareBp: c.promoter_share_bp ?? null,
      fraudReserveBp: c.fraud_reserve_bp ?? null,
      marginFloorBp: c.margin_floor_bp ?? null,
      holdHours: c.hold_hours ?? null,
      autoPausePct: c.auto_pause_pct ?? null,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    })),
  });
}

/**
 * POST /api/v1/campaigns/:id/payment-link — open a collection intent.
 *
 * This creates a PAYMENT INTENT, not a receipt. The row starts 'pending' and
 * only a provider callback whose transfer was re-verified against the
 * provider may settle it and credit the escrow. Flutterwave exposes no
 * hosted payment-link endpoint on the API host this deployment uses (probed
 * live: /v3/payment-links, /v3/links and /v3/payments/links all answer with
 * an HTML "Cannot POST" page), so the link we hand back is a REAL page on
 * this site that shows the reference and the amount to send — never a
 * fabricated provider URL.
 */
export async function createPaymentLink(req, params) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const campaignId = String(params?.id || '');
  if (!UUID_RE.test(campaignId)) return fail('that campaign id is not valid');

  const campaigns = await sb.select(
    'campaigns',
    `id=eq.${campaignId}&select=id,owner_id,title,state,budget_minor,currency`
  );
  const campaign = campaigns?.[0];
  if (!campaign) return fail('that campaign does not exist', 404);
  if (campaign.owner_id !== auth.sub) return fail('you do not own that campaign', 403);

  const amountMinor = Number(campaign.budget_minor ?? 0);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return fail('this campaign has no budget to collect yet, so there is nothing to pay', 409);
  }

  // Reuse an existing open intent for this campaign so a double click cannot
  // create two references for the same amount.
  const open = await sb.select(
    'campaign_payments',
    `campaign_id=eq.${campaignId}&status=eq.pending&select=id,provider_ref,amount_minor,payment_link,created_at&order=created_at.desc&limit=1`
  );
  if (open?.[0]) {
    return ok({
      link: open[0].payment_link,
      reference: open[0].provider_ref,
      amountMinor: Number(open[0].amount_minor),
      currency: campaign.currency || 'NGN',
      reused: true,
    });
  }

  const providerRef = `cpay-${crypto.randomUUID()}`;
  const paymentLink = `/business.html?campaign=${encodeURIComponent(campaignId)}&ref=${encodeURIComponent(providerRef)}`;

  const inserted = await sb.insert('campaign_payments', {
    campaign_id: campaignId,
    provider_ref: providerRef,
    provider: 'flutterwave',
    amount_minor: amountMinor,
    currency: campaign.currency || 'NGN',
    status: 'pending',
    payment_link: paymentLink,
    created_by: auth.sub,
    updated_at: new Date().toISOString(),
  });

  await audit(auth.sub, auth.role, 'campaign.payment_intent', 'campaign', campaignId, {
    reference: providerRef,
    amountMinor,
  });

  return ok({
    link: inserted?.[0]?.payment_link || paymentLink,
    reference: providerRef,
    amountMinor,
    currency: campaign.currency || 'NGN',
    reused: false,
  });
}

/** GET /api/v1/campaigns/:id/payments — the collection attempts for a campaign. */
export async function listCampaignPayments(req, params) {
  const auth = await requireSession(req);
  if (!auth) return fail('sign in required', 401);
  const campaignId = String(params?.id || '');
  if (!UUID_RE.test(campaignId)) return fail('that campaign id is not valid');

  const campaigns = await sb.select('campaigns', `id=eq.${campaignId}&select=id,owner_id`);
  const campaign = campaigns?.[0];
  if (!campaign) return fail('that campaign does not exist', 404);
  if (campaign.owner_id !== auth.sub) return fail('you do not own that campaign', 403);

  const rows = await sb.select(
    'campaign_payments',
    `campaign_id=eq.${campaignId}&select=id,provider_ref,provider,provider_tx_id,amount_minor,settled_minor,currency,status,payment_link,paid_at,failure_reason,created_at&order=created_at.desc`
  );
  return ok({
    payments: (rows || []).map((p) => ({
      id: p.id,
      reference: p.provider_ref,
      providerRef: p.provider_ref,
      provider: p.provider,
      providerTxId: p.provider_tx_id,
      amountMinor: Number(p.amount_minor),
      settledMinor: p.settled_minor == null ? null : Number(p.settled_minor),
      currency: p.currency,
      status: p.status,
      link: p.payment_link,
      paidAt: p.paid_at,
      failureReason: p.failure_reason,
      createdAt: p.created_at,
    })),
  });
}

/* ------------------------------------------------------- points: giving them back */

/**
 * Reverse the points a redemption debited.
 *
 * A redemption debits the points FIRST and the provider is called second. If
 * the provider never delivers, the promoter has been charged for nothing —
 * so the debit is reversed automatically. The reversal runs through
 * reverse_point_entry(), which is idempotent by key, so a replayed callback
 * cannot credit twice.
 *
 * Returns { ok, reversed } — reversed is false when there was nothing to do.
 */
export async function reverseRedemptionPoints(redemptionId, reason) {
  const rows = await sb.select(
    'redemptions',
    `id=eq.${redemptionId}&select=id,profile_id,idempotency_key,state,points_spent`
  );
  const redemption = rows?.[0];
  if (!redemption) return { ok: false, error: 'no redemption carries that id' };
  if (redemption.state === 'reversed') return { ok: true, reversed: false, reason: 'already reversed' };

  const entries = await sb.select(
    'point_entries',
    `idempotency_key=eq.${redemption.idempotency_key}&select=id,points,kind`
  );
  const entry = (entries || []).find((e) => e.kind !== 'reversal');
  if (!entry) return { ok: false, error: 'the redemption has no point entry to reverse' };

  try {
    await sb.rpc('reverse_point_entry', {
      p_entry: entry.id,
      p_reason: String(reason || 'the redemption did not deliver').slice(0, 200),
    });
  } catch (e) {
    return { ok: false, error: `the points could not be returned: ${String(e.message || e).slice(0, 200)}` };
  }

  await sb.update('redemptions', `id=eq.${redemption.id}`, {
    state: 'reversed',
    updated_at: new Date().toISOString(),
  });
  await audit(null, 'system', 'redemption.reversed', 'redemption', redemption.id, {
    points: redemption.points_spent,
    reason: String(reason || '').slice(0, 200),
  });
  return { ok: true, reversed: true, points: redemption.points_spent };
}

/* ------------------------------------------------- money in: settling a payment */

/**
 * Settle a campaign payment from a VERIFIED provider callback.
 *
 * The amount is taken from the provider, never from the callback body, and
 * the escrow credit carries an idempotency key derived from the reference, so
 * a replayed webhook cannot credit twice.
 *
 * Returns { ok, settled } — settled is false when there is nothing to settle.
 */
export async function settleCampaignPayment({ reference, providerTxId, amountNaira, paidAt }) {
  if (!reference) return { ok: false, error: 'a payment reference is required' };
  const rows = await sb.select(
    'campaign_payments',
    `provider_ref=eq.${reference}&select=id,campaign_id,amount_minor,settled_minor,status,created_by`
  );
  const payment = rows?.[0];
  if (!payment) return { ok: false, error: 'no campaign payment carries that reference' };
  if (payment.status === 'settled') return { ok: true, settled: false, reason: 'already settled' };

  const settledMinor = Math.round(Number(amountNaira)) * 100;
  if (!Number.isInteger(settledMinor) || settledMinor <= 0) {
    return { ok: false, error: 'the verified transfer carried no usable amount' };
  }
  // The provider must not settle more than was asked for.
  if (settledMinor > Number(payment.amount_minor)) {
    return { ok: false, error: 'the verified transfer is larger than the amount requested' };
  }

  await sb.update('campaign_payments', `id=eq.${payment.id}`, {
    provider_tx_id: providerTxId ? String(providerTxId) : null,
    settled_minor: settledMinor,
    status: 'settled',
    paid_at: paidAt || new Date().toISOString(),
    failure_reason: null,
    updated_at: new Date().toISOString(),
  });

  // Credit the escrow. The idempotency key is derived from the reference, so
  // a replayed webhook is a no-op inside Postgres.
  try {
    await sb.rpc('fund_campaign_escrow', {
      p_campaign: payment.campaign_id,
      p_amount_minor: settledMinor,
      p_created_by: payment.created_by,
      p_note: `campaign payment ${reference} confirmed by the provider`,
      p_idem: `escrowfund:payment:${reference}`,
    });
  } catch (e) {
    await sb.update('campaign_payments', `id=eq.${payment.id}`, {
      status: 'failed',
      failure_reason: `the escrow could not be credited: ${String(e.message || e).slice(0, 200)}`,
      updated_at: new Date().toISOString(),
    });
    return { ok: false, error: `the escrow could not be credited: ${String(e.message || e).slice(0, 200)}` };
  }

  return { ok: true, settled: true, campaignId: payment.campaign_id, settledMinor };
}
