/* feedback.js — Promota global feedback layer.
   ONE system for every user-facing action on every page:
   - toasts (ok/err/info) with an aria-live region, zero dependencies;
   - a branded boot splash that shows the loading symbol until the page
     signals readiness (or a hard 7s ceiling, so nobody is ever trapped);
   - FB.describe(result, okMsg, errMsg) — the standard way every call site
     turns an Auth.api {status, body} answer into user feedback.
   Loaded before the page script on every app surface. */
(function () {
  'use strict';

  /* ---------- toast stack ---------- */
  var stack = null;
  function ensureStack() {
    if (stack && document.body.contains(stack)) return stack;
    stack = document.createElement('div');
    stack.id = 'fb-stack';
    stack.className = 'fb-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
    return stack;
  }

  function toast(kind, msg) {
    if (!msg || typeof msg !== 'string') return;
    var el = document.createElement('div');
    el.className = 'fb-toast fb-' + kind;
    var icon = document.createElement('span');
    icon.className = 'fb-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = kind === 'ok' ? '\u2714' : kind === 'err' ? '\u2716' : '\u2139';
    var text = document.createElement('span');
    text.textContent = msg; /* textContent: never inject markup */
    el.appendChild(icon);
    el.appendChild(text);
    var host = ensureStack();
    host.appendChild(el);
    while (host.children.length > 4) host.removeChild(host.firstChild);
    /* force a layout pass so the entrance transition always plays */
    void el.offsetWidth;
    el.classList.add('fb-show');
    window.setTimeout(function () {
      el.classList.remove('fb-show');
      window.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, kind === 'err' ? 6000 : 4200);
  }

  /* ---------- boot splash ---------- */
  var splash = null;
  var splashDone = false;
  function ensureSplash() {
    if (document.getElementById('boot-splash')) {
      splash = document.getElementById('boot-splash');
      return splash;
    }
    splash = document.createElement('div');
    splash.id = 'boot-splash';
    splash.setAttribute('aria-hidden', 'true');
    splash.innerHTML =
      '<div class="splash-card">' +
      '<img class="splash-mark" src="/assets/identity/mark.svg" alt="" width="56" height="56">' +
      '<div class="splash-ring"></div>' +
      '<div class="splash-word"><span class="ow">Pro</span><span class="works">mota</span></div>' +
      '</div>';
    document.body.appendChild(splash);
    return splash;
  }

  function ready() {
    if (splashDone) return;
    splashDone = true;
    var el = splash || document.getElementById('boot-splash');
    if (!el) return;
    el.classList.add('splash-hide');
    window.setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 380);
  }
  /* hard ceiling: the splash can never outlive 7 seconds */
  window.setTimeout(ready, 7000);
  window.addEventListener('pagehide', ready);

  /* ---------- describe: one call site, every surface ---------- */
  function describe(result, okMsg, errMsg) {
    if (!result || typeof result.status !== 'number') {
      toast('err', errMsg || 'Something went wrong. Try again.');
      return result;
    }
    if (result.status >= 200 && result.status < 300) {
      toast('ok', typeof okMsg === 'function' ? okMsg(result.body) : okMsg);
    } else {
      var detail = result.body && result.body.error ? String(result.body.error) : '';
      var msg = typeof errMsg === 'function' ? errMsg(result.body) : (errMsg || 'Action failed.');
      if (detail) msg = msg.replace(/\s*$/, '') + ' — ' + detail;
      toast('err', msg);
    }
    return result;
  }

  window.FB = {
    ok: function (m) { toast('ok', m); },
    err: function (m) { toast('err', m); },
    info: function (m) { toast('info', m); },
    describe: describe,
    ready: ready
  };

  /* pages opt in: the splash renders immediately, before first paint jank */
  if (document.body) ensureSplash();
  else document.addEventListener('DOMContentLoaded', ensureSplash);
})();
