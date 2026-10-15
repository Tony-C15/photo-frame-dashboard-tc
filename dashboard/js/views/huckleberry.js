// Huckleberry: live baby-tracker data — running timers, last feed / sleep / diaper, solid foods and the allergen schedule.
// Display only. Data comes from js/huckleberry.js; sign-in happens on the frame (token kept in localStorage).
(function () {
  'use strict';
  var H = window.Huck;
  var V = {
    el: null, active: false, status: 'init', // init | out | loading | ready | error
    kids: [], cid: null, live: null, hist: null,
    err: '', loginErr: '', busy: false, liveAt: 0, histAt: 0, ever: null, everAt: 0, tryAt: 0, submitting: false
  };
  var CKEY = 'hb.child';
  var LIVE_EVERY = 30, HIST_EVERY = 300; // seconds

  // How each reaction is shown. (Plain Unicode 6.0 emoji — fine on the frame's Android 6 emoji font.)
  var REACTIONS = {
    LOVED: { e: '😍', label: 'Loved it' }, MEH: { e: '😑', label: 'Meh' },
    HATED: { e: '😖', label: 'Hated it' }, ALLERGIC: { e: '😡', label: 'Allergy or sensitivity' }
  };
  function emoji(r) { return r ? '<span class="hb-e" role="img" aria-label="' + REACTIONS[r].label + '">' + REACTIONS[r].e + '</span>' : ''; }
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
  // The common baby allergens, matched on the food's name (Huckleberry has no allergen field on a logged
  // food, so this is a keyword match — e.g. "yogurt" counts as milk). `skip` removes look-alikes first
  // ("peanut butter" is not dairy, "coconut milk" is not milk, "rice noodles" are not wheat).
  var ALLERGENS = [
    { k: 'milk', label: 'Milk', re: /\b(milk|yogh?urt|cheese|cheddar|mozzarella|parmesan|ricotta|cream|butter|kefir|custard|dairy|paneer|ghee|whey)\b/i, skip: /\b(coconut|almond|oat|soy|rice|cashew|nut|peanut|seed|apple|cocoa)\s+(milk|butter)\b|\bbutternut\b/ig },
    { k: 'egg', label: 'Egg', re: /\b(eggs?|omelet+e?|frittata|mayo|mayonnaise|meringue|quiche)\b/i },
    { k: 'peanut', label: 'Peanut', re: /\b(peanuts?|groundnuts?)\b/i },
    { k: 'wheat', label: 'Wheat', re: /\b(wheat|bread|toast|pasta|noodles?|spaghetti|macaroni|couscous|flour|pancakes?|waffles?|muffins?|biscuits?|bagels?|tortillas?|udon|ramen|cookies?|cake|pizza|baguette|croissant)\b/i, skip: /\b(rice|glass|mung|sweet potato)\s+noodles?\b/ig },
    { k: 'soy', label: 'Soy', re: /\b(soy|soya|soybeans?|tofu|edamame|miso|tempeh|natto)\b/i },
    { k: 'fish', label: 'Fish', re: /\b(fish|salmon|tuna|cod|tilapia|trout|halibut|sardines?|anchov(y|ies)|mackerel|haddock|snapper|pollock|herring|swordfish|mahi)\b/i },
    { k: 'shellfish', label: 'Shellfish', re: /\b(shrimps?|prawns?|crab|lobster|scallops?|clams?|oysters?|mussels?|shellfish|crawfish|crayfish|squid|octopus)\b/i },
    { k: 'sesame', label: 'Sesame', re: /\b(sesame|tahini|hummus|hummous)\b/i },
    // tree nuts, one by one (a generic "mixed nuts" / "nut butter" lands under Other nuts)
    { k: 'almond', label: 'Almond', nut: true, re: /\balmonds?\b/i },
    { k: 'cashew', label: 'Cashew', nut: true, re: /\bcashews?\b/i },
    { k: 'walnut', label: 'Walnut', nut: true, re: /\bwalnuts?\b/i },
    { k: 'pecan', label: 'Pecan', nut: true, re: /\bpecans?\b/i },
    { k: 'pistachio', label: 'Pistachio', nut: true, re: /\bpistachios?\b/i },
    { k: 'hazelnut', label: 'Hazelnut', nut: true, re: /\b(hazelnuts?|nutella|filberts?)\b/i },
    { k: 'macadamia', label: 'Macadamia', nut: true, re: /\bmacadamias?\b/i },
    { k: 'othernut', label: 'Other nuts', nut: true, re: /\b(brazil nuts?|pine nuts?|chestnuts?|tree nuts?|nut butter|mixed nuts|nuts)\b/i, skip: /\b(pea|ground|coco|butter|dough|wal|hazel|pista)nuts?\b|\bpeanut\b/ig }
  ];
  function hasAllergen(a, name) {
    var n = a.skip ? name.replace(a.skip, ' ') : name;
    return a.re.test(n);
  }
  // Solids meals, newest first. All-time when we have it; otherwise just the last 30 days (and we say so).
  function solidsMeals() {
    var src = V.ever || ((V.hist && V.hist.feed) || []).filter(function (e) { return e.mode === 'solids'; });
    return src.slice().sort(function (a, b) { return b.start - a.start; });
  }
  // Paused allergens are skipped everywhere: never "overdue", never suggested. Kept in this device's
  // localStorage, per child (Huckleberry has nowhere to store it).
  function pausedSet() {
    if (V._pcid !== V.cid) {
      V._pcid = V.cid;
      try { V._paused = JSON.parse(localStorage.getItem('hb.paused.' + V.cid) || '[]'); } catch (e) { V._paused = []; }
    }
    return V._paused;
  }
  function isPaused(k) { return pausedSet().indexOf(k) > -1; }
  function setPaused(k, on) {
    var list = pausedSet().filter(function (x) { return x !== k; });
    if (on) list.push(k);
    V._paused = list;
    try { localStorage.setItem('hb.paused.' + V.cid, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  var GOAL = 2; // servings of each introduced allergen per rolling 7 days
  function allergenModel() {
    var meals = solidsMeals(), weekAgo = nowS() - 7 * 86400;
    return ALLERGENS.map(function (a) {
      var x = { a: a, count7: 0 };
      meals.forEach(function (m) { // newest first
        var hit = foodNames(m.foods).filter(function (n) { return hasAllergen(a, n); });
        if (!hit.length) return;
        if (x.start == null) { x.start = m.start; x.food = hit[0]; }
        if (m.start >= weekAgo) x.count7++;
        x.total = (x.total || 0) + 1;
        x.first = m.start; // ends up as the oldest
      });
      x.paused = isPaused(a.k);
      x.due = !x.paused && x.start != null && x.count7 < GOAL; // only foods already introduced can be "overdue"
      return x;
    });
  }

  // What to serve next: first anything introduced but behind this week (most behind first); otherwise the next
  // allergen not tried yet, in the usual order of introduction. Also warns if one was only just introduced.
  var ORDER = ['peanut', 'egg', 'milk', 'wheat', 'soy', 'sesame', 'fish', 'shellfish', 'almond', 'cashew', 'walnut', 'hazelnut', 'pistachio', 'pecan', 'macadamia', 'othernut'];
  function nextUp(model) {
    var due = model.filter(function (x) { return x.due; }).sort(function (a, b) { return a.count7 - b.count7 || a.start - b.start; });
    var never = model.filter(function (x) { return x.start == null && !x.paused; }).sort(function (a, b) { return ORDER.indexOf(a.a.k) - ORDER.indexOf(b.a.k); });
    var justStarted = model.filter(function (x) { return !x.paused && x.first != null && x.first >= nowS() - 3 * 86400; });
    return { paused: model.filter(function (x) { return x.paused; }), due: due, never: never, pick: due[0] || never[0] || null, fromDue: !!due[0], justStarted: justStarted[0] || null };
  }

  function foodsModel() {
    var meals = ((V.hist && V.hist.feed) || []).filter(function (e) { return e.mode === 'solids'; });
    return { today: today(meals) };
  }
  // "Today", "Yesterday", "5d ago", "3w ago", "4mo ago" — by calendar day, not 24-hour blocks. Short so it fits the tile.
  function daysAgo(sec) {
    var d = Math.round((dayStartS() - (function () { var x = new Date(sec * 1000); x.setHours(0, 0, 0, 0); return x.getTime() / 1000; })()) / 86400);
    if (d <= 0) return 'Today';
    if (d === 1) return 'Yesterday';
    if (d < 14) return d + 'd ago';
    if (d < 70) return Math.round(d / 7) + 'w ago';
    return Math.round(d / 30) + 'mo ago';
  }

  // ------------------------------------------------------------ rendering
  function card(cls, c, rgb, ink, inner, on) {
    return '<section class="hb-card ' + cls + (on ? ' is-live' : '') + '">' + inner + '</section>';
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
      head('bottle', 'Feeding', badge) + '<div class="hb-big">' + main + '</div><p class="hb-sub">' + sub + '</p>' +
      '<footer class="hb-foot">' + stat(m.count, 'feeds today') + stat(m.counts.solids, 'solids') + '</footer>', m.on);
  }
  function diaperCard() {
    var m = diaperModel(), main, sub;
    if (m.last) {
      main = '<span class="num">' + ago(m.last.start) + '</span>';
      sub = 'Last change · ' + at(m.last.start) + (m.last.mode ? ' · ' + m.last.mode : '');
    } else { main = '<span class="num">—</span>'; sub = 'No diapers logged yet'; }
    return card('hb-diaper', '#00A36C', '0 163 108', '#FFFFFF',
      head('diaper', 'Diapers') + '<div class="hb-big">' + main + '</div><p class="hb-sub">' + sub + '</p>' +
      '<footer class="hb-foot">' + stat(m.pee, 'pee') + stat(m.poo, 'poo') + stat(m.count, 'today') + '</footer>', false);
  }

  function solidsCard() {
    var F = foodsModel();
    var meals = F.today.length ? F.today.map(function (e) {
      var r = reactionOf(e), names = foodNames(e.foods);
      return '<li><span class="hb-t">' + at(e.start) + '</span><span class="hb-meal">' + (names.length ? esc(names.join(', ')) : 'Solids') + '</span>' +
        (r ? '<span class="hb-rx">' + emoji(r) + '</span>' : '') + '</li>';
    }).join('') : '<li class="hb-empty">No solids logged today</li>';
    function tile(x) {
      var data = ' data-al="' + x.a.k + '"';
      if (x.paused) {
        return '<li class="hb-al hb-al--paused"' + data + '><span class="hb-al-n">' + x.a.label + '</span><b class="hb-al-v">Paused</b>' +
          (x.start != null ? '<span class="hb-al-s">last ' + daysAgo(x.start).toLowerCase() + '</span>' : '') + '</li>';
      }
      return x.start == null
        ? '<li class="hb-al hb-al--none"' + data + '><span class="hb-al-n">' + x.a.label + '</span><b class="hb-al-v">Not yet</b></li>'
        : '<li class="hb-al' + (x.due ? ' hb-al--due' : '') + '"' + data + '><span class="hb-al-n">' + x.a.label + '<i class="hb-al-c">' + x.count7 + '/' + GOAL + '</i></span><b class="hb-al-v">' + daysAgo(x.start) + '</b><span class="hb-al-s">' + esc(x.food) + '</span></li>';
    }
    var model = allergenModel();
    var al = model.filter(function (x) { return !x.a.nut; }).map(tile).join('') +
      '<li class="hb-al-group">Tree nuts</li>' + model.filter(function (x) { return x.a.nut; }).map(tile).join('');
    return card('hb-solids', '#E4007C', '228 0 124', '#FFFFFF',
      head('utensils', 'Solid foods') +
      '<div class="hb-solids-body"><div class="hb-col"><div class="label">Today · ' + F.today.length + ' meal' + (F.today.length === 1 ? '' : 's') + '</div><ul class="hb-meals">' + meals + '</ul></div>' +
      '<div class="hb-col"><div class="label">Common allergens · last had · <span class="hb-key">amber = under ' + GOAL + '× in 7 days</span>' + (V.ever ? '' : ' · last 30 days only') + '</div><ul class="hb-allergens">' + al + '</ul></div></div>', false);
  }
  function openAllergenSheet(k) {
    var x = allergenModel().filter(function (m) { return m.a.k === k; })[0];
    if (!x) return;
    function date(sec) { var d = new Date(sec * 1000); return App.fmt.monthShort(d) + ' ' + d.getDate(); }
    var rows = x.start == null
      ? '<p class="sheet-p">Never logged in Huckleberry.</p>'
      : '<div class="al-facts">' +
        '<div><small>Last had</small><b>' + daysAgo(x.start) + '</b><span>' + date(x.start) + ' · ' + esc(x.food) + '</span></div>' +
        '<div><small>Last 7 days</small><b>' + x.count7 + ' of ' + GOAL + '</b><span>' + (x.paused ? 'paused' : x.due ? 'behind' : 'on track') + '</span></div>' +
        '<div><small>All time</small><b>' + x.total + ' meal' + (x.total === 1 ? '' : 's') + '</b><span>first ' + date(x.first) + '</span></div></div>';
    App.sheet('<div class="sheet-pad"><div class="label">Allergen' + (x.paused ? ' · paused' : '') + '</div><h2 class="serif sheet-h">' + esc(x.a.label) + '</h2>' + rows +
      '<p class="sheet-p">' + (x.paused ? 'Paused allergens aren’t flagged as overdue and won’t be suggested.' : 'Pausing stops it being flagged as overdue and from being suggested next.') + '</p>' +
      '<div class="sheet-actions"><button class="btn ' + (x.paused ? 'btn--solid' : 'btn--ghost') + '" data-alpause>' + (x.paused ? 'Resume ' : 'Pause ') + esc(x.a.label) + '</button></div></div>', {
      onMount: function (sheet, close) {
        sheet.querySelector('[data-alpause]').addEventListener('click', function () { setPaused(k, !x.paused); close(); render(); });
      }
    });
  }

  function nextCard() {
    var model = allergenModel(), n = nextUp(model), p = n.pick, body;
    if (!p) {
      body = '<div class="hb-next-pick"><small>All caught up</small><b>Nothing overdue</b><p>Every allergen has been had ' + GOAL + '× this week.</p></div>';
    } else {
      var reason = n.fromDue
        ? 'Last had ' + daysAgo(p.start).toLowerCase() + ' · ' + p.count7 + '/' + GOAL + ' this week'
        : 'Not introduced yet';
      body = '<div class="hb-next-pick"><small>Serve next</small><b>' + esc(p.a.label) + '</b><p>' + reason + '</p></div>';
      if (!n.fromDue && n.justStarted) body += '<p class="hb-wait">' + esc(n.justStarted.a.label) + ' was only just introduced (' + daysAgo(n.justStarted.first).toLowerCase() + '). Waiting a couple of days before the next new one is usual.</p>';
    }
    var others = n.due.filter(function (x) { return x !== p; });
    if (others.length) {
      body += '<div class="label">Also behind this week</div><ul class="hb-due">' + others.map(function (x) {
        return '<li><b>' + esc(x.a.label) + '</b><span>' + daysAgo(x.start) + ' · ' + x.count7 + '/' + GOAL + '</span></li>';
      }).join('') + '</ul>';
    }
    var rest = n.never.filter(function (x) { return x !== p; });
    if (rest.length) body += '<div class="label">Not introduced yet</div><p class="hb-never">' + rest.map(function (x) { return esc(x.a.label); }).join(', ') + '</p>';
    if (n.paused.length) body += '<div class="label">Paused · not suggested</div><p class="hb-never">' + n.paused.map(function (x) { return esc(x.a.label); }).join(', ') + '</p>';
    body += '<p class="hb-note">One new allergen at a time — check with your pediatrician.</p>';
    return card('hb-next', '#00A36C', '0 163 108', '#FFFFFF', head('star', 'Next allergen') + '<div class="hb-next-body">' + body + '</div>', false);
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
      html = '<div class="hb">' + topbar() + '<div class="hb-grid">' + sleepCard() + feedCard() + diaperCard() + solidsCard() + nextCard() + '</div></div>';
    }
    // keep typed text if we re-render the login form mid-typing
    var keep = {};
    ['.hb-allergens', '.hb-meals'].forEach(function (sel) { var n = el.querySelector(sel); if (n) keep[sel] = n.scrollTop; });
    el.innerHTML = html;
    Object.keys(keep).forEach(function (sel) { var n = el.querySelector(sel); if (n) n.scrollTop = keep[sel]; });
  }

  // ------------------------------------------------------------ data flow
  function fail(e) {
    V.busy = false;
    if (e && e.auth) { V.status = 'out'; V.loginErr = H.errorText(e); V.live = V.hist = V.ever = null; render(); return; }
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
      var needEver = !V.ever || Date.now() - V.everAt > 30 * 60 * 1000;
      return Promise.all([H.live(cid), needHist ? H.history(cid) : null, needEver ? H.solidsEver(cid).catch(function () { return null; }) : null]).then(function (r) {
        if (cid !== V.cid) return; // switched child while loading
        V.live = r[0];
        V.liveAt = Date.now();
        if (r[1]) { V.hist = r[1]; V.histAt = Date.now(); }
        if (r[2]) { V.ever = r[2]; V.everAt = Date.now(); }
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
        V.submitting = false; V.kids = []; V.cid = null; V.live = V.hist = V.ever = null;
        boot();
      }, function (err) {
        V.submitting = false; V.loginErr = H.errorText(err);
        render();
      });
    });
    el.addEventListener('click', function (e) {
      var al = e.target.closest('[data-al]');
      if (al) return openAllergenSheet(al.dataset.al);
      var t = e.target.closest('[data-refresh],[data-signout],[data-child]');
      if (!t) return;
      if (t.hasAttribute('data-signout')) {
        H.signOut();
        V.kids = []; V.cid = null; V.live = V.hist = V.ever = null; V.status = 'out'; V.loginErr = ''; V.err = '';
        render();
      } else if (t.hasAttribute('data-child')) {
        V.cid = t.dataset.child; V.live = V.hist = V.ever = null; V.status = 'loading';
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
