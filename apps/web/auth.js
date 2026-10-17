/* auth.js — shared session + OTP helpers for Promota pages.
   The backend is passwordless: Termii proves the phone, then /api/auth/otp/verify
   returns a signed 12-hour bearer token (api/session.mjs). Everything in the app
   calls same-origin /api endpoints with that bearer. The token is kept in
   localStorage so a refresh or a later page keeps the session, mirroring
   approval-queue.js. */
(function () {
  'use strict';

  var TOKEN_KEY = 'promota-session';

  function getToken() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); }
    catch (e) { return ''; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* storage unavailable */ }
  }
  function clearToken() { setToken(''); }

  /* Same-shape helper as approval-queue.js: every call answers
     { status, body } and never throws for HTTP errors. */
  function api(path, options) {
    var headers = { 'content-type': 'application/json' };
    var token = getToken();
    if (token) headers.authorization = 'Bearer ' + token;
    return fetch(path, {
      headers: headers,
      method: (options && options.method) || 'GET',
      body: options && options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      return res.json().then(function (body) {
        return { status: res.status, body: body };
      }, function () {
        return { status: res.status, body: null };
      });
    }, function () {
      return { status: 0, body: null };
    });
  }

  /* Mirror of api/routes.mjs normalisePhone + app.js validation:
     0 + 10 digits, NCC prefixes only. */
  var MSISDN_PREFIXES = ['080', '081', '070', '090', '071'];
  function normalisePhone(raw) {
    var d = String(raw || '').replace(/[\s\-().]/g, '').replace(/\D/g, '');
    if (d.length === 13 && d.indexOf('234') === 0) d = '0' + d.slice(3);
    else if (d.length !== 11 || d.charAt(0) !== '0') return null;
    var ok = /^0\d{10}$/.test(d) && MSISDN_PREFIXES.some(function (p) { return d.indexOf(p) === 0; });
    return ok ? d : null;
  }

  /** POST /api/auth/otp/request → { sent, phone, network, pinId } */
  function requestOtp(phone) {
    return api('/api/auth/otp/request', { method: 'POST', body: { phone: phone } });
  }

  /** POST /api/auth/otp/verify → saves token; returns { status, body } */
  function verifyOtp(phone, pinId, pin) {
    return api('/api/auth/otp/verify', { method: 'POST', body: { phone: phone, pinId: pinId, pin: pin } })
      .then(function (r) {
        if (r.status === 200 && r.body && r.body.token) setToken(r.body.token);
        return r;
      });
  }

  function signOut() { clearToken(); }

  window.PromotaAuth = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    api: api,
    normalisePhone: normalisePhone,
    requestOtp: requestOtp,
    verifyOtp: verifyOtp,
    signOut: signOut
  };
})();
