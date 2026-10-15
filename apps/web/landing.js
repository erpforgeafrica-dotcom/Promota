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
