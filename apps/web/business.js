/* business.js — the business campaign manager.
   Every number comes from a live /api call with the session bearer; nothing
   is mocked. Boot gates on the session token: no token -> the sign-in gate,
   a refused call -> the server's own error, shown verbatim.

   A business cannot create a campaign until an admin has VERIFIED its
   campaign-owner record, so the page reads that record first
   (GET /api/v1/campaign-owner), submits it when it is missing or still
   pending (POST /api/v1/campaign-owners) and says plainly which state it is
   in. The server stays the authority: the create call is still made and its
   403 is shown verbatim.

   Endpoints used:
     GET  /api/me
     GET  /api/v1/campaign-owner
     POST /api/v1/campaign-owners
     GET  /api/v1/business/campaigns
     POST /api/v1/campaigns
     POST /api/v1/campaigns/:id/payment-link
     GET  /api/v1/campaigns/:id/payments */
(function () {
  'use strict';

  var Auth = window.PromotaAuth;
  if (!Auth) return;

  /* ---------- theme toggle (same pattern as dashboard.js) ---------- */
  var themeMeta = document.getElementById('themeColor');
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('owoworks-theme', theme); } catch (e) { /* storage unavailable */ }
    if (themeMeta) themeMeta.setAttribute('content', theme === 'light' ? '#f4f7f2' : '#04120b');
    var tbtn = document.getElementById('themeBtnBiz');
    if (tbtn) tbtn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }
  var themeBtn = document.getElementById('themeBtnBiz');
  if (themeBtn) {
    themeBtn.setAttribute('aria-pressed',
      document.documentElement.getAttribute('data-theme') === 'light' ? 'true' : 'false');
    themeBtn.addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    });
  }

  var OBJECTIVES = [
    { value: 'click', label: 'click' },
    { value: 'signup', label: 'signup' },
    { value: 'code', label: 'code' },
    { value: 'api_post', label: 'api_post' },
    { value: 'repost', label: 'repost' }
  ];

  var ACTION_TYPES = [
    { value: 'post', label: 'Post' },
    { value: 'like', label: 'Like' },
    { value: 'comment', label: 'Comment' },
    { value: 'follow', label: 'Follow' },
    { value: 'subscribe', label: 'Subscribe' },
    { value: 'repost', label: 'Repost' },
    { value: 'share', label: 'Share' },
    { value: 'view', label: 'View' },
    { value: 'join_channel', label: 'Join channel' },
    { value: 'review', label: 'Review' }
  ];

  var campaigns = [];
  var rowSeq = 0;
  var owner = null;          /* the campaign-owner record, exactly as the server sent it */
  var ownerStateKnown = false; /* false when we could not read it: never guess the gate */

  var gate = document.getElementById('gate');
  var app = document.getElementById('app');
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
  function stateBadge(state) {
    var s = String(state == null || state === '' ? '–' : state);
    var low = s.toLowerCase();
    var cls = 'badge';
    if (low === 'live' || low === 'active' || low === 'settled' || low === 'approved' || low === 'verified') cls += ' badge-approved';
    else if (low === 'review' || low === 'pending' || low === 'submitted' || low === 'checking') cls += ' badge-submitted';
    else if (low === 'paused' || low === 'held' || low === 'rejected' || low === 'failed' || low === 'refunded') cls += ' badge-held';
    return '<span class="' + cls + '">' + esc(s) + '</span>';
  }
  function say(boxId, message, isError) {
    var b = document.getElementById(boxId);
    if (!b) return;
    b.textContent = message || '';
    b.className = 'form-status' + (isError ? ' error' : '');
  }
  function fieldValue(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }
  function numberOrNull(id) {
    var raw = fieldValue(id);
    if (raw === '') return null;
    var n = Number(raw);
    return isFinite(n) ? n : null;
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
    var h = document.getElementById('gate-title');
    var p = document.getElementById('gate-copy');
    if (h) h.textContent = title;
    if (p) p.textContent = copy;
    if (gate) gate.hidden = false;
    if (app) app.hidden = true;
    FB && FB.ready();
  }

  /* ---------- campaign owner verification ---------- */

  function ownerSay(message, isError) {
    var b = document.getElementById('owner-form-status');
    if (!b) return;
    b.textContent = message || '';
    b.className = 'form-status' + (isError ? ' error' : '');
  }

  function ownerFail(message) {
    ownerSay(message, true);
    FB && FB.err(message);
    return false;
  }

  function ownerVerified() {
    return Boolean(owner && owner.verificationState === 'verified');
  }

  /* Plain words for the server's own verification_state. Nothing is invented:
     what is not known is written as "not submitted" only when the server
     really said there is no owner record. */
  function ownerPhrase() {
    if (!owner) return 'not submitted yet';
    var st = String(owner.verificationState || '').toLowerCase();
    if (st === 'verified') return 'verified';
    if (st === 'rejected') return 'rejected';
    if (st === 'pending') return 'submitted, waiting for review';
    return st || 'submitted, waiting for review';
  }

  function renderOwner() {
    var box = document.getElementById('owner-state');
    if (box) {
      if (!owner) {
        box.innerHTML = 'Verification: <span class="badge badge-submitted">not submitted</span>'
          + ' · send your details below and an admin reviews them.';
      } else {
        var st = String(owner.verificationState || 'pending');
        var extra = '';
        if (st === 'verified') {
          extra = owner.verifiedAt
            ? ' · verified on ' + esc(when(owner.verifiedAt))
            : ' · you can create campaigns.';
        } else if (st === 'rejected') {
          extra = owner.verificationNote
            ? ' · ' + esc(owner.verificationNote)
            : ' · send corrected details to try again.';
        } else {
          extra = ' · submitted, waiting for review.';
        }
        box.innerHTML = 'Verification: ' + stateBadge(st) + extra;
      }
      box.className = 'fine';
    }
    var btn = document.getElementById('owner-submit');
    if (btn) {
      if (ownerVerified()) {
        btn.disabled = true;
        btn.textContent = 'Already verified';
      } else {
        btn.disabled = false;
        btn.textContent = 'Submit for verification';
      }
    }
  }

  /* GET /api/v1/campaign-owner — this profile's owner row, or none. */
  function loadOwner() {
    return Auth.api('/api/v1/campaign-owner').then(function (r) {
      if (r.status === 200 && r.body) {
        owner = r.body.owner || null;
        ownerStateKnown = true;
        renderOwner();
        fillOwnerForm(owner);
        return owner;
      }
      if (r.status === 401) {
        Auth.clearToken();
        failGate('Sign in required', 'Your session is missing or expired.');
        return null;
      }
      /* The state is UNKNOWN here. Do not treat that as "not submitted" and
         do not block on it either — the server decides at create time. */
      ownerStateKnown = false;
      var box = document.getElementById('owner-state');
      if (box) {
        box.textContent = (r.body && r.body.error) || 'Could not read your verification status.';
        box.className = 'fine';
      }
      return null;
    });
  }

  /* POST /api/v1/campaign-owners — submit (or refresh) the owner record. */
  function submitOwner() {
    var kind = fieldValue('owner-kind') === 'individual' ? 'individual' : 'business';
    var displayName = fieldValue('owner-display-name');
    var contact = fieldValue('owner-contact');
    var website = fieldValue('owner-website');
    var businessName = fieldValue('owner-business-name');
    var businessReg = fieldValue('owner-business-reg');

    if (!displayName) return ownerFail('Enter the display name a reviewer should use.');
    if (!contact) return ownerFail('Enter a contact: phone, email or social handle.');
    if (kind === 'business' && !businessName) return ownerFail('A business must give its business name.');
    if (website && !/^https?:\/\//i.test(website)) return ownerFail('The website must start with http:// or https://');

    var body = { kind: kind, displayName: displayName, contact: contact };
    if (kind === 'business') {
      body.businessName = businessName;
      if (businessReg) body.businessReg = businessReg;
    }
    if (website) body.website = website;

    var btn = document.getElementById('owner-submit');
    if (btn) btn.disabled = true;
    ownerSay('Sending your details for review…', false);

    return Auth.api('/api/v1/campaign-owners', { method: 'POST', body: body }).then(function (r) {
      if (r.status === 201 && r.body && r.body.owner) {
        owner = r.body.owner;
        ownerStateKnown = true;
        renderOwner();
        ownerSay('Submitted, waiting for review. Campaigns open up once an admin verifies the record.', false);
        FB && FB.ok('Verification request submitted.');
        return owner;
      }
      if (r.status === 409) {
        ownerSay((r.body && r.body.error) || 'This record is already verified.', false);
        loadOwner();
        return null;
      }
      var msg = (r.body && r.body.error) || 'Could not submit your details.';
      if (btn) btn.disabled = false;
      ownerSay(msg, true);
      FB && FB.err(msg);
      return null;
    });
  }

  /* An individual owner must not carry a business name, so the business
     fields only show for a business application. */
  function syncOwnerKind() {
    var business = fieldValue('owner-kind') !== 'individual';
    var nameField = document.getElementById('owner-business-name-field');
    var regField = document.getElementById('owner-business-reg-field');
    if (nameField) nameField.hidden = !business;
    if (regField) regField.hidden = !business;
  }

  /* Pre-fill the form from the record the server already holds, so a pending
     business can correct one field instead of retyping everything. Never
     overwrites what the reviewer typed. */
  function fillOwnerForm(o) {
    if (!o) return;
    var set = function (id, v) {
      var el = document.getElementById(id);
      if (el && !String(el.value || '').trim() && v) el.value = v;
    };
    set('owner-kind', o.kind);
    set('owner-display-name', o.displayName);
    set('owner-business-name', o.businessName);
    set('owner-business-reg', o.businessReg);
    set('owner-website', o.website);
    set('owner-contact', o.contact);
    syncOwnerKind();
  }

  /* ---------- campaigns list ---------- */

  function renderCampaigns() {
    var body = document.getElementById('campaigns-body');
    if (!body) return;
    if (!campaigns.length) {
      body.innerHTML = '<tr><td colspan="7" class="fine">No campaigns yet. Create your first one on the New campaign tab.</td></tr>';
      return;
    }
    body.innerHTML = campaigns.map(function (c) {
      var id = String(c.id || '');
      return '<tr>' +
        '<td>' + esc(c.title || '–') + (c.ownerName || c.owner ? '<br><span class="fine">' + esc(c.ownerName || c.owner) + '</span>' : '') + '</td>' +
        '<td>' + esc(c.platform || '–') + '</td>' +
        '<td>' + esc(c.objective || '–') + '</td>' +
        '<td>' + stateBadge(c.state) + '</td>' +
        '<td>' + esc(naira(c.budgetMinor)) + '</td>' +
        '<td>' + esc(c.escrowMinor == null ? '–' : naira(c.escrowMinor)) + '</td>' +
        '<td><button type="button" class="btn btn-sm" data-pay="' + esc(id) + '">Payment link</button></td>' +
        '</tr>';
    }).join('');
  }

  function fillCampaignPicker() {
    var sel = document.getElementById('payments-campaign');
    if (!sel) return;
    var current = sel.value;
    sel.innerHTML = '';
    if (!campaigns.length) {
      var none = document.createElement('option');
      none.value = '';
      none.textContent = 'No campaigns yet';
      sel.appendChild(none);
      return;
    }
    campaigns.forEach(function (c) {
      var o = document.createElement('option');
      o.value = String(c.id || '');
      o.textContent = String(c.title || '–') + ' · ' + String(c.state || '–');
      sel.appendChild(o);
    });
    if (current) sel.value = current;
  }

  function loadCampaigns() {
    return Auth.api('/api/v1/business/campaigns').then(function (r) {
      if (r.status === 200 && r.body && Array.isArray(r.body.campaigns)) {
        campaigns = r.body.campaigns;
        renderCampaigns();
        fillCampaignPicker();
        say('campaigns-status', campaigns.length + (campaigns.length === 1 ? ' campaign' : ' campaigns') + ' on file.');
        return campaigns;
      }
      if (r.status === 401) {
        Auth.clearToken();
        failGate('Sign in required', 'Your session is missing or expired.');
        return [];
      }
      if (r.status === 403) {
        /* Not an error to hide the console over: an unverified business still
           needs the verification form. Say what the server said and stop. */
        say('campaigns-status', ((r.body && r.body.error) || 'Your account is not verified to run campaigns yet.')
          + ' Open the Business verification tab to send your details.', true);
        return [];
      }
      say('campaigns-status', (r.body && r.body.error) || 'Could not load your campaigns.', true);
      FB && FB.err((r.body && r.body.error) || 'Could not load your campaigns.');
      return [];
    });
  }

  /* ---------- payment link ---------- */

  function renderPayLink(b) {
    var box = document.getElementById('paylink-out');
    if (!box) return;
    var link = String(b.link || '');
    var safe = /^https:\/\//i.test(link);
    /* The server answers { link, reference, amountMinor, currency }. Anything
       it did not send is left out rather than guessed. */
    var bits = ['Amount <strong>' + esc(b.amountMinor == null ? '–' : naira(b.amountMinor)) + '</strong>'];
    if (b.reference) bits.push('reference ' + esc(b.reference));
    if (b.currency) bits.push('currency ' + esc(b.currency));
    box.hidden = false;
    box.innerHTML = '<h3>Payment link</h3>' +
      '<p>' + bits.join(' · ') + '</p>' +
      (safe
        ? '<p><a class="btn gold" href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Open the payment link</a></p>' +
          '<p class="fine">Send this link to whoever funds the campaign: ' + esc(link) + '</p>'
        : '<p class="fine">The server returned a link we will not auto-open: ' + esc(link) + '</p>');
  }

  function requestPaymentLink(id, button) {
    if (!id) return;
    say('campaigns-status', 'Creating a payment link…', false);
    if (button) button.disabled = true;
    Auth.api('/api/v1/campaigns/' + encodeURIComponent(id) + '/payment-link', { method: 'POST', body: {} })
      .then(function (r) {
        if (button) button.disabled = false;
        if (r.status === 200 && r.body && r.body.link) {
          renderPayLink(r.body);
          say('campaigns-status', 'Payment link ready.');
          FB && FB.ok('Payment link ready.');
          return;
        }
        var msg = (r.body && r.body.error) || 'Could not create a payment link.';
        say('campaigns-status', msg, true);
        FB && FB.err(msg);
      });
  }

  /* ---------- repeatable task rows ---------- */

  function makeField(labelText, id, type, opts) {
    opts = opts || {};
    var wrap = document.createElement('div');
    wrap.className = 'field';
    var lab = document.createElement('label');
    lab.setAttribute('for', id);
    lab.textContent = labelText;
    var el;
    if (type === 'select') {
      el = document.createElement('select');
      var items = opts.items || [];
      for (var i = 0; i < items.length; i++) {
        var o = document.createElement('option');
        o.value = items[i].value;
        o.textContent = items[i].label;
        el.appendChild(o);
      }
    } else {
      el = document.createElement('input');
      el.type = type || 'text';
    }
    el.id = id;
    el.name = opts.name || id;
    if (opts.dataField) el.setAttribute('data-f', opts.dataField);
    if (opts.placeholder) el.setAttribute('placeholder', opts.placeholder);
    if (opts.maxlength) el.setAttribute('maxlength', String(opts.maxlength));
    if (opts.min != null) el.setAttribute('min', String(opts.min));
    if (opts.max != null) el.setAttribute('max', String(opts.max));
    if (opts.step != null) el.setAttribute('step', String(opts.step));
    if (opts.inputmode) el.setAttribute('inputmode', opts.inputmode);
    if (opts.required) el.required = true;
    wrap.appendChild(lab);
    wrap.appendChild(el);
    return wrap;
  }

  function taskRows() {
    var host = document.getElementById('task-rows');
    return host ? host.querySelectorAll('.task-row') : [];
  }

  function addTaskRow() {
    var host = document.getElementById('task-rows');
    if (!host) return;
    var rows = taskRows();
    if (rows.length >= 10) {
      say('campaign-form-status', 'A campaign can hold at most 10 tasks.', true);
      return;
    }
    rowSeq += 1;
    var n = rowSeq;

    var row = document.createElement('div');
    row.className = 'task-row';
    row.setAttribute('data-row', '1');

    var head = document.createElement('div');
    head.className = 'row-head';
    var title = document.createElement('h3');
    title.textContent = 'Task ' + n;
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'btn ghost btn-sm';
    rm.textContent = 'Remove';
    rm.setAttribute('data-remove-task', '1');
    head.appendChild(title);
    head.appendChild(rm);
    row.appendChild(head);

    var grid = document.createElement('div');
    grid.className = 'row-grid';
    grid.appendChild(makeField('Caption', 'task-caption-' + n, 'text', {
      dataField: 'caption', maxlength: 300, required: true,
      placeholder: 'What the promoter should post'
    }));
    grid.appendChild(makeField('Tracked link', 'task-link-' + n, 'url', {
      dataField: 'trackedLink', maxlength: 500, required: true,
      placeholder: 'https://… the tracked link'
    }));
    grid.appendChild(makeField('Action type', 'task-action-' + n, 'select', {
      dataField: 'actionType', items: ACTION_TYPES
    }));
    grid.appendChild(makeField('Points', 'task-points-' + n, 'number', {
      dataField: 'points', min: 0, step: 1, inputmode: 'numeric', placeholder: 'Optional'
    }));
    grid.appendChild(makeField('Views required', 'task-views-' + n, 'number', {
      dataField: 'viewsRequired', min: 0, step: 1, inputmode: 'numeric', placeholder: 'Optional'
    }));
    row.appendChild(grid);

    host.appendChild(row);
    say('campaign-form-status', '', false);
  }

  function removeTaskRow(row) {
    var host = document.getElementById('task-rows');
    if (!host || !row) return;
    var rows = taskRows();
    if (rows.length <= 1) {
      say('campaign-form-status', 'A campaign needs at least one task.', true);
      return;
    }
    if (row.parentNode) row.parentNode.removeChild(row);
    say('campaign-form-status', '', false);
  }

  function rowValue(row, name) {
    var el = row.querySelector('[data-f="' + name + '"]');
    return el ? String(el.value || '').trim() : '';
  }

  function buildTasks() {
    var out = [];
    var rows = taskRows();
    for (var i = 0; i < rows.length; i++) {
      var t = {
        caption: rowValue(rows[i], 'caption'),
        trackedLink: rowValue(rows[i], 'trackedLink'),
        actionType: rowValue(rows[i], 'actionType') || 'post'
      };
      var pts = rowValue(rows[i], 'points');
      if (pts !== '') t.points = Number(pts);
      var views = rowValue(rows[i], 'viewsRequired');
      if (views !== '') t.viewsRequired = Number(views);
      out.push(t);
    }
    return out;
  }

  /* ---------- create a campaign ---------- */

  function submitCampaign() {
    /* The server refuses a campaign unless the campaign-owner record is
       verified. When we know the state, say so before the round trip; when we
       do not know it, we still try and let the server answer. */
    if (ownerStateKnown && !ownerVerified()) {
      var gateMsg = 'Your campaign owner record is ' + ownerPhrase() +
        ', and an admin has to verify it before any campaign can be created. '
        + 'Send or refresh your details on the Business verification tab.';
      say('campaign-form-status', gateMsg, true);
      FB && FB.err(gateMsg);
      setPane('owner');
      return null;
    }

    var title = fieldValue('business-title');
    var platform = fieldValue('business-platform');
    var objective = fieldValue('business-objective');
    var brief = fieldValue('business-brief');
    var budgetNaira = numberOrNull('business-budget');
    var priceNaira = numberOrNull('business-price');
    var shareBp = numberOrNull('business-promoter-share');
    var reserveBp = numberOrNull('business-fraud-reserve');
    var floorBp = numberOrNull('business-margin-floor');

    if (!title) return fail('Give the campaign a title.');
    if (!platform) return fail('Name the platform this campaign runs on.');
    if (!(budgetNaira > 0)) return fail('Budget must be a positive amount in naira.');
    if (!(priceNaira > 0)) return fail('Price per outcome must be a positive amount in naira.');
    if (shareBp != null && (shareBp < 0 || shareBp > 10000)) return fail('Promoter share must be between 0 and 10000 basis points.');
    if (reserveBp != null && (reserveBp < 0 || reserveBp > 10000)) return fail('Fraud reserve must be between 0 and 10000 basis points.');
    if (floorBp != null && (floorBp < 0 || floorBp > 10000)) return fail('Margin floor must be between 0 and 10000 basis points.');
    if (shareBp != null && reserveBp != null && shareBp + reserveBp > 10000) {
      return fail('Promoter share plus fraud reserve cannot exceed 10000 basis points.');
    }

    var tasks = buildTasks();
    if (!tasks.length) return fail('A campaign needs at least one task.');
    if (tasks.length > 10) return fail('A campaign can hold at most 10 tasks.');
    for (var i = 0; i < tasks.length; i++) {
      if (!tasks[i].caption) return fail('Every task needs a caption.');
      if (!/^https:\/\//i.test(tasks[i].trackedLink)) return fail('Every task needs a tracked link that starts with https://');
    }

    var body = {
      title: title,
      platform: platform,
      objective: objective,
      budgetMinor: Math.round(budgetNaira * 100),
      pricePerOutcomeMinor: Math.round(priceNaira * 100),
      tasks: tasks
    };
    if (brief) body.brief = brief;
    if (shareBp != null) body.promoterShareBp = shareBp;
    if (reserveBp != null) body.fraudReserveBp = reserveBp;
    if (floorBp != null) body.marginFloorBp = floorBp;

    var btn = document.getElementById('campaign-submit');
    if (btn) btn.disabled = true;
    say('campaign-form-status', 'Creating your campaign…', false);

    return Auth.api('/api/v1/campaigns', { method: 'POST', body: body }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 201 && r.body) {
        var created = r.body.campaign || {};
        var msg = 'Campaign created: ' + (created.title || title) + '. ' + (r.body.nextStep || 'It goes to review next.');
        say('campaign-form-status', msg, false);
        FB && FB.ok('Campaign created.');
        resetForm();
        loadCampaigns();
        return r.body;
      }
      var errMsg = (r.body && r.body.error) || 'The campaign was not created.';
      if (r.status === 403) {
        errMsg += ' Open the Business verification tab to send your details.';
        say('campaign-form-status', errMsg, true);
        FB && FB.err(errMsg);
        loadOwner();
        setPane('owner');
        return null;
      }
      say('campaign-form-status', errMsg, true);
      FB && FB.err(errMsg);
      return null;
    });
  }

  function fail(message) {
    say('campaign-form-status', message, true);
    FB && FB.err(message);
    return false;
  }

  function resetForm() {
    var form = document.getElementById('business-form');
    if (!form) return;
    form.reset();
    var host = document.getElementById('task-rows');
    if (host) host.innerHTML = '';
    rowSeq = 0;
    addTaskRow();
  }

  /* ---------- payments ---------- */

  function renderPayments(rows) {
    var body = document.getElementById('payments-body');
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="fine">No payments recorded for this campaign yet.</td></tr>';
      return;
    }
    body.innerHTML = rows.map(function (p) {
      var amount = p.settledMinor != null ? p.settledMinor : p.amountMinor;
      var paidAt = p.paidAt || p.settledAt || p.createdAt;
      return '<tr>' +
        '<td>' + esc(p.reference || p.providerRef || p.id || '–') + '</td>' +
        '<td>' + esc(amount == null ? '–' : naira(amount)) + '</td>' +
        '<td>' + stateBadge(p.status || p.state) + '</td>' +
        '<td>' + esc(paidAt ? when(paidAt) : '–') + '</td>' +
        '</tr>';
    }).join('');
  }

  function loadPayments(campaignId) {
    if (!campaignId) {
      say('payments-status', 'Pick a campaign first.', true);
      return null;
    }
    say('payments-status', 'Loading payments…', false);
    return Auth.api('/api/v1/campaigns/' + encodeURIComponent(campaignId) + '/payments').then(function (r) {
      if (r.status === 200 && r.body && Array.isArray(r.body.payments)) {
        renderPayments(r.body.payments);
        say('payments-status', r.body.payments.length + (r.body.payments.length === 1 ? ' payment' : ' payments') + ' on file.');
        return r.body.payments;
      }
      if (r.status === 401) {
        Auth.clearToken();
        failGate('Sign in required', 'Your session is missing or expired.');
        return [];
      }
      var msg = (r.body && r.body.error) || 'Could not load the payments.';
      say('payments-status', msg, true);
      FB && FB.err(msg);
      return [];
    });
  }

  /* ---------- wiring ---------- */

  var campaignsBody = document.getElementById('campaigns-body');
  if (campaignsBody) {
    campaignsBody.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button[data-pay]') : null;
      if (!btn) return;
      requestPaymentLink(btn.getAttribute('data-pay'), btn);
    });
  }

  var addTaskBtn = document.getElementById('add-task');
  if (addTaskBtn) addTaskBtn.addEventListener('click', addTaskRow);

  var taskHost = document.getElementById('task-rows');
  if (taskHost) {
    taskHost.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button[data-remove-task]') : null;
      if (!btn) return;
      var row = btn.closest('.task-row');
      removeTaskRow(row);
    });
  }

  var businessForm = document.getElementById('business-form');
  if (businessForm) {
    businessForm.addEventListener('submit', function (e) {
      e.preventDefault();
      submitCampaign();
    });
  }

  var ownerForm = document.getElementById('owner-form');
  if (ownerForm) {
    ownerForm.addEventListener('submit', function (e) {
      e.preventDefault();
      submitOwner();
    });
  }

  var ownerKind = document.getElementById('owner-kind');
  if (ownerKind) {
    ownerKind.addEventListener('change', syncOwnerKind);
  }

  var paymentsForm = document.getElementById('payments-filter');
  if (paymentsForm) {
    paymentsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      loadPayments(fieldValue('payments-campaign'));
    });
  }

  var campaignSelect = document.getElementById('payments-campaign');
  if (campaignSelect) {
    campaignSelect.addEventListener('change', function () {
      loadPayments(campaignSelect.value);
    });
  }

  var signoutBtn = document.getElementById('signout');
  if (signoutBtn) signoutBtn.addEventListener('click', function () {
    Auth.signOut();
    window.location.href = '/';
  });

  /* ---------- boot ---------- */
  function loadMe() {
    return Auth.api('/api/me').then(function (r) {
      if (r.status === 401 || r.status === 403) {
        Auth.clearToken();
        failGate('Sign in required', 'Your session is missing or expired.');
        return null;
      }
      if (r.status !== 200 || !r.body) return null;
      /* /api/me answers { profile: { id, displayName, phone, network, state,
         role, kycTier, phoneVerified, ageVerified }, points, level, ... }.
         There is no legalName or businessName on it — only displayName. */
      var p = r.body.profile || {};
      var label = p.displayName || '';
      if (whoami) {
        whoami.hidden = false;
        whoami.textContent = label || 'Business workspace';
      }
      return r.body;
    });
  }

  if (!Auth.getToken()) {
    failGate('Sign in required', 'Your session is missing. Sign in with your business account to run campaigns.');
    return;
  }
  if (gate) gate.hidden = true;
  if (app) app.hidden = false;

  addTaskRow();
  syncOwnerKind();

  Promise.all([loadCampaigns(), loadMe(), loadOwner()]).then(function () {
    if (dashLink) {
      dashLink.hidden = false;
      dashLink.addEventListener('click', function () { window.location.href = '/dashboard.html'; });
    }
    FB && FB.ready();
  });
})();
