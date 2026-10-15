// Live weather: the forecast comes from the dashboard's own server (/api/weather → Open-Meteo), so the frame
// never talks to a third-party HTTPS host. No demo data: until it loads, or if it fails, the Today page and
// idle screen say the weather isn't available.
(function () {
  'use strict';
  var W = window.DATA.weather;
  var EVERY = 20 * 60 * 1000, RETRY = 60 * 1000;

  function done(ok) {
    App.emit('data');
    setTimeout(load, ok ? EVERY : RETRY);
  }
  function load() {
    fetch('/api/weather').then(function (r) { return r.json(); }).then(function (d) {
      if (d.error || !d.hours) { W.error = d.error || 'no data'; return done(false); }
      W.hours = d.hours; W.days = d.days; W.place = d.place; W.lat = d.lat; W.lon = d.lon;
      W.skew = d.now - Date.now(); // so the right hour is shown even if the frame's clock is off
      W.live = true; W.error = '';
      done(true);
    }).catch(function () { W.error = 'server unreachable'; done(false); });
  }
  App.on('ready', load);
})();
