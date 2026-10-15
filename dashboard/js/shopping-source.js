// Live shopping list: items come from a Todoist project through the dashboard's own server (/api/shopping),
// so the frame never talks to a third-party HTTPS host. No demo data: until it loads, or if it fails, the
// Groceries tab and the Home card say so. Category and store are Todoist labels (@produce, @costco); the
// count is a "×2" suffix on the title. Writes are optimistic and queued per item, so taps stay instant.
(function () {
  'use strict';
  var D = window.DATA, S = D.shop;
  var EVERY = 30 * 1000, RETRY = 15 * 1000, QTY_WAIT = 600;
  var busy = 0, seq = 0, sig = '';
  var Shop = window.Shop = {};

  function slug(s) { return s.toLowerCase().replace(/&/g, '').replace(/\s+/g, '-').replace(/-+/g, '-'); }
  var CAT_BY_SLUG = {};
  D.catOrder.all.forEach(function (c) { CAT_BY_SLUG[slug(c)] = c; });

  Shop.categorize = function (name) {
    var n = name.toLowerCase();
    var hit = D.catalog.filter(function (c) { return c[0].toLowerCase() === n; })[0] ||
      D.catalog.filter(function (c) { var a = c[0].toLowerCase(); return a.indexOf(n) > -1 || n.indexOf(a) > -1; })[0] ||
      D.catalog.filter(function (c) { return n.split(/\s+/).some(function (w) { return w.length > 3 && c[0].toLowerCase().indexOf(w) > -1; }); })[0];
    return hit ? hit[1] : 'Other';
  };
  Shop.tmpId = function () { return 'tmp-' + (++seq); };
  Shop.isBusy = function () { return busy > 0; };

  var storeBySection = {}, sectionByStore = {}; // Todoist section id <-> store id (matched by name)
  function mapSections(list) {
    storeBySection = {}; sectionByStore = {};
    (list || []).forEach(function (sec) {
      D.stores.forEach(function (s) { if (s.name.toLowerCase() === String(sec.name).trim().toLowerCase()) { storeBySection[sec.id] = s.id; sectionByStore[s.id] = sec.id; } });
    });
  }

  function fromServer(t) {
    var labels = (t.labels || []).map(function (l) { return String(l).toLowerCase(); });
    var cat = '', store = storeBySection[t.sectionId] || '';
    labels.forEach(function (l) { if (CAT_BY_SLUG[l]) cat = CAT_BY_SLUG[l]; });
    return { id: t.id, name: t.name, qty: t.qty, note: t.note || '', done: false, cat: cat || Shop.categorize(t.name), store: store, labels: t.labels || [] };
  }
  // Labels for a new task: its category (the store is a section, not a label).
  function labelsOf(g) { return g.cat && g.cat !== 'Other' ? [slug(g.cat)] : []; }

  function post(body) {
    return fetch('/api/shopping', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Frame-App': '1' }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'request failed'); return j; });
    });
  }

  // Run one write for an item after its earlier writes finished (a new item's id only exists once Todoist answers).
  function queue(g, fn) {
    busy++;
    g._p = (g._p || Promise.resolve()).then(fn).catch(function (e) {
      App.toast('Couldn’t save to the shopping list' + (e && e.message ? ' · ' + App.esc(e.message) : ''), { icon: 'cart', tone: 'error', ms: 4000 });
      sig = ''; // force the next load to repaint from the server's truth
    }).then(function () { if (--busy === 0) load(); });
  }
  function retag(from, to) {
    App.$$('[data-id="' + from + '"],[data-check="' + from + '"]').forEach(function (el) {
      if (el.dataset.id === from) el.dataset.id = to;
      if (el.dataset.check === from) el.dataset.check = to;
    });
  }

  Shop.add = function (g) {
    queue(g, function () {
      return post({ op: 'add', name: g.name, qty: g.qty, labels: labelsOf(g), note: g.note, sectionId: sectionByStore[g.store] || null }).then(function (j) {
        var old = g.id; g.id = j.item.id; retag(old, g.id);
      });
    });
  };
  // patch: { done } and/or { qty } and/or { store } (a store id, or '' for none)
  Shop.set = function (g, patch) {
    if ('qty' in patch) {
      clearTimeout(g._qt);
      if (!g._qtOpen) { g._qtOpen = true; busy++; } // hold off reloads while a count change waits to be sent
      g._qt = setTimeout(function () {
        g._qtOpen = false;
        queue(g, function () { return post({ op: 'update', id: g.id, name: g.name, qty: g.qty }); });
        if (--busy === 0) load();
      }, QTY_WAIT);
    }
    if ('store' in patch) queue(g, function () { return post({ op: 'update', id: g.id, sectionId: sectionByStore[g.store] || null }); });
    if ('done' in patch) queue(g, function () { return post({ op: 'update', id: g.id, done: patch.done }); });
  };

  function paintAll() { App.emit('data'); App.emit('shop'); }

  function load() {
    if (busy > 0) return Promise.resolve();
    var before = S.live + '|' + S.off + '|' + S.error, changed = false;
    return fetch('/api/shopping').then(function (r) { return r.json(); }).then(function (d) {
      if (busy > 0) return; // a tap landed while we were loading: the next load will catch up
      if (d.configured === false) { S.off = true; S.live = false; S.error = ''; return; }
      if (d.error || !d.items) { S.error = d.error || 'no data'; return; }
      S.off = false; S.error = ''; S.live = true; S.project = d.project || '';
      mapSections(d.sections);
      var next = d.items.map(fromServer);
      var s = JSON.stringify(next);
      var kept = D.groceries.filter(function (g) { return g.done; }); // checked off this session, for the "Got it" drawer
      var ids = {};
      next.forEach(function (g) { ids[g.id] = 1; });
      if (s === sig) return;
      sig = s; changed = true;
      D.groceries = next.concat(kept.filter(function (g) { return !ids[g.id]; }));
    }).catch(function () { S.error = 'server unreachable'; }).then(function () { if (changed || before !== S.live + '|' + S.off + '|' + S.error) paintAll(); });
  }
  Shop.load = load;

  // Delete an item. The Todoist delete waits a few seconds so "Undo" can cancel it.
  Shop.remove = function (g) {
    busy++; // no reload while the delete is pending
    g._rm = setTimeout(function () {
      g._rm = null;
      queue(g, function () { return post({ op: 'delete', id: g.id }); });
      if (--busy === 0) load();
    }, 4500);
  };
  Shop.unremove = function (g) {
    if (!g._rm) return;
    clearTimeout(g._rm); g._rm = null;
    if (--busy === 0) load();
  };

  // "Often bought": names checked off most in the last 90 days, from Todoist (server caches it for 10 minutes).
  S.often = [];
  function loadOften() {
    fetch('/api/shopping/history').then(function (r) { return r.json(); }).then(function (d) {
      S.often = (d.items || []).filter(function (x) { return x.count >= 2 && D.oftenHide.indexOf(x.name.toLowerCase()) < 0; }).map(function (x) { return x.name; });
    }).catch(function () {}).then(function () { App.emit('shop'); setTimeout(loadOften, 30 * 60 * 1000); });
  }
  App.on('ready', loadOften);

  function loop() { load().then(function () { setTimeout(loop, S.live ? EVERY : RETRY); }); }
  App.on('ready', loop);
})();
