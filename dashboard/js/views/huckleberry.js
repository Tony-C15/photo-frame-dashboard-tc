// Huckleberry: live baby-tracker data — running timers, last feed / sleep / diaper, solid foods, activities.
// Display only. Data comes from js/huckleberry.js; sign-in happens on the frame (token kept in localStorage).
(function () {
  'use strict';
  var H = window.Huck;
  var V = {
    el: null, active: false, status: 'init', // init | out | loading | ready | error
    kids: [], cid: null, live: null, hist: null,
    err: '', loginErr: '', busy: false, liveAt: 0, histAt: 0, tryAt: 0, submitting: false
  };
  var CKEY = 'hb.child';
  var LIVE_EVERY = 30, HIST_EVERY = 300; // seconds

  var MODES = [
    ['bath', 'Bath'], ['tummyTime', 'Tummy time'], ['storyTime', 'Story time'], ['screenTime', 'Screen time'],
    ['outdoorPlay', 'Outdoor play'], ['indoorPlay', 'Indoor play'], ['skinToSkin', 'Skin-to-skin'], ['brushTeeth', 'Brush teeth']
  ];
  var REACTIONS = { LOVED: 'Loved', MEH: 'Meh', HATED: 'Hated', ALLERGIC: 'Allergic' };
  var esc = function (s) { return App.esc(s); };

  // ------------------------------------------------------------ time + formatting
  function nowS() { return (Date.now() + H.skew) / 1000; }
  function dayStartS() { var d = new Date(Date.now() + H.skew); d.setHours(0, 0, 0, 0); return (d.getTime() - H.skew) / 1000; }
  function dur(sec) {
    var m = Math.max(0, Math.floor(sec / 60));
    if (m < 1) return '<1m';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h >= 48) return Math.floor(h / 24) + 'd';
    return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  }
  function clock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function at(sec) { return App.fmt.time(new Date(sec * 1000)); }
  function ago(sec) { return '<span data-ago="' + sec + '">' + dur(nowS() - sec) + '</span>'; }
  function age(b) {
    var d = typeof b === 'number' ? new Date(b * 1000) : new Date(String(b || '').slice(0, 10) + 'T12:00:00');
    if (!b || isNaN(d)) return '';
    var n = new Date(), mo = (n.getFullYear() - d.getFullYear()) * 12 + n.getMonth() - d.getMonth() - (n.getDate() < d.getDate() ? 1 : 0);
    if (mo < 0) return '';
    if (mo < 24) return mo + ' mo';
    return Math.floor(mo / 12) + ' yr' + (mo % 12 ? ' ' + (mo % 12) + ' mo' : '');
  }
  function liveClock(t0) { return '<span class="num" data-clock="' + t0 + '">' + clock(nowS() - t0) + '</span>'; }

  // ------------------------------------------------------------ model (raw docs -> what the cards need)
  function pick(o, path) {
    for (var i = 0; i < path.length && o; i++) o = o[path[i]];
    return o == null ? null : o;
  }
  function today(list) { var s = dayStartS(); return (list || []).filter(function (e) { return e.start >= s; }); }
  function foodNames(foods) {
    return Object.keys(foods || {}).map(function (k) { return foods[k] && foods[k].created_name; }).filter(Boolean);
  }
  function reactionOf(e) {
    var r = e.reactions || {}, order = ['ALLERGIC', 'HATED', 'MEH', 'LOVED'];
    for (var i = 0; i < order.length; i++) if (r[order[i]]) return order[i];
    return '';
  }

  function sleepModel() {
    var L = V.live.sleep, t = pick(L, ['timer']), last = pick(L, ['prefs', 'lastSleep']);
    var total = today(V.hist && V.hist.sleep).reduce(function (s, e) { return s + (e.duration || 0); }, 0);
    var m = { total: total, naps: today(V.hist && V.hist.sleep).length };
    if (t && t.active && t.timerStartTime) {
      m.on = true; m.paused = !!t.paused; m.t0 = t.timerStartTime / 1000;
      m.fixed = t.paused && t.timerEndTime ? (t.timerEndTime - t.timerStartTime) / 1000 : 0;
      m.total += m.paused ? m.fixed : nowS() - m.t0;
    }
    if (last && last.start != null) { m.lastStart = last.start; m.lastDur = last.duration || 0; m.wokeAt = last.start + (last.duration || 0); }
    return m;
  }
  function feedModel() {
    var L = V.live.feed, t = pick(L, ['timer']), p = pick(L, ['prefs']) || {};
    var m = { counts: { breast: 0, bottle: 0, solids: 0 } };
    today(V.hist && V.hist.feed).forEach(function (e) { if (m.counts[e.mode] != null) m.counts[e.mode]++; });
    m.count = m.counts.breast + m.counts.bottle + m.counts.solids;
    if (t && t.active) {
      m.on = true; m.paused = !!t.paused; m.side = t.activeSide || t.lastSide || '';
      var banked = (t.leftDuration || 0) + (t.rightDuration || 0);
      m.fixed = banked;
      m.t0 = nowS() - banked - (t.paused || !t.timerStartTime ? 0 : nowS() - t.timerStartTime);
    }
    var cands = [];
    if (p.lastNursing && p.lastNursing.start) cands.push({ t: p.lastNursing.start, what: 'Nursing', detail: dur((p.lastNursing.leftDuration || 0) + (p.lastNursing.rightDuration || 0) || p.lastNursing.duration || 0) });
    if (p.lastBottle && p.lastBottle.start) cands.push({ t: p.lastBottle.start, what: 'Bottle', detail: p.lastBottle.bottleAmount ? p.lastBottle.bottleAmount + ' ' + (p.lastBottle.bottleUnits || '') : (p.lastBottle.bottleType || '') });
    if (p.lastSolid && p.lastSolid.start) cands.push({ t: p.lastSolid.start, what: 'Solids', detail: foodNames(p.lastSolid.foods).join(', ') });
    cands.sort(function (a, b) { return b.t - a.t; });
    m.last = cands[0] || null;
    return m;
  }
  function diaperModel() {
    var last = pick(V.live.diaper, ['prefs', 'lastDiaper']);
    var m = { pee: 0, poo: 0, dry: 0, last: last && last.start ? last : null };
    today(V.hist && V.hist.diaper).forEach(function (e) {
      if (e.mode === 'pee' || e.mode === 'both') m.pee++;
      if (e.mode === 'poo' || e.mode === 'both') m.poo++;
      if (e.mode === 'dry') m.dry++;
    });
    m.count = today(V.hist && V.hist.diaper).length;
    return m;
  }
  function actModel() {
    var A = V.live.act || {}, rows = [];
    var totals = {};
    today(V.hist && V.hist.act).forEach(function (e) { totals[e.mode] = (totals[e.mode] || 0) + (e.duration || 0); });
    MODES.forEach(function (md) {
      var k = md[0], t = pick(A, ['timer', k]), last = pick(A, ['prefs', 'last' + k.charAt(0).toUpperCase() + k.slice(1)]);
      var row = { k: k, label: md[1], total: totals[k] || 0, last: last && last.start ? last.start : 0 };
      if (t && t.active && t.startTime) {
        row.on = true; row.paused = !!t.paused; row.t0 = t.startTime / 1000; row.fixed = t.paused ? (t.duration || 0) : 0;
      }
      rows.push(row);
    });
    rows.sort(function (a, b) { return (b.on ? 1 : 0) - (a.on ? 1 : 0); });
    return rows;
  }
  // Foods seen in the last 30 days: most recent meal wins for the reaction shown.
  function foodsModel() {
    var meals = ((V.hist && V.hist.feed) || []).filter(function (e) { return e.mode === 'solids'; });
    var seen = {}, list = [], weekAgo = nowS() - 7 * 86400;
    meals.forEach(function (e) { // newest first
      foodNames(e.foods).forEach(function (n) {
        var key = n.toLowerCase();
        if (!seen[key]) { seen[key] = { name: n, last: e.start, first: e.start, n: 0, r: reactionOf(e) }; list.push(seen[key]); }
        seen[key].n++; seen[key].first = e.start;
      });
    });
    list.forEach(function (f) { f.isNew = f.first >= weekAgo; });
    return { meals: meals, today: today(meals), foods: list, fresh: list.filter(function (f) { return f.isNew; }).length };
  }

  // ------------------------------------------------------------ rendering
  function card(cls, c, rgb, ink, inner, on) {
    return '<section class="hb-card ' + cls + (on ? ' is-live' : '') + '" style="--c:' + c + ';--c-rgb:' + rgb + ';--c-ink:' + ink + '">' + inner + '</section>';
  }
  function head(icon, title, badge) {
    return '<header class="hb-head"><span class="hb-ic">' + App.icon(icon, 22) + '</span><b>' + title + '</b>' + (badge ? '<span class="hb-badge">' + badge + '</span>' : '') + '</header>';
  }
  function stat(n, label) { return '<div><span class="num">' + n + '</span><small>' + label + '</small></div>'; }

  function sleepCard() {
    var m = sleepModel(), main, sub, badge = '';
    if (m.on) {
      badge = m.paused ? 'Paused' : '<i></i>Sleeping';
      main = m.paused ? '<span class="num">' + clock(m.fixed) + '</span>' : liveClock(m.t0);
      sub = 'Asleep since ' + at(m.t0);
    } else if (m.wokeAt) {
      main = '<span class="num">' + ago(m.wokeAt) + '</span>';
      sub = 'Awake since ' + at(m.wokeAt) + ' · last sleep ' + dur(m.lastDur);
    } else { main = '<span class="num">—</span>'; sub = 'No sleep logged yet'; }
    return card('hb-sleep', '#2D5BFF', '45 91 255', '#FFFFFF',
      head('moon', 'Sleep', badge) + '<div class="hb-big">' + main + '</div><p class="hb-sub">' + sub + '</p>' +
      '<footer class="hb-foot">' + stat(dur(m.total), 'slept today') + stat(m.naps + (m.on ? 1 : 0), 'sessions') + '</footer>', m.on);
  }
  function feedCard() {
    var m = feedModel(), main, sub, badge = '';
    if (m.on) {
      badge = m.paused ? 'Paused' : '<i></i>Nursing';
      main = m.paused ? '<span class="num">' + clock(m.fixed) + '</span>' : liveClock(m.t0);
      sub = 'Nursing' + (m.side && m.side !== 'none' ? ' · ' + m.side + ' side' : '');
    } else if (m.last) {
      main = '<span class="num">' + ago(m.last.t) + '</span>';
      sub = m.last.what + (m.last.detail ? ' · ' + esc(m.last.detail) : '') + ' · ' + at(m.last.t);
    } else { main = '<span class="num">—</span>'; sub = 'No feeds logged yet'; }
    return card('hb-feed', '#FFB000', '255 176 0', '#111111',
      head('drop', 'Feeding', badge) + '<div class="hb-big">' + main + '</div><p class="hb-sub">' + sub + '</p>' +
      '<footer class="hb-foot">' + stat(m.count, 'feeds today') + stat(m.counts.solids, 'solids') + '</footer>', m.on);
  }
  function diaperCard() {
    var m = diaperModel(), main, sub;
    if (m.last) {
      main = '<span class="num">' + ago(m.last.start) + '</span>';
      sub = 'Last change · ' + at(m.last.start) + (m.last.mode ? ' · ' + m.last.mode : '');
    } else { main = '<span class="num">—</span>'; sub = 'No diapers logged yet'; }
    return card('hb-diaper', '#00A36C', '0 163 108', '#FFFFFF',
      head('box', 'Diapers') + '<div class="hb-big">' + main + '</div><p class="hb-sub">' + sub + '</p>' +
      '<footer class="hb-foot">' + stat(m.pee, 'pee') + stat(m.poo, 'poo') + stat(m.count, 'today') + '</footer>', false);
  }

  function solidsCard() {
    var F = foodsModel();
    var meals = F.today.length ? F.today.map(function (e) {
      var r = reactionOf(e), names = foodNames(e.foods);
      return '<li><span class="hb-t">' + at(e.start) + '</span><span class="hb-meal">' + (names.length ? esc(names.join(', ')) : 'Solids') + '</span>' +
        (r ? '<em class="hb-rx hb-rx--' + r.toLowerCase() + '">' + REACTIONS[r] + '</em>' : '') + '</li>';
    }).join('') : '<li class="hb-empty">No solids logged today</li>';
    var foods = F.foods.length ? F.foods.slice(0, 30).map(function (f) {
      return '<li class="hb-food' + (f.r ? ' hb-food--' + f.r.toLowerCase() : '') + '">' + esc(f.name) + (f.isNew ? '<b>New</b>' : '') + '</li>';
    }).join('') : '<li class="hb-empty">Nothing tried in the last 30 days</li>';
    return card('hb-solids', '#E4007C', '228 0 124', '#FFFFFF',
      head('utensils', 'Solid foods') +
      '<div class="hb-solids-body"><div class="hb-col"><div class="label">Today · ' + F.today.length + ' meal' + (F.today.length === 1 ? '' : 's') + '</div><ul class="hb-meals">' + meals + '</ul></div>' +
      '<div class="hb-col"><div class="label">Foods tried · 30 days · ' + F.foods.length + (F.fresh ? ' · ' + F.fresh + ' new' : '') + '</div><ul class="hb-foods">' + foods + '</ul></div></div>', false);
  }
  function actCard() {
    var rows = actModel(), anyOn = rows.some(function (r) { return r.on; });
    var list = rows.map(function (r) {
      var right;
      if (r.on) right = r.paused ? '<span class="num">' + clock(r.fixed) + '</span>' : liveClock(r.t0);
      else right = r.last ? ago(r.last) + ' ago' : '—';
      return '<li class="' + (r.on ? 'is-on' : '') + '"><span class="hb-act-n">' + r.label + '</span>' +
        '<span class="hb-act-today">' + (r.total ? dur(r.total) : '') + '</span><span class="hb-act-last">' + right + '</span></li>';
    }).join('');
    return card('hb-act', '#7A3FF2', '122 63 242', '#FFFFFF',
      head('star', 'Activities', anyOn ? '<i></i>Live' : '') + '<div class="hb-act-cols"><span></span><span>Today</span><span>Last</span></div><ul class="hb-acts">' + list + '</ul>', false);
  }

  function topbar() {
    var k = V.kids.filter(function (x) { return x.cid === V.cid; })[0] || {};
    var chips = V.kids.length > 1 ? '<div class="hb-kids">' + V.kids.map(function (x) {
      return '<button class="hb-kid' + (x.cid === V.cid ? ' is-on' : '') + '" data-child="' + esc(x.cid) + '">' + esc(x.name) + '</button>';
    }).join('') + '</div>' : '';
    var a = age(k.birthdate);
    return '<header class="hb-top"><div><div class="label">Huckleberry' + (a ? ' · ' + a : '') + '</div><h1 class="serif">' + esc(k.name || 'Baby') + '</h1></div>' +
      '<div class="hb-tools">' + chips + '<span class="label" data-synced>' + synced() + '</span>' +
      '<button class="icon-btn" data-refresh aria-label="Refresh">' + App.icon('undo', 26) + '</button>' +
      '<button class="hb-out" data-signout>Sign out</button></div></header>';
  }
  function synced() {
    if (V.err) return 'Offline · ' + (V.liveAt ? 'updated ' + dur(nowS() - V.liveAt / 1000) + ' ago' : 'no data');
    if (!V.liveAt) return 'Loading…';
    var s = (Date.now() - V.liveAt) / 1000;
    return s < 60 ? 'Updated just now' : 'Updated ' + dur(s) + ' ago';
  }

  function loginView() {
    return '<div class="hb-login"><form class="hb-login-card" data-login autocomplete="on">' +
      '<div class="label">Huckleberry</div><h1 class="serif">Sign in</h1>' +
      '<p>Use your Huckleberry account. Your password isn’t kept on the frame — only a sign-in token.</p>' +
      '<input name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Email" value="' + esc(H.email) + '">' +
      '<input name="password" type="password" autocomplete="current-password" placeholder="Password">' +
      '<div class="hb-err" data-loginerr>' + esc(V.loginErr) + '</div>' +
      '<button class="btn btn--solid" type="submit" ' + (V.submitting ? 'disabled' : '') + '>' + (V.submitting ? 'Signing in…' : 'Sign in') + '</button>' +
      '</form></div>';
  }
  function messageView(title, text, btn) {
    return '<div class="hb-login"><div class="hb-login-card"><div class="label">Huckleberry</div><h1 class="serif">' + title + '</h1><p>' + text + '</p>' + btn + '</div></div>';
  }

  function render() {
    var el = V.el;
    if (!el) return;
    var html;
    if (V.status === 'out') html = loginView();
    else if (!V.live) {
      html = V.status === 'error'
        ? messageView('Can’t load', esc(V.err), '<button class="btn btn--solid" data-refresh>Try again</button>' + '<button class="hb-out" data-signout>Sign out</button>')
        : messageView('Loading…', 'Fetching from Huckleberry', '');
    } else {
      html = '<div class="hb">' + topbar() + '<div class="hb-grid">' + sleepCard() + feedCard() + diaperCard() + solidsCard() + actCard() + '</div></div>';
    }
    // keep typed text if we re-render the login form mid-typing
    el.innerHTML = html;
  }

  // ------------------------------------------------------------ data flow
  function fail(e) {
    V.busy = false;
    if (e && e.auth) { V.status = 'out'; V.loginErr = H.errorText(e); V.live = V.hist = null; render(); return; }
    V.err = H.errorText(e);
    if (!V.live) V.status = 'error';
    render();
  }
  function refresh(full) {
    if (V.busy || !H.signedIn()) return;
    V.busy = true;
    V.tryAt = Date.now();
    var kids = V.kids.length ? Promise.resolve(V.kids) : H.children();
    kids.then(function (list) {
      V.kids = list;
      if (!list.length) throw new Error('No children on this Huckleberry account');
      var saved = null;
      try { saved = localStorage.getItem(CKEY); } catch (e) { /* ignore */ }
      if (!V.cid || !list.some(function (k) { return k.cid === V.cid; })) {
        V.cid = list.some(function (k) { return k.cid === saved; }) ? saved : list[0].cid;
      }
      var cid = V.cid, needHist = full || !V.hist || Date.now() - V.histAt > HIST_EVERY * 1000;
      return Promise.all([H.live(cid), needHist ? H.history(cid) : null]).then(function (r) {
        if (cid !== V.cid) return; // switched child while loading
        V.live = r[0];
        V.liveAt = Date.now();
        if (r[1]) { V.hist = r[1]; V.histAt = Date.now(); }
        V.err = ''; V.status = 'ready'; V.busy = false;
        render();
      });
    }).catch(fail);
  }
  function boot() {
    if (!H.signedIn()) { V.status = 'out'; render(); return; }
    V.status = 'loading';
    render();
    refresh(true);
  }

  // ------------------------------------------------------------ per-second upkeep (no rebuilds)
  function tick() {
    if (!V.active || !V.el) return;
    App.$$('[data-clock]', V.el).forEach(function (n) { n.textContent = clock(nowS() - +n.dataset.clock); });
    App.$$('[data-ago]', V.el).forEach(function (n) { var t = dur(nowS() - +n.dataset.ago); if (n.textContent !== t) n.textContent = t; });
    var s = V.el.querySelector('[data-synced]');
    if (s) s.textContent = synced();
    if (V.status === 'ready' && !V.busy) {
      if (Date.now() - V.tryAt >= LIVE_EVERY * 1000) refresh(false);
    }
  }

  // ------------------------------------------------------------ events
  function bind(el) {
    el.addEventListener('submit', function (e) {
      var f = e.target.closest('[data-login]');
      if (!f) return;
      e.preventDefault();
      if (V.submitting) return;
      var email = f.elements.email.value.trim(), pw = f.elements.password.value;
      if (!email || !pw) { V.loginErr = 'Enter your email and password.'; render(); return; }
      V.submitting = true; V.loginErr = '';
      render();
      H.signIn(email, pw).then(function () {
        V.submitting = false; V.kids = []; V.cid = null; V.live = V.hist = null;
        boot();
      }, function (err) {
        V.submitting = false; V.loginErr = H.errorText(err);
        render();
      });
    });
    el.addEventListener('click', function (e) {
      var t = e.target.closest('[data-refresh],[data-signout],[data-child]');
      if (!t) return;
      if (t.hasAttribute('data-signout')) {
        H.signOut();
        V.kids = []; V.cid = null; V.live = V.hist = null; V.status = 'out'; V.loginErr = ''; V.err = '';
        render();
      } else if (t.hasAttribute('data-child')) {
        V.cid = t.dataset.child; V.live = V.hist = null; V.status = 'loading';
        try { localStorage.setItem(CKEY, V.cid); } catch (x) { /* ignore */ }
        V.busy = false;
        render();
        refresh(true);
      } else {
        V.err = '';
        refresh(true);
      }
    });
  }

  App.register('huckleberry', {
    show: function (el) {
      V.active = true;
      if (!V.el) { V.el = el; bind(el); }
      if (V.status === 'init') boot();
      else {
        render();
        if (V.status === 'ready' && Date.now() - V.liveAt > LIVE_EVERY * 1000) refresh(false);
      }
    },
    resume: function () {
      V.active = true;
      if (V.status === 'ready' && Date.now() - V.liveAt > LIVE_EVERY * 1000) refresh(false);
    },
    hide: function () { V.active = false; }
  });
  App.on('second', tick);
})();
