// Weather page (tap the weather card on Today): conditions, 7-day outlook, hourly rain chance, and a live
// precipitation radar over a base map. Radar frames and map tiles come through our own server (server/radar.js).
(function () {
  'use strict';
  var D = window.DATA, V = { el: null };
  var R = { z: 11, frames: [], now: 0, imgs: [], at: 0, idx: 0, timer: null, playing: true, W: 736, H: 752, tiles: '' };
  var ZOOMS = [[7, 'Wide'], [11, 'Local']];
  var STEP_MS = 650, HOLD_MS = 1800, REFRESH = 6 * 60 * 1000;

  // ------------------------------------------------------------ left column (forecast)
  function nowHour() {
    var W = D.weather, now = Date.now() + W.skew, i = -1;
    for (var k = 0; k < W.hours.length; k++) if (W.hours[k].ts <= now) i = k; else break;
    return i;
  }
  function today() {
    var W = D.weather, now = Date.now() + W.skew, day = null;
    W.days.forEach(function (d) { if (d.ts <= now) day = d; });
    return day;
  }
  function hoursChart(i) {
    var hrs = D.weather.hours.slice(i, i + 24), peak = 0;
    hrs.forEach(function (h) { if (h.p > peak) peak = h.p; });
    return '<div class="wx-hrs">' + hrs.map(function (h, n) {
      var d = new Date(h.ts), lbl = n % 4 === 0 ? (n === 0 ? 'Now' : App.fmt.hour(d).replace(':00', '').replace(' ', '')) : '';
      return '<div class="wx-hr' + (h.p >= 50 ? ' is-wet' : '') + '"><i style="height:' + Math.max(3, Math.round(h.p * 0.56)) + 'px"></i><span>' + lbl + '</span></div>';
    }).join('') + '</div>' +
      '<div class="wx-hrs-note">' + (peak < 20 ? 'No rain expected in the next 24 hours' : 'Chance of precipitation, next 24 hours · peaks at ' + peak + '%') + '</div>';
  }
  function left() {
    var w = App.weatherNow(), W = D.weather;
    var back = '<div class="wx-top"><button class="btn wx-back" data-go="home">' + App.icon('left', 22) + 'Today</button><span class="wx-place">' + App.esc(W.place || '') + '</span></div>';
    if (!w) return back + '<div class="card wx-cur"><p class="wx-note">' + (W.error ? 'Weather unavailable · ' + App.esc(W.error) : 'Loading…') + '</p></div>';
    var i = nowHour(), cur = W.hours[i], day = today(), days = App.daily(7);
    var sun = day && day.rise ? '<span>' + App.icon('sunrise', 18) + App.fmt.time(new Date(day.rise)) + '</span><span>' + App.icon('moon', 18) + App.fmt.time(new Date(day.set)) + '</span>' : '';
    return back +
      '<div class="card wx-cur">' +
      '<div class="wx-cur-row"><span class="wx-cur-ic">' + App.icon(w.cond, 72) + '</span><span class="wx-temp serif">' + w.temp + '°</span>' +
      '<span class="wx-cur-meta"><b>' + w.label + '</b><span>Feels like ' + cur.fl + '°</span><span>H ' + w.hi + '°  L ' + w.lo + '°</span></span></div>' +
      '<div class="wx-say"><b>' + w.summary + '.</b> ' + w.advice + '.</div>' +
      '<div class="wx-facts"><span>Wind ' + cur.wind + ' km/h</span><span>Humidity ' + cur.hum + '%</span>' + sun + '</div></div>' +
      '<div class="card wx-days">' + days.map(function (d) {
        return '<div class="wx-day' + (d.p >= 50 ? ' is-wet' : '') + '"><b>' + d.label + '</b><span class="wx-day-i">' + App.icon(d.c, 24) + '</span>' +
          '<span class="wx-day-p">' + (d.p >= 20 ? d.p + '%' : '') + '</span><span class="wx-day-lo num">' + d.lo + '°</span><span class="wx-day-hi num">' + d.hi + '°</span></div>';
      }).join('') + '</div>' +
      '<div class="card wx-hours">' + hoursChart(i) + '</div>';
  }
  function paintLeft() { if (V.el && V.left) V.left.innerHTML = left(); }

  // ------------------------------------------------------------ radar map
  var $ = function (s) { return V.el.querySelector(s); };
  // Web-Mercator pixel (at zoom z, 256px tiles) <-> lon/lat
  function px(lon, z) { return (lon + 180) / 360 * 256 * Math.pow(2, z); }
  function py(lat, z) { var s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z); }

  function view() {
    var W = D.weather, z = R.z;
    var lat = W.lat || 43.7764, lon = W.lon || -79.2318;
    var left = px(lon, z) - R.W / 2, top = py(lat, z) - R.H / 2;
    return { z: z, left: left, top: top, key: z + ':' + Math.round(left) + ':' + Math.round(top) + ':' + R.W + 'x' + R.H };
  }
  // ---- base map: OpenFreeMap vector tiles (slimmed to JSON by the server) drawn into ONE canvas, once — no per-tile images,
  // no WebGL. A tile that can't be fetched is left as plain land.
  // Radar-first look: a quiet grey map (land, water, a few highways) so the radar is the only saturated colour on screen.
  // Place names are drawn on their own canvas ABOVE the radar so heavy rain can't hide them.
  var COL = { land: '#f2f4f6', water: '#d9e3ec', river: '#d9e3ec', casing: '#ffffff', major: '#c3cad2', road: '#d0d6dc',
    border: '#aab2bc', province: '#c0c7cf', label: '#27313d', halo: '#ffffff', lake: '#6a7f99', state: '#7a8693' };
  var ROAD_W = { motorway: 2.4, trunk: 2, primary: 1.4 };      // wide (zoom 7) draws them thinner
  var ROAD_ORDER = ['primary', 'trunk', 'motorway'];
  var CITY_PX = { city: 18, town: 14, village: 12, suburb: 12, state: 15 };

  function fetchTile(z, tx, ty, n) {
    var x = ((tx % n) + n) % n;
    return fetch('/api/map/vec/' + z + '/' + x + '/' + ty + '.json?v=8').then(function (r) {
      if (!r.ok) throw new Error('tile');
      return r.json();
    }).then(function (j) { return { v: j }; }, function () { return { failed: true }; });
  }
  function trace(ctx, paths, ox, oy, k, close) {
    paths.forEach(function (p) {
      for (var i = 0; i < p.length; i += 2) {
        if (i) ctx.lineTo(ox + p[i] * k, oy + p[i + 1] * k); else ctx.moveTo(ox + p[0] * k, oy + p[1] * k);
      }
      if (close) ctx.closePath();
    });
  }
  function paintBase(ctx, lctx, tiles, v) {
    var wide = v.z < 9, scale = wide ? 0.65 : 1;
    ctx.fillStyle = COL.land; ctx.fillRect(0, 0, R.W, R.H);
    if (tiles.some(function (t) { return t.failed; })) R.tiles = ''; // a tile is missing: redraw next time the page opens
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    // Polygons are filled one tile at a time: neighbouring tiles overlap by a few px, which an even-odd fill over a
    // combined path would turn into gaps. Lines don't care, so each line layer is one stroke call across all tiles.
    function fill(key, col) {
      ctx.fillStyle = col;
      tiles.forEach(function (t) {
        if (!t.v || !t.v[key].length) return;
        ctx.beginPath(); trace(ctx, t.v[key], t.x, t.y, 256 / t.v.e, true); ctx.fill('evenodd');
      });
    }
    function stroke(get, col, w, dash) {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.beginPath();
      tiles.forEach(function (t) { var p = t.v && get(t.v); if (p) trace(ctx, p, t.x, t.y, 256 / t.v.e, false); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    fill('water', COL.water);
    stroke(function (j) { return j.rivers; }, COL.river, 1.2);
    stroke(function (j) { return j.provinces; }, COL.province, 1, [5, 4]);
    stroke(function (j) { return j.borders; }, COL.border, 1.4);
    ROAD_ORDER.forEach(function (c) { stroke(function (j) { return j.roads[c]; }, COL.casing, ROAD_W[c] * scale + 1.6); });
    ROAD_ORDER.forEach(function (c) { stroke(function (j) { return j.roads[c]; }, c === 'primary' ? COL.road : COL.major, ROAD_W[c] * scale); });
    // labels, biggest places first; skip any that would overlap one already placed
    var list = [];
    tiles.forEach(function (t) {
      if (!t.v) return;
      t.v.places.forEach(function (p) {
        var px = t.x + p[3] * 256 / t.v.e, py = t.y + p[4] * 256 / t.v.e, size = CITY_PX[p[1]];
        if (size && px > 20 && px < R.W - 20 && py > 20 && py < R.H - 20) list.push({ n: p[0], s: wide ? size - 2 : size, c: p[1], r: p[2], x: px, y: py, k: p[1] === 'state' ? 1 : 0 });
      });
    });
    tiles.forEach(function (t) {
      if (!t.v) return;
      t.v.lakes.forEach(function (p) {
        var px = t.x + p[1] * 256 / t.v.e, py = t.y + p[2] * 256 / t.v.e;
        if (px > 40 && px < R.W - 40 && py > 20 && py < R.H - 100) list.push({ n: p[0], s: 13, c: 'lake', r: 0, x: px, y: py, k: 2 });
      });
    });
    list.sort(function (a, b) { return (a.k === 2) - (b.k === 2) || b.s - a.s || a.r - b.r; });
    var boxes = [];
    lctx.textAlign = 'center'; lctx.textBaseline = 'middle'; lctx.lineWidth = 3;
    list.forEach(function (p) {
      lctx.font = (p.k ? 'italic 500 ' : '600 ') + p.s + 'px Figtree, sans-serif';
      var w = lctx.measureText(p.n).width + 8, h = p.s + 6;
      var box = [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
      if (boxes.some(function (b) { return box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]; })) return;
      boxes.push(box);
      lctx.strokeStyle = COL.halo; lctx.strokeText(p.n, p.x, p.y);
      lctx.fillStyle = p.k === 2 ? COL.lake : p.k === 1 ? COL.state : COL.label; lctx.fillText(p.n, p.x, p.y);
    });
  }
  // Scale bar: pick a round distance that comes out 70-150 px wide at this zoom and latitude.
  function scaleBar(z) {
    var lat = D.weather.lat || 43.7764, m = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
    var km = [1, 2, 5, 10, 20, 50, 100, 200].filter(function (k) { return k * 1000 / m >= 70; })[0] || 200;
    var el = $('.wx-scale');
    el.style.width = Math.round(km * 1000 / m) + 'px';
    el.firstChild.textContent = km + ' km';
  }
  function drawBase() {
    var v = view();
    scaleBar(v.z);
    if (R.tiles === v.key) return;
    R.tiles = v.key;
    var cv = $('.wx-base'), lv = $('.wx-labels'), n = Math.pow(2, v.z), jobs = [];
    cv.width = lv.width = R.W; cv.height = lv.height = R.H;
    for (var ty = Math.floor(v.top / 256); ty <= Math.floor((v.top + R.H) / 256); ty++) {
      for (var tx = Math.floor(v.left / 256); tx <= Math.floor((v.left + R.W) / 256); tx++) {
        if (ty < 0 || ty >= n) continue;
        jobs.push(fetchTile(v.z, tx, ty, n).then((function (x, y) { return function (t) { t.x = x; t.y = y; return t; }; })(Math.round(tx * 256 - v.left), Math.round(ty * 256 - v.top))));
      }
    }
    Promise.all(jobs).then(function (tiles) { if (R.tiles === v.key) paintBase(cv.getContext('2d'), lv.getContext('2d'), tiles, v); });
  }
  function radarUrl(f, v) {
    var mpp = 2 * Math.PI * 6378137 / (256 * Math.pow(2, v.z)), o = 20037508.342789244;
    var bbox = [v.left * mpp - o, o - (v.top + R.H) * mpp, (v.left + R.W) * mpp - o, o - v.top * mpp].map(function (m) { return Math.round(m); });
    // requested at half size and stretched: radar is blurry anyway and 23 frames must fit in the frame's memory
    return '/api/radar/img?time=' + f.t + (f.f ? '&f=1' : '') + '&bbox=' + bbox.join(',') + '&w=' + (R.W >> 1) + '&h=' + (R.H >> 1);
  }

  function stop() { clearTimeout(R.timer); R.timer = null; }
  function show(i) {
    R.idx = i;
    var cv = $('.wx-radar'), ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (R.imgs[i] && R.imgs[i].naturalWidth) ctx.drawImage(R.imgs[i], 0, 0, cv.width, cv.height);
    var fr = R.frames[i];
    if (!fr) return;
    var d = new Date(fr.t), mins = Math.round((fr.t - (Date.now() + D.weather.skew)) / 60000), a = Math.abs(mins);
    var rel = a < 10 ? 'Now' : (a >= 60 ? Math.floor(a / 60) + ' h' + (a % 60 >= 10 && !fr.f ? ' ' + (Math.round(a % 60 / 6) * 6) + ' min' : '') : a + ' min');
    $('.wx-when').innerHTML = '<b>' + App.fmt.time(d, true).replace(':00 ', ' ') + '</b><span>' + (fr.f ? 'Forecast · in ' + rel : rel === 'Now' ? 'Radar · now' : 'Radar · ' + rel + ' ago') + '</span>';
    var ticks = $('.wx-ticks').children;
    for (var k = 0; k < ticks.length; k++) ticks[k].classList.toggle('is-on', k === i);
  }
  function tick() {
    if (!R.playing || App.current !== 'weather') return;
    var next = (R.idx + 1) % R.frames.length;
    show(next);
    R.timer = setTimeout(tick, next === R.frames.length - 1 || next === R.now ? HOLD_MS : STEP_MS);
  }
  function play(on) {
    R.playing = on; stop();
    $('.wx-play').innerHTML = App.icon(on ? 'pause' : 'play', 26);
    if (on) R.timer = setTimeout(tick, STEP_MS);
  }
  function note(msg) { var n = $('.wx-radar-note'); n.textContent = msg || ''; n.hidden = !msg; }

  function loadRadar() {
    var v = view(), z = R.z;
    drawBase();
    note('Loading radar…');
    fetch('/api/radar/frames').then(function (r) { return r.json(); }).then(function (d) {
      if (z !== R.z) return;
      if (!d.past) throw new Error(d.error || 'no frames');
      R.frames = d.past.map(function (t) { return { t: t, f: false }; }).concat((d.future || []).map(function (t) { return { t: t, f: true }; }));
      R.now = d.past.length - 1; R.at = Date.now();
      var box = $('.wx-radar'), pending = R.frames.length, ok = 0;
      box.width = R.W >> 1; box.height = R.H >> 1; // half size, stretched by CSS
      box.getContext('2d').clearRect(0, 0, box.width, box.height);
      $('.wx-ticks').innerHTML = R.frames.map(function (fr, n) { return '<button data-f="' + n + '"' + (fr.f ? ' class="is-fc"' : '') + ' aria-label="Frame ' + (n + 1) + '"><i></i></button>'; }).join('');
      R.imgs = R.frames.map(function (t) {
        var im = new Image();
        im.alt = '';
        im.onload = im.onerror = function () {
          if (z !== R.z) return;
          if (im.naturalWidth) ok++;
          if (--pending === 0) {
            if (!ok) { note('Radar isn’t available right now'); return; }
            note(''); show(R.now); play(true);
          }
        };
        im.src = radarUrl(t, v);
        return im;
      });
    }).catch(function (e) { if (z === R.z) note('Radar isn’t available right now'); });
  }

  function activate() {
    if (!V.el) return;
    if (!R.imgs.length || Date.now() - R.at > REFRESH) { stop(); loadRadar(); }
    else { drawBase(); play(R.playing); }
  }

  function build(el) {
    el.innerHTML = '<div class="wx">' +
      '<div class="wx-left"></div>' +
      '<div class="card wx-map">' +
      '<canvas class="wx-base"></canvas><canvas class="wx-radar"></canvas><canvas class="wx-labels"></canvas><i class="wx-home"></i>' +
      '<div class="wx-zoom">' + ZOOMS.map(function (z) { return '<button data-z="' + z[0] + '"' + (z[0] === R.z ? ' class="is-on"' : '') + '>' + z[1] + '</button>'; }).join('') + '</div>' +
      '<p class="wx-radar-note" hidden></p>' +
      '<div class="wx-scale"><span></span></div>' +
      '<span class="wx-credit">Map © OpenFreeMap, OpenMapTiles, OpenStreetMap · Radar: Environment Canada</span>' +
      '<div class="wx-legend"><span>Light</span><i></i><span>Heavy</span></div>' +
      '<div class="wx-bar"><button class="wx-play" aria-label="Play or pause"></button><div class="wx-ticks"></div><div class="wx-when"></div></div>' +
      '</div></div>';
    V.left = el.querySelector('.wx-left');
    el.addEventListener('click', function (e) {
      var g = e.target.closest('[data-go]');
      if (g) { App.go(g.dataset.go); return; }
      var z = e.target.closest('[data-z]');
      if (z) {
        R.z = +z.dataset.z; R.tiles = ''; R.imgs = []; stop();
        Array.prototype.forEach.call(el.querySelectorAll('[data-z]'), function (b) { b.classList.toggle('is-on', b === z); });
        loadRadar(); return;
      }
      var f = e.target.closest('[data-f]');
      if (f) { play(false); show(+f.dataset.f); return; }
      if (e.target.closest('.wx-play')) play(!R.playing);
    });
  }

  App.register('weather', {
    show: function (el) {
      V.el = el;
      if (!el.firstChild) build(el);
      paintLeft();
      if (App.current === 'weather') {
        var m = el.querySelector('.wx-map');
        if (m && m.clientWidth) { R.W = m.clientWidth; R.H = m.clientHeight; }
        activate();
      }
    },
    resume: function () { activate(); },
    hide: function () { stop(); }
  });
  App.on('data', function () { if (App.current === 'weather') paintLeft(); });
})();
