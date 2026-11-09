/* kyc.js — promoter payout-account KYC.
   A cash redemption needs a verified bank account on file. The account
   number is encrypted with AES-256-GCM before it is stored
   (providers/payoutCrypto.mjs) and the API NEVER returns it: the state
   endpoint only exposes bankName + last4, so the number field is cleared
   after a successful save and is never rendered back to the page. When the
   server has no key configured, it refuses to store the account rather than
   storing it in the clear.

   Exposes window.PromotaKyc = { bind, load } so dashboard.js can wire it
   into its boot sequence. Loaded before dashboard.js. */
(function () {
  'use strict';

  var Auth = window.PromotaAuth;
  if (!Auth) return;

  var STATE_ID = 'kyc-state';
  var NOTE_ID = 'kyc-note';
  var STATUS_ID = 'kyc-status';
  var FORM_ID = 'kyc-form';
  var SUBMIT_ID = 'kyc-submit';

  function byId(id) { return document.getElementById(id); }

  function value(id) {
    var el = byId(id);
    return el ? String(el.value || '').trim() : '';
  }

  function when(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-NG') + ' ' + d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  }

  function setStatus(message, kind) {
    var box = byId(STATUS_ID);
    if (!box) return;
    box.textContent = message || '';
    box.className = 'form-status' + (kind ? ' ' + kind : '');
  }

  function setNote(message, kind) {
    var box = byId(NOTE_ID);
    if (!box) return;
    box.textContent = message || '';
    box.className = 'form-status' + (kind ? ' ' + kind : '');
  }

  /* ------------------------------------------------------------ KYC status */

  var TIER_COPY = {
    t0: 'Tier 0 — no KYC on file. Data and airtime work; cash payouts do not.',
    t1: 'Tier 1 — legal name and bank details on file. An admin can raise you to tier 2.',
    t2: 'Tier 2 — identity verified. Cash payouts are open to you.'
  };

  /* Paint the /api/me snapshot into the KYC status line. Idempotent: the
     dashboard calls it from renderMe, the KYC tab calls it again on load. */
  function paint(me) {
    var box = byId('kyc-tier');
    if (!box) return;
    var p = (me && me.profile) || {};
    var tier = String(p.kycTier || 't0').toLowerCase();
    var bits = [TIER_COPY[tier] || ('Tier ' + tier + '.')];
    bits.push(p.phoneVerified ? 'Phone verified.' : 'Phone not verified.');
    bits.push(p.ageVerified ? 'Age 18+ verified.' : 'Age not verified yet.');
    if (tier !== 't2') {
      bits.push(p.ageVerified
        ? 'Cash payouts need tier 2 — an admin raises the tier once your identity is on file.'
        : 'Cash payouts need tier 2 plus a verified 18+ age. Use the identity form below.');
    }
    box.textContent = bits.join(' ');
    box.className = 'fine';
  }

  function refreshMe() {
    return Auth.api('/api/me').then(function (r) {
      if (r.status === 200 && r.body) paint(r.body);
    }).catch(function () { /* the status line keeps its last known value */ });
  }

  /* ------------------------------------------------------- basic KYC (t1) */

  function submitBasic(e) {
    e.preventDefault();
    var legalName = value('kyc-basic-legal-name');
    var bankName = value('kyc-basic-bank-name');
    var bankLast4 = value('kyc-basic-last4');
    var box = byId('kyc-basic-status');

    function bad(msg) {
      if (box) { box.textContent = msg; box.className = 'form-status error'; }
      FB && FB.err(msg);
      return false;
    }
    if (!/^[A-Za-z][A-Za-z .'-]{1,119}$/.test(legalName)) return bad('Enter your legal full name as it appears at your bank.');
    if (!bankName) return bad('Enter your bank name.');
    if (!/^[0-9]{4}$/.test(bankLast4)) return bad('Enter only the last 4 digits of your account number.');

    var btn = byId('kyc-basic-submit');
    if (btn) btn.disabled = true;
    if (box) { box.textContent = 'Saving…'; box.className = 'form-status'; }

    return Auth.api('/api/v1/kyc/basic', {
      method: 'POST',
      body: { legalName: legalName, bankName: bankName, bankLast4: bankLast4 }
    }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 200) {
        if (box) {
          box.textContent = 'Saved. Your KYC tier is ' + String((r.body && r.body.kycTier) || 't1').toUpperCase() + '.';
          box.className = 'form-status ok';
        }
        FB && FB.ok('KYC details saved.');
        refreshMe();
        return r.body;
      }
      if (r.status === 401) { Auth.clearToken(); return bad('Your session expired. Sign in again.'); }
      return bad((r.body && r.body.error) || 'Could not save your KYC details.');
    });
  }

  /* ---------------------------------------------------- identity KYC (t2) */

  function submitIdentity(e) {
    e.preventDefault();
    var idType = value('kyc-id-type').toUpperCase();
    var idValue = value('kyc-id-value');
    var dob = value('kyc-dob');
    var box = byId('kyc-identity-status');

    function bad(msg) {
      if (box) { box.textContent = msg; box.className = 'form-status error'; }
      FB && FB.err(msg);
      return false;
    }
    if (idType !== 'NIN' && idType !== 'BVN') return bad('Choose NIN or BVN.');
    if (!/^[0-9]{11}$/.test(idValue)) return bad('A NIN or BVN is 11 digits.');
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(dob)) return bad('Enter your date of birth.');

    var btn = byId('kyc-identity-submit');
    if (btn) btn.disabled = true;
    if (box) { box.textContent = 'Checking…'; box.className = 'form-status'; }

    return Auth.api('/api/v1/kyc/identity', {
      method: 'POST',
      body: { idType: idType, idValue: idValue, dob: dob }
    }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 200) {
        /* The number is never sent back; drop it from the DOM anyway. */
        var el = byId('kyc-id-value');
        if (el) el.value = '';
        if (box) {
          box.textContent = 'Identity stored as a fingerprint and your age is verified. Cash payouts need tier 2 — an admin raises the tier.';
          box.className = 'form-status ok';
        }
        FB && FB.ok('Identity verified.');
        refreshMe();
        return r.body;
      }
      if (r.status === 401) { Auth.clearToken(); return bad('Your session expired. Sign in again.'); }
      return bad((r.body && r.body.error) || 'Could not verify your identity.');
    });
  }

  function bindForm(id, handler) {
    var form = byId(id);
    if (!form || form.getAttribute('data-kyc-bound') === '1') return;
    form.setAttribute('data-kyc-bound', '1');
    form.addEventListener('submit', handler);
  }

  /* Paint the stored state. set=true -> the account is on file and we show
     the masked number; set=false -> there is nothing to pay out to yet.
     failureReason always wins over the verified timestamp. */
  function renderState(s) {
    var box = byId(STATE_ID);
    if (box) {
      if (s && s.set) {
        var line = 'Bank account on file: ' + (s.bankName || '–') + ' •••• ' + (s.last4 || '–');
        if (s.accountName) line += ' · ' + s.accountName;
        box.textContent = line;
      } else {
        box.textContent = 'No bank account on file yet. Add one to request a cash payout.';
      }
      box.className = 'fine';
    }
    if (s && s.failureReason) {
      setNote(String(s.failureReason), 'error');
    } else if (s && s.set && s.verifiedAt) {
      setNote('Verified ' + when(s.verifiedAt), 'ok');
    } else {
      setNote('', '');
    }
  }

  /* GET /api/v1/kyc/payout-account + GET /api/me for the tier line */
  function load() {
    refreshMe();
    var box = byId(STATE_ID);
    if (box && !box.textContent) box.textContent = 'Loading your payout account…';
    return Auth.api('/api/v1/kyc/payout-account').then(function (r) {
      if (r.status === 200 && r.body) {
        renderState(r.body);
        return r.body;
      }
      if (r.status === 401) {
        Auth.clearToken();
        setStatus('Your session is missing or expired. Sign in again to manage your payout account.', 'error');
        FB && FB.err('Your session is missing or expired.');
        return null;
      }
      setStatus((r.body && r.body.error) || 'Could not load your payout account.', 'error');
      return null;
    });
  }

  function fail(message) {
    setStatus(message, 'error');
    FB && FB.err(message);
    return false;
  }

  /* POST /api/v1/kyc/payout-account */
  function save() {
    var legalName = value('kyc-legal-name');
    var bankName = value('kyc-bank-name');
    var bankCode = value('kyc-bank-code');
    var accountNumber = value('kyc-account-number');
    var accountName = value('kyc-account-name');

    if (!legalName) return fail('Enter your legal name.');
    if (!bankName) return fail('Enter your bank name.');
    if (!/^[0-9]{3}$/.test(bankCode)) return fail('Bank code must be 3 digits, for example 058.');
    if (!/^[0-9]{10}$/.test(accountNumber)) return fail('Account number must be 10 digits.');
    if (!accountName) return fail('Enter the account name on the bank account.');

    var btn = byId(SUBMIT_ID);
    if (btn) btn.disabled = true;
    setStatus('Saving…', '');

    var body = {
      legalName: legalName,
      bankCode: bankCode,
      bankName: bankName,
      accountNumber: accountNumber,
      accountName: accountName
    };

    return Auth.api('/api/v1/kyc/payout-account', { method: 'POST', body: body }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 200 && r.body) {
        /* The number is never shown again — drop it from the DOM. */
        var numEl = byId('kyc-account-number');
        if (numEl) numEl.value = '';
        /* The server answers { ok, set, last4, verified, failureReason }. */
        if (r.body.ok === false || r.body.failureReason) {
          fail(String(r.body.failureReason || 'The server did not accept the payout account.'));
          load();
          return r.body;
        }
        var msg = r.body.verified === true
          ? 'Payout account saved and verified.'
          : 'Payout account saved. It is not verified yet, so no payout can go out.';
        setStatus(msg, 'ok');
        FB && FB.ok(msg);
        load();
        return r.body;
      }
      if (r.status === 401) {
        Auth.clearToken();
        fail('Your session is missing or expired. Sign in again.');
        return null;
      }
      fail((r.body && r.body.error) || 'Could not save the payout account.');
      return null;
    });
  }

  function onSubmit(e) {
    e.preventDefault();
    save();
  }

  function bind() {
    bindForm(FORM_ID, onSubmit);
    bindForm('kyc-basic-form', submitBasic);
    bindForm('kyc-identity-form', submitIdentity);
    load();
  }

  window.PromotaKyc = {
    bind: bind,
    load: load,
    paint: paint
  };
})();
