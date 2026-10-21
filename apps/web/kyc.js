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

  /* GET /api/v1/kyc/payout-account */
  function load() {
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
    var form = byId(FORM_ID);
    if (!form) return;
    if (form.getAttribute('data-kyc-bound') === '1') return;
    form.setAttribute('data-kyc-bound', '1');
    form.addEventListener('submit', onSubmit);
    load();
  }

  window.PromotaKyc = {
    bind: bind,
    load: load
  };
})();
