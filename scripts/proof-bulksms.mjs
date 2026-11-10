#!/usr/bin/env node
/**
 * proof-bulksms.mjs — live proof for the BulkSMS Nigeria integration.
 *
 * Runs against the SANDBOX by default (`BULKSMS_SANDBOX=1`): no real SMS is
 * sent and the wallet is not charged. It proves, in order:
 *
 *   1. the token authenticates                      GET  /balance
 *   2. a send is accepted and labelled sandbox      POST /sms
 *   3. an OTP round trip completes                  sendOtp -> verifyOtp
 *   4. a wrong code and a foreign number are refused
 *
 * It never prints the token, a full phone number, or the OTP itself.
 *
 *   node scripts/proof-bulksms.mjs                 # sandbox (safe, free)
 *   BULKSMS_SANDBOX=0 node scripts/proof-bulksms.mjs  # production (real SMS)
 *
 * NOT in `npm test`: it needs a live credential, and CI stays offline.
 */
import * as bulksms from '../providers/bulksms.mjs';
import * as sms from '../providers/sms.mjs';

let pass = 0, fail = 0;
const mask = (n) => {
  const d = String(n).replace(/\D/g, '');
  return d.length > 4 ? `${d.slice(0, 4)}***${d.slice(-2)}` : '***';
};
function check(label, ok, detail) {
  console.log(ok ? `  PASS  ${label}` : `  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

// Sandbox unless the operator explicitly asked for production.
if (process.env.BULKSMS_SANDBOX === undefined) process.env.BULKSMS_SANDBOX = '1';
if (!process.env.OTP_SECRET && !process.env.SESSION_SECRET) {
  // Signing only needs a local secret; a proof run must not require the real one.
  process.env.OTP_SECRET = 'proof-run-only-secret';
  console.log('  note  OTP_SECRET/SESSION_SECRET absent — using a proof-only secret (no session was issued)');
}

const TO = process.env.PROOF_PHONE || '08030000000';

(async () => {
  console.log('BULK SMS NIGERIA — live proof');
  console.log(`  provider   ${sms.provider()}`);
  console.log(`  sandbox    ${bulksms.sandbox()}`);
  console.log(`  recipient  ${mask(TO)}`);
  console.log(`  base       ${process.env.BULKSMS_BASE_URL || (bulksms.sandbox() ? 'sandbox' : 'production')}`);

  if (!sms.configured()) {
    console.log('\n  FAIL  no SMS credential configured (set BULKSMS_API_TOKEN)');
    process.exitCode = 1;
    return;
  }
  if (sms.provider() !== 'bulksms') {
    console.log(`\n  FAIL  the live provider is "${sms.provider()}", not bulksms — set BULKSMS_API_TOKEN`);
    process.exitCode = 1;
    return;
  }

  /* 1. balance */
  let bal = null;
  try { bal = await bulksms.balance(); } catch (e) {
    check('token authenticates (GET /balance)', false, e.message);
  }
  if (bal) {
    check('token authenticates (GET /balance)', typeof bal.balance === 'number', JSON.stringify(bal));
    console.log(`          balance ${bal.balance} ${bal.currency}${bal.formatted ? ` (${bal.formatted})` : ''}`);
  }

  /* 2. a real-shaped send */
  let sent = null;
  try {
    sent = await bulksms.sendSms({ to: TO, message: 'Promota integration proof — no action needed.' });
    check('POST /sms accepted', Boolean(sent.messageId), JSON.stringify(sent));
    check('the response says which environment answered',
      typeof sent.sandbox === 'boolean', String(sent.sandbox));
    console.log(`          message_id ${sent.messageId} cost ${sent.cost} ${sent.currency} gateway ${sent.gatewayUsed}`);
  } catch (e) {
    check('POST /sms accepted', false, e.message);
  }

  /* 3. OTP round trip */
  let challenge = null;
  try {
    const pin = '7319';
    challenge = await bulksms.sendOtp({ to: TO, pin });
    check('sendOtp issues a challenge', typeof challenge.pinId === 'string' && challenge.pinId.startsWith('bs1.'),
      String(challenge.pinId).slice(0, 12));
    check('the correct code verifies',
      await bulksms.verifyOtp({ pinId: challenge.pinId, pin: '7319', to: TO }) === true);

    const second = await bulksms.sendOtp({ to: TO, pin: '7319' });
    check('a wrong code is refused, not an error',
      await bulksms.verifyOtp({ pinId: second.pinId, pin: '0000', to: TO }) === false);
    check('the same challenge cannot be redeemed from another number',
      await bulksms.verifyOtp({ pinId: second.pinId, pin: '7319', to: '08039999999' }) === false);
  } catch (e) {
    check('OTP round trip', false, e.message);
  }

  console.log(`\n  ${pass} pass, ${fail} fail`);
  console.log(fail ? '  BULK SMS PROOF: FAIL' : '  BULK SMS PROOF: PASS');
  process.exitCode = fail ? 1 : 0;
})();
