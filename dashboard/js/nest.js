// Google Nest: the real thermostat and cameras (server/nest.js). If Nest isn't connected the Home tab
// says so — there is no demo thermostat or camera.
(function () {
  'use strict';
  var D = window.DATA;
  var N = App.nest = { configured: false, devices: [], scale: 'CELSIUS', thermo: null };
  var EVERY = 60 * 1000;
  var MODE = { HEAT: 'heat', COOL: 'cool', HEATCOOL: 'auto', OFF: 'off' };

  // Temperatures arrive in °C. Show them in the scale the thermostat itself uses.
  App.deg = function (c) {
    if (!N.thermo) return c;
    return N.scale === 'FAHRENHEIT' ? Math.round(c * 9 / 5 + 32) : Math.round(c * 10) / 10;
  };
  N.toC = function (shown) { return N.scale === 'FAHRENHEIT' ? Math.round((shown - 32) * 5 / 9 * 100) / 100 : shown; };
  N.step = function () { return N.scale === 'FAHRENHEIT' ? 1 : 0.5; };

  N.command = function (device, command, params) {
    return fetch('/api/nest/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Frame-App': '1' },
      body: JSON.stringify({ device: device, command: command, params: params || {} })
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'request failed'); return j.results || {}; });
    });
  };

  function apply(t) {
    var c = D.climate;
    if (N.dirty) { c.current = t.currentC; c.humidity = t.humidity; c.hvac = t.hvac; return; } // don't overwrite a change still waiting to be sent
    c.live = true; c.id = t.id; c.room = t.room || t.name; c.online = t.online;
    c.current = t.currentC; c.humidity = t.humidity;
    c.mode = MODE[t.mode] || 'off'; c.modes = (t.modes || []).map(function (m) { return MODE[m]; });
    c.eco = t.eco; c.hvac = t.hvac; c.heat = t.heatC; c.cool = t.coolC;
    c.set = c.mode === 'cool' ? t.coolC : t.heatC != null ? t.heatC : t.coolC;
  }

  N.load = function (fresh) {
    return fetch('/api/nest/devices' + (fresh ? '?fresh=1' : '')).then(function (r) { return r.json(); }).then(function (d) {
      N.error = d.error || '';
      if (!d.configured) { if (N.error) App.emit('nest'); return; }
      N.configured = true; N.devices = d.devices;
      var t = d.devices.filter(function (x) { return x.kind === 'thermostat'; })[0];
      if (t) { N.thermo = t; N.scale = t.scale; apply(t); }
      N.cameras = d.devices.filter(function (x) { return x.kind === 'camera' || x.kind === 'doorbell'; });
      App.emit('nest');
      App.emit('data');
    }).catch(function () { N.error = 'unreachable'; });
  };

  App.on('ready', function () { N.load(); setInterval(function () { N.load(); }, EVERY); });
})();
