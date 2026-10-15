// Home: what is actually connected — thermostat and cameras (Google Nest), speakers (Cast), smart plugs
// (Tuya). Nothing here is placeholder data: if a service isn't connected the tab says so.
(function () {
  'use strict';
  var D = window.DATA;
  var V = { el: null };
  var TY = { configured: false, list: [], error: '', busy: {} }; // smart plugs (server/tuya.js)
  var SP = { list: [], sel: null, at: 0, tick: 0, timer: null, vol: {}, sheet: null }; // real speakers (server/cast.js)
  try { SP.sel = localStorage.getItem('hc.spk'); } catch (e) { /* ignore */ }

  // ------------------------------------------------------------ thermostat
  function verb(c) {
    if (c.mode === 'off') return 'Off';
    if (c.eco) return 'Eco';
    if (c.live && c.hvac) return c.hvac === 'HEATING' ? 'Heating' : c.hvac === 'COOLING' ? 'Cooling' : 'Holding';
    return c.set > c.current ? 'Heating' : c.set < c.current ? 'Cooling' : 'Holding';
  }
  function setText(c) {
    if (c.live && c.mode === 'auto' && c.cool != null && c.heat != null) return App.deg(c.heat) + '–' + App.deg(c.cool);
    var v = App.deg(c.set);
    return c.live ? String(v) : v.toFixed(1).replace('.0', '');
  }
  function climate() {
    var c = D.climate;
    if (!c.live) return '<div class="label label--light">Climate</div><div class="th-none"><b>' + (App.nest.error === 'rate limited' ? 'Nest is busy' : 'Thermostat not connected') + '</b><span>' + (App.nest.error === 'rate limited' ? 'Google is rate-limiting requests. Retrying in a minute.' : 'Nest isn’t reachable. Check the server and the Nest setup.') + '</span></div>';
    var v = verb(c), modes = [['heat', 'Heat'], ['cool', 'Cool'], ['auto', 'Auto'], ['off', 'Off']].filter(function (m) { return !c.live || !c.modes || c.modes.indexOf(m[0]) > -1; });
    return '<div class="label label--light">Climate · ' + App.esc(c.room || 'Main floor') + (c.live && c.online === false ? ' · offline' : '') + '</div>' +
      '<div class="th-main"><button class="th-btn" data-temp="-1" aria-label="Cooler">' + App.icon('minus', 36) + '</button>' +
      '<div class="th-set"><span class="num' + (c.eco ? '' : setText(c).length >= 5 ? ' th-range' : setText(c).length === 4 ? ' th-mid' : '') + '">' + (c.eco ? 'Eco' : setText(c) + '°') + '</span><small>' + (c.mode === 'auto' && c.live ? 'Heat – cool' : 'Set to') + '</small></div>' +
      '<button class="th-btn" data-temp="1" aria-label="Warmer">' + App.icon('plus', 36) + '</button></div>' +
      '<div class="th-now"><span><b class="num">' + App.deg(c.current) + '°</b> inside</span><span class="th-verb th-verb--' + v.toLowerCase() + '">' + v + '</span><span><b class="num">' + c.humidity + '%</b> humidity</span></div>' +
      '<div class="seg">' + modes.map(function (m) {
        return '<button class="' + (c.mode === m[0] ? 'is-on' : '') + '" data-tmode="' + m[0] + '">' + m[1] + '</button>';
      }).join('') + '</div>' +
      (c.fan ? '<button class="th-fan' + (c.fan.on ? ' is-on' : '') + '" data-fan>' + App.icon('fan', 22) + '<span>Fan</span><b>' + fanText(c.fan) + '</b></button>' : '');
  }

  // ------------------------------------------------------------ cameras (Nest)
  // ------------------------------------------------------------ fan (timer only — all the Nest API offers)
  var FAN_OPTIONS = [[15, '15 min'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [480, '8 hours'], [720, '12 hours']];
  function fanText(f) {
    if (!f.on) return 'Off';
    var mins = f.until ? Math.max(1, Math.ceil((f.until - Date.now()) / 60000)) : 0;
    if (!mins) return 'On';
    return (mins >= 60 ? Math.floor(mins / 60) + ' h ' + (mins % 60 ? mins % 60 + ' min' : '') : mins + ' min') + ' left';
  }
  function setFan(on, minutes) {
    var c = D.climate;
    if (!c.live || !c.fan) return;
    c.fan = { on: on, until: on ? Date.now() + minutes * 60000 : 0 };
    paintPart('.hc-climate', climate());
    App.nest.command(c.id, 'sdm.devices.commands.Fan.SetTimer', on ? { timerMode: 'ON', duration: minutes * 60 + 's' } : { timerMode: 'OFF' })
      .then(function () { setTimeout(function () { App.nest.load(true); }, 3000); }, function (err) {
        App.toast(err.message === 'rate limited' ? 'Nest is rate-limiting changes · try again in a minute' : 'Couldn’t reach the thermostat', { tone: 'error', icon: 'bolt' });
        App.nest.load(true);
      });
  }
  function openFanSheet() {
    var f = D.climate.fan;
    if (!f) return;
    App.sheet('<div class="sheet-pad"><div class="label">Thermostat fan · ' + App.esc(D.climate.room || '') + '</div>' +
      '<h2 class="serif sheet-h">' + (f.on ? 'Fan is on · ' + fanText(f) : 'Run the fan for…') + '</h2>' +
      '<div class="fan-grid">' + FAN_OPTIONS.map(function (o) { return '<button class="fan-opt" data-fanmin="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</div>' +
      (f.on ? '<div class="sheet-actions"><button class="btn btn--solid" data-fanoff>Turn fan off</button></div>' : '') +
      '<p class="sheet-p">The fan runs for the time you pick, then stops. Google’s API doesn’t offer an “always on” setting.</p></div>', {
      onMount: function (sheet, close) {
        sheet.addEventListener('click', function (e) {
          var t = e.target.closest('button');
          if (!t) return;
          if (t.dataset.fanmin) { close(); setFan(true, +t.dataset.fanmin); }
          if (t.hasAttribute('data-fanoff')) { close(); setFan(false); }
        });
      }
    });
  }

  function cams() {
    var list = App.nest.configured ? (App.nest.cameras || []) : [];
    return '<section class="room"><div class="room-h"><h3 class="serif">Cameras</h3><span class="label">' + (list.length ? 'Tap for live view' : '') + '</span></div><div class="cams">' + (list.length ? list.slice(0, 4).map(function (c) {
      return '<button class="cam cam--nest' + (c.online ? '' : ' is-off') + '" data-ncam="' + c.id + '">' + App.icon(c.kind === 'doorbell' ? 'bell' : 'camera', 34) +
        '<span class="cam-name">' + App.esc(c.name) + '</span><span class="cam-age">' + (c.online ? 'Live view' : 'Offline') + '</span></button>';
    }).join('') : '<span class="cam-none">' + (App.nest.configured ? 'No cameras shared with this app' : 'Cameras not connected') + '</span>') + '</div></section>';
  }

  // ------------------------------------------------------------ speakers (Cast)
  function pct(v) { return Math.round((v || 0) * 100); }
  // The speaker you last picked; failing that, whichever is playing right now, else the first. The choice
  // is then kept, so pausing doesn't make the card jump to another speaker.
  function selected() {
    var s = SP.list.filter(function (x) { return x.id === SP.sel; })[0];
    if (!s) {
      s = SP.list.filter(function (x) { return x.media && x.media.state === 'PLAYING'; })[0] || SP.list[0];
      if (s) SP.sel = s.id;
    }
    return s;
  }
  function media() {
    if (!SP.list.length) return '<div class="np-empty"><b>No speakers found</b><span>Speakers are found over Wi-Fi, so this needs the dashboard to run on your home network.</span></div>';
    var s = selected(), m2 = s.media, playing = m2 && m2.state === 'PLAYING', live = m2 && m2.state !== 'IDLE';
    var tabs = '<div class="np-top">' + (SP.list.length > 1 ? '<div class="np-tabs">' + SP.list.map(function (x) {
      return '<button class="np-tab' + (x.id === s.id ? ' is-on' : '') + '" data-spk="' + x.id + '">' + App.esc(x.name.replace(/ speaker$/i, '')) + (x.media && x.media.state === 'PLAYING' ? '<i></i>' : '') + '</button>';
    }).join('') + '</div>' : '<b class="np-one">' + App.esc(s.name) + '</b>') +
      '<button class="np-gear" data-spk-settings aria-label="Speaker settings">' + App.icon('sliders', 22) + '</button></div>';
    if (s.error) return tabs + '<div class="np-empty"><b>Can’t reach ' + App.esc(s.name) + '</b><span>Is it powered on and on the same Wi-Fi?</span></div>';
    return tabs +
      '<div class="np-row">' + (m2 && m2.art ? '<img class="np-art" src="' + m2.art + '" alt="">' : '<span class="np-art np-art--none">' + App.icon('music', 28) + '</span>') +
      '<div class="np-text"><span class="label">' + App.esc(s.app || 'Idle') + '</span><b>' + App.esc(live && m2.title ? m2.title : 'Nothing playing') + '</b>' +
      '<span>' + App.esc(live ? m2.artist : s.name) + '</span></div></div>' +
      '<div class="np-prog"><i style="width:' + progress(s) + '%"></i></div>' +
      '<div class="np-ctl">' +
      '<button class="np-skip' + (live && m2.canPrev ? '' : ' is-off') + '" data-np="prev" aria-label="Previous">' + App.icon('prev', 28) + '</button>' +
      '<button class="np-btn' + (live ? '' : ' is-off') + '" data-np="toggle" aria-label="Play/Pause">' + App.icon(playing ? 'pause' : 'play', 30) + '</button>' +
      '<button class="np-skip' + (live && m2.canNext ? '' : ' is-off') + '" data-np="next" aria-label="Next">' + App.icon('next', 28) + '</button></div>' +
      '<div class="np-vol"><button class="np-v" data-vol="-1" aria-label="Quieter">' + App.icon('minus', 24) + '</button>' +
      '<div class="np-volbar"><i style="width:' + pct(s.volume) + '%"></i></div>' +
      '<button class="np-v" data-vol="1" aria-label="Louder">' + App.icon('plus', 24) + '</button><b class="num">' + volText(s) + '</b></div>';
  }
  function volText(s) { return s.muted ? 'Muted' : pct(s.volume) + '%'; }
  function progress(s) {
    var m = s.media;
    if (!m || !m.duration) return 0;
    var pos = m.position + (m.state === 'PLAYING' ? (Date.now() - SP.at) / 1000 * (m.rate || 1) : 0);
    return Math.max(0, Math.min(100, Math.round(pos / m.duration * 1000) / 10));
  }

  // ------------------------------------------------------------ real speakers
  function loadSpeakers() {
    return fetch('/api/cast/speakers').then(function (r) { return r.json(); }).then(function (d) {
      if (Object.keys(SP.vol).length) return; // don't jump the volume bar while a change is being sent
      SP.list = d.configured && d.speakers ? d.speakers : [];
      SP.at = Date.now();
      repaintMedia();
    }).catch(function () { /* no dev server / offline: keep what we have */ });
  }
  function repaintMedia() {
    if (!V.el) return;
    paintPart('.hc-media', media());
    if (SP.sheet) SP.sheet.innerHTML = sheetBody();
  }
  function speakerCmd(id, action, value) {
    return fetch('/api/cast/command', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Frame-App': '1' },
      body: JSON.stringify({ id: id, action: action, value: value })
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'failed'); }); });
  }
  function speakerAction(t) {
    var s = selected(), a = t.dataset.np, m = s && s.media;
    if (!s || !m || m.state === 'IDLE') return;
    if (a === 'toggle') {
      var play = m.state !== 'PLAYING';
      if (!play) m.position += (Date.now() - SP.at) / 1000 * (m.rate || 1); // freeze the progress bar where it is
      m.state = play ? 'PLAYING' : 'PAUSED'; SP.at = Date.now();
      repaintMedia();
      speakerCmd(s.id, play ? 'play' : 'pause').then(function () { setTimeout(loadSpeakers, 1200); }, function () {
        App.toast('Couldn’t reach <b>' + App.esc(s.name) + '</b>', { tone: 'error', icon: 'bolt' }); loadSpeakers();
      });
    } else {
      if (a === 'next' ? !m.canNext : !m.canPrev) return App.toast('This app can’t skip from here', { icon: 'music', ms: 2200 });
      speakerCmd(s.id, a).then(function () { setTimeout(loadSpeakers, 1500); }, function () {
        App.toast('Couldn’t skip on <b>' + App.esc(s.name) + '</b>', { tone: 'error', icon: 'bolt' });
      });
    }
  }
  // Set one speaker's volume (0–1). Updates the screen now, sends once the taps stop.
  function setVolume(s, level, quiet) {
    s.volume = Math.max(0, Math.min(1, Math.round(level * 100) / 100));
    if (s.muted) s.muted = false;
    paintVolume(s);
    clearTimeout(SP.vol[s.id]);
    SP.vol[s.id] = setTimeout(function () {
      speakerCmd(s.id, 'volume', s.volume).then(function () { delete SP.vol[s.id]; setTimeout(loadSpeakers, 800); }, function () {
        delete SP.vol[s.id];
        if (!quiet) App.toast('Couldn’t change the volume on <b>' + App.esc(s.name) + '</b>', { tone: 'error', icon: 'bolt' });
        loadSpeakers();
      });
    }, 350);
  }
  function paintVolume(s) {
    var sel = selected(), card = V.el && V.el.querySelector('.hc-media');
    if (card && sel && sel.id === s.id && card.querySelector('.np-volbar i')) {
      card.querySelector('.np-volbar i').style.width = pct(s.volume) + '%';
      card.querySelector('.np-vol .num').textContent = volText(s);
    }
    var row = SP.sheet && SP.sheet.querySelector('[data-row="' + s.id + '"]');
    if (row) {
      row.querySelector('.np-volbar i').style.width = pct(s.volume) + '%';
      row.querySelector('.num').textContent = volText(s);
      row.querySelector('[data-smute]').classList.toggle('is-on', !!s.muted);
    }
  }
  function speakerVolume(dir) {
    var s = selected();
    if (s && s.volume != null) setVolume(s, s.volume + dir * 0.05);
  }

  // ------------------------------------------------------------ speaker settings sheet
  function reachable() { return SP.list.filter(function (x) { return !x.error && x.volume != null; }); }
  function sheetBody() {
    var ref = selected(), playing = SP.list.filter(function (x) { return x.media && x.media.state === 'PLAYING'; });
    var others = reachable().filter(function (x) { return ref && x.id !== ref.id; });
    var rows = SP.list.map(function (x) {
      var sub = x.error ? 'Can’t reach this speaker' : x.media && x.media.state !== 'IDLE' ? (x.media.state === 'PLAYING' ? 'Playing' : 'Paused') + ' · ' + (x.media.title || x.app || '') : 'Idle';
      return '<div class="spk-row" data-row="' + x.id + '"><div class="spk-id"><b>' + App.esc(x.name) + '</b><span>' + App.esc(sub) + '</span></div>' +
        (x.error ? '' : '<div class="np-vol spk-vol"><button class="np-v" data-svol="-1" data-sid="' + x.id + '" aria-label="Quieter">' + App.icon('minus', 24) + '</button>' +
        '<div class="np-volbar"><i style="width:' + pct(x.volume) + '%"></i></div>' +
        '<button class="np-v" data-svol="1" data-sid="' + x.id + '" aria-label="Louder">' + App.icon('plus', 24) + '</button><b class="num">' + volText(x) + '</b></div>' +
        '<button class="spk-mute' + (x.muted ? ' is-on' : '') + '" data-smute data-sid="' + x.id + '">Mute</button>') + '</div>';
    }).join('');
    return '<div class="label">Speakers · each one separately</div><h2 class="serif sheet-h">Speaker settings</h2><div class="spk-list">' + rows + '</div>' +
      '<div class="sheet-actions">' +
      '<button class="btn btn--ghost' + (others.length ? '' : ' is-off') + '" data-spk-match>Match volumes' + (ref && others.length ? ' to ' + App.esc(ref.name.replace(/ speaker$/i, '')) + ' · ' + pct(ref.volume) + '%' : '') + '</button>' +
      '<button class="btn btn--solid' + (playing.length ? '' : ' is-off') + '" data-spk-pause>Pause all</button></div>';
  }
  function openSpeakerSheet() {
    if (!SP.list.length) return;
    App.sheet('<div class="sheet-pad spk-body"></div>', {
      cls: 'sheet--wide',
      onClose: function () { SP.sheet = null; },
      onMount: function (sheet) {
        SP.sheet = sheet.querySelector('.spk-body');
        SP.sheet.innerHTML = sheetBody();
        SP.sheet.addEventListener('click', function (e) {
          var t = e.target.closest('button');
          if (!t) return;
          var s = SP.list.filter(function (x) { return x.id === t.dataset.sid; })[0];
          if (t.dataset.svol && s) return setVolume(s, s.volume + +t.dataset.svol * 0.05);
          if (t.hasAttribute('data-smute') && s) {
            s.muted = !s.muted; paintVolume(s);
            return speakerCmd(s.id, 'mute', s.muted).then(function () { setTimeout(loadSpeakers, 800); }, function () {
              App.toast('Couldn’t reach <b>' + App.esc(s.name) + '</b>', { tone: 'error', icon: 'bolt' }); loadSpeakers();
            });
          }
          if (t.hasAttribute('data-spk-match')) return matchVolumes();
          if (t.hasAttribute('data-spk-pause')) return pauseAll();
        });
      }
    });
  }
  // Everyone else gets the selected speaker's volume.
  function matchVolumes() {
    var ref = selected(), others = reachable().filter(function (x) { return x.id !== ref.id; });
    if (!ref || !others.length) return;
    others.forEach(function (x) { setVolume(x, ref.volume, true); });
    App.toast('Matched ' + others.map(function (x) { return App.esc(x.name.replace(/ speaker$/i, '')); }).join(' + ') + ' to <b>' + pct(ref.volume) + '%</b>', { icon: 'music', ms: 2800 });
  }
  function pauseAll() {
    var playing = SP.list.filter(function (x) { return x.media && x.media.state === 'PLAYING'; });
    if (!playing.length) return;
    playing.forEach(function (x) {
      x.media.position += (Date.now() - SP.at) / 1000 * (x.media.rate || 1);
      x.media.state = 'PAUSED';
      speakerCmd(x.id, 'pause').catch(function () { App.toast('Couldn’t pause <b>' + App.esc(x.name) + '</b>', { tone: 'error', icon: 'bolt' }); });
    });
    SP.at = Date.now();
    repaintMedia();
    setTimeout(loadSpeakers, 1500);
    App.toast('Paused ' + playing.length + ' speaker' + (playing.length === 1 ? '' : 's'), { icon: 'pause', ms: 2500 });
  }
  function speakerTimer() {
    clearInterval(SP.timer);
    SP.tick = 0;
    loadSpeakers();
    loadPlugs();
    SP.timer = setInterval(function () {
      var s = SP.list.length && selected();
      if (s) { var bar = V.el.querySelector('.np-prog i'); if (bar) bar.style.width = progress(s) + '%'; }
      if (++SP.tick % 10 === 0) loadSpeakers();
      if (SP.tick % 20 === 0) loadPlugs();
    }, 1000);
  }

  // ------------------------------------------------------------ smart plugs (Tuya)
  function plugTile(d) {
    var off = !d.online || !d.switchCode, pend = TY.busy[d.id];
    return '<button class="tile tile--light' + (d.on && !off ? ' is-on' : '') + (off ? ' is-offline' : '') + '" data-plug="' + d.id + '" style="--lvl:' + (d.on && !off ? 100 : 0) + '%"' + (off ? ' disabled' : '') + '>' +
      '<span class="tile-fill"></span>' + (pend ? '<i class="pend"></i>' : '') +
      '<span class="tile-icon">' + App.icon('plug', 28) + '</span>' +
      '<span class="tile-name">' + App.esc(d.name) + '</span>' +
      '<span class="tile-state num">' + (!d.online ? 'Offline' : !d.switchCode ? 'Unsupported' : d.on ? 'On' : 'Off') + (d.on && d.watts != null ? '<small>' + Math.round(d.watts) + ' W</small>' : '') + '</span></button>';
  }
  function plugs() {
    if (!TY.configured && !TY.error) return '';
    var on = TY.list.filter(function (d) { return d.on; }).length;
    return '<section class="room"><div class="room-h"><h3 class="serif">Smart plugs</h3><span class="label">' + (TY.error && !TY.list.length ? 'Unavailable' : on ? on + ' on' : 'All off') + '</span></div>' +
      (TY.list.length ? '<div class="tiles">' + TY.list.map(plugTile).join('') + '</div>' :
        '<p class="plug-note">' + (TY.error ? 'Couldn’t reach Tuya · ' + App.esc(TY.error) : 'No plugs found on this Tuya account.') + '</p>') + '</section>';
  }
  function paintPlugs() { var box = V.el && V.el.querySelector('.hc-plugs'); if (box) box.innerHTML = plugs(); }
  function loadPlugs(fresh) {
    return fetch('/api/tuya/devices' + (fresh ? '?fresh=1' : '')).then(function (r) { return r.json(); }).then(function (d) {
      TY.configured = !!d.configured; TY.error = d.error || '';
      if (d.configured && d.devices) TY.list = d.devices;
      paintPlugs();
    }).catch(function () { TY.error = 'server unreachable'; paintPlugs(); });
  }
  function togglePlug(id) {
    var d = TY.list.filter(function (x) { return x.id === id; })[0];
    if (!d || !d.switchCode || !d.online || TY.busy[id]) return;
    var want = !d.on;
    d.on = want; TY.busy[id] = true; paintPlugs();
    fetch('/api/tuya/switch', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Frame-App': '1' },
      body: JSON.stringify({ device: id, on: want })
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'failed'); }); }).then(function () {
      delete TY.busy[id];
      setTimeout(function () { loadPlugs(true); }, 1200);
    }, function (err) {
      delete TY.busy[id]; d.on = !want; paintPlugs();
      App.toast('Couldn’t switch <b>' + App.esc(d.name) + '</b> · ' + App.esc(err.message), { tone: 'error', icon: 'bolt' });
    });
  }

  // Granular updates: an action repaints only what it touched (full paint() rebuilds ~270 nodes,
  // which costs ~350ms on the wall tablet).
  function paintPart(sel, html) { if (V.el) V.el.querySelector(sel).innerHTML = html; }

  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-fan]'))) return openFanSheet();
    if ((t = e.target.closest('[data-plug]'))) return togglePlug(t.dataset.plug);
    if ((t = e.target.closest('[data-spk-settings]'))) return openSpeakerSheet();
    if ((t = e.target.closest('[data-np]'))) return speakerAction(t);
    if ((t = e.target.closest('[data-vol]'))) return speakerVolume(+t.dataset.vol);
    if ((t = e.target.closest('[data-spk]'))) {
      SP.sel = t.dataset.spk;
      try { localStorage.setItem('hc.spk', SP.sel); } catch (x) { /* ignore */ }
      return repaintMedia();
    }
    if ((t = e.target.closest('[data-ncam]'))) return App.nestCameraSheet(App.nest.cameras.filter(function (c) { return c.id === t.dataset.ncam; })[0]);
    if ((t = e.target.closest('[data-temp]'))) return adjustTemp(+t.dataset.temp);
    if ((t = e.target.closest('[data-tmode]'))) return setMode(t.dataset.tmode);
  }

  // ------------------------------------------------------------ thermostat actions
  // Nest allows ~5 commands per minute per thermostat (100/hour). Taps are applied on screen at once,
  // but sent as at most one command per 15s: the newest wanted mode, then the newest wanted temperature.
  var SET = 'sdm.devices.commands.ThermostatTemperatureSetpoint.';
  var MIN_GAP = 15000, want = { mode: null, temp: false }, lastSent = 0, pump = null, backoff = 0;
  function dirty() { App.nest.dirty = !!(want.mode || want.temp); }
  function schedule(ms) { clearTimeout(pump); pump = setTimeout(sendNext, ms); }
  function sendNext() {
    var c = D.climate, sent;
    if (!want.mode && !want.temp) return;
    var wait = Math.max(lastSent + MIN_GAP - Date.now(), backoff - Date.now(), 0);
    if (wait > 0) return schedule(wait);
    var cmd;
    if (want.mode) {
      sent = { mode: want.mode };
      cmd = App.nest.command(c.id, 'sdm.devices.commands.ThermostatMode.SetMode', { mode: want.mode });
      want.mode = null;
    } else {
      sent = { temp: true };
      cmd = c.mode === 'auto' ? App.nest.command(c.id, SET + 'SetRange', { heatCelsius: c.heat, coolCelsius: c.cool })
        : App.nest.command(c.id, SET + (c.mode === 'heat' ? 'SetHeat' : 'SetCool'), c.mode === 'heat' ? { heatCelsius: c.set } : { coolCelsius: c.set });
      want.temp = false;
    }
    lastSent = Date.now();
    cmd.then(function () {
      dirty();
      if (want.mode || want.temp) schedule(MIN_GAP); else setTimeout(function () { App.nest.load(true); }, 3000);
    }, function (err) {
      if (err.message === 'rate limited') { // keep what we wanted and try again once the window clears
        backoff = Date.now() + 65000;
        if (sent.mode && !want.mode) want.mode = sent.mode;
        if (sent.temp) want.temp = true;
        App.toast('Nest is rate-limiting changes · will apply in about a minute', { icon: 'thermo', ms: 4000 });
        return schedule(65000);
      }
      want.mode = null; want.temp = false; dirty();
      App.toast('Couldn’t reach the thermostat · ' + App.esc(err.message), { tone: 'error', icon: 'bolt' });
      App.nest.load();
    });
  }
  function adjustTemp(dir) {
    var c = D.climate;
    if (!c.live) return;
    if (c.eco) {
      App.nest.command(c.id, 'sdm.devices.commands.ThermostatEco.SetMode', { mode: 'OFF' }).then(function () { App.toast('Eco mode off', { icon: 'thermo', ms: 2500 }); App.nest.load(); },
        function (err) { App.toast(err.message === 'rate limited' ? 'Nest is rate-limiting changes · try again in a minute' : 'Couldn’t reach the thermostat', { tone: 'error', icon: 'bolt' }); });
      return;
    }
    if (c.mode === 'off') return App.toast('Turn the thermostat on first · pick Heat, Cool or Auto', { icon: 'thermo', ms: 2500 });
    var step = App.nest.step() * dir, f = App.nest.scale === 'FAHRENHEIT';
    // snap to the thermostat's own grid first (whole °F, half °C), then step — rounding °C to whole numbers made ↓ a no-op from x.5
    var shift = function (v) { var shown = App.deg(v); return App.nest.toC((f ? Math.round(shown) : Math.round(shown * 2) / 2) + step); };
    var clamp = function (v) { return Math.max(9, Math.min(32, v)); };
    if (c.mode === 'auto') { c.heat = clamp(shift(c.heat)); c.cool = clamp(shift(c.cool)); }
    else { c.set = clamp(shift(c.set)); if (c.mode === 'heat') c.heat = c.set; else c.cool = c.set; }
    want.temp = true; dirty();
    climateChanged();
    schedule(2500); // let a run of taps finish, then send once (further limited by MIN_GAP)
  }
  function setMode(m) {
    var c = D.climate;
    if (!c.live) return;
    c.mode = m; c.eco = false;
    want.mode = { heat: 'HEAT', cool: 'COOL', auto: 'HEATCOOL', off: 'OFF' }[m];
    want.temp = false; dirty(); // the new mode's own setpoint stays as the thermostat has it
    climateChanged();
    schedule(1200);
  }
  function climateChanged() { paintPart('.hc-climate', climate()); App.emit('data'); }
  var LIVE = 'sdm.devices.commands.CameraLiveStream.';
  function waitIce(pc, ms) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var t = setTimeout(done, ms);
      function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', chk); resolve(); }
      function chk() { if (pc.iceGatheringState === 'complete') done(); }
      pc.addEventListener('icegatheringstatechange', chk);
    });
  }
  function startStream(cam, video, status) {
    var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    var media = new MediaStream(), session = null, ext = null, dead = false, gotVideo = null;
    pc.addTransceiver('audio', { direction: 'recvonly' }); // Nest wants m-lines in this order: audio, video, application
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.createDataChannel('dataSendChannel');
    pc.ontrack = function (e) { media.addTrack(e.track); video.srcObject = media; };
    video.onplaying = function () { clearTimeout(gotVideo); status('Live'); };
    pc.onconnectionstatechange = function () {
      if (!dead && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed')) status('Stream ended');
    };
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
      .then(function () { return waitIce(pc, 2500); })
      .then(function () { return App.nest.command(cam.id, LIVE + 'GenerateWebRtcStream', { offerSdp: pc.localDescription.sdp }); })
      .then(function (r) {
        session = r.mediaSessionId;
        return pc.setRemoteDescription({ type: 'answer', sdp: r.answerSdp });
      })
      .then(function () {
        status('Connecting…');
        gotVideo = setTimeout(function () { status('No video — the camera may be asleep or offline'); }, 20000);
        ext = setInterval(function () { App.nest.command(cam.id, LIVE + 'ExtendWebRtcStream', { mediaSessionId: session }).catch(function () {}); }, 4 * 60 * 1000);
      })
      .catch(function (err) { if (!dead) status('Couldn’t start · ' + err.message); });
    return function stop() {
      dead = true; clearInterval(ext); clearTimeout(gotVideo);
      if (session) App.nest.command(cam.id, LIVE + 'StopWebRtcStream', { mediaSessionId: session }).catch(function () {});
      try { pc.close(); } catch (e) { /* already closed */ }
      video.srcObject = null;
    };
  }
  App.nestCameraSheet = function (cam) {
    if (!cam) return;
    var stop = null, keep = null;
    App.sheet('<div class="cam-big"><video class="cam-video" autoplay playsinline muted></video>' +
      '<div class="cam-big-bar"><span class="tk-live"><i></i>' + App.esc(cam.name) + '</span><span class="label label--light" data-cstat>Starting…</span>' +
      '<button class="cam-snd" data-snd>Sound off</button></div></div>', {
      cls: 'sheet--cam',
      onClose: function () { if (stop) stop(); clearInterval(keep); },
      onMount: function (s) {
        var video = s.querySelector('video'), stat = s.querySelector('[data-cstat]'), snd = s.querySelector('[data-snd]');
        stop = startStream(cam, video, function (t) { stat.textContent = t; });
        snd.onclick = function () { video.muted = !video.muted; snd.textContent = video.muted ? 'Sound off' : 'Sound on'; };
        keep = setInterval(App.resetIdle, 10000); // watching isn't idle: don't bounce back to Today mid-stream
      }
    });
  };

  App.on('minute', function () { if (V.el && V.el.firstChild && D.climate.fan && D.climate.fan.on) paintPart('.hc-climate', climate()); });

  App.on('nest', function () {
    if (!V.el || !V.el.firstChild) return;
    paintPart('.hc-climate', climate()); paintPart('.hc-cams', cams());
  });

  App.register('control', {
    show: function (el) {
      if (!V.el) {
        V.el = el;
        el.innerHTML = '<div class="hc">' +
          '<div class="hc-left"><div class="hc-cams"></div><div class="hc-plugs"></div></div>' +
          '<div class="hc-right"><div class="hc-climate"></div><div class="hc-media card"></div></div>' +
          '</div>';
        el.addEventListener('click', onClick);
      }
      paintPart('.hc-climate', climate());
      paintPart('.hc-cams', cams());
      paintPart('.hc-media', media());
      paintPlugs();
      speakerTimer();
    },
    resume: function () { speakerTimer(); },
    hide: function () { clearInterval(SP.timer); }
  });
})();
