/* landing.js — theme, mobile menu, FAQ accordion, and the REAL phone-OTP
   auth modal for the Promota landing pages.
   External (not inline) so pages ship a strict CSP (script-src 'self').
   The modal talks to the live backend: POST /api/auth/otp/request, then
   POST /api/auth/otp/verify, which returns the session bearer. Signing in and
   signing up are the same flow — a first-time verify creates the account
   (api/routes.mjs verifyOtp). */
(function () {
  'use strict';

  /* ---------- theme toggle ---------- */
  var meta = document.getElementById('themeColor');
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('owoworks-theme', theme); } catch (e) { /* storage unavailable */ }
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f7f2' : '#04120b');
    var btn = document.getElementById('themeBtnNav');
    if (btn) btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }
  var themeBtn = document.getElementById('themeBtnNav');
  if (themeBtn) {
    themeBtn.setAttribute('aria-pressed', currentTheme() === 'light' ? 'true' : 'false');
    themeBtn.addEventListener('click', function () {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
  }

  /* ---------- auth modal: phone step -> OTP step -> dashboard ---------- */
  var modal = document.getElementById('modal');
  var authForm = document.getElementById('auth-form');
  if (!modal || !authForm || !window.PromotaAuth) return;

  var modalTitle = document.getElementById('modal-title');
  var modalSubtitle = document.getElementById('modal-subtitle');
  var modalContent = document.getElementById('modal-content');
  var phoneStep = document.getElementById('auth-phone-step');
  var otpStep = document.getElementById('auth-otp-step');
  var phoneInput = document.getElementById('auth-phone');
  var otpInput = document.getElementById('auth-otp');
  var otpHint = document.getElementById('auth-otp-hint');
  var statusEl = document.getElementById('auth-status');
  var submitBtn = document.getElementById('auth-submit');
  var backBtn = document.getElementById('auth-back');
  var closeModalBtn = document.getElementById('close-modal');

  var mode = 'login';
  var pendingPhone = '';
  var pendingPinId = '';
  var busy = false;

  function say(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.className = 'form-status' + (isError ? ' error' : '');
  }

  function showPhoneStep() {
    if (phoneStep) phoneStep.hidden = false;
    if (otpStep) otpStep.hidden = true;
    if (backBtn) backBtn.hidden = true;
    if (submitBtn) submitBtn.textContent = mode === 'login' ? 'Send code' : 'Create free account';
    if (otpInput) otpInput.value = '';
    pendingPinId = '';
    say('');
    if (phoneInput) phoneInput.focus();
  }

  function showOtpStep(network) {
    if (phoneStep) phoneStep.hidden = true;
    if (otpStep) otpStep.hidden = false;
    if (backBtn) backBtn.hidden = false;
    if (submitBtn) submitBtn.textContent = 'Verify code';
    if (otpHint) otpHint.textContent = 'Code sent to ' + pendingPhone +
      (network ? ' (' + network + ')' : '') + '. It expires quickly.';
    say('');
    if (otpInput) otpInput.focus();
  }

  function openModal(requestedMode) {
    mode = requestedMode === 'signup' ? 'signup' : 'login';
    if (modalTitle) modalTitle.textContent = mode === 'signup' ? 'Sign up' : 'Sign in';
    if (modalSubtitle) modalSubtitle.textContent = mode === 'signup'
      ? 'Create your account with your phone number'
      : 'Enter your phone number to continue';
    authForm.reset();
    showPhoneStep();
    modal.hidden = false;
    if (phoneInput) phoneInput.focus();
  }
  function closeModalFn() { modal.hidden = true; }

  if (closeModalBtn) closeModalBtn.addEventListener('click', closeModalFn);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModalFn(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !modal.hidden) closeModalFn();
  });
  if (backBtn) backBtn.addEventListener('click', showPhoneStep);

  /* One delegated handler: the CURRENT data-auth value decides the action, so
     the signed-in rename below can flip buttons to 'dashboard' safely. */
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-auth]') : null;
    if (!el) return;
    var requested = el.getAttribute('data-auth');
    if (requested === 'dashboard') {
      e.preventDefault();
      window.location.href = '/dashboard.html';
      return;
    }
    openModal(requested || 'login');
  });
  ['login-btn', 'signup-btn', 'login-cta', 'signup-cta', 'final-cta'].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.setAttribute('data-auth', id.indexOf('signup') === 0 ? 'signup' : 'login');
  });

  authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (busy) return;

    if (pendingPinId) {
      /* ---- OTP step ---- */
      var pin = otpInput ? otpInput.value.trim() : '';
      if (!/^\d{4,8}$/.test(pin)) { say('Enter the code from the SMS.', true); return; }
      busy = true;
      if (submitBtn) submitBtn.disabled = true;
      say('Checking the code…');
      window.PromotaAuth.verifyOtp(pendingPhone, pendingPinId, pin).then(function (r) {
        if (r.status === 200 && r.body && r.body.token) {
          say('Signed in. Opening your dashboard…');
          window.location.href = '/dashboard.html';
          return;
        }
        busy = false;
        if (submitBtn) submitBtn.disabled = false;
        var msg = (r.body && r.body.error) || 'That code is not valid.';
        if (r.status === 503) msg = 'SMS service is not configured on the server yet.';
        say(msg, true);
        if (otpInput) otpInput.focus();
      });
      return;
    }

    /* ---- phone step ---- */
    var normalised = window.PromotaAuth.normalisePhone(phoneInput ? phoneInput.value : '');
    if (!normalised) {
      say('Use a Nigerian number, for example 0803 000 0000 or +234 803 000 0000.', true);
      if (phoneInput) phoneInput.focus();
      return;
    }
    busy = true;
    if (submitBtn) submitBtn.disabled = true;
    say('Sending the code…');
    window.PromotaAuth.requestOtp(normalised).then(function (r) {
      if (r.status === 200 && r.body && r.body.sent && r.body.pinId) {
        pendingPhone = r.body.phone || normalised;
        pendingPinId = r.body.pinId;
        busy = false;
        if (submitBtn) submitBtn.disabled = false;
        showOtpStep(r.body.network);
        return;
      }
      busy = false;
      if (submitBtn) submitBtn.disabled = false;
      var msg = (r.body && r.body.error) || 'Could not send the code. Please try again.';
      if (r.status === 503) msg = 'SMS service is not configured on the server yet.';
      say(msg, true);
      if (phoneInput) phoneInput.focus();
    });
  });

  /* ---------- signed-in state: nav buttons become a dashboard link ---------- */
  if (window.PromotaAuth.getToken()) {
    ['login-btn', 'login-cta', 'final-cta', 'login-m', 'signup-btn', 'signup-cta', 'signup-m'].forEach(function (id) {
      var b = document.getElementById(id);
      if (!b) return;
      b.textContent = id.indexOf('signup') === 0 ? 'Open dashboard' : 'Dashboard';
      b.setAttribute('data-auth', 'dashboard');
      b.removeAttribute('id');
    });
  }

  /* ---------- mobile menu ---------- */
  var menuBtn = document.getElementById('menu-btn');
  var mobileMenu = document.getElementById('mobile-menu');
  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener('click', function () {
      var open = mobileMenu.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    mobileMenu.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') {
        mobileMenu.classList.remove('open');
        menuBtn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  /* ---------- FAQ accordion: .q click toggles .a.open + aria-expanded ---------- */
  document.querySelectorAll('.q').forEach(function (q) {
    q.addEventListener('click', function () {
      var expanded = q.getAttribute('aria-expanded') === 'true';
      q.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      var answerId = q.getAttribute('aria-controls');
      var answer = answerId ? document.getElementById(answerId) : null;
      if (answer) answer.classList.toggle('open', !expanded);
      var mark = q.querySelector('span');
      if (mark) mark.textContent = expanded ? '+' : '−';
    });
  });

  /* ---------- mobile theme toggle mirrors the nav toggle ---------- */
  var menuTheme = document.getElementById('themeBtnMenu');
  if (menuTheme) {
    var isLight = function () {
      return document.documentElement.getAttribute('data-theme') === 'light';
    };
    var syncMenuTheme = function () {
      menuTheme.setAttribute('aria-pressed', isLight() ? 'true' : 'false');
    };
    syncMenuTheme();
    menuTheme.addEventListener('click', function () {
      var next = isLight() ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('owoworks-theme', next); } catch (e) { /* storage unavailable */ }
      var meta2 = document.getElementById('themeColor');
      if (meta2) meta2.setAttribute('content', next === 'light' ? '#f4f7f2' : '#04120b');
      syncMenuTheme();
      var navTheme = document.getElementById('themeBtnNav');
      if (navTheme) navTheme.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
    });
  }
})();
