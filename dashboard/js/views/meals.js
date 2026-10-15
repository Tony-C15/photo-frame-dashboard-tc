// Meals: leftovers we cooked (with a day counter) + key fridge items to use up.
// Stored on the device (localStorage) — nothing is placeholder data here.
(function () {
  'use strict';
  var SK = 'hc.meals';
  var MEAL_LIFE = 3; // leftovers are good for 3 days
  var WHEN_CHOICES = [[0, 'Today'], [1, 'Yesterday'], [2, '2 days ago'], [3, '3 days ago']];
  var QUICK_ITEMS = ['Chicken', 'Ground beef', 'Salmon', 'Berries', 'Baby spinach', 'Milk', 'Eggs', 'Deli meat', 'Yogurt', 'Cooked rice', 'Cut fruit', 'Hummus'];

  var V = { el: null, add: null };
  var S = load();

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(SK));
      if (s && s.meals && s.items) return s;
    } catch (e) { /* private mode / bad json */ }
    return { meals: [], items: [] };
  }
  function save() {
    try { localStorage.setItem(SK, JSON.stringify(S)); } catch (e) { /* ignore */ }
    App.emit('data');
  }
  function uid() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  // Whole days since the entry's start day (calendar days, so it ticks over at midnight).
  function age(x) { return Math.max(0, Math.round((App.dayStart(App.now()) - App.dayStart(new Date(x.start))) / 864e5)); }
  // Colour of the counter. Meals: last day at 3, past it after that. Fridge items: no fixed limit, so 3-4 days is amber, 5+ red.
  function tone(x, kind) {
    var a = age(x);
    if (kind === 'meals') return a > MEAL_LIFE ? 'bad' : a === MEAL_LIFE ? 'warn' : 'ok';
    return a >= 5 ? 'bad' : a >= 3 ? 'warn' : 'ok';
  }
  function leftText(x) {
    var left = MEAL_LIFE - age(x);
    return left < 0 ? 'Past due · ' + -left + (left === -1 ? ' day' : ' days') : left === 0 ? 'Last day' : left + (left === 1 ? ' day left' : ' days left');
  }
  function startFor(daysAgo) { return +App.addDays(App.dayStart(App.now()), -daysAgo); }
  function sorted(list) { return list.slice().sort(function (a, b) { return a.start - b.start; }); }

  function cookedText(x) {
    var a = age(x), d = new Date(x.start);
    return (a === 0 ? 'Today' : a === 1 ? 'Yesterday' : App.fmt.day(d)) + ' · ' + App.fmt.monthShort(d) + ' ' + d.getDate();
  }

  function card(x, kind) {
    var a = age(x);
    return '<div class="ml-card ml-card--' + tone(x, kind) + '" data-id="' + x.id + '">' +
      '<div class="ml-day"><span class="num">' + a + '</span><small>' + (a === 1 ? 'day' : 'days') + '</small></div>' +
      '<div class="ml-body"><b>' + App.esc(x.name) + '</b>' +
      '<span class="ml-sub">' + (kind === 'meals' ? 'Cooked ' : 'Bought ') + cookedText(x) + '</span>' +
      (kind === 'meals' ? '<span class="ml-left">' + leftText(x) + '</span>' : '') +
      '</div>' +
      '<button class="ml-done" data-done="' + kind + '" data-id="' + x.id + '">' + App.icon('check', 24) + '<span>' + (kind === 'meals' ? 'All eaten' : 'Used up') + '</span></button>' +
      '</div>';
  }

  function column(kind, title, sub, empty) {
    var list = sorted(S[kind]);
    return '<section class="ml-col">' +
      '<header class="ml-col-h"><div><div class="label">' + sub + '</div><h2 class="serif">' + title + '</h2></div>' +
      '<button class="btn btn--solid" data-add="' + kind + '">' + App.icon('plus', 24) + (kind === 'meals' ? 'Add meal' : 'Add item') + '</button></header>' +
      '<div class="ml-list">' + (list.length ? list.map(function (x) { return card(x, kind); }).join('') : '<div class="ml-empty serif">' + empty + '</div>') + '</div>' +
      '</section>';
  }

  function render() {
    V.el.innerHTML = '<div class="meals">' +
      '<header class="ml-head"><div><div class="label">Leftovers &amp; fridge</div><h1 class="serif">Meals</h1></div>' +
      '<div class="ml-sum">' + '<span class="num">' + (S.meals.length + S.items.length) + '</span> tracked' + '</div></header>' +
      column('meals', 'Cooked this week', 'Leftovers', 'No leftovers.<br><i>Add a meal when you cook.</i>') +
      column('items', 'In the fridge', 'Use it up', 'Nothing tracked.<br><i>Add key items to watch.</i>') +
      '</div>';
  }

  // ---- add sheet
  function openAdd(kind) {
    var isMeal = kind === 'meals';
    var st = { name: '', when: 0 };
    function paint(root) {
      root.querySelector('[data-when-box]').innerHTML = WHEN_CHOICES.map(function (c) {
        return '<button class="chip' + (st.when === c[0] ? ' is-on' : '') + '" data-when="' + c[0] + '">' + c[1] + '</button>';
      }).join('');
      root.querySelector('[data-save]').classList.toggle('is-disabled', !st.name.trim());
    }
    App.sheet('<div class="sheet-pad ml-sheet">' +
      '<div class="label">' + (isMeal ? 'Leftovers' : 'Fridge') + '</div>' +
      '<h2 class="sheet-h serif">' + (isMeal ? 'What did we cook?' : 'What should we use up?') + '</h2>' +
      '<label class="s-input-wrap ml-input">' + App.icon(isMeal ? 'utensils' : 'cart', 30) + '<input class="s-input" placeholder="' + (isMeal ? 'e.g. Chicken curry' : 'e.g. Baby spinach') + '" autocomplete="off" enterkeyhint="done"></label>' +
      (isMeal ? '' : '<div class="label ml-lbl">Quick add</div><div class="chips">' + QUICK_ITEMS.map(function (n) { return '<button class="chip chip--ghost" data-quick="' + n + '">' + n + '</button>'; }).join('') + '</div>') +
      '<div class="label ml-lbl">' + (isMeal ? 'Cooked' : 'Bought') + '</div><div class="chips" data-when-box></div>' +
      '<div class="sheet-actions"><button class="btn btn--ghost" data-close>Cancel</button><button class="btn btn--solid" data-save>' + App.icon('check', 24) + 'Save</button></div>' +
      '</div>', {
      cls: 'sheet--wide',
      onMount: function (sheet, close) {
        var input = sheet.querySelector('.s-input');
        paint(sheet);
        input.addEventListener('input', function () { st.name = input.value; paint(sheet); });
        function save1() {
          var name = st.name.trim();
          if (!name) return;
          S[kind].push({ id: uid(), name: name.charAt(0).toUpperCase() + name.slice(1), start: startFor(st.when) });
          save();
          close();
          render();
          App.toast('Added <b>' + App.esc(name) + '</b>', { icon: 'utensils', ms: 2500 });
        }
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save1(); });
        sheet.addEventListener('click', function (e) {
          var t;
          if ((t = e.target.closest('[data-when]'))) { st.when = +t.dataset.when; paint(sheet); }
          else if ((t = e.target.closest('[data-quick]'))) {
            st.name = t.dataset.quick; input.value = st.name;
            paint(sheet);
          } else if ((t = e.target.closest('[data-save]'))) save1();
        });
      }
    });
  }

  // ---- mark done (removes it; undo restores it)
  function finish(kind, id) {
    var i = -1;
    S[kind].forEach(function (x, n) { if (x.id === id) i = n; });
    if (i < 0) return;
    var gone = S[kind].splice(i, 1)[0];
    save(); render();
    App.toast('<b>' + App.esc(gone.name) + '</b> ' + (kind === 'meals' ? 'all eaten' : 'used up'), {
      icon: 'check', ms: 5000,
      undo: function () { S[kind].push(gone); save(); render(); }
    });
  }

  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-done]'))) return finish(t.dataset.done, t.dataset.id);
    if ((t = e.target.closest('[data-add]'))) return openAdd(t.dataset.add);
  }

  App.register('meals', {
    minutely: true, // the day counters tick over at midnight
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      render();
    }
  });
})();
