// Live calendar: loads the events from the sources configured on the server (Google, iCloud, ICS links —
// see server/calendar.js). There is no demo data: if nothing is connected the calendar is empty, and a
// banner says why, so an empty calendar is never mistaken for a quiet day.
(function () {
  'use strict';
  var D = window.DATA;
  var EVERY = 10 * 60 * 1000;
  var warned = false;

  function localDate(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); } // all-day: local midnight, no UTC shift
  function toEvent(e) {
    return {
      id: e.id, title: e.title, allDay: e.allDay,
      start: e.allDay ? localDate(e.start) : new Date(e.start),
      end: e.allDay ? localDate(e.end) : new Date(e.end),
      people: e.people || D.ALL, loc: e.loc, notes: e.notes, color: e.color, cal: e.cal
    };
  }

  function warn(sub) {
    if (warned) return;
    warned = true;
    App.banner({ tone: 'amber', icon: 'calendar', title: 'Calendar isn’t connected', sub: sub, dismiss: 'OK' });
  }

  function load() {
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var from = new Date(+today - 14 * 864e5), to = new Date(+today + 45 * 864e5);
    return fetch('/api/calendar?from=' + from.toISOString() + '&to=' + to.toISOString())
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.configured) return warn('No calendar is set up on the server');
        if (d.errors && d.errors.length) console.warn('Calendar sources failed:', d.errors);
        if (d.errors && d.errors.length === (d.sources || []).length) return warn('Every calendar failed to load'); // keep what we had
        D.events.length = 0;
        d.events.forEach(function (e) { D.events.push(toEvent(e)); });
        warned = false;
        App.emit('data');
        App.rerender();
      })
      .catch(function () { warn('Couldn’t reach the server'); });
  }

  App.on('ready', function () { load(); setInterval(load, EVERY); });
})();
