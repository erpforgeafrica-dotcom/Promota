/**
 * flutterwave.mjs — Flutterwave adapter for CASH PAYOUTS.
 *
 * Cash redemptions use the Transfers API (send money), NOT the Charge API
 * (take money). Verified against the live test key on 2026-10-08:
 *   GET /v3/transfers/1 -> 404 "Transfer not found", which proves the secret
 *   key authenticated. A 401/403 would have meant a bad key.
 *
 * Prerequisites before real money moves (none of which are code problems):
 *   1. Merchant KYC complete and the account approved for transfers.
 *   2. Server IP allow-listed in the Flutterwave dashboard.
 *   3. Available balance >= batch total.
 *   4. A beneficiary bank code resolved from /banks?country=NG.
 *
 * Every transfer carries a caller-supplied idempotency `reference`. Replaying
 * a payout must never move money twice, so the reference is derived from our
 * own redemption id rather than being random.
 */

const BASE = process.env.FLUTTERWAVE_BASE_URL
  || 'https://api.flutterwave.com';

export function configured() {
  return Boolean((process.env.FLUTTERWAVE_SECRET_KEY || '').trim());
}

function secret() {
  const s = (process.env.FLUTTERWAVE_SECRET_KEY || '').trim();
  if (!s) throw new Error('FLUTTERWAVE_SECRET_KEY is not configured');
  return s;
}

async function call(path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret()}`,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok || json?.status === 'error') {
    const msg = json?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`flutterwave ${path}: ${msg}`);
  }
  return json;
}

/**
 * Initiate a bank transfer.
 * amount is in naira (not kobo) — Flutterwave's transfers API takes major units.
 * reference MUST be stable per redemption so a retry cannot double-pay.
 */
export async function createTransfer({
  reference, amount, accountNumber, accountBank, beneficiaryName, narration,
}) {
  if (!reference) throw new Error('transfer reference is required for idempotency');
  if (!(amount > 0)) throw new Error('transfer amount must be positive');
  if (!accountNumber || !accountBank) throw new Error('beneficiary account and bank code are required');

  const r = await call('/v3/transfers', {
    method: 'POST',
    body: {
      reference,
      amount,
      currency: 'NGN',
      account_number: accountNumber,
      account_bank: accountBank,
      beneficiary_name: beneficiaryName,
      narration: narration || 'Promota cash redemption',
      meta: { source: 'promota' },
    },
  });
  return {
    transferId: r.data?.id ?? null,
    reference: r.data?.reference ?? reference,
    status: r.data?.status ?? 'UNKNOWN',
    fee: r.data?.fee ?? null,
    requiresApproval: Boolean(r.data?.requires_approval),
  };
}

/** Poll a transfer. The webhook is authoritative; this is the reconciler. */
export async function verifyTransfer(id) {
  const r = await call(`/v3/transfers/${encodeURIComponent(id)}`);
  const s = String(r.data?.status ?? '').toUpperCase();
  return {
    id: r.data?.id ?? null,
    status: s,
    amount: r.data?.amount ?? null,
    reference: r.data?.reference ?? null,
    // Flutterwave terminal states for a payout
    successful: s === 'SUCCESS' || s === 'COMPLETED',
    failed: s === 'FAILED' || s === 'CANCELLED' || s === 'REJECTED',
  };
}

/** Nigerian bank codes, cached; needed before any transfer can be built. */
let bankCache = null;
export async function banks(country = 'NG') {
  if (bankCache && country === 'NG') return bankCache;
  const r = await call(`/banks?country=${encodeURIComponent(country)}`);
  bankCache = (r.data || []).map(b => ({
    code: String(b.code),
    name: b.name,
  }));
  return bankCache;
}

/** Confirm an account number belongs to the named person before paying it. */
export async function resolveAccount({ accountNumber, bankCode }) {
  const r = await call('/banks/account-resolve', {
    method: 'POST',
    body: {
      account_number: accountNumber,
      bank_code: bankCode,
      ...(process.env.FLUTTERWAVE_ENCRYPTION_KEY
        ? { encryption_key: process.env.FLUTTERWAVE_ENCRYPTION_KEY }
        : {}),
    },
  });
  return {
    accountNumber: r.data?.account_number ?? accountNumber,
    accountName: r.data?.account_name ?? null,
    bankName: r.data?.bank_name ?? null,
  };
}

/**
 * Verify a webhook really came from Flutterwave.
 *
 * Flutterwave supports a shared-secret hash. We compare in constant time so a
 * timing side-channel cannot be used to recover the secret. An unset secret
 * means webhooks are refused rather than trusted blindly — fail closed.
 */
export function verifyWebhookSignature(rawBody, secretHashHeader) {
  const expected = (process.env.FLUTTERWAVE_WEBHOOK_SECRET || '').trim();
  if (!expected) return { ok: false, reason: 'webhook secret not configured' };
  if (!secretHashHeader) return { ok: false, reason: 'missing verif-hash header' };

  const a = Buffer.from(String(secretHashHeader));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return { ok: false, reason: 'verif-hash mismatch' };
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: 'verif-hash mismatch' };
}

function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}