/* admin.js — the admin console. Only real /api/admin/* calls; nothing mocked.
   Boot gates on GET /api/admin/stats: 401 -> sign in, 403 -> not admin/owner. */
(function () {
  'use strict';

  var Auth = window.PromotaAuth;
  if (!Auth) return;

  /* ---------- theme toggle (same pattern as approval-queue.js) ---------- */
  var themeMeta = document.getElementById('themeColor');
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('owoworks-theme', theme); } catch (e) { /* storage unavailable */ }
    if (themeMeta) themeMeta.setAttribute('content', theme === 'light' ? '#f4f7f2' : '#04120b');
    var tbtn = document.getElementById('themeBtnAdmin');
    if (tbtn) tbtn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }
  var themeBtn = document.getElementById('themeBtnAdmin');
  if (themeBtn) {
    themeBtn.setAttribute('aria-pressed',
      document.documentElement.getAttribute('data-theme') === 'light' ? 'true' : 'false');
    themeBtn.addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    });
  }

  var gate = document.getElementById('gate');
  var app = document.getElementById('app');
  var loadStatus = document.getElementById('load-status');
  var whoami = document.getElementById('whoami');
  var dashLink = document.getElementById('dash-link');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function naira(minor) {
    var n = Number(minor || 0) / 100;
    return '₦' + n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function when(iso) {
    if (!iso) return '–';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '–' : d.toLocaleDateString('en-NG') + ' ' + d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  }
  function badge(state) {
    return '<span class="badge">' + esc(state || '–') + '</span>';
  }
  function short(id) { return esc(String(id || '')).slice(0, 8) + '…'; }
  function say(boxId, message, isError) {
    var b = document.getElementById(boxId);
    if (!b) return;
    b.textContent = message || '';
    b.className = 'form-status' + (isError ? ' error' : '');
  }
  function setPane(id) {
    document.querySelectorAll('.tab').forEach(function (t) {
      var on = t.getAttribute('data-pane') === id;
      t.classList.toggle('active', on);
      t.setAttribute('aria-checked', String(on));
    });
    document.querySelectorAll('.pane').forEach(function (p) {
      p.hidden = p.id !== 'pane-' + id;
    });
  }
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { setPane(t.getAttribute('data-pane')); });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { /* no modal here */ } });

  function failGate(title, copy) {
    var h = document.getElementById('gate-title');
    var p = document.getElementById('gate-copy');
    if (h) h.textContent = title;
    if (p) p.textContent = copy;
    if (gate) gate.hidden = false;
    if (app) app.hidden = true;
  }

  /* ---------------- stats ---------------- */

  function paintStats(s) {
    document.getElementById('st-users').textContent = String((s.users && s.users.total) || 0);
    document.getElementById('st-tasks').textContent = String((s.tasks && s.tasks.total) || 0);
    document.getElementById('st-campaigns').textContent = String((s.campaigns && s.campaigns.total) || 0);
    document.getElementById('st-budget').textContent = naira(s.campaigns && s.campaigns.budgetMinor);
    document.getElementById('st-spent').textContent = naira(s.campaigns && s.campaigns.spentMinor);
    document.getElementById('st-payouts').textContent = naira(s.payouts && s.payouts.amountMinor);
    document.getElementById('st-redemptions').textContent = String((s.redemptions && s.redemptions.total) || 0);
    document.getElementById('st-disputes').textContent = String((s.disputes && s.disputes.total) || 0);

    var rows = [];
    [['Users by state', s.users && s.users.byState], ['Users by role', s.users && s.users.byRole],
     ['Tasks by state', s.tasks && s.tasks.byState], ['Campaigns by state', s.campaigns && s.campaigns.byState],
     ['Payouts by status', s.payouts && s.payouts.byStatus], ['Redemptions by state', s.redemptions && s.redemptions.byState],
     ['Disputes by state', s.disputes && s.disputes.byState]].forEach(function (pair) {
      var map = pair[1] || {};
      Object.keys(map).forEach(function (k) {
        rows.push([pair[0], k, String(map[k])]);
      });
    });
    var body = document.getElementById('breakdown-body');
    if (body) {
      body.innerHTML = rows.length
        ? rows.map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + badge(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'; }).join('')
        : '<tr><td colspan="3" class="fine">No data yet.</td></tr>';
    }
  }

  function loadStats() {
    return Auth.api('/api/admin/stats').then(function (r) {
      if (r.status === 200 && r.body) { paintStats(r.body); say('load-status', 'Stats loaded.', false); return true; }
      if (r.status === 403) { failGate('Admin access required', 'Your account does not have an admin role. Sign in with an admin account.'); return false; }
      if (r.status === 401) { Auth.clearToken(); failGate('Sign in required', 'Your session is missing or expired.'); return false; }
      failGate('The console is not reachable right now', (r.body && r.body.error) || 'Try again shortly.');
      return false;
    });
  }

  var stRefresh = document.getElementById('st-refresh');
  if (stRefresh) stRefresh.addEventListener('click', function () { loadStats(); });

  /* ---------------- users ---------------- */

  function userRow(u) {
    var actions = '<button class="btn ghost btn-sm" type="button" data-user-detail="' + esc(String(u.id)) + '">Detail</button>';
    if (u.state === 'active') {
      actions += ' <button class="btn ghost btn-sm" type="button" data-suspend="' + esc(String(u.id)) + '">Suspend</button>';
    } else if (u.state === 'suspended') {
      actions += ' <button class="btn ghost btn-sm" type="button" data-reinstate="' + esc(String(u.id)) + '">Reinstate</button>';
    }
    return '<tr><td>' + esc(u.displayName || u.phone || short(u.id)) + '<br><span class="fine">' + esc(u.phone || short(u.id)) + '</span></td>' +
      '<td>' + esc(u.role) + '</td><td>' + badge(u.state) + '</td>' +
      '<td>' + esc(u.kycTier == null ? '–' : String(u.kycTier)) + '</td>' +
      '<td>' + esc(u.trustScore == null ? '–' : String(u.trustScore)) + '</td>' +
      '<td>' + when(u.createdAt) + '</td><td>' + actions + '</td></tr>';
  }

  function bindUserActions() {
    var body = document.getElementById('users-body');
    if (!body) return;
    body.querySelectorAll('[data-suspend]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-suspend');
        var reason = window.prompt('Suspension reason (required):');
        if (!reason || !reason.trim()) { say('users-status', 'A suspension reason is required.', true); return; }
        b.disabled = true;
        Auth.api('/api/admin/users/' + encodeURIComponent(id) + '/suspend', { method: 'POST', body: { reason: reason.trim() } })
          .then(function (r) {
            if (r.status === 200) { say('users-status', 'User suspended.', false); loadUsers(); }
            else { say('users-status', (r.body && r.body.error) || 'Suspend refused.', true); b.disabled = false; }
          });
      });
    });
    body.querySelectorAll('[data-reinstate]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-reinstate');
        b.disabled = true;
        Auth.api('/api/admin/users/' + encodeURIComponent(id) + '/reinstate', { method: 'POST', body: {} })
          .then(function (r) {
            if (r.status === 200) { say('users-status', 'User reinstated.', false); loadUsers(); }
            else { say('users-status', (r.body && r.body.error) || 'Reinstate refused.', true); b.disabled = false; }
          });
      });
    });
    body.querySelectorAll('[data-user-detail]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-user-detail');
        Auth.api('/api/admin/users/' + encodeURIComponent(id)).then(function (r) {
          var box = document.getElementById('user-detail');
          if (!box) return;
          if (r.status !== 200 || !r.body) { box.hidden = false; box.innerHTML = '<p class="fine">' + esc((r.body && r.body.error) || 'Could not load the user.') + '</p>'; return; }
          var u = r.body.user;
          box.hidden = false;
          box.innerHTML =
            '<h3>' + esc(u.displayName || u.phone || short(u.id)) + '</h3>' +
            '<p>Role: ' + esc(u.role) + ' · State: ' + badge(u.state) + ' · KYC: ' + esc(String(u.kycTier == null ? '–' : u.kycTier)) +
            ' · Phone verified: ' + (u.phoneVerified ? 'yes' : 'no') + ' · 18+ verified: ' + (u.ageVerified ? 'yes' : 'no') + '</p>' +
            (u.suspensionReason ? '<p>Suspension reason: ' + esc(u.suspensionReason) + '</p>' : '') +
            '<p class="fine">Recent tasks:</p>' +
            (r.body.recentTasks || []).map(function (t) {
              return '<p>' + short(t.id) + ' · ' + badge(t.state) + ' · ' + (t.points != null ? esc(String(t.points)) + ' pts' : '–') + ' · ' + when(t.createdAt) + '</p>';
            }).join('') +
            '<p class="fine">Recent redemptions:</p>' +
            (r.body.recentRedemptions || []).map(function (x) {
              return '<p>' + esc(x.kind) + ' · ' + esc(String(x.pointsSpent)) + ' pts · ' + badge(x.state) + ' · ' + when(x.createdAt) + '</p>';
            }).join('');
        });
      });
    });
  }

  function loadUsers() {
    var state = document.getElementById('users-state').value;
    var role = document.getElementById('users-role').value;
    var q = (document.getElementById('users-q').value || '').trim();
    var qs = [];
    if (state) qs.push('state=' + encodeURIComponent(state));
    if (role) qs.push('role=' + encodeURIComponent(role));
    if (q) qs.push('q=' + encodeURIComponent(q));
    return Auth.api('/api/admin/users' + (qs.length ? '?' + qs.join('&') : '')).then(function (r) {
      var body = document.getElementById('users-body');
      if (r.status === 200 && r.body) {
        if (body) body.innerHTML = (r.body.users || []).length
          ? r.body.users.map(userRow).join('')
          : '<tr><td colspan="7" class="fine">No users match.</td></tr>';
        bindUserActions();
        say('users-status', '', false);
        return;
      }
      if (body) body.innerHTML = '<tr><td colspan="7" class="fine">' + esc((r.body && r.body.error) || 'Could not load users.') + '</td></tr>';
    });
  }

  var usersFilter = document.getElementById('users-filter');
  if (usersFilter) usersFilter.addEventListener('submit', function (e) { e.preventDefault(); loadUsers(); });

  /* ---------------- task review ---------------- */

  function reviewRow(t) {
    var actions = '';
    if (['submitted', 'checking', 'held'].indexOf(t.state) !== -1) {
      actions = '<button class="btn primary btn-sm" type="button" data-approve="' + esc(String(t.id)) + '">Approve</button>' +
        ' <button class="btn ghost btn-sm" type="button" data-reject="' + esc(String(t.id)) + '">Reject</button>';
    }
    var proof = t.proofUrl ? '<a href="' + esc(t.proofUrl) + '" target="_blank" rel="noopener noreferrer">Open proof</a>' : '–';
    return '<tr><td>' + esc(t.caption || short(t.id)) + '<br><span class="fine">' + short(t.id) + ' · campaign ' + short(t.campaignId) + '</span></td>' +
      '<td>' + badge(t.state) + '</td><td>' + proof + '</td><td>' + when(t.submittedAt || t.createdAt) + '</td><td>' + actions + '</td></tr>';
  }

  function bindReviewActions() {
    var body = document.getElementById('review-body');
    if (!body) return;
    body.querySelectorAll('[data-approve]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-approve');
        b.disabled = true;
        Auth.api('/api/admin/tasks/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: {} })
          .then(function (r) {
            if (r.status === 200) { say('review-status', 'Task approved.', false); loadReview(); }
            else { say('review-status', (r.body && r.body.error) || 'Approve refused.', true); b.disabled = false; }
          });
      });
    });
    body.querySelectorAll('[data-reject]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-reject');
        var reason = window.prompt('Rejection reason (required):');
        if (!reason || !reason.trim()) { say('review-status', 'A rejection reason is required.', true); return; }
        b.disabled = true;
        Auth.api('/api/admin/tasks/' + encodeURIComponent(id) + '/reject', { method: 'POST', body: { reason: reason.trim() } })
          .then(function (r) {
            if (r.status === 200) { say('review-status', 'Task rejected.', false); loadReview(); }
            else { say('review-status', (r.body && r.body.error) || 'Reject refused.', true); b.disabled = false; }
          });
      });
    });
  }

  function loadReview() {
    var state = document.getElementById('review-state').value;
    return Auth.api('/api/admin/tasks?state=' + encodeURIComponent(state) + '&limit=100').then(function (r) {
      var body = document.getElementById('review-body');
      if (r.status === 200 && r.body) {
        if (body) body.innerHTML = (r.body.tasks || []).length
          ? r.body.tasks.map(reviewRow).join('')
          : '<tr><td colspan="5" class="fine">No tasks in state "' + esc(state) + '".</td></tr>';
        bindReviewActions();
        say('review-status', '', false);
        return;
      }
      if (body) body.innerHTML = '<tr><td colspan="5" class="fine">' + esc((r.body && r.body.error) || 'Could not load tasks.') + '</td></tr>';
    });
  }

  var reviewFilter = document.getElementById('review-filter');
  if (reviewFilter) reviewFilter.addEventListener('submit', function (e) { e.preventDefault(); loadReview(); });

  /* ---------------- campaigns ---------------- */

  function loadCampaigns() {
    return Auth.api('/api/admin/campaigns?limit=100').then(function (r) {
      var body = document.getElementById('campaigns-body');
      if (r.status === 200 && r.body) {
        if (body) body.innerHTML = (r.body.campaigns || []).length
          ? r.body.campaigns.map(function (c) {
            return '<tr><td>' + esc(c.title) + '<br><span class="fine">' + short(c.id) + '</span></td>' +
              '<td>' + esc(c.platform) + '</td><td>' + esc(c.objective) + '</td>' +
              '<td>' + badge(c.state) + '</td><td>' + naira(c.budgetMinor) + '</td><td>' + naira(c.spentMinor) + '</td></tr>';
          }).join('')
          : '<tr><td colspan="6" class="fine">No campaigns yet — create one below.</td></tr>';
        say('campaigns-status', '', false);
        return;
      }
      if (body) body.innerHTML = '<tr><td colspan="6" class="fine">' + esc((r.body && r.body.error) || 'Could not load campaigns.') + '</td></tr>';
    });
  }

  var campaignForm = document.getElementById('campaign-form');
  if (campaignForm) campaignForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var stat = document.getElementById('campaign-status');
    var body = {
      title: document.getElementById('c-title').value.trim(),
      platform: document.getElementById('c-platform').value.trim(),
      objective: document.getElementById('c-objective').value,
      brief: document.getElementById('c-brief').value.trim() || null,
      budgetMinor: Number(document.getElementById('c-budget').value),
      pricePerOutcomeMinor: Number(document.getElementById('c-price').value),
      promoterShareBp: Number(document.getElementById('c-share').value),
      marginFloorBp: Number(document.getElementById('c-floor').value)
    };
    var reserve = document.getElementById('c-reserve').value;
    if (reserve !== '') body.fraudReserveBp = Number(reserve);
    var hold = document.getElementById('c-hold').value;
    if (hold !== '') body.holdHours = Number(hold);
    var pause = document.getElementById('c-pause').value;
    if (pause !== '') body.autoPausePct = Number(pause);

    var btn = campaignForm.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    if (stat) { stat.textContent = 'Creating…'; stat.className = 'form-status'; }
    Auth.api('/api/admin/campaigns', { method: 'POST', body: body }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 201) {
        if (stat) { stat.textContent = 'Campaign created in draft.'; stat.className = 'form-status ok'; }
        campaignForm.reset();
        loadCampaigns();
        return;
      }
      if (stat) { stat.textContent = (r.body && r.body.error) || 'Campaign refused.'; stat.className = 'form-status error'; }
    });
  });

  /* ---------------- settings ---------------- */

  function settingInput(s) {
    var v = s.value == null ? '' : s.value;
    switch (s.valueType) {
      case 'bool':
        return '<select data-key="' + esc(s.key) + '" data-type="bool"><option value="true"' + (v === true ? ' selected' : '') + '>true</option><option value="false"' + (v === false ? ' selected' : '') + '>false</option></select>';
      case 'int':
      case 'money_minor':
      case 'pct_bp':
        return '<input type="number" step="1" data-key="' + esc(s.key) + '" data-type="' + esc(s.valueType) + '" value="' + esc(String(v)) + '">';
      default:
        return '<input type="text" data-key="' + esc(s.key) + '" data-type="string" maxlength="500" value="' + esc(String(v)) + '">';
    }
  }

  function loadSettings() {
    return Auth.api('/api/admin/settings').then(function (r) {
      var body = document.getElementById('settings-body');
      if (r.status === 200 && r.body) {
        if (body) body.innerHTML = (r.body.settings || []).map(function (s) {
          return '<tr><td>' + esc(s.key) + (s.label ? '<br><span class="fine">' + esc(s.label) + '</span>' : '') + '</td>' +
            '<td>' + settingInput(s) + '</td><td>' + esc(s.valueType) + '</td><td>' + esc(s.group || '–') + '</td>' +
            '<td><button class="btn ghost btn-sm" type="button" data-save="' + esc(s.key) + '">Save</button></td></tr>';
        }).join('');
        body.querySelectorAll('[data-save]').forEach(function (b) {
          b.addEventListener('click', function () {
            var key = b.getAttribute('data-save');
            var input = body.querySelector('[data-key="' + key.replace(/"/g, '\\"') + '"]');
            if (!input) return;
            var type = input.getAttribute('data-type');
            var raw = input.value;
            var value;
            if (type === 'bool') value = raw === 'true';
            else if (type === 'int' || type === 'money_minor' || type === 'pct_bp') {
              value = Number(raw);
              if (!Number.isInteger(value)) { say('settings-status', key + ': value must be a whole number.', true); return; }
            } else value = raw;
            b.disabled = true;
            Auth.api('/api/admin/settings', { method: 'POST', body: { key: key, value: value } }).then(function (r2) {
              if (r2.status === 200) { say('settings-status', key + ' saved.', false); }
              else { say('settings-status', key + ': ' + ((r2.body && r2.body.error) || 'update refused.'), true); }
              b.disabled = false;
            });
          });
        });
        say('settings-status', '', false);
        return;
      }
      if (body) body.innerHTML = '<tr><td colspan="5" class="fine">' + esc((r.body && r.body.error) || 'Could not load settings.') + '</td></tr>';
    });
  }

  var settingsLoad = document.getElementById('settings-load');
  if (settingsLoad) settingsLoad.addEventListener('click', loadSettings);

  /* ---------------- audit ---------------- */

  var auditOffset = 0;
  var AUDIT_LIMIT = 50;

  function bindAudit(rows) {
    var prev = document.getElementById('audit-prev');
    var next = document.getElementById('audit-next');
    var pos = document.getElementById('audit-position');
    if (prev) {
      prev.disabled = auditOffset === 0;
      prev.onclick = function () { auditOffset = Math.max(0, auditOffset - AUDIT_LIMIT); loadAudit(); };
    }
    if (next) {
      next.disabled = !(rows && rows.length === AUDIT_LIMIT);
      next.onclick = function () { auditOffset += AUDIT_LIMIT; loadAudit(); };
    }
    if (pos) pos.textContent = 'Rows ' + (auditOffset + 1) + '–' + (auditOffset + (rows ? rows.length : 0));
  }

  function loadAudit() {
    return Auth.api('/api/admin/audit?limit=' + AUDIT_LIMIT + '&offset=' + auditOffset).then(function (r) {
      var body = document.getElementById('audit-body');
      if (r.status === 200 && r.body) {
        var rows = r.body.audit || [];
        if (body) body.innerHTML = rows.length
          ? rows.map(function (a) {
            var change = '';
            if (a.afterState != null) {
              change = esc(typeof a.afterState === 'object' ? JSON.stringify(a.afterState) : String(a.afterState));
              if (a.beforeState != null) change = esc(typeof a.beforeState === 'object' ? JSON.stringify(a.beforeState) : String(a.beforeState)) + ' → ' + change;
            }
            return '<tr><td>' + when(a.createdAt) + '</td><td>' + esc(a.actorRole || '–') + '</td>' +
              '<td>' + badge(a.action) + '</td><td>' + esc(a.targetType) + ' ' + short(a.targetId) + '</td>' +
              '<td class="fine">' + (change || '–') + '</td></tr>';
          }).join('')
          : '<tr><td colspan="5" class="fine">No audit rows yet.</td></tr>';
        bindAudit(rows);
        say('audit-status', '', false);
        return;
      }
      if (body) body.innerHTML = '<tr><td colspan="5" class="fine">' + esc((r.body && r.body.error) || 'Could not load the audit trail.') + '</td></tr>';
    });
  }

  /* ---------------- boot ---------------- */

  var signoutBtn = document.getElementById('signout');
  if (signoutBtn) signoutBtn.addEventListener('click', function () {
    Auth.signOut();
    window.location.href = '/';
  });

  if (!Auth.getToken()) {
    failGate('Sign in required', 'Sign in with an admin or owner phone number to open the console.');
    return;
  }
  if (gate) gate.hidden = true;
  if (app) app.hidden = false;

  Promise.all([loadStats(), loadUsers(), loadReview(), loadCampaigns()]).then(function () {
    return Auth.api('/api/me').then(function (r) {
      if (r.status === 200 && r.body) {
        var p = r.body.profile || {};
        if (whoami) { whoami.hidden = false; whoami.textContent = (p.role || '') + (p.phone ? ' · ' + p.phone : ''); }
        if (dashLink) dashLink.hidden = false;
      }
    });
  });
})();
