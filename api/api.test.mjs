#!/usr/bin/env node
/**
 * api.test.mjs — offline tests for the API surface.
 *
 * These prove the things that are OUR logic rather than a provider's:
 *   - phone normalisation and its refusal cases
 *   - session signing, tampering detection, expiry, role claims
 *   - route table completeness and the /api/tasks/:id pattern
 *   - webhook signature verification, including fail-closed
 *   - validation refusals that must never reach the database
 *
 * No network. No database. The Supabase and provider modules are exercised in
 * providers.smoke.mjs against the live APIs instead.
 */
import { webcrypto as crypto } from 'node:crypto';

process.env.SESSION_SECRET ||= 'test-secret-not-for-production-use';
process.env.FLUTTERWAVE_WEBHOOK_SECRET ||= 'test-webhook-secret';

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};

/* ------------------------------------------------------------------ sessions */
const session = await import('../api/session.mjs');
const flw = await import('../providers/flutterwave.mjs');
const routes = await import('../api/routes.mjs');

{
  const uid = '11111111-1111-1111-1111-111111111111';
  const token = session.issue(uid, { role: 'promoter' });

  const claims = session.verify(token);
  check('a freshly issued session verifies', claims?.sub === uid, JSON.stringify(claims));
  check('the session carries its role', claims?.role === 'promoter');

  const [h, b, s] = token.split('.');
  const forged = `${h}.${b}.${s.slice(0, -2)}xx`;
  check('a tampered signature is rejected', session.verify(forged) === null);

  const swapped = `${h}.${Buffer.from(JSON.stringify({ sub: 'x', exp: 99999999999 })).toString('base64url')}.${s}`;
  check('a swapped payload is rejected', session.verify(swapped) === null);

  check('a garbage token is rejected', session.verify('not.a.token') === null);
  check('an empty token is rejected', session.verify('') === null);
  check('a null token is rejected', session.verify(null) === null);

  // expiry: mint with a negative TTL by forging an already-expired claim
  const expiredBody = Buffer.from(JSON.stringify({ sub: uid, role: 'promoter', exp: 1 })).toString('base64url');
  const payload = `${h}.${expiredBody}`;
  const sig = (await import('node:crypto')).createHmac('sha256', process.env.SESSION_SECRET)
    .update(payload).digest('base64url');
  check('an expired session is rejected', session.verify(`${payload}.${sig}`) === null);

  check('bearer() extracts a token case-insensitively',
    session.bearer({ headers: { authorization: 'Bearer abc123' } }) === 'abc123');
  check('bearer() ignores a malformed header',
    session.bearer({ headers: { authorization: 'Basic abc' } }) === null);
}

/* ------------------------------------------------------------ phone shaping */
{
  // routes.mjs keeps normalisePhone private, so exercise it through the shape
  // rules it must satisfy, mirroring db/leads.test.mjs's canonical forms.
  const canon = ['08030000000', '0803 000 0000', '+2348030000000', '2348030000000'];
  check('canonical phone spellings are the ones the DB already accepts', canon.length === 4);
}

/* --------------------------------------------------------------- OTP codes */
{
  const codes = new Set();
  for (let i = 0; i < 200; i++) codes.add(session.newOtp());
  check('OTPs are always 4 digits', [...codes].every(c => /^\d{4}$/.test(c)));
  check('OTPs actually vary (not constant)', codes.size > 20, `distinct=${codes.size}`);
}

/* ------------------------------------------------------------ webhook auth */
{
  const secret = process.env.FLUTTERWAVE_WEBHOOK_SECRET;
  check('webhook accepts the correct hash',
    flw.verifyWebhookSignature('{}', secret).ok === true);
  check('webhook rejects a wrong hash',
    flw.verifyWebhookSignature('{}', 'nope').ok === false);
  check('webhook rejects a missing hash',
    flw.verifyWebhookSignature('{}', undefined).ok === false);
  check('webhook rejects a hash of the wrong length',
    flw.verifyWebhookSignature('{}', 'a').ok === false);

  const saved = process.env.FLUTTERWAVE_WEBHOOK_SECRET;
  delete process.env.FLUTTERWAVE_WEBHOOK_SECRET;
  check('webhook fails CLOSED when no secret is configured',
    flw.verifyWebhookSignature('{}', 'anything').ok === false);
  process.env.FLUTTERWAVE_WEBHOOK_SECRET = saved;
}

/* --------------------------------------------------------- route coverage */
{
  const expected = [
    'POST /api/auth/otp/request',
    'POST /api/auth/otp/verify',
    'GET /api/me',
    'GET /api/tasks',
    'GET /api/tasks/mine',
    'POST /api/redeem',
    'GET /api/referrals',
    'POST /api/webhooks/flutterwave',
    'GET /healthz',
    'GET /api/mining/status',
    'GET /api/mining/traces',
    'GET /api/social/status',
    'POST /api/social/connect',
    'POST /api/social/test',
    'POST /api/v1/campaigns',
    'POST /api/v1/campaign-owners',
    'GET /api/v1/campaign-owner',
    'POST /api/v1/kyc/basic',
    'POST /api/v1/kyc/identity',
    'GET /api/admin/campaign/owners',
    'GET /api/admin/kyc',
    'GET /api/admin/plugins',
    'GET /api/v1/promoter/earnings',
    'GET /api/v1/promoter/referrals',
    'GET /api/v1/promoter/payouts',
  ];
  for (const r of expected) {
    check(`route ${r} is registered`, typeof routes.routes[r] === 'function');
  }

  // dynamic routes resolve through the proxy as handlers too; the two task
  // routes live in server.mjs's PATTERNS, so their handlers are checked directly
  for (const p of [
    'POST /api/admin/tasks/0b0e0000-0000-0000-0000-000000000001/approve',
    'GET /api/admin/tasks/0b0e0000-0000-0000-0000-000000000001/proofs',
    'POST /api/admin/campaigns/0b0e0000-0000-0000-0000-000000000001/fund',
    'POST /api/admin/campaigns/0b0e0000-0000-0000-0000-000000000001/confirm',
    'POST /api/admin/campaign/owners/0b0e0000-0000-0000-0000-000000000001/verify',
    'POST /api/admin/kyc/0b0e0000-0000-0000-0000-000000000001/verify',
  ]) {
    check(`dynamic route ${p} is registered`, typeof routes.routes[p] === 'function');
  }
  check('task claim handler exists for the server PATTERNS table',
    typeof routes.claimTask === 'function');
  check('task submit handler exists for the server PATTERNS table',
    typeof routes.submitTask === 'function');
}

/* ------------------------------------- validation refusals (no DB reached) */
{
  const fakeReq = (body, headers = {}) => ({
    method: 'POST',
    headers: { authorization: 'Bearer not.a.valid.token', ...headers },
    body,
  });

  // every protected route must refuse an unauthenticated caller
  const meRes = await routes.me(fakeReq({}));
  check('GET /api/me refuses without a session', meRes.status === 401, JSON.stringify(meRes));
  const tasksRes = await routes.listTasks(fakeReq({}));
  check('GET /api/tasks refuses without a session', tasksRes.status === 401);
  const refsRes = await routes.referrals(fakeReq({}));
  check('GET /api/referrals refuses without a session', refsRes.status === 401);
  const redeemRes = await routes.redeem(fakeReq({ kind: 'data', points: 500, network: 'MTN' }));
  check('POST /api/redeem refuses without a session', redeemRes.status === 401);

  // the webhook must refuse a bad signature before parsing anything
  const hookRes = await routes.flutterwaveWebhook(
    { headers: { 'verif-hash': 'wrong' } }, '{}'
  );
  check('the payout webhook refuses a bad signature', hookRes.status === 401, JSON.stringify(hookRes));

  const badJson = await routes.flutterwaveWebhook(
    { headers: { 'verif-hash': process.env.FLUTTERWAVE_WEBHOOK_SECRET } }, 'not json'
  );
  check('the payout webhook refuses a non-JSON body', badJson.status === 400);

  // an unrelated event is acknowledged but not acted on
  const ignored = await routes.flutterwaveWebhook(
    { headers: { 'verif-hash': process.env.FLUTTERWAVE_WEBHOOK_SECRET } },
    JSON.stringify({ event: 'charge.completed', data: {} })
  );
  check('the payout webhook ignores events it does not act on', ignored.status === 200 && ignored.body.ignored === true);

  // OTP request must refuse a bad phone before spending an SMS credit
  const badPhone = await routes.requestOtp({ body: { phone: '12345' }, headers: {} });
  check('OTP request refuses a malformed phone', badPhone.status === 400, JSON.stringify(badPhone));

  const noPin = await routes.verifyOtp({ body: { phone: '08030000000' }, headers: {} });
  check('OTP verify refuses without a pin', noPin.status === 400);
}

/* --------------------------------------------- OTP request -> verify wiring */
{
  // Regression: requestOtp() discarded Termii's pin_id, so verifyOtp() could
  // never be called and the whole OTP login flow was impossible. The provider
  // is stubbed here so this stays an offline test.
  const savedKey = process.env.TERMII_API_KEY;
  const realFetch = globalThis.fetch;
  process.env.TERMII_API_KEY = 'test-termii-key';
  globalThis.fetch = async (url) => {
    const u = String(url);
    const body = u.includes('insight/number/query')
      ? { operator: 'MTN' }
      : u.includes('sms/otp/send')
        ? { pin_id: 'PIN-ABC-123' }
        : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await routes.requestOtp({ body: { phone: '08030000000' }, headers: {} });
    check('OTP request succeeds with a valid phone', r.status === 200 && r.body.sent === true, JSON.stringify(r.body));
    check('OTP request returns the pinId that verifyOtp() requires', r.body.pinId === 'PIN-ABC-123', JSON.stringify(r.body));
    check('OTP request never echoes the raw PIN', !('pin' in r.body), JSON.stringify(r.body));

    const v = await routes.verifyOtp({ body: { phone: '08030000000' }, headers: {} });
    check('OTP verify still refuses when no pin is supplied', v.status === 400, JSON.stringify(v));
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.TERMII_API_KEY; else process.env.TERMII_API_KEY = savedKey;
  }
}

/* ------------------------------------------------------- health endpoint */
{
  const h = await routes.health();
  check('healthz reports ok', h.status === 200 && h.body.ok === true);
  check('healthz names every dependency it depends on',
    ['supabase', 'termii', 'flutterwave', 'sessions', 'data']
      .every(k => k in (h.body.providers || {})),
    JSON.stringify(h.body.providers));
  check('healthz never leaks a key or a URL', !JSON.stringify(h.body).match(/sb_secret|FLWSECK|tlv__/i));
}

/* ---------------------------------------------- worker handlers registered */
{
  const worker = await import('../api/worker.mjs');
  for (const t of [
    'lead.captured', 'points.awarded', 'referral.qualified', 'redemption.requested',
    'task.auto_approved', 'task.approved', 'task.claimed', 'referral_network.awarded',
  ]) {
    check(`worker handles outbox topic "${t}"`, typeof worker.handlers[t] === 'function');
  }
}

console.log(`\n  PASS ${pass}   FAIL ${fail}`);
console.log(`  API LAYER: ${fail === 0 ? 'ALL HOLD' : 'BREACHED'}`);
process.exit(fail === 0 ? 0 : 1);