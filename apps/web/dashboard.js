/* dashboard.js — the promoter dashboard.
   Every number on this page comes from a live /api call with the session
   bearer; nothing is mocked. A missing/expired session shows the sign-in gate
   instead of pretending. */
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
    var tbtn = document.getElementById('themeBtnDash');
    if (tbtn) tbtn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }
  var themeBtn = document.getElementById('themeBtnDash');
  if (themeBtn) {
    themeBtn.setAttribute('aria-pressed',
      document.documentElement.getAttribute('data-theme') === 'light' ? 'true' : 'false');
    themeBtn.addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    });
  }

  var gate = document.getElementById('gate');
  var app = document.getElementById('app');
  var whoami = document.getElementById('whoami');
  var adminLink = document.getElementById('admin-link');

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

  function failGate(title, copy) {
    if (gate) {
      var h = document.getElementById('gate-title');
      var p = document.getElementById('gate-copy');
      if (h) h.textContent = title;
      if (p) p.textContent = copy;
      gate.hidden = false;
    }
    if (app) app.hidden = true;
    FB && FB.ready();
  }

  /* ---------- rendering ---------- */

  function renderMe(me) {
    document.getElementById('stat-points').textContent = me.points.toLocaleString('en-NG');
    document.getElementById('stat-level').textContent = 'Level ' + me.level;
    document.getElementById('stat-referrals').textContent = String(me.qualifiedReferrals);
    document.getElementById('stat-cash').textContent = me.cashUnlocked ? 'Unlocked' : 'Locked';
    var p = me.profile || {};
    if (whoami) {
      whoami.hidden = false;
      whoami.textContent = (p.displayName || '') + (p.phone ? ' · ' + p.phone : '');
    }
    var nl = me.nextLevel;
    var next = document.getElementById('next-level');
    if (next) {
      if (nl) {
        next.hidden = false;
        next.textContent = 'Next: ' + (nl.label || ('Level ' + nl.level)) + ' — ' +
          (nl.pointsNeeded > 0 ? (nl.pointsNeeded.toLocaleString('en-NG') + ' more points') : '') +
          (nl.pointsNeeded > 0 && nl.referralsNeeded > 0 ? ' and ' : '') +
          (nl.referralsNeeded > 0 ? (nl.referralsNeeded + ' more qualified referral' + (nl.referralsNeeded === 1 ? '' : 's')) : '') +
          ((nl.pointsNeeded > 0 || nl.referralsNeeded > 0) ? '.' : ' You are at the top level.');
      } else {
        next.hidden = false;
        next.textContent = 'You are at the top level.';
      }
    }
    var adminRoles = ['admin', 'owner', 'support', 'finance'];
    if (adminLink && adminRoles.indexOf(p.role) !== -1) {
      adminLink.hidden = false;
      adminLink.addEventListener('click', function () { window.location.href = '/admin.html'; });
    }
  }

  var ACTION_LABEL = {
    post: 'Post', like: 'Like', comment: 'Comment', follow: 'Follow', subscribe: 'Subscribe',
    repost: 'Repost', share: 'Share', view: 'Watch', join_channel: 'Join the channel', review: 'Review',
  };

  function taskCard(t, actionsHtml) {
    var views = t.viewsRequired ? ' · ' + Number(t.viewsRequired).toLocaleString('en-NG') + '+ views earns a bonus' : '';
    var asset = (t.campaignAssets && t.campaignAssets[0])
      ? '<p>Creative: <a href="' + esc(t.campaignAssets[0]) + '" target="_blank" rel="noopener noreferrer">open asset</a></p>'
      : '';
    return '<article class="panel task-card">' +
      '<div class="task-head"><h3>' + esc(t.caption || 'Untitled task') + '</h3>' + badge(t.state) + '</div>' +
      '<p>' + (t.trackedLink ? 'Tracked link: <a href="' + esc(t.trackedLink) + '" target="_blank" rel="noopener noreferrer">' + esc(t.trackedLink) + '</a>' : '') + '</p>' +
      asset +
      '<p class="fine">Action: ' + esc(ACTION_LABEL[t.actionType] || (t.actionType || 'Post')) + views +
      ' · Disclosure: ' + esc(t.disclosureTag || '#ad') + ' · Worth ' + (t.points != null ? esc(String(t.points)) + ' points' : 'a reward') +
      (t.rewardMinor ? ' (' + naira(t.rewardMinor) + ')' : '') + '</p>' +
      (actionsHtml || '') +
      '</article>';
  }

  function renderTasks(status, listEl, tasks) {
    var box = document.getElementById(status);
    var el = document.getElementById(listEl);
    if (!el) return;
    if (!tasks.length) {
      el.innerHTML = '<p class="fine">Nothing here yet. Check back soon.</p>';
      if (box) box.textContent = '';
      return;
    }
    el.innerHTML = tasks.map(function (t) {
      return taskCard(t, '<form class="claim-form" data-task="' + esc(String(t.id)) + '">' +
        '<button type="submit" class="btn">Claim task</button></form>');
    }).join('');
    el.querySelectorAll('.claim-form').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var id = form.getAttribute('data-task');
        var btn = form.querySelector('button');
        if (btn) btn.disabled = true;
        Auth.api('/api/tasks/' + encodeURIComponent(id) + '/claim', { method: 'POST' }).then(function (r) {
          if (r.status === 200) {
            if (box) { box.textContent = 'Task claimed — finish it under "my tasks".'; box.className = 'form-status ok'; }
            FB && FB.ok('Task claimed — finish it under My tasks.');
            loadTasks();
            loadMine();
            return;
          }
          if (btn) btn.disabled = false;
          if (box) { box.textContent = (r.body && r.body.error) || 'Could not claim the task.'; box.className = 'form-status error'; }
          FB && FB.err((r.body && r.body.error) || 'Could not claim the task.');
        });
      });
    });
    if (box) box.textContent = '';
  }

  function renderMine(status, listEl, tasks) {
    var box = document.getElementById(status);
    var el = document.getElementById(listEl);
    if (!el) return;
    if (!tasks.length) {
      el.innerHTML = '<p class="fine">No assigned tasks yet. Grab one from the available tasks.</p>';
      if (box) box.textContent = '';
      return;
    }
    el.innerHTML = tasks.map(function (t) {
      var actions = '';
      if (t.state === 'assigned') {
        actions = '<form class="proof-form" data-task="' + esc(String(t.id)) + '">' +
          '<input type="url" name="proofUrl" required placeholder="https:// proof link of your post">' +
          '<select name="platform">' +
          '<option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option>' +
          '<option value="x">X / Twitter</option><option value="instagram">Instagram</option>' +
          '<option value="tiktok">TikTok</option><option value="facebook">Facebook</option>' +
          '<option value="youtube">YouTube</option><option value="other">Other</option></select>' +
          '<input type="number" name="views" min="0" step="1" placeholder="views (optional)">' +
          '<input type="url" name="screenshotUrl" placeholder="https:// screenshot link (optional)">' +
          '<button type="submit" class="btn primary">Submit proof</button></form>';
      } else if (t.state === 'submitted') {
        actions = '<p class="fine">Waiting for review' + (t.autoApproveAt ? ' — auto-approves after ' + when(t.autoApproveAt) : '') + '.</p>';
      } else if (t.state === 'rejected' && t.rejectionReason) {
        actions = '<p class="fine">Rejected: ' + esc(t.rejectionReason) + '</p>';
      } else if (t.proofUrl) {
        actions = '<p class="fine">Proof: <a href="' + esc(t.proofUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(t.proofUrl) + '</a></p>';
      }
      return taskCard(t, actions);
    }).join('');

    el.querySelectorAll('.proof-form').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = form.querySelector('input[name="proofUrl"]');
        var url = input ? input.value.trim() : '';
        if (!/^https?:\/\//i.test(url)) {
          var b = document.getElementById('mine-status');
          if (b) { b.textContent = 'Paste the full link of your post (https://…).'; b.className = 'form-status error'; }
          FB && FB.err('Paste the full link of your post (https://…).');
          return;
        }
        var body = { proofUrl: url };
        var platform = form.querySelector('select[name="platform"]');
        if (platform) body.platform = platform.value;
        var viewsEl = form.querySelector('input[name="views"]');
        if (viewsEl && viewsEl.value !== '') body.views = Number(viewsEl.value);
        var shot = form.querySelector('input[name="screenshotUrl"]');
        if (shot && shot.value.trim()) body.screenshotUrl = shot.value.trim();
        var id = form.getAttribute('data-task');
        var btn = form.querySelector('button');
        if (btn) btn.disabled = true;
        Auth.api('/api/tasks/' + encodeURIComponent(id) + '/submit', { method: 'POST', body: body })
          .then(function (r) {
            loadMine();
            var b = document.getElementById('mine-status');
            var okMsg = r.status === 200 && b;
            if (okMsg) { b.textContent = (r.body && r.body.nextStep) || 'Proof submitted. Points land after verification.'; b.className = 'form-status ok'; FB && FB.ok('Proof submitted. Points land after verification.'); return; }
            if (b) { b.textContent = (r.body && r.body.error) || 'Could not submit the proof.'; b.className = 'form-status error'; }
            FB && FB.err((r.body && r.body.error) || 'Could not submit the proof.');
            if (btn) btn.disabled = false;
          });
      });
    });
  }

  function fillTable(bodyId, rows, cellFn) {
    var body = document.getElementById(bodyId);
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="9" class="fine">Nothing yet.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function (r) {
      return '<tr>' + cellFn(r).map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }).join('');
  }

  function renderMoney(earnings, payoutsData) {
    fillTable('payouts-body', (payoutsData && payoutsData.payouts) || [], function (p) {
      return [when(p.createdAt), esc(p.kind || '–'), naira(p.amountMinor), badge(p.status)];
    });
    fillTable('redemptions-body', (payoutsData && payoutsData.redemptions) || [], function (r) {
      return [when(r.createdAt), esc(r.kind || '–'), esc(String(r.pointsSpent)), naira(r.valueMinor), esc(r.network || '–'), badge(r.state)];
    });
    fillTable('entries-body', (earnings && earnings.entries) || [], function (e2) {
      var pts = Number(e2.points);
      return [when(e2.createdAt), esc(e2.kind || '–'),
        '<span class="' + (pts >= 0 ? 'points-plus' : 'points-minus') + '">' + (pts >= 0 ? '+' : '') + esc(String(pts)) + '</span>',
        esc(e2.memo || e2.taskId || '–')];
    });
  }

  function renderReferrals(data) {
    var box = document.getElementById('referrals-status');
    if (box) {
      var eco = [];
      if (data.awardPerReferral != null) eco.push(String(data.awardPerReferral) + ' points land for you on every qualified referral');
      if (data.downlineBonusBp != null) eco.push('a ' + (data.downlineBonusBp / 100) + '% slice of every task your referrals complete flows to you too');
      box.textContent = String(data.total) + ' referral' + (data.total === 1 ? '' : 's') + ', ' +
        String(data.qualified) + ' qualified.' + (eco.length ? ' ' + eco.join(', and ') + '.' : '') +
        ' A referral qualifies when your invitee completes their first task — the faster they work, the closer you are to cash.';
      box.className = 'form-status';
    }
    fillTable('referrals-body', data.referrals || [], function (r) {
      return [when(r.joinedAt), r.qualifiedAt ? 'Yes · ' + when(r.qualifiedAt) : 'Not yet', esc(String(r.pointsAwarded == null ? '' : r.pointsAwarded))];
    });
  }

  /* ---------- loaders ---------- */

  function loadMine() {
    return Auth.api('/api/tasks/mine').then(function (r) {
      if (r.status === 200 && r.body) renderMine('mine-status', 'mine-list', r.body.tasks || []);
      else {
        var b = document.getElementById('mine-status');
        if (b) { b.textContent = (r.body && r.body.error) || 'Could not load your tasks.'; b.className = 'form-status error'; }
      }
    });
  }

  function redeemPaneBind() {
    var form = document.getElementById('redeem-form');
    if (!form) return;
    var kindSel = document.getElementById('redeem-kind');
    var netSel = document.getElementById('redeem-network');
    var sync = function () {
      netSel.parentElement && (netSel.style.display = kindSel.value === 'data' ? '' : 'none');
    };
    kindSel.addEventListener('change', sync);
    sync();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var stat = document.getElementById('redeem-status');
      var points = Number(document.getElementById('redeem-points').value);
      var btn = form.querySelector('button[type="submit"]');
      if (!(Number.isInteger(points) && points > 0)) {
        if (stat) { stat.textContent = 'Points must be a positive whole number.'; stat.className = 'form-status error'; }
        return;
      }
      if (btn) btn.disabled = true;
      if (stat) { stat.textContent = 'Sending…'; stat.className = 'form-status'; }
      var body = { kind: kindSel.value, points: points };
      if (kindSel.value === 'data') body.network = netSel.value;
      Auth.api('/api/redeem', { method: 'POST', body: body }).then(function (r) {
        if (btn) btn.disabled = false;
        if (r.status === 202 && stat) {
          stat.textContent = 'Redemption queued — fulfilment happens in the background.';
          stat.className = 'form-status ok';
          FB && FB.ok('Redemption queued — fulfilment happens in the background.');
          loadMoney();
          loadMe();
          return;
        }
        if (stat) {
          var msg = (r.body && r.body.error) || 'Redemption refused.';
          if (r.status === 403) msg = 'Cash payouts are not unlocked at your level yet.';
          if (r.status === 409) msg = (r.body && r.body.error) || 'You do not have that many points.';
          stat.textContent = msg;
          stat.className = 'form-status error';
          FB && FB.err(msg);
        }
      });
    });
  }

  function loadTasks() {
    return Auth.api('/api/tasks').then(function (r) {
      if (r.status === 200 && r.body) renderTasks('tasks-status', 'tasks-list', r.body.tasks || []);
      else {
        var b = document.getElementById('tasks-status');
        if (b) { b.textContent = (r.body && r.body.error) || 'Could not load tasks.'; b.className = 'form-status error'; }
      }
    });
  }

  function loadMoney() {
    return Promise.all([
      Auth.api('/api/v1/promoter/earnings'),
      Auth.api('/api/v1/promoter/payouts')
    ]).then(function (rs) {
      renderMoney(rs[0].body, rs[1].body);
    });
  }

  function loadReferrals() {
    return Auth.api('/api/referrals').then(function (r) {
      if (r.status === 200 && r.body) renderReferrals(r.body);
      else {
        var b = document.getElementById('referrals-status');
        if (b) { b.textContent = (r.body && r.body.error) || 'Could not load referrals.'; b.className = 'form-status error'; }
      }
    });
  }

  function loadMe() {
    return Auth.api('/api/me').then(function (r) {
      if (r.status === 401 || r.status === 403) {
        Auth.clearToken();
        failGate('Sign in to open your dashboard', r.body && r.body.error ? r.body.error : 'Your session is missing or expired.');
        return null;
      }
      if (r.status !== 200 || !r.body) {
        failGate('The dashboard is not reachable right now', 'Try again shortly — the service may be restarting.');
        return null;
      }
      renderMe(r.body);
      return r.body;
    });
  }

  /* ---------- daily check-in ---------- */

  function renderCheckin(st) {
    var panel = document.getElementById('checkin');
    if (!panel) return;
    panel.hidden = false;

    var grid = document.getElementById('checkin-grid');
    var btn = document.getElementById('checkin-btn');
    var stEl = document.getElementById('checkin-status');
    var lDay = String(st.lagosDay || '');
    var checked = {};
    var days = Array.isArray(st.checkedThisMonth) ? st.checkedThisMonth : [];
    for (var i = 0; i < days.length; i++) checked[days[i]] = true;
    var dayNum = Number(lDay.slice(8)) || 0;
    var now = new Date();
    var dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    if (grid) {
      var html = '';
      for (var d = 1; d <= dim; d++) {
        var key = lDay.slice(0, 8) + String(d).padStart(2, '0');
        var cls = 'dot';
        if (checked[key]) cls += ' hit';
        else if (d <= dayNum) cls += ' miss';
        else cls += ' off';
        html += '<span class="' + cls + '" title="' + key + '" aria-hidden="true"></span>';
      }
      grid.innerHTML = html;
      grid.setAttribute('data-dots', String(dim));
    }

    if (st.checkedInToday) {
      if (btn) { btn.disabled = true; btn.textContent = 'Checked in today'; }
      if (stEl) stEl.textContent = 'Streak: ' + (Number(st.streak) || 0) + ' day(s). Miss zero days for the rest of the month to keep a perfect month.';
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Check in'; }
      if (stEl) stEl.textContent = 'No check-in yet today. Show up daily for points; streaks pay milestone bonuses.';
    }
  }

  function loadCheckin() {
    return Auth.api('/api/v1/checkin').then(function (r) {
      if (r.status === 200 && r.body) renderCheckin(r.body);
    }).catch(function () { /* the boot gate surfaces real failures */ });
  }

  var checkinBtn = document.getElementById('checkin-btn');
  if (checkinBtn) checkinBtn.addEventListener('click', function () {
    checkinBtn.disabled = true;
    Auth.api('/api/v1/checkin', { method: 'POST' }).then(function (r) {
      var body = r.body || {};
      if (r.status === 200 && body.already) {
        FB && FB.info('Today is already checked in.');
      } else if ((r.status === 200 || r.status === 201) && !body.already) {
        var extra = body.points ? body.points + ' points earned.' : 'Points earned.';
        if (body.streak) extra += ' Streak: ' + body.streak + ' day(s).';
        FB && FB.ok('Checked in. ' + extra);
      } else {
        FB && FB.err(body.error || 'Check-in refused. Try again shortly.');
      }
      loadCheckin();
      loadMe();
    });
  });

  var signoutBtn = document.getElementById('signout');
  if (signoutBtn) signoutBtn.addEventListener('click', function () {
    Auth.signOut();
    window.location.href = '/';
  });

  /* ---------- boot ---------- */
  if (!Auth.getToken()) {
    failGate('Sign in to open your dashboard', 'Your session is missing. Sign in with your phone number to continue.');
    return;
  }
  if (gate) gate.hidden = true;
  if (app) app.hidden = false;

  loadMe().then(function (me) {
    if (!me) return;
    redeemPaneBind();
    return Promise.all([
      loadTasks(),
      loadMine(),
      loadMoney(),
      loadReferrals(),
      loadCheckin()
    ]);
  }).then(function () { FB && FB.ready(); }, function () { FB && FB.ready(); });
})();
