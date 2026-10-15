// GO Transit departures. The planned timetable is a small file built from Metrolinx's GTFS feed
// (public/transit/schedule.json, see server/transit-build.mjs); live predictions come from our own server
// (/api/transit → Metrolinx Open Data), so the frame never talks to a third-party HTTPS host. No demo data:
// no stations chosen, no timetable, or no live key are all said on the page instead of invented.
(function () {
  'use strict';
  var T = window.Transit = { schedule: null, error: '', live: { configured: null, stops: {}, error: '' }, skew: 0 };
  var SCHED_EVERY = 6 * 60 * 60 * 1000, LIVE_EVERY = 60 * 1000, RETRY = 30 * 1000;
  var liveTimer = null, watching = false;

  function now() { return Date.now() + T.skew; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayKey(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  // "2026-10-15 17:42:00" (Toronto local) -> ms
  function parse(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::(\d\d))?/.exec(s || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime() : 0;
  }

  // ---- timetable
  function loadSchedule() {
    fetch('/transit/schedule.json').then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (s) {
      T.schedule = s; T.error = '';
      App.emit('data'); startLive();
      setTimeout(loadSchedule, SCHED_EVERY);
    }).catch(function (e) { T.error = 'timetable missing (' + e.message + ')'; App.emit('data'); setTimeout(loadSchedule, RETRY * 4); });
  }

  // ---- live (only while the Transit tab is open)
  function codes() { return T.schedule ? T.schedule.stations.map(function (s) { return s.code; }) : []; }
  function pollLive() {
    clearTimeout(liveTimer);
    var c = codes();
    if (!watching || !c.length || T.live.configured === false) return;
    fetch('/api/transit?stops=' + c.join(',')).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error && !d.stops) throw new Error(d.error);
      T.live.configured = d.configured !== false;
      T.live.stops = d.stops || {}; T.live.error = d.error || '';
      if (d.now) T.skew = d.now - Date.now();
      liveTimer = setTimeout(pollLive, LIVE_EVERY);
      App.emit('data');
    }).catch(function (e) { T.live.error = e.message || 'server unreachable'; liveTimer = setTimeout(pollLive, RETRY); App.emit('data'); });
  }
  function startLive() { if (watching) pollLive(); }
  T.watch = function (on) { watching = on; if (on) pollLive(); else clearTimeout(liveTimer); };

  // ---- board: the next departures at one station: [{ ts, planned, line, head, num, late, status, platform }]
  T.board = function (st, max) {
    var t = now(), today = new Date(t), prev = new Date(t); prev.setDate(prev.getDate() - 1);
    var midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    var liveRows = (T.live.stops[st.code] && T.live.stops[st.code].departures) || [];
    var liveBy = {};
    liveRows.forEach(function (l) { liveBy[l.trip] = l; });
    var out = [], seen = {};
    function add(planned, line, head, num) {
      var l = liveBy[num], ts = planned, late = 0, status = '', platform = '';
      if (l) {
        var p = parse(l.live);
        if (p) { ts = p; late = Math.round((p - planned) / 60000); }
        status = l.status; platform = l.platform;
        seen[num] = true;
      }
      if (ts < t - 60000) return;
      out.push({ ts: ts, planned: planned, line: line, head: head, num: num, late: late, status: status, platform: platform, live: !!l });
    }
    [[prev, -86400], [today, 0]].forEach(function (x) {
      var key = dayKey(x[0]);
      st.patterns.forEach(function (p) {
        if (p.dates.indexOf(key) < 0) return;
        p.deps.forEach(function (d) { add(midnight + (x[1] === 0 ? 0 : -86400000) + d[0] * 1000, d[1], d[2], d[3]); });
      });
    });
    // Tomorrow, so late evening isn't empty
    if (out.length < max) {
      var tm = new Date(today); tm.setDate(tm.getDate() + 1);
      var key2 = dayKey(tm), start = new Date(tm.getFullYear(), tm.getMonth(), tm.getDate()).getTime();
      st.patterns.forEach(function (p) { if (p.dates.indexOf(key2) > -1) p.deps.forEach(function (d) { add(start + d[0] * 1000, d[1], d[2], d[3]); }); });
    }
    // Live trains the timetable doesn't know about (e.g. an added service)
    var lineOk = {}; (T.schedule.lines || []).forEach(function (l) { lineOk[l.code] = true; });
    liveRows.forEach(function (l) {
      if (seen[l.trip] || !lineOk[l.line]) return;
      var p = parse(l.live) || parse(l.sched);
      if (p >= t - 60000) out.push({ ts: p, planned: parse(l.sched) || p, line: l.line, head: l.dir, num: l.trip, late: 0, status: l.status, platform: l.platform, live: true });
    });
    out.sort(function (a, b) { return a.ts - b.ts; });
    return out.slice(0, max);
  };
  T.now = now;
  T.lineColor = function (code) {
    var c = (T.schedule.lines || []).filter(function (l) { return l.code === code; })[0];
    return c ? c.color : '#5b6776';
  };
  T.lineName = function (code) {
    var c = (T.schedule.lines || []).filter(function (l) { return l.code === code; })[0];
    return c ? c.name : code;
  };

  App.on('ready', loadSchedule);
})();
