/* approval-queue.js — reviewer workspace logic for approval-queue.html.
   External (not inline) so the page can ship a strict CSP (script-src 'self').
   Theme toggle + modal dialog copy the landing.js patterns; landing.js itself
   is untouched. No external assets, no dependencies. */
(function () {
  'use strict';

  /* ---------- theme toggle (pattern copied from landing.js) ---------- */
  var meta = document.getElementById('themeColor');
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('owoworks-theme', theme); } catch (e) { /* storage unavailable */ }
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f7f2' : '#04120b');
    var btn = document.getElementById('themeBtnQueue');
    if (btn) btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }
  var themeBtn = document.getElementById('themeBtnQueue');
  if (themeBtn) {
    themeBtn.setAttribute('aria-pressed', currentTheme() === 'light' ? 'true' : 'false');
    themeBtn.addEventListener('click', function () {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
  }

  /* ---------- modal (pattern copied from landing.js) ---------- */
  var modal = document.getElementById('modal');
  var modalContent = document.getElementById('modal-content');
  var modalTitle = document.getElementById('modal-title');
  var modalSubtitle = document.getElementById('modal-subtitle');
  var closeModalBtn = document.getElementById('close-modal');
  var rejectForm = document.getElementById('reject-form');
  var rejectReason = document.getElementById('reject-reason');
  var pendingRejectId = null;

  function openModal(taskId) {
    pendingRejectId = taskId;
    if (modalTitle) modalTitle.textContent = 'Reject task';
    if (modalSubtitle) modalSubtitle.textContent = 'A reason is required and is stored with the decision.';
    if (rejectForm) rejectForm.reset();
    modal.hidden = false;
    var first = modalContent.querySelector('input, button');
    if (first) first.focus();
  }
  function closeModalFn() {
    modal.hidden = true;
    pendingRejectId = null;
  }

  if (closeModalBtn) closeModalBtn.addEventListener('click', closeModalFn);
  if (modal) modal.addEventListener('click', function (e) { if (e.target === modal) closeModalFn(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal && !modal.hidden) closeModalFn(); });

  /* ---------- reviewer session ---------- */
  var TOKEN_KEY = 'promota-reviewer-token';
  var sessionForm = document.getElementById('session-form');
  var sessionInput = document.getElementById('session-token');
  var sessionClear = document.getElementById('session-clear');
  var sessionStatus = document.getElementById('session-status');

  function getToken() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); }
    catch (e) { return ''; }
  }
  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* storage unavailable */ }
    paintSession();
  }
  function paintSession() {
    var has = Boolean(getToken());
    if (sessionStatus) sessionStatus.textContent = has
      ? 'Token saved. The queue and trail can now load.'
      : 'No token saved. The queue stays empty until sign in.';
  }

  if (sessionForm) sessionForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var t = sessionInput ? sessionInput.value.trim() : '';
    if (!t) return;
    setToken(t);
    if (sessionInput) sessionInput.value = '';
    loadQueue();
    loadAudit();
  });
  if (sessionClear) sessionClear.addEventListener('click', function () {
    setToken('');
    if (sessionInput) sessionInput.value = '';
    clearTables('Token cleared. Sign in to load the queue.');
  });
  paintSession();

  /* ---------- helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, options) {
    var token = getToken();
    var headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = 'Bearer ' + token;
    return fetch(path, Object.assign({ headers: headers }, options || {}))
      .then(function (res) {
        return res.json().then(function (body) {
          return { status: res.status, body: body };
        });
      });
  }

  function badge(state) {
    return '<span class="badge badge-' + esc(state) + '">' + esc(state) + '</span>';
  }

  /* ---------- queue ---------- */
  var queueBody = document.getElementById('queue-body');
  var queueStatus = document.getElementById('queue-status');
  var queueRefresh = document.getElementById('queue-refresh');
  var activeState = '';

  function clearTables(message) {
    if (queueBody) queueBody.innerHTML = '';
    var auditBody = document.getElementById('audit-body');
    if (auditBody) auditBody.innerHTML = '';
    if (queueStatus) queueStatus.textContent = message;
    var auditStatus = document.getElementById('audit-status');
    if (auditStatus) auditStatus.textContent = message;
  }

  function loadQueue() {
    if (!getToken()) {
      if (queueStatus) queueStatus.textContent = 'Sign in to load the queue.';
      return;
    }
    if (queueStatus) queueStatus.textContent = 'Loading…';
    var path = '/api/admin/tasks?limit=50' + (activeState ? '&state=' + encodeURIComponent(activeState) : '');
    api(path).then(function (res) {
      if (res.status === 401) {
        if (queueStatus) queueStatus.textContent = 'That token is not a signed-in reviewer. Save a fresh token.';
        return;
      }
      if (res.status !== 200 || !res.body || !Array.isArray(res.body.tasks)) {
        if (queueStatus) queueStatus.textContent = 'The queue could not load: ' + ((res.body && res.body.error) || 'unknown error');
        return;
      }
      var tasks = res.body.tasks;
      if (!tasks.length) {
        queueBody.innerHTML = '';
        if (queueStatus) queueStatus.textContent = 'Nothing waiting. The queue is clear.';
        return;
      }
      var html = '';
      tasks.forEach(function (t) {
        html += '<tr>'
          + '<td><strong>' + esc(t.caption || t.id) + '</strong><br><span class="fine">' + esc(t.id) + '</span></td>'
          + '<td>' + badge(t.state) + '</td>'
          + '<td>' + (t.proofUrl ? '<a href="' + esc(t.proofUrl) + '">Proof</a>' : '<span class="fine">None</span>') + '</td>'
          + '<td>' + esc(t.submittedAt || '—') + '</td>'
          + '<td><button class="btn gold queue-approve" type="button" data-id="' + esc(t.id) + '">Approve</button> '
          + '<button class="btn ghost queue-reject" type="button" data-id="' + esc(t.id) + '">Reject</button></td>'
          + '</tr>';
      });
      queueBody.innerHTML = html;
      if (queueStatus) queueStatus.textContent = tasks.length + ' waiting.';
    }).catch(function () {
      if (queueStatus) queueStatus.textContent = 'The queue could not load. Check the connection and retry.';
    });
  }

  document.querySelectorAll('.queue-filter').forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeState = btn.getAttribute('data-state') || '';
      document.querySelectorAll('.queue-filter').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      loadQueue();
    });
  });
  if (queueRefresh) queueRefresh.addEventListener('click', loadQueue);

  if (queueBody) queueBody.addEventListener('click', function (e) {
    var approve = e.target.closest ? e.target.closest('.queue-approve') : null;
    var reject = e.target.closest ? e.target.closest('.queue-reject') : null;
    if (approve) decide(approve.getAttribute('data-id'), 'approve');
    else if (reject) openModal(reject.getAttribute('data-id'));
  });

  function decide(id, kind, reason) {
    var path = '/api/admin/tasks/' + encodeURIComponent(id) + '/' + kind;
    var payload = kind === 'reject' ? { reason: reason } : {};
    api(path, { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
      if (res.status === 401) {
        if (queueStatus) queueStatus.textContent = 'That token is not a signed-in reviewer. Save a fresh token.';
        return;
      }
      if (res.status !== 200) {
        if (queueStatus) queueStatus.textContent = 'Decision refused: ' + ((res.body && res.body.error) || 'unknown error');
        return;
      }
      loadQueue();
      loadAudit();
    }).catch(function () {
      if (queueStatus) queueStatus.textContent = 'The decision could not save. Retry.';
    });
  }

  if (rejectForm) rejectForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var reason = rejectReason ? rejectReason.value.trim() : '';
    if (!reason || !pendingRejectId) return;
    var id = pendingRejectId;
    closeModalFn();
    decide(id, 'reject', reason);
  });

  /* ---------- audit trail ---------- */
  var auditBody = document.getElementById('audit-body');
  var auditStatus = document.getElementById('audit-status');
  var auditRefresh = document.getElementById('audit-refresh');

  function loadAudit() {
    if (!getToken()) {
      if (auditStatus) auditStatus.textContent = 'Sign in to load the trail.';
      return;
    }
    if (auditStatus) auditStatus.textContent = 'Loading…';
    api('/api/admin/audit?limit=50').then(function (res) {
      if (res.status === 401) {
        if (auditStatus) auditStatus.textContent = 'That token is not a signed-in reviewer. Save a fresh token.';
        return;
      }
      if (res.status !== 200 || !res.body || !Array.isArray(res.body.audit)) {
        if (auditStatus) auditStatus.textContent = 'The trail could not load: ' + ((res.body && res.body.error) || 'unknown error');
        return;
      }
      var rows = res.body.audit;
      if (!rows.length) {
        auditBody.innerHTML = '';
        if (auditStatus) auditStatus.textContent = 'No entries yet.';
        return;
      }
      var html = '';
      rows.forEach(function (a) {
        html += '<tr>'
          + '<td>' + esc(a.createdAt || '—') + '</td>'
          + '<td>' + badge(a.action) + '<br><span class="fine">' + esc(a.targetType || '') + ' ' + esc(a.targetId || '') + '</span></td>'
          + '<td><span class="fine">' + esc(a.targetId || '—') + '</span></td>'
          + '<td>' + esc(a.actorRole || '—') + '<br><span class="fine">' + esc(a.actorId || '') + '</span></td>'
          + '</tr>';
      });
      auditBody.innerHTML = html;
      if (auditStatus) auditStatus.textContent = rows.length + ' recent entries.';
    }).catch(function () {
      if (auditStatus) auditStatus.textContent = 'The trail could not load. Check the connection and retry.';
    });
  }

  if (auditRefresh) auditRefresh.addEventListener('click', loadAudit);

  /* ---------- boot ---------- */
  if (getToken()) {
    loadQueue();
    loadAudit();
  }
})();
