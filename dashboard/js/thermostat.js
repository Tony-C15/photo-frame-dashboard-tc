// Thermostat rendering (Kitchen Table "Thermostat"): the full card and the compact pill, as HTML strings
// from DATA.climate (js/nest.js). Plumbing lives elsewhere: js/nest.js loads the device, js/views/control.js
// sends changes. Temperatures are °C inside DATA.climate and shown through App.deg() in the thermostat's own scale.
(function () {
  'use strict';
  var D = window.DATA;
  var T = App.thermostat = {};
  var LOW = 9, HIGH = 32; // the range the controls clamp to (js/views/control.js)

  var ACT = {
    heating: { icon: 'flame', word: 'Heating', tone: 'heat' },
    cooling: { icon: 'snowflake', word: 'Cooling', tone: 'cool' },
    idle: { icon: 'check', word: 'Idle', tone: 'idle' },
    eco: { icon: 'leaf', word: 'Eco', tone: 'eco' },
    off: { icon: 'power', word: 'Off', tone: 'off' }
  };
  var MODES = [['heat', 'Heat'], ['cool', 'Cool'], ['auto', 'Heat·Cool'], ['off', 'Off']];

  function num(c) { return String(App.deg(c)); }
  function fmt(c) { return num(c) + '°'; }
  function fmtRange(a, b) { return num(a) + '–' + fmt(b); }

  // What the thermostat is doing now. The device reports it (hvac); only guess from the temperatures if it doesn't.
  function activity(c, mode, set, heat, cool) {
    if (mode === 'off') return 'off';
    if (c.hvac) return c.hvac === 'HEATING' ? 'heating' : c.hvac === 'COOLING' ? 'cooling' : 'idle';
    if (mode === 'heat') return c.current < set - 0.25 ? 'heating' : 'idle';
    if (mode === 'cool') return c.current > set + 0.25 ? 'cooling' : 'idle';
    return c.current < heat - 0.25 ? 'heating' : c.current > cool + 0.25 ? 'cooling' : 'idle';
  }

  function view(c) {
    var mode = c.mode, eco = !!c.eco && mode !== 'off';
    var set = c.set, heat = c.heat != null ? c.heat : c.set, cool = c.cool != null ? c.cool : c.set;
    var act = activity(c, mode, set, heat, cool);
    return { c: c, mode: mode, eco: eco, set: set, heat: heat, cool: cool, act: act,
      status: mode === 'off' ? 'off' : eco && act === 'idle' ? 'eco' : act };
  }

  // 270° dial: angles in degrees clockwise from 12 o'clock, -135 … +135
  function dial(v, mini) {
    var size = 240, mid = size / 2, r = 104;
    function ang(t) { return -135 + Math.max(0, Math.min(1, (t - LOW) / (HIGH - LOW))) * 270; }
    function pt(a) { var rad = a * Math.PI / 180; return [mid + r * Math.sin(rad), mid - r * Math.cos(rad)]; }
    function arc(a1, a2) {
      if (a2 < a1) { var t = a1; a1 = a2; a2 = t; }
      var p1 = pt(a1), p2 = pt(a2);
      return 'M' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + (a2 - a1 > 180 ? 1 : 0) + ' 1 ' + p2[0].toFixed(2) + ' ' + p2[1].toFixed(2);
    }
    var cur = v.c.current, out = '<path class="kt-dial-track" d="' + arc(-135, 135) + '"/>', handles = [];
    if (v.mode === 'auto') {
      out += '<path class="kt-dial-range" d="' + arc(ang(v.heat), ang(v.cool)) + '"/>';
      handles = [[v.heat, 'heat'], [v.cool, 'cool']];
    } else if (v.mode !== 'off' && !v.eco) handles = [[v.mode === 'cool' ? v.cool : v.heat, v.mode === 'cool' ? 'cool' : 'heat']];
    if (v.mode !== 'off' && !v.eco) {
      if (v.act === 'heating') out += '<path class="kt-dial-active is-heat" d="' + arc(ang(cur), ang(v.mode === 'auto' ? v.heat : v.set)) + '"/>';
      if (v.act === 'cooling') out += '<path class="kt-dial-active is-cool" d="' + arc(ang(cur), ang(v.mode === 'auto' ? v.cool : v.set)) + '"/>';
    }
    var p = pt(ang(cur));
    out += '<circle class="kt-dial-current" cx="' + p[0].toFixed(2) + '" cy="' + p[1].toFixed(2) + '" r="' + (mini ? 13 : 6) + '"/>';
    handles.forEach(function (h) {
      var q = pt(ang(h[0]));
      out += '<circle class="kt-dial-handle is-' + h[1] + '" cx="' + q[0].toFixed(2) + '" cy="' + q[1].toFixed(2) + '" r="' + (mini ? 22 : 12) + '"/>';
    });
    return '<svg class="kt-dial-svg' + (mini ? ' is-mini' : '') + '" viewBox="0 0 ' + size + ' ' + size + '" aria-hidden="true">' + out + '</svg>';
  }

  function chip(status, extra) {
    var a = ACT[status];
    return '<span class="kt-tstat-chip is-' + a.tone + '">' + App.icon(a.icon, 18) + a.word + '</span>';
  }

  function stepper(v, which, word) {
    return '<div class="kt-tstat-stepper">' +
      '<button class="kt-iconbtn kt-iconbtn-outline" data-temp="-1" data-which="' + which + '" aria-label="Lower ' + word.toLowerCase() + ' temperature">' + App.icon('minus', 24) + '</button>' +
      '<span class="kt-tstat-stepper-val is-' + (which === 'cool' ? 'cool' : 'heat') + '">' + word + ' ' + fmt(v[which]) + '</span>' +
      '<button class="kt-iconbtn kt-iconbtn-outline" data-temp="1" data-which="' + which + '" aria-label="Raise ' + word.toLowerCase() + ' temperature">' + App.icon('plus', 24) + '</button></div>';
  }

  // fanText(f) is the existing "12 min left" wording from the control view
  T.card = function (fanText) {
    var c = D.climate, v = view(c), activeNow = v.act === 'heating' || v.act === 'cooling';
    var label, big, bigRange = false;
    if (v.mode === 'off') { label = 'Thermostat'; big = 'Off'; }
    else if (v.eco) { label = App.icon('leaf', 18) + 'Eco'; big = 'Eco'; }
    else if (v.mode === 'auto') { label = v.act === 'heating' ? 'Heating · keep' : v.act === 'cooling' ? 'Cooling · keep' : 'Keep between'; big = fmtRange(v.heat, v.cool); bigRange = true; }
    else if (v.mode === 'cool') { label = v.act === 'cooling' ? 'Cooling to' : 'Cool set to'; big = fmt(v.set); }
    else { label = v.act === 'heating' ? 'Heating to' : 'Heat set to'; big = fmt(v.set); }
    var labelTone = v.eco ? 'eco' : activeNow ? ACT[v.act].tone : 'muted';
    var canAdjust = v.mode !== 'off' && !v.eco;

    var modes = MODES.filter(function (m) { return !c.modes || c.modes.indexOf(m[0]) > -1; });
    var fanOn = c.fan && c.fan.on;

    return '<section class="kt-tstat is-' + ACT[v.status].tone + '" aria-label="' + App.esc(c.room || 'Thermostat') + ' thermostat">' +
      '<header class="kt-tstat-head"><h3 class="kt-tstat-room">' + App.esc(c.room || 'Thermostat') + (c.online === false ? '<small> · offline</small>' : '') + '</h3>' +
        '<div class="kt-tstat-chips">' + (fanOn ? '<span class="kt-tstat-chip is-fan">' + App.icon('fan', 18) + 'Fan</span>' : '') + chip(v.status) + '</div></header>' +
      '<div class="kt-dial">' + dial(v) +
        '<div class="kt-dial-center" aria-live="polite"><span class="kt-dial-label is-' + labelTone + '">' + label + '</span>' +
          '<span class="kt-dial-big' + (bigRange ? ' is-range' : '') + (v.mode === 'off' ? ' is-off' : '') + '">' + big + '</span>' +
          '<span class="kt-dial-sub">Inside ' + fmt(c.current) + '</span></div>' +
        (canAdjust && v.mode !== 'auto' ? '<div class="kt-dial-buttons">' +
          '<button class="kt-iconbtn kt-iconbtn-outline" data-temp="-1" aria-label="Lower temperature">' + App.icon('minus', 24) + '</button>' +
          '<button class="kt-iconbtn kt-iconbtn-outline" data-temp="1" aria-label="Raise temperature">' + App.icon('plus', 24) + '</button></div>' : '') +
      '</div>' +
      (canAdjust && v.mode === 'auto' ? '<div class="kt-tstat-steppers">' + stepper(v, 'heat', 'Heat') + stepper(v, 'cool', 'Cool') + '</div>' : '') +
      (c.humidity != null ? '<div class="kt-tstat-readings"><span>' + App.icon('droplet', 16) + Math.round(c.humidity) + '% humidity</span></div>' : '') +
      '<div class="kt-tstat-row kt-tstat-row--mode"><span class="kt-tstat-row-label">Mode</span><div class="kt-tstat-row-controls">' +
        '<div class="kt-seg" role="radiogroup" aria-label="Mode">' + modes.map(function (m) {
          return '<button type="button" role="radio" aria-checked="' + (c.mode === m[0]) + '" class="kt-seg-btn' + (c.mode === m[0] ? ' is-on' : '') + '" data-tmode="' + m[0] + '">' + m[1] + '</button>';
        }).join('') + '</div>' +
        '<button type="button" class="kt-eco-btn' + (v.eco ? ' is-on' : '') + '" data-eco aria-pressed="' + v.eco + '"' + (c.mode === 'off' ? ' disabled' : '') + ' aria-label="Eco">' + App.icon('leaf', 22) + '</button></div></div>' +
      (c.fan ? '<div class="kt-tstat-row"><span class="kt-tstat-row-label">' + App.icon('fan', 18) + 'Fan</span><div class="kt-tstat-row-controls">' +
        '<div class="kt-seg" role="radiogroup" aria-label="Fan">' +
          '<button type="button" role="radio" aria-checked="' + !fanOn + '" class="kt-seg-btn' + (fanOn ? '' : ' is-on') + '" data-fanoff>Auto</button>' +
          '<button type="button" role="radio" aria-checked="' + !!fanOn + '" class="kt-seg-btn' + (fanOn ? ' is-on' : '') + '" data-fan>On</button></div>' +
        '<span class="kt-tstat-fan-text">' + (fanOn ? 'Running' + (c.fan.until ? ' · ' + fanText(c.fan) : '') : 'Runs with heating and cooling') + '</span></div></div>' : '') +
      '</section>';
  };

  // The at-a-glance tile: read-only, one button that goes to the Home tab, where the full card is.
  // Not shown: the Eco range, "ready in" time and schedule — the device data this app loads doesn't include them.
  T.tile = function () {
    var c = D.climate, v = view(c), a = ACT[v.status];
    var target = v.mode === 'off' || v.eco ? null : v.mode === 'auto' ? fmtRange(v.heat, v.cool) : fmt(v.mode === 'cool' ? v.cool : v.heat);
    var line;
    if (v.mode === 'off') line = 'Thermostat off';
    else if (v.act === 'heating') line = 'Heating to <b>' + target + '</b>';
    else if (v.act === 'cooling') line = 'Cooling to <b>' + target + '</b>';
    else if (v.eco) line = 'Eco';
    else if (v.mode === 'auto') line = 'Keeping <b>' + target + '</b>';
    else line = 'Set to <b>' + target + '</b>';
    var extras = (c.fan && c.fan.on ? '<span>' + App.icon('fan', 16, 'kt-spin') + 'Fan on</span>' : '');
    return '<button type="button" class="kt-ttile is-' + a.tone + '" data-thermo aria-label="' + App.esc(c.room || 'Thermostat') + ': ' + fmt(c.current) + ' inside, ' +
      (v.status === 'off' ? 'off' : a.word.toLowerCase() + (target ? ', set to ' + target : '')) + '. Open thermostat">' +
      '<div class="kt-ttile-head"><span class="kt-ttile-room">' + App.esc(c.room || 'Thermostat') + '</span>' + chip(v.status) + '</div>' +
      '<div class="kt-ttile-body"><div class="kt-ttile-main"><span class="kt-ttile-now">' + fmt(c.current) + '</span><span class="kt-ttile-line">' + line + '</span></div>' +
        '<div class="kt-ttile-dial" aria-hidden="true">' + dial(v, true) + App.icon(a.icon, 22, 'kt-ttile-dial-icon') + '</div></div>' +
      (extras ? '<div class="kt-ttile-extras">' + extras + '</div>' : '') + '</button>';
  };

  // The small pill (for a header bar; nothing in the app uses it right now): "19° › 21.5°" with the activity icon and colour. Tapping it opens the full card (the Home tab).
  T.compact = function () {
    var c = D.climate, v = view(c), a = ACT[v.status];
    var target = v.mode === 'off' ? null : v.eco ? 'Eco' : v.mode === 'auto' ? fmtRange(v.heat, v.cool) : fmt(v.set);
    return '<button type="button" class="kt-tstat-compact is-' + a.tone + '" data-go="control" aria-label="' + App.esc(c.room || 'Thermostat') + ': ' + fmt(c.current) + ' inside, ' +
      (v.status === 'off' ? 'off' : a.word.toLowerCase() + (target ? ', set to ' + target : '')) + '">' +
      App.icon(a.icon, 22) + '<span class="kt-tstat-compact-now">' + fmt(c.current) + '</span>' +
      '<span class="kt-tstat-compact-target">' + (target ? App.icon('chevron-right', 14) + target : 'Off') + '</span></button>' +
      (c.fan && c.fan.on ? '<span class="kt-tstat-chip is-fan">' + App.icon('fan', 18) + 'Fan</span>' : '');
  };
})();
