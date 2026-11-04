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

  /* One-time session handoff: /admin.html#token=<session token>.

     WHY A FRAGMENT: the browser never sends the fragment to the server and
     never includes it in a Referer header, so the token cannot end up in
     access logs. It is consumed once, then erased from the address bar and
     from the history entry.

     WHY A ROLE CHECK: without it, a link could log the owner into somebody
     else's ordinary account (login CSRF). Only an already-privileged session
     is accepted here; a promoter token in a fragment is ignored. The signature
     is still verified server-side on every request - this check only decides
     whether the browser should adopt the token at all. */
  var PRIVILEGED_ROLES = { owner: true, admin: true, support: true };

  /** Decode the (unverified) claims of a token, or null when malformed. */
  function claimsOf(token) {
    var parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    var b = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    try { return JSON.parse(atob(b)); } catch (e) { return null; }
  }

  /** Adopt a privileged token from the URL fragment. Returns true when used. */
  function adoptHashToken() {
    var hash = String((typeof location !== 'undefined' && location.hash) || '');
    if (hash.indexOf('#token=') !== 0) return false;
    var token = '';
    try { token = decodeURIComponent(hash.slice(7)).trim(); } catch (e) { return false; }
    var claims = claimsOf(token);
    if (!claims || !PRIVILEGED_ROLES[claims.role]) return false;
    if (!claims.exp || claims.exp * 1000 <= Date.now()) return false;
    setToken(token);
    try { history.replaceState(null, '', location.pathname + location.search); }
    catch (e) { /* older browser: the token is already stored */ }
    return true;
  }

  adoptHashToken();

  window.PromotaAuth = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    api: api,
    normalisePhone: normalisePhone,
    requestOtp: requestOtp,
    verifyOtp: verifyOtp,
    signOut: signOut,
    adoptHashToken: adoptHashToken
  };
})();
