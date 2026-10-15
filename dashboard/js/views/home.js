// Home / Today: the glanceable overview. Never scrolls.
(function () {
  'use strict';
  var D = window.DATA, V = {};

  function clock() {
    var n = App.now();
    return '<div class="h-time num">' + App.fmt.time(n, false) + '<span class="h-ampm">' + App.fmt.ampm(n) + '</span></div>' +
      '<div class="h-date"><b>' + App.fmt.day(n) + '</b> ' + App.fmt.month(n) + ' ' + n.getDate() + '</div>';
  }

  function weather() {
    var w = App.weatherNow();
    if (!w) {
      var err = D.weather.error;
      return '<div class="label">Weather</div><p class="h-w-note">' + (err ? 'Weather unavailable · ' + App.esc(err) : 'Loading…') + '</p>';
    }
    var days = App.daily(7);
    return '<div class="h-wx-top">' +
      '<span class="h-wx-icon">' + App.icon(w.cond, 60) + '</span>' +
      '<span class="h-wx-temp num">' + w.temp + '°</span>' +
      '<span class="h-wx-meta"><b>' + w.label + '</b><span>H ' + w.hi + '°  L ' + w.lo + '°</span></span>' +
      '</div>' +
      '<div class="h-wx-say"><b>' + w.summary + '.</b> ' + w.advice + '.</div>' +
      '<div class="h-wx-hours">' + days.map(function (d) {
        return '<div class="h-hr' + (d.p >= 50 ? ' is-wet' : '') + '"><span class="h-hr-l">' + d.label + '</span>' +
          '<span class="h-hr-i">' + App.icon(d.c, 24) + '</span><b>' + d.hi + '°</b><span class="h-hr-lo">' + d.lo + '°</span></div>';
      }).join('') + '</div>';
  }

  // ------------------------------------------------------------ bath night (from Huckleberry; every 3 days)
  var BATH_EVERY = 3;
  var B = { at: null, status: 'init', busy: false, tried: 0, cid: null }; // status: init | out | ready | error
  function bathDays() {
    var now = new Date(Date.now() + (window.Huck ? window.Huck.skew : 0));
    return Math.max(0, Math.round((App.dayStart(now) - App.dayStart(new Date(B.at * 1000))) / 864e5));
  }
  function bath() {
    var head = '<div class="h-bath-h"><span class="label">Bath night</span>' + App.icon('bath', 52) + '</div>';
    if (!window.Huck || !window.Huck.signedIn()) return head + '<p class="h-w-note">Huckleberry isn’t connected</p>';
    if (B.status === 'error' && B.at == null) return head + '<p class="h-w-note">Can’t reach Huckleberry</p>';
    if (B.status !== 'ready') return head + '<p class="h-w-note">Loading…</p>';
    if (B.at == null) return head + '<p class="h-w-note">No bath logged yet</p>';
    var d = bathDays(), left = BATH_EVERY - d;
    var next = App.addDays(App.dayStart(new Date(B.at * 1000)), BATH_EVERY);
    var tone = left < 0 ? ' is-over' : left === 0 ? ' is-due' : '';
    var line = left > 0 ? left === 1 ? 'Due tomorrow' : 'Due ' + App.fmt.dayShort(next) + ' · ' + left + ' days'
      : left === 0 ? 'Bath night today' : 'Overdue by ' + -left + (left === -1 ? ' day' : ' days');
    var pips = '';
    for (var i = 0; i < BATH_EVERY; i++) pips += '<i' + (i < d ? ' class="on"' : '') + '></i>';
    return '<div class="h-bath-in' + tone + '">' + head +
      '<div class="h-bath-big serif">' + (d === 0 ? 'Today' : d === 1 ? 'Yesterday' : d + ' days ago') + '</div>' +
      '<div class="h-bath-line"><span class="h-bath-pips">' + pips + '</span>' + line + '</div></div>';
  }
  function loadBath() {
    var H = window.Huck;
    if (!H || !H.signedIn() || B.busy) return paintBath();
    B.busy = true; B.tried = Date.now();
    var kid = B.cid ? Promise.resolve(B.cid) : H.children().then(function (list) {
      var saved = null;
      try { saved = localStorage.getItem('hb.child'); } catch (e) { /* ignore */ }
      if (!list.length) throw new Error('No children');
      return (list.filter(function (k) { return k.cid === saved; })[0] || list[0]).cid;
    });
    kid.then(function (cid) { B.cid = cid; return H.lastBath(cid); }).then(function (at) {
      B.at = at; B.status = 'ready'; B.busy = false; paintBath();
    }).catch(function () { B.status = 'error'; B.busy = false; paintBath(); });
  }
  // The whole card lights up (soft green) on bath night, i.e. when the bath is due today or overdue.
  function setBath(el) {
    el.innerHTML = bath();
    el.classList.toggle('is-lit', !!el.querySelector('.h-bath-in.is-due, .h-bath-in.is-over'));
  }
  function paintBath() { if (V.el && V.el.firstChild) setBath(V.el.querySelector('.h-bath')); }

  function hero() {
    var e = App.nextEvent(), now = App.now();
    if (!e) {
      var tomorrow = App.timedOn(App.addDays(now, 1))[0];
      return '<div class="h-hero h-hero--empty" data-go="calendar">' +
        '<div class="label label--light">Rest of today</div>' +
        '<div class="h-hero-title serif">Nothing else scheduled.<br><i>Enjoy the quiet.</i></div>' +
        (tomorrow ? '<div class="h-hero-meta">Tomorrow starts with <b>' + App.esc(tomorrow.title) + '</b> at ' + App.fmt.time(tomorrow.start) + '</div>' : '') +
        '</div>';
    }
    var p = App.evColor(e);
    var mins = (e.start - now) / 60000;
    var leave = (App.leaveBy(e) - now) / 60000;
    var big = mins < 100
      ? '<div class="h-hero-count num">' + Math.round(mins) + '<small>min</small></div>'
      : '<div class="h-hero-count num">' + App.fmt.time(e.start, false) + '<small>' + App.fmt.ampm(e.start) + '</small></div>';
    var leavePill = '';
    if (e.travel) {
      leavePill = leave <= 0
        ? '<span class="pill pill--alert"><i class="pulse"></i>Leave now</span>'
        : '<span class="pill' + (leave <= 15 ? ' pill--soon' : '') + '">' + App.icon('car', 20) + 'Leave in ' + App.fmt.mins(leave) + '</span>';
    }
    return '<button class="h-hero" style="' + App.pstyle(p) + '" data-ev="' + e.id + '">' +
      '<div class="h-hero-main">' +
      '  <div class="label label--on">Next up</div>' +
      '  <div class="h-hero-title serif">' + App.esc(e.title) + '</div>' +
      '  <div class="h-hero-meta">' + App.fmt.range(e.start, e.end) + (e.loc ? ' · ' + App.esc(e.loc) : '') + '</div>' +
      '  <div class="h-hero-foot">' + leavePill + '</div>' +
      '</div>' + big + '</button>';
  }

  function lanes() {
    var now = App.now();
    var allDay = App.allDayOn(now), adShown = allDay.slice(0, 3), adMore = allDay.length - adShown.length;
    var list = App.timedOn(now).filter(function (e) { return e.end > now; });
    var room = allDay.length ? 4 : 6; // the all-day row takes the space of two timed events
    var shown = list.slice(0, list.length > room ? room - 1 : room), more = list.length - shown.length;
    var ad = '<div class="label h-up-h">All day</div>' + (allDay.length
      ? '<div class="h-allday">' + adShown.map(function (e) {
        return '<button class="h-ad" data-ev="' + e.id + '" style="' + App.pstyle(App.evColor(e)) + '">' + App.esc(e.title) + '</button>';
      }).join('') + (adMore > 0 ? '<button class="h-more" data-go="calendar">+' + adMore + ' more</button>' : '') + '</div>'
      : '<div class="h-free">Nothing all day</div>');
    return ad + '<div class="label h-up-h">Coming up today</div>' +
      (list.length ? '<div class="h-up">' + shown.map(function (e) {
        var cur = e.start <= now;
        return '<button class="h-ev' + (cur ? ' is-now' : '') + '" data-ev="' + e.id + '" style="' + App.pstyle(App.evColor(e)) + '">' +
          '<span class="h-ev-t">' + (cur ? 'Now' : App.fmt.time(e.start, false)) + '</span>' +
          '<span class="h-ev-n">' + App.esc(e.title) + '</span></button>';
      }).join('') + (more > 0 ? '<button class="h-more" data-go="calendar">+' + more + ' more</button>' : '') + '</div>'
        : '<div class="h-free serif">Nothing else planned today</div>');
  }

  // ------------------------------------------------------------ curbside collection (City of Toronto)
  var W = { data: null, error: '' };
  // [key, label, picture, accent colour, rgb]
  var BINS = [
    ['garbage', 'Garbage', '/bins/garbage.png', '#3B3934', '59 57 52'],
    ['recycling', 'Recycling', '/bins/recycling.png', '#1F6FEB', '31 111 235'],
    ['greenBin', 'Green bin', '/bins/green-bin.png', '#2E9E4F', '46 158 79'],
    ['yardWaste', 'Yard waste', '/bins/yard-waste.png', '#8C5A2B', '140 90 43'],
    ['christmasTree', 'Tree', null, '#C0392B', '192 57 43']
  ];
  function localISO(d) { return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' + (d.getDate() < 10 ? '0' : '') + d.getDate(); }
  function isoToDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function daysFromToday(d) { return Math.round((App.dayStart(d) - App.dayStart(App.now())) / 864e5); }
  function when(d) {
    var diff = daysFromToday(d);
    return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : App.fmt.dayShort(d);
  }
  // first pickup of a stream on/after `from` (ISO date), optionally no later than `to`
  function pickupIn(list, from, to) {
    for (var i = 0; i < (list || []).length; i++) if (list[i] >= from && (!to || list[i] <= to)) return isoToDate(list[i]);
    return null;
  }
  function waste() {
    var d = W.data;
    if (!d) return '<div class="label">Collection</div><p class="h-w-note">' + (W.error ? 'Schedule unavailable · ' + App.esc(W.error) : 'Loading…') + '</p>';
    if (!d.configured) return '<div class="label">Collection</div><p class="h-w-note">Not set up yet</p>';
    var now = App.now(), today = localISO(now);
    var sunday = localISO(App.addDays(App.dayStart(now), (7 - now.getDay()) % 7)); // end of this Monday–Sunday week
    // only what's still to come this week (today counts)
    var items = BINS.map(function (b) { return { b: b, date: pickupIn(d.pickups[b[0]], today, sunday) }; })
      .filter(function (x) { return x.date; })
      .sort(function (x, y) { return x.date - y.date; });
    var head = '<div class="label">Collection · ' + App.esc(d.calendar.replace(/(\d)$/, ' · wk $1')) + '</div>';
    if (!items.length) {
      var up = BINS.map(function (b) { return { b: b, date: pickupIn(d.pickups[b[0]], today) }; })
        .filter(function (x) { return x.date; }).sort(function (x, y) { return x.date - y.date; })[0];
      return head + '<p class="h-w-note"><b>Nothing else this week.</b>' + (up ? ' Next: ' + up.b[1] + ' · ' + App.fmt.dayShort(up.date) + ' ' + App.fmt.monthShort(up.date) + ' ' + up.date.getDate() + '.' : ' No more pickups listed for ' + d.years[d.years.length - 1] + ' — next year’s schedule isn’t published yet.') + '</p>';
    }
    return head + '<div class="h-bins" style="--n:' + items.length + '">' + items.map(function (x) {
      var soon = daysFromToday(x.date) <= 1;
      return '<div class="h-bin' + (soon ? ' is-soon' : '') + '" style="--c:' + x.b[3] + ';--c-rgb:' + x.b[4] + '">' +
        (x.b[2] ? '<img src="' + x.b[2] + '" alt="">' : '<span class="h-bin-e">🎄</span>') +
        '<b>' + when(x.date) + '</b><span>' + x.b[1] + ' · ' + App.fmt.monthShort(x.date) + ' ' + x.date.getDate() + '</span></div>';
    }).join('') + '</div>';
  }
  function loadWaste() {
    fetch('/api/waste').then(function (r) { return r.json(); }).then(function (d) {
      W.data = d.error ? (W.data || null) : d; W.error = d.error || '';
      if (V.el && V.el.firstChild) V.el.querySelector('.h-waste').innerHTML = waste();
    }).catch(function () { W.error = 'server unreachable'; if (V.el && V.el.firstChild && !W.data) V.el.querySelector('.h-waste').innerHTML = waste(); });
  }

  // ------------------------------------------------------------ time to clinic (Mapbox traffic; only updates when tapped)
  var C = { data: null, busy: false, error: '', off: false };
  // minutes vs the usual time for that hour -> the note under the time and its colour
  function clinicNote(c) {
    var diff = c.typical ? c.minutes - c.typical : null;
    return {
      tone: diff == null ? '' : diff >= Math.max(5, c.typical * 0.25) ? ' is-slow' : diff <= 1 ? ' is-clear' : '',
      text: diff == null ? c.km + ' km' : diff >= 2 ? '+' + diff + ' min vs usual' : diff <= -2 ? -diff + ' min faster than usual' : 'Normal traffic'
    };
  }
  function clinic() {
    var d = C.data;
    var go = '<span class="h-cl-go' + (C.busy ? ' is-busy' : '') + '">' + App.icon('refresh', 26) + '</span>';
    var head = function (up) { return '<div class="h-cl-head"><div class="label">' + App.icon('car', 18) + 'Time to clinic</div>' + (up ? '<span class="h-cl-up">' + up + '</span>' : '') + go + '</div>'; };
    var note = function (t) { return '<p class="h-w-note h-cl-msg">' + t + '</p>'; };
    if (C.off) return '<div class="h-cl-head"><div class="label">' + App.icon('car', 18) + 'Time to clinic</div></div>' + note('Not set up yet');
    if (!d) return head('') + note(C.busy ? 'Checking traffic…' : C.error ? 'Couldn’t check · ' + App.esc(C.error) : 'Tap to check traffic');
    var up = C.busy ? 'Checking…' : C.error ? 'Couldn’t refresh' : 'Updated ' + App.fmt.time(new Date(d.at + D.weather.skew));
    return head(up) + '<div class="h-cl-rows">' + d.clinics.map(function (c) {
      if (c.error) return '<div class="h-cl-row"><div class="h-cl-who"><b>' + App.esc(c.name) + '</b><span class="h-cl-note">Couldn’t check</span></div></div>';
      var n = clinicNote(c);
      return '<div class="h-cl-row"><div class="h-cl-who"><b>' + App.esc(c.name) + '</b><span class="h-cl-note' + n.tone + '">' + n.text + (c.km ? ' · ' + c.km + ' km' : '') + '</span></div>' +
        '<div class="h-cl-time"><b class="serif">' + c.minutes + '</b> min</div></div>';
    }).join('') + '</div>';
  }
  function paintClinic() { if (V.el && V.el.firstChild) V.el.querySelector('.h-clinic').innerHTML = clinic(); }
  function loadClinic() {
    if (C.busy) return;
    C.busy = true; C.error = ''; paintClinic();
    fetch('/api/clinic').then(function (r) { return r.json(); }).then(function (d) {
      if (d.configured === false) { C.off = true; return; }
      if (d.error) { C.error = d.error; return; }
      C.data = d; C.off = false;
    }).catch(function () { C.error = 'server unreachable'; }).then(function () { C.busy = false; paintClinic(); });
  }

  function shopping() {
    var S = D.shop;
    if (!S.live) return '<div class="label">Shopping</div><div class="h-st-row is-muted"><span>' +
      (S.off ? 'Shopping list not connected' : S.error ? 'Can’t reach the list' : 'Loading…') + '</span></div>';
    var open = D.groceries.filter(function (g) { return !g.done; });
    var recent = open.slice(-3).reverse();
    return '<div class="label">Shopping</div>' +
      '<div class="h-stat"><span class="num">' + open.length + '</span><small>items to get</small></div>' +
      '<ul class="h-recent">' + recent.map(function (g) {
        return '<li><i></i>' + App.esc(g.name) + '</li>';
      }).join('') + '</ul>';
  }

  // Thermostat card: the temperature is the point; below it, what the thermostat is doing (no "inside").
  function status() {
    var c = D.climate;
    if (!c.live) return '<div class="label">Home</div><div class="h-st-row is-muted"><span>Thermostat not connected</span></div>';
    var state = c.mode === 'off' ? ['Off', ''] : c.eco ? ['Eco', ''] :
      c.hvac === 'HEATING' ? ['Heating', ' is-heat'] : c.hvac === 'COOLING' ? ['Cooling', ' is-cool'] : ['Holding', ''];
    var pills = '<span class="h-st-pill' + state[1] + '">' + state[0] + '</span>' +
      (c.fan && c.fan.on ? '<span class="h-st-pill is-fan">' + App.icon('fan', 16) + 'Fan on</span>' : '');
    return '<div class="label">Home</div>' +
      '<div class="h-st-row">' + App.icon('thermo', 32) + '<b class="h-st-temp">' + App.deg(c.current) + '°</b></div>' +
      '<div class="h-st-pills">' + pills + '</div>';
  }

  function paint() {
    var el = V.el;
    el.querySelector('.h-clock').innerHTML = clock();
    el.querySelector('.h-weather').innerHTML = weather();
    setBath(el.querySelector('.h-bath'));
    el.querySelector('.h-hero-slot').innerHTML = hero();
    el.querySelector('.h-lanes').innerHTML = lanes();
    el.querySelector('.h-waste').innerHTML = waste();
    el.querySelector('.h-shop').innerHTML = shopping();
    el.querySelector('.h-clinic').innerHTML = clinic();
    var st = el.querySelector('.h-status');
    st.innerHTML = status();
    // The whole card takes the colour of what the thermostat is doing, so heating / cooling reads from across the room.
    st.classList.toggle('is-heating', !!st.querySelector('.h-st-pill.is-heat'));
    st.classList.toggle('is-cooling', !!st.querySelector('.h-st-pill.is-cool'));
  }

  App.register('home', {
    show: function (el) {
      V.el = el;
      if (!el.firstChild) {
        el.innerHTML = '<div class="home">' +
          '<div class="h-clock" data-go="calendar"></div>' +
          '<div class="h-weather" data-go="weather"></div>' +
          '<div class="h-bath"></div>' +
          '<div class="h-main"><div class="h-hero-slot"></div><div class="h-low"><div class="h-lanes"></div>' +
          '  <div class="h-pair"><button class="h-shop card" data-go="shopping"></button><button class="h-status card" data-go="control"></button></div></div></div>' +
          '<div class="h-side">' +
          '  <div class="h-waste card"></div>' +
          '  <button class="h-clinic card" data-clinic></button>' +
          '</div></div>';
        el.addEventListener('click', function (e) {
          var ev = e.target.closest('[data-ev]');
          if (ev) { App.eventSheet(App.findEvent(ev.dataset.ev)); return; }
          if (e.target.closest('[data-clinic]')) { loadClinic(); return; }
          var g = e.target.closest('[data-go]');
          if (g) App.go(g.dataset.go);
        });
      }
      paint();
      if (Date.now() - B.tried > 5 * 60 * 1000) loadBath();
      if (!V.wasteTimer) { loadWaste(); V.wasteTimer = setInterval(loadWaste, 6 * 3600 * 1000); }
    }
  });
  // Every minute: just the clock and next-up countdown (cheap, even while hidden). Weather on the hour.
  App.on('minute', function (n) {
    if (!V.el || !V.el.firstChild) return;
    V.el.querySelector('.h-clock').innerHTML = clock();
    V.el.querySelector('.h-hero-slot').innerHTML = hero();
    paintBath();
    if (n.getMinutes() % 10 === 0 && Date.now() - B.tried > 5 * 60 * 1000) loadBath();
    if (n.getMinutes() === 0) { V.el.querySelector('.h-waste').innerHTML = waste(); V.el.querySelector('.h-weather').innerHTML = weather(); V.el.querySelector('.h-lanes').innerHTML = lanes(); }
  });
  App.on('data', function () { if (App.current === 'home') paint(); });
})();
