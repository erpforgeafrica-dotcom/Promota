/* promotion.js -- "Promote you": members promote each other.
   A member publishes a promo card, an admin approves it, then two members
   agree a swap: each posts the other's card with a disclosure, an admin
   approves each delivery, and Postgres mints the points. Nothing here mints
   or computes a point value -- the numbers shown are what the server sent.

   Exposes window.PromotaPromotion = { bind, load } so dashboard.js can wire it
   into its tab switch. Loaded before dashboard.js. */
(function () {
  'use strict';

  var Auth = window.PromotaAuth;
  if (!Auth) return;

  var KINDS = ['person', 'creator', 'business', 'cause'];
  var PLATFORMS = ['instagram', 'tiktok', 'x', 'facebook', 'youtube', 'whatsapp', 'telegram', 'linkedin', 'other'];
  var DISCLOSURES = [['ad', '#ad'], ['sponsored', '#sponsored'], ['paid_partnership', 'Paid partnership']];

  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function when(iso) {
    if (!iso) return '\u2013';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-NG') + ' ' + d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  }
  function badge(state) { return '<span class="badge">' + esc(state || '\u2013') + '</span>'; }
  function say(id, message, kind) {
    var b = byId(id);
    if (!b) return;
    b.textContent = message || '';
    b.className = 'form-status' + (kind ? ' ' + kind : '');
  }
  function fail(id, message) { say(id, message, 'error'); FB && FB.err(message); }
  function httpsOk(v) { return /^https:\/\/[^\s]+$/i.test(String(v || '').trim()); }

  var cards = [];      // my cards, latest server answer
  var pairs = [];      // my pairs, latest server answer

  /* ------------------------------------------------------------- my cards */

  function myCardRow(c) {
    var note = c.moderationNote
      ? '<p class="fine">Reviewer note: ' + esc(c.moderationNote) + '</p>'
      : '';
    var live = c.state === 'active'
      ? '<p class="fine">Live since ' + when(c.approvedAt) + '. Other members can now propose a swap.</p>'
      : '';
    return '<article class="panel task-card">' +
      '<div class="task-head"><h3>' + esc(c.title || 'Untitled card') + '</h3>' + badge(c.state) + '</div>' +
      '<p class="fine">' + esc(c.kind || 'person') +
      (c.category ? ' \u00b7 ' + esc(c.category) : '') +
      (c.city ? ' \u00b7 ' + esc(c.city) : '') + '</p>' +
      '<p>' + esc(c.summary || '') + '</p>' +
      (c.linkUrl ? '<p class="fine"><a href="' + esc(c.linkUrl) + '" target="_blank" rel="noopener noreferrer">Your link</a></p>' : '') +
      note + live +
      '</article>';
  }

  function renderMyCards() {
    var host = byId('promo-cards-list');
    if (!host) return;
    if (!cards.length) {
      host.innerHTML = '<p class="fine">No promotion card yet. Create one below -- an admin reviews it before it goes live.</p>';
      return;
    }
    host.innerHTML = cards.map(myCardRow).join('');
    renderSelfOptions();
  }

  function renderSelfOptions() {
    var sel = byId('promo-self-card');
    if (!sel) return;
    var live = cards.filter(function (c) { return c.state === 'active'; });
    var previous = sel.value;
    sel.innerHTML = live.length
      ? live.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.title) + '</option>'; }).join('')
      : '<option value="">No live card yet</option>';
    if (previous && live.some(function (c) { return c.id === previous; })) sel.value = previous;
    var hint = byId('promo-self-hint');
    if (hint) {
      hint.textContent = live.length
        ? 'Your live card is what the other member posts; theirs is what you post.'
        : 'A card must be approved before you can offer it. Create one above and wait for review.';
    }
    document.querySelectorAll('[data-propose-partner]').forEach(function (b) {
      b.disabled = !live.length;
    });
  }

  function loadMyCards() {
    return Auth.api('/api/v1/promotion/cards/mine').then(function (r) {
      if (r.status === 200 && r.body) {
        cards = r.body.cards || [];
        renderMyCards();
        return;
      }
      say('promo-cards-status', (r.body && r.body.error) || 'Could not load your promotion cards.', 'error');
    });
  }

  function createCard(e) {
    e.preventDefault();
    var kind = byId('promo-kind');
    var title = byId('promo-title');
    var summary = byId('promo-summary');
    var link = byId('promo-link');
    var media = byId('promo-media');
    var category = byId('promo-category');
    var city = byId('promo-city');

    var body = {
      kind: kind ? kind.value : 'person',
      title: title ? title.value.trim() : '',
      summary: summary ? summary.value.trim() : '',
      linkUrl: link ? link.value.trim() : ''
    };
    if (media && media.value.trim()) body.mediaUrl = media.value.trim();
    if (category && category.value.trim()) body.category = category.value.trim();
    if (city && city.value.trim()) body.city = city.value.trim();

    if (body.title.length < 3) return fail('promo-cards-status', 'A title of at least 3 characters is required.');
    if (body.summary.length < 10) return fail('promo-cards-status', 'A summary of at least 10 characters is required.');
    if (!httpsOk(body.linkUrl)) return fail('promo-cards-status', 'Paste the https link you want promoted.');
    if (body.mediaUrl && !httpsOk(body.mediaUrl)) return fail('promo-cards-status', 'The media URL must be an https link.');

    var btn = byId('promo-card-submit');
    if (btn) btn.disabled = true;
    say('promo-cards-status', 'Sending the card for review\u2026', '');

    Auth.api('/api/v1/promotion/cards', { method: 'POST', body: body }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 201) {
        var form = byId('promo-card-form');
        if (form) form.reset();
        say('promo-cards-status', 'Card submitted for review. It goes live once an admin approves it.', 'ok');
        FB && FB.ok('Promotion card submitted for review.');
        loadMyCards();
        return;
      }
      if (r.status === 401) { Auth.clearToken(); return fail('promo-cards-status', 'Your session expired. Sign in again.'); }
      fail('promo-cards-status', (r.body && r.body.error) || 'Could not create the card.');
    });
  }

  /* ---------------------------------------------------------------- browse */

  function browseCard(c) {
    return '<article class="panel task-card">' +
      '<div class="task-head"><h3>' + esc(c.title || 'Untitled card') + '</h3>' + badge(c.kind) + '</div>' +
      '<p>' + esc(c.summary || '') + '</p>' +
      '<p class="fine">' +
      (c.category ? esc(c.category) : '') +
      (c.city ? (c.category ? ' \u00b7 ' : '') + esc(c.city) : '') +
      (c.linkUrl ? ' \u00b7 <a href="' + esc(c.linkUrl) + '" target="_blank" rel="noopener noreferrer">Preview</a>' : '') +
      '</p>' +
      '<p><button class="btn" type="button" data-propose-partner="' + esc(c.id) + '">Propose a swap</button></p>' +
      '</article>';
  }

  function renderBrowse(list) {
    var host = byId('promo-browse-list');
    if (!host) return;
    if (!list.length) {
      host.innerHTML = '<p class="fine">No other member has a live card yet.</p>';
      return;
    }
    host.innerHTML = list.map(browseCard).join('');
    host.querySelectorAll('[data-propose-partner]').forEach(function (b) {
      b.addEventListener('click', function () { propose(b.getAttribute('data-propose-partner'), b); });
    });
    renderSelfOptions();
  }

  function loadBrowse() {
    return Auth.api('/api/v1/promotion/cards?limit=30').then(function (r) {
      if (r.status === 200 && r.body) {
        renderBrowse(r.body.cards || []);
        return;
      }
      say('promo-browse-status', (r.body && r.body.error) || 'Could not load the promotion cards.', 'error');
    });
  }

  function propose(partnerCardId, btn) {
    var sel = byId('promo-self-card');
    var selfCardId = sel ? sel.value : '';
    if (!selfCardId) return fail('promo-browse-status', 'Your card must be approved before you can propose a swap.');
    if (btn) btn.disabled = true;
    say('promo-browse-status', 'Sending the proposal\u2026', '');
    Auth.api('/api/v1/promotion/pairs', {
      method: 'POST',
      body: { selfCardId: selfCardId, partnerCardId: partnerCardId }
    }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 201) {
        say('promo-browse-status', 'Proposal sent. It starts once the other member accepts.', 'ok');
        FB && FB.ok('Swap proposed.');
        loadPairs();
        return;
      }
      if (r.status === 401) { Auth.clearToken(); return fail('promo-browse-status', 'Your session expired. Sign in again.'); }
      fail('promo-browse-status', (r.body && r.body.error) || 'Could not send the proposal.');
    });
  }

  /* ----------------------------------------------------------------- pairs */

  function deliveryLines(p) {
    var out = '';
    (p.deliveries || []).forEach(function (d) {
      var who = d.mine ? 'You' : 'Partner';
      var state = badge(d.state);
      var pts = d.state === 'approved' ? ' \u00b7 ' + esc(String(d.points || 0)) + ' points' : '';
      var link = d.postUrl
        ? ' \u00b7 <a href="' + esc(d.postUrl) + '" target="_blank" rel="noopener noreferrer">post</a>'
        : '';
      var reason = d.state === 'rejected' && d.rejectReason
        ? '<br><span class="fine">Reason: ' + esc(d.rejectReason) + '</span>'
        : '';
      out += '<p class="fine">' + who + ' \u00b7 ' + esc(d.platform || '\u2013') + ' \u00b7 ' + state + pts + link + reason + '</p>';
    });
    return out;
  }

  function deliverForm(p) {
    return '<form class="proof-form" data-deliver-pair="' + esc(p.id) + '">' +
      '<select name="platform" aria-label="Platform">' +
      PLATFORMS.map(function (pl) { return '<option value="' + pl + '">' + esc(pl) + '</option>'; }).join('') +
      '</select>' +
      '<input type="url" name="postUrl" required placeholder="https:// link to your post">' +
      '<select name="disclosure" aria-label="Disclosure">' +
      DISCLOSURES.map(function (d) { return '<option value="' + d[0] + '">' + esc(d[1]) + '</option>'; }).join('') +
      '</select>' +
      '<button type="submit" class="btn primary">Submit delivery</button>' +
      '</form>';
  }

  function pairRow(p) {
    var partner = p.partnerCard || {};
    var mine = p.myCard || {};
    var head = '<div class="task-head"><h3>' + esc(partner.title || 'A member\u2019s card') + '</h3>' + badge(p.state) + '</div>';
    var legs = '<p class="fine">You promote: ' + esc(partner.title || '\u2013') +
      ' \u00b7 They promote: ' + esc(mine.title || '\u2013') + '</p>';
    var when2 = '';
    if (p.state === 'proposed') {
      when2 = p.role === 'invitee' && !p.proposedByMe
        ? '<p><button class="btn primary" type="button" data-accept-pair="' + esc(p.id) + '">Accept and start the clock</button></p>'
        : '<p class="fine">Waiting for the other member to accept.</p>';
    } else if (p.state === 'active') {
      var myDelivery = (p.deliveries || []).filter(function (d) { return d.mine; })[0];
      when2 = '<p class="fine">Deliver by ' + when(p.deliveryDeadline) + '.</p>';
      if (!myDelivery) when2 += deliverForm(p);
    } else if (p.state === 'expired') {
      when2 = '<p class="fine">The delivery window closed before both sides delivered.</p>';
    } else if (p.state === 'cancelled') {
      when2 = '<p class="fine">This pair was cancelled.</p>';
    }
    return '<article class="panel task-card">' + head + legs + when2 + deliveryLines(p) + '</article>';
  }

  function renderPairs() {
    var host = byId('promo-pairs-list');
    if (!host) return;
    if (!pairs.length) {
      host.innerHTML = '<p class="fine">No swaps yet. Propose one from the list above.</p>';
      return;
    }
    host.innerHTML = pairs.map(pairRow).join('');
    host.querySelectorAll('[data-accept-pair]').forEach(function (b) {
      b.addEventListener('click', function () { accept(b.getAttribute('data-accept-pair'), b); });
    });
    host.querySelectorAll('[data-deliver-pair]').forEach(function (form) {
      form.addEventListener('submit', function (e) { deliver(e, form); });
    });
  }

  function loadPairs() {
    return Auth.api('/api/v1/promotion/pairs').then(function (r) {
      if (r.status === 200 && r.body) {
        pairs = r.body.pairs || [];
        renderPairs();
        return;
      }
      say('promo-pairs-status', (r.body && r.body.error) || 'Could not load your swaps.', 'error');
    });
  }

  function accept(id, btn) {
    if (btn) btn.disabled = true;
    say('promo-pairs-status', 'Accepting\u2026', '');
    Auth.api('/api/v1/promotion/pairs/' + encodeURIComponent(id) + '/accept', { method: 'POST' }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 200) {
        say('promo-pairs-status', 'Accepted. Deliver your side before the deadline.', 'ok');
        FB && FB.ok('Swap accepted.');
        loadPairs();
        return;
      }
      if (r.status === 401) { Auth.clearToken(); return fail('promo-pairs-status', 'Your session expired. Sign in again.'); }
      fail('promo-pairs-status', (r.body && r.body.error) || 'Could not accept the swap.');
    });
  }

  function deliver(e, form) {
    e.preventDefault();
    var id = form.getAttribute('data-deliver-pair');
    var platform = form.querySelector('select[name="platform"]');
    var postUrl = form.querySelector('input[name="postUrl"]');
    var disclosure = form.querySelector('select[name="disclosure"]');
    var body = {
      platform: platform ? platform.value : '',
      postUrl: postUrl ? postUrl.value.trim() : '',
      disclosure: disclosure ? disclosure.value : ''
    };
    if (!httpsOk(body.postUrl)) return fail('promo-pairs-status', 'Paste the https link to your post.');
    var btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    say('promo-pairs-status', 'Submitting your delivery\u2026', '');
    Auth.api('/api/v1/promotion/pairs/' + encodeURIComponent(id) + '/deliver', {
      method: 'POST',
      body: body
    }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 201) {
        say('promo-pairs-status', 'Delivery submitted. Points land after an admin approves it.', 'ok');
        FB && FB.ok('Delivery submitted for review.');
        loadPairs();
        return;
      }
      if (r.status === 401) { Auth.clearToken(); return fail('promo-pairs-status', 'Your session expired. Sign in again.'); }
      fail('promo-pairs-status', (r.body && r.body.error) || 'Could not submit the delivery.');
    });
  }

  /* ----------------------------------------------------------------- boot */

  var bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    var form = byId('promo-card-form');
    if (form) form.addEventListener('submit', createCard);
  }

  var loadedOnce = false;
  function load() {
    bind();
    if (loadedOnce) { loadMyCards(); loadPairs(); return Promise.resolve(); }
    loadedOnce = true;
    return Promise.all([loadMyCards(), loadBrowse(), loadPairs()]);
  }

  window.PromotaPromotion = { bind: bind, load: load };
})();
