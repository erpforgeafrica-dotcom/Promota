#!/usr/bin/env node
/**
 * dataManager.test.mjs — adversarial tests for the multi-provider manager.
 *
 * Every network boundary is stubbed; no real provider is ever touched and no
 * key/env value leaks into an assertion message (assertions reference pairs,
 * never values). The matrix cases are the WHOLE point:
 *   delivered → attributed, no failover          pending → parked, no failover
 *   UNKNOWN   → no failover, retryable           rejected → next provider, same ref
 */
import * as manager from './dataManager.mjs';
import { makeRequestId, verifyWebhook, resetAuth } from './vtung.mjs';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const envSave = { ...process.env };
function env(set) { Object.assign(process.env, set); }
function envReset() {
  for (const k of Object.keys(envSave)) process.env[k] = envSave[k];
  for (const k of ['TWENTY5_API_KEY', 'TWENTY5_PUBLIC_KEY', 'VTU_USERNAME', 'VTU_PASSWORD',
    'DATA_PROVIDER_API_KEY', 'DATA_PROVIDER_BASE_URL', 'DATA_PROVIDER_ORDER']) delete process.env[k];
}

/** The reference travels to every provider unchanged — that is the idempotency core. */
function routeFetch(log) {
  return (url, init = {}) => {
    log.push({ url: String(url), method: init.method || 'GET', body: init.body, headers: init.headers || {} });
    throw new Error(`no stub route for ${init.method || 'GET'} ${url}`);
  };
}
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/* --------------------------------------------------- case: nothing configured */
async function caseNoneConfigured() {
  envReset();
  const log = [];
  const r = await manager.deliver({ network: 'MTN', phone: '+2348000000001', planCode: 'MTN-1GB-DAILY',
    reference: 'ref:none' }, { fetchFn: routeFetch(log) });
  check('no provider → refuse + reversible', r.ok === false && r.retryable === false
    && /no data aggregator|no capable|not configured/.test(r.error), JSON.stringify(r).slice(0, 160));
  check('no provider → no http was fired', log.length === 0, `calls=${log.length}`);
}

/* ------------------------------------------------- case: bearer pair required */
async function caseBearer() {
  envReset();
  process.env.TWENTY5_API_KEY = 'sk_test_12345'; // value irrelevant; shape tested
  const s1 = manager.status();
  check('secret alone → not ready', s1.ready === false && /pk_test/.test(s1.reason), s1.reason?.slice(0, 80));

  env({ TWENTY5_PUBLIC_KEY: 'pk_test_ok' });
  const s2 = manager.status();
  check('pk+sk halves → ready', s2.ready === true, JSON.stringify(s2).slice(0, 120));
  const { bearer } = await import('./twenty5.mjs');
  check('bearer pair is dotted', /^[^.]+\.sk_test_12345$/.test(bearer() || ''), `composed ${bearer()?.slice(0, 12)}…`);
}

/* ------------------------------------------------------ case: happy delivery */
async function caseHappy() {
  envReset();
  env({ TWENTY5_API_KEY: 'sk_rand', TWENTY5_PUBLIC_KEY: 'pk_test_ok' });
  const opt = new URLSearchParams();
  const log = [];
  const f = (url, init = {}) => {
    log.push({ url: String(url), body: init.body });
    if (String(url).includes('/data/send')) return json(200, {
      message: 'Successful', success: true,
      data: { data_id: 'D-9', status: 'sent', amount_charged: 49000, remaining_balance: 1000000, test_mode: true },
    });
    throw new Error(`unexpected ${url}`);
  };
  const r = await manager.deliver({ network: 'MTN', phone: '+2348', planCode: 'MTN-1GB-DAILY',
    reference: 'ref:aaa' }, { fetchFn: f });
  check('A delivers → ok', r.ok === true, JSON.stringify(r));
  check('A delivers → provider attributed', r.provider === 'twenty5' && r.providerRef === 'D-9', r.provider);
  check('A delivers → B was never run after success', log.every((c) => String(c.url).includes('api.twenty5.io') === false ? String(c.url).includes('data/send') : true) && log.filter((c) => String(c.url).includes('/data/send')).length === 1, `calls=${log.length}`);
  const body = JSON.parse(log[0].body || '{}');
  check('A send carries plan_code + recipient', body.plan_code === 'MTN-1GB-DAILY' && body.recipient === '+2348', log[0].body);
  log.forEach((c) => opt.forEach((_, k) => k)); // no-op guard against unused var lint
}

/* --------------------------------------------- case: wallet failover + same ref */
async function caseWalletFailover() {
  envReset();
  env({ TWENTY5_API_KEY: 'sk_rand', TWENTY5_PUBLIC_KEY: 'pk_test_ok', VTU_USERNAME: 'u', VTU_PASSWORD: 'p' });
  const log = [];
  const f = (url, init = {}) => {
    log.push({ url: String(url), body: init.body });
    if (String(url).includes('/data/send')) return json(402, {
      message: 'Insufficient balance', success: false,
      data: { required: 500000, available: 10000 },
    });
    if (String(url).includes('/jwt-auth')) return json(200, { token: 'tok' });
    if (String(url).includes('/api/v2/data')) return json(200, {
      code: 'success', data: { order_id: 5567789, status: 'completed-api', request_id: 'ref:b' },
    });
    throw new Error(`unexpected ${url}`);
  };
  const r = await manager.deliver({ network: 'GLO', phone: '+2348', planCode: 'VTU-2GB-30-DAY',
    reference: 'REF:bbb/AA' }, { fetchFn: f });
  check('402 → failover lands on B', r.ok === true && r.provider === 'vtung', JSON.stringify(r));
  const b = log.find((c) => String(c.url).includes('/api/v2/data'));
  check('B got the SAME internal reference', b && JSON.parse(b.body).request_id === makeRequestId('REF:bbb/AA'),
    b && b.body);
  check('B login happened once for this flow', log.filter((c) => String(c.url).includes('/jwt-auth')).length === 1);
}

/* ----------------------------------------------- case: UNKNOWN never failovers */
async function caseUnknown() {
  envReset();
  env({ TWENTY5_API_KEY: 'sk_rand', TWENTY5_PUBLIC_KEY: 'pk_test_ok', VTU_USERNAME: 'u', VTU_PASSWORD: 'p' });
  const log = [];
  const f = (url, init = {}) => {
    log.push({ url: String(url) });
    throw Object.assign(new TypeError('fetch failed'), { name: 'AbortError' }); // mid-flight death
  };
  const r = await manager.deliver({ network: 'MTN', phone: '+2348', planCode: 'MTN-1GB-DAILY',
    reference: 'ref:c' }, { fetchFn: f });
  check('UNKNOWN → no blind provider switch', r.ok === false && r.unknown === true && r.provider === 'twenty5',
    JSON.stringify(r).slice(0, 160));
  check('UNKNOWN → stays retryable for the SAME provider',
    r.retryable === true && !log.some((c) => String(c.url).includes('/api/v2/data')), `retryable=${r.retryable}`);
}

/* ------------------------------------------------ case: pending stays parked */
async function casePending() {
  envReset();
  env({ TWENTY5_API_KEY: 'sk_rand', TWENTY5_PUBLIC_KEY: 'pk_test_ok', VTU_USERNAME: 'u', VTU_PASSWORD: 'p' });
  const log = [];
  const f = (url, init = {}) => {
    log.push({ url: String(url) });
    if (String(url).includes('/data/send')) return json(200, {
      message: 'Successful', success: true, data: { data_id: 'D-4', status: 'pending' },
    });
    throw new Error(`unexpected ${url}`);
  };
  const r = await manager.deliver({ network: 'MTN', phone: '+2348', planCode: 'MTN-1GB-DAILY',
    reference: 'ref:d' }, { fetchFn: f });
  check('pending → parked, not failed', r.ok === false && r.pending === true && r.providerRef === 'D-4',
    JSON.stringify(r));
  check('pending → B never attempted this pass', !log.some((c) => String(c.url).includes('/api/v2/data')),
    `calls=${log.length}`);
  envReset();
}

/* ------------------------------------------ case: B token cache + 409 dup pool */
async function caseVtuCache409() {
  envReset();
  resetAuth(); // earlier cases legitimately logged in; this case counts its OWN logins
  env({ VTU_USERNAME: 'u', VTU_PASSWORD: 'p' });
  const log = [];
  const f = (url, init = {}) => {
    log.push({ url: String(url) });
    if (String(url).includes('/jwt-auth')) return json(200, { token: 'tok' });
    if (String(url).includes('/api/v2/data')) return json(409, { message: 'duplicate request_id' });
    throw new Error(`unexpected ${url}`);
  };
  await manager.deliver({ network: 'MTN', phone: '+2348', planCode: 'VTU-1GB-30-DAY', reference: 'ref:e' }, { fetchFn: f });
  const r2 = await manager.deliver({ network: 'MTN', phone: '+2348', planCode: 'VTU-1GB-30-DAY', reference: 'ref:f' }, { fetchFn: f });
  check('token cached across delivers', log.filter((x) => String(x.url).includes('/jwt-auth')).length === 1,
    `logins=${log.filter((x) => String(x.url).includes('/jwt-auth')).length}`);
  check('409 duplicate → pending (3-min swarm lock)', r2.ok === false && r2.pending === true, JSON.stringify(r2));
  envReset();
}

/* -------------------------------------------- case: recheck routes to requery */
async function caseRecheck() {
  envReset();
  resetAuth();
  env({ VTU_USERNAME: 'u', VTU_PASSWORD: 'p' });
  const push = [];
  const f = (u) => {
    push.push(String(u));
    if (String(u).includes('/jwt-auth')) return json(200, { token: 'tok' });
    if (String(u).includes('/api/v2/data')) return json(409, { message: 'duplicate request_id' });
    if (String(u).includes('/requery')) return json(200, { code: 'success', data: { order_id: 42, status: 'completed-api' } });
    throw new Error(`unexpected ${u}`);
  };
  // requery needs a live token: warm deliver logs in once, recheck must add none
  await manager.deliver({ network: 'MTN', phone: '+2348', planCode: 'VTU-1GB-30-DAY', reference: 'ref:warm' }, { fetchFn: f });
  const loginsAfterWarm = push.filter((x) => x.includes('/jwt-auth')).length;
  check('warm-up logged in exactly once', loginsAfterWarm === 1, `logins=${loginsAfterWarm}`);
  const r = await manager.recheck({ provider: 'vtung', reference: 'ref:g' }, { fetchFn: f });
  check('recheck → requery delivered', r.ok === true && r.providerRef === '42', JSON.stringify(r));
  check('recheck did not re-login (token cache)',
    push.filter((x) => x.includes('/jwt-auth')).length === loginsAfterWarm, 'unexpected logins');
  envReset();
}

/* ----------------------------------------------- case: webhook signature pins */
async function caseWebhookSig() {
  envReset();
  env({ VTU_USER_PIN: '1234' });
  const raw = '{"event":"completed-api","order_id":1}';
  const { createHmac } = await import('node:crypto');
  const sig = createHmac('sha256', '1234').update(raw).digest('hex');
  check('verifyWebhook accepts hex', verifyWebhook(raw, sig) === true, 'hex mismatch');
  check('verifyWebhook rejects wrong pin sig', verifyWebhook(raw, sig.replace('a', 'b')) === false, 'accepted tampered');
  env({ VTU_USER_PIN: '' });
  check('verifyWebhook unusable without pin', verifyWebhook(raw, sig) === false, 'accepted without pin');
}

/* ------------------------------------------------------------------- request_id */
async function caseRequestId() {
  const long = `${'x'.repeat(40)}:Y/dsc`;
  const id = makeRequestId(long);
  check('request_id ≤50 chars', id.length <= 50, id.length);
  check('request_id charset safe', /^[a-z0-9_-]+$/.test(id), id);
}

/* --------------------------------------------------- case: the legacy adapter
   The legacy DATA_PROVIDER_* port used to report "delivered" for ANY 2xx and
   fall back to OUR OWN reference as the provider reference, so an
   unconfirmed order looked confirmed to the database. */
async function caseLegacyAdapter() {
  envReset();
  env({ DATA_PROVIDER_API_KEY: 'legacy-key', DATA_PROVIDER_BASE_URL: 'https://legacy.test',
    DATA_PROVIDER_ORDER: 'generic' });

  // 2xx with no delivery signal → parked, never "delivered".
  const r1 = await manager.deliver({ network: 'MTN', phone: '+2348000000001',
    planCode: 'P1', reference: 'ref:legacy-1' }, {
    fetchFn: async () => json(200, { status: 'pending', success: false }),
  });
  check('legacy 2xx without a delivery signal is NOT delivered',
    r1.ok === false && r1.pending === true, JSON.stringify(r1).slice(0, 140));

  // 2xx with an explicit delivery status → delivered, attributed to the provider.
  const r2 = await manager.deliver({ network: 'MTN', phone: '+2348000000001',
    planCode: 'P1', reference: 'ref:legacy-2' }, {
    fetchFn: async () => json(200, { status: 'delivered', id: 'LEG-9' }),
  });
  check('legacy explicit delivery is delivered and attributed',
    r2.ok === true && r2.providerRef === 'LEG-9', JSON.stringify(r2).slice(0, 140));

  // A delivery with no provider reference cannot be audited → refused.
  const r3 = await manager.deliver({ network: 'MTN', phone: '+2348000000001',
    planCode: 'P1', reference: 'ref:legacy-3' }, {
    fetchFn: async () => json(200, { status: 'delivered' }),
  });
  check('legacy delivery without a provider reference is refused',
    r3.ok === false, JSON.stringify(r3).slice(0, 140));

  // 5xx → the outcome is UNKNOWN, so no failover and no re-purchase.
  const r4 = await manager.deliver({ network: 'MTN', phone: '+2348000000001',
    planCode: 'P1', reference: 'ref:legacy-4' }, {
    fetchFn: async () => json(500, { message: 'boom' }),
  });
  check('legacy 5xx does not report success', r4.ok === false, JSON.stringify(r4).slice(0, 140));
  check('legacy 5xx keeps the UNKNOWN marker', /UNKNOWN/.test(String(r4.error || '')), String(r4.error).slice(0, 140));
}

/* ------------------------------------------- case: an unknown provider name
   A typo in DATA_PROVIDER_ORDER used to throw a TypeError, which took
   /healthz down with a 500 and killed every redemption. */
async function caseUnknownProviderName() {
  envReset();
  env({ DATA_PROVIDER_ORDER: 'bogus,twenty5', TWENTY5_API_KEY: 'sk_rand', TWENTY5_PUBLIC_KEY: 'pk_test_ok' });

  const s = manager.status();
  check('an unknown provider name does not throw', s && typeof s.ready === 'boolean', JSON.stringify(s).slice(0, 140));
  check('an unknown provider name is reported', (s.unknown || []).includes('bogus'), JSON.stringify(s.unknown));

  const log = [];
  const r = await manager.deliver({ network: 'MTN', phone: '+2348000000001', planCode: 'P1',
    reference: 'ref:unknown-name' }, {
    fetchFn: async (url, init = {}) => {
      log.push(String(url));
      if (String(url).includes('/data/send')) return json(200, {
        message: 'Successful', success: true,
        data: { data_id: 'D-1', status: 'sent' },
      });
      return json(200, { data: { plans: [] } });
    },
  });
  check('an unknown provider name does not kill the delivery',
    r.ok === true, JSON.stringify(r).slice(0, 140));
}

(async () => {
  try {
    await caseNoneConfigured();
    await caseBearer();
    await caseHappy();
    await caseWalletFailover();
    await caseUnknown();
    await casePending();
    await caseVtuCache409();
    await caseRecheck();
    await caseWebhookSig();
    await caseRequestId();
    await caseLegacyAdapter();
    await caseUnknownProviderName();
  } catch (e) {
    fail++;
    console.error('  FAIL  unhandled in test runner', String(e && e.stack || e).split('\n')[0]);
  }
  envReset();
  console.log(`\n${pass} pass, ${fail} fail`);
  // natural exit so unref'd handles drain: a hard process.exit aborts libuv's
  // add-on teardown on Windows (Assertion failed in async.c)
  process.exitCode = fail ? 1 : 0;
})();
