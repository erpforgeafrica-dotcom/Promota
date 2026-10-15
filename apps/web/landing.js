/* landing.js — modal dialog + theme toggle for the Promota landing page.
   External (not inline) so the page can ship a strict CSP (script-src 'self').
   Mirrors theme-boot.js: stored choice wins, then OS preference, then dark. */
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

  /* ---------- modal ---------- */
  var modal = document.getElementById('modal');
  var modalContent = document.getElementById('modal-content');
  var loginBtn = document.getElementById('login-btn');
  var signupBtn = document.getElementById('signup-btn');
  var loginCta = document.getElementById('login-cta');
  var signupCta = document.getElementById('signup-cta');
  var finalCta = document.getElementById('final-cta');
  var closeModal = document.getElementById('close-modal');
  var switchToSignup = document.getElementById('switch-to-signup');
  var authForm = document.getElementById('auth-form');
  var modalTitle = document.getElementById('modal-title');
  var modalSubtitle = document.getElementById('modal-subtitle');
  if (!modal || !authForm) return;

  function openModal(mode) {
    modal.hidden = false;
    if (mode === 'login') {
      modalTitle.textContent = 'Login';
      modalSubtitle.textContent = 'Enter your credentials';
    } else {
      modalTitle.textContent = 'Signup';
      modalSubtitle.textContent = 'Create your account';
    }
    authForm.reset();
    var first = modalContent.querySelector('input, button');
    if (first) first.focus();
  }
  function closeModalFn() { modal.hidden = true; }

  if (loginBtn) loginBtn.addEventListener('click', function () { openModal('login'); });
  if (signupBtn) signupBtn.addEventListener('click', function () { openModal('signup'); });
  if (loginCta) loginCta.addEventListener('click', function () { openModal('login'); });
  if (signupCta) signupCta.addEventListener('click', function () { openModal('signup'); });
  if (finalCta) finalCta.addEventListener('click', function () { openModal('login'); });
  if (closeModal) closeModal.addEventListener('click', closeModalFn);
  if (switchToSignup) switchToSignup.addEventListener('click', function () { openModal('signup'); });
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModalFn(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !modal.hidden) closeModalFn(); });
  authForm.addEventListener('submit', function (e) {
    e.preventDefault();
    closeModalFn();
  });
})();

/* ---------- landing additions: mobile menu, FAQ accordion, data-auth hooks ---------- */
(function () {
  'use strict';

  /* mobile menu toggle */
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

  /* FAQ accordion: .q click toggles .a.open + aria-expanded */
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

  /* data-auth buttons open the shared modal without the fixed nav/hero IDs */
  var modalEl = document.getElementById('modal');
  if (modalEl) {
    var openAuth = function (mode) {
      modalEl.hidden = false;
      var title = document.getElementById('modal-title');
      var subtitle = document.getElementById('modal-subtitle');
      if (title && subtitle) {
        if (mode === 'login') {
          title.textContent = 'Login';
          subtitle.textContent = 'Enter your credentials';
        } else {
          title.textContent = 'Signup';
          subtitle.textContent = 'Create your account';
        }
      }
      var form = document.getElementById('auth-form');
      if (form) form.reset();
    };
    document.querySelectorAll('[data-auth]').forEach(function (el) {
      el.addEventListener('click', function () {
        openAuth(el.getAttribute('data-auth') || 'signup');
      });
    });
  }

  /* mobile theme toggle mirrors the nav toggle */
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
      var meta = document.getElementById('themeColor');
      if (meta) meta.setAttribute('content', next === 'light' ? '#f4f7f2' : '#04120b');
      syncMenuTheme();
      var navTheme = document.getElementById('themeBtnNav');
      if (navTheme) navTheme.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
    });
  }
})();
