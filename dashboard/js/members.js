// Who owns which colour. Each person has one design-system key for good (coral, apricot, sky, lilac, sage, blush, assigned in
// that order); their avatar and filter chip use the solid colour and their events use the matching -soft fill.
// `match` lists lowercase fragments of the calendar names (as they come from the server) that belong to the person.
// Shared calendars map to calendar-family / calendar-birthdays / calendar-holidays.
window.MEMBERS = (function () {
  var people = [
    // { id: 'mum', name: 'Mum', color: 'coral', match: ['mum', 'jane'] },
  ];
  var PALETTE = ['coral', 'apricot', 'sky', 'lilac', 'sage', 'blush'];
  var auto = {};
  // Calendars that aren't tied to a person get their own member colour, handed out in alphabetical order of the
  // calendars currently loaded, so each source stays tellable apart. Call with every calendar name on screen.
  function assign(names) {
    var uniq = {}, list = [];
    names.forEach(function (n) { if (n && keyFor(n, true) === null && !uniq[n]) { uniq[n] = 1; list.push(n); } });
    list.sort();
    auto = {};
    list.forEach(function (n, i) { auto['' + n] = 'member-' + PALETTE[i % PALETTE.length]; });
  }
  function keyFor(cal, probe) {
    var n = String(cal || '').toLowerCase(), i, j;
    for (i = 0; i < people.length; i++) {
      for (j = 0; j < people[i].match.length; j++) if (n.indexOf(people[i].match[j]) !== -1) return 'member-' + people[i].color;
    }
    if (n.indexOf('birthday') !== -1) return 'calendar-birthdays';
    if (n.indexOf('holiday') !== -1) return 'calendar-holidays';
    if (probe) return null;
    return auto[String(cal || '')] || 'calendar-family';
  }
  return { people: people, keyFor: keyFor, assign: assign };
})();
