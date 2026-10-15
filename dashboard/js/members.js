// Who owns which colour. Each person has one design-system key for good (coral, apricot, sky, lilac, sage, blush, assigned in
// that order); their avatar and filter chip use the solid colour and their events use the matching -soft fill.
// `match` lists lowercase fragments of the calendar names (as they come from the server) that belong to the person.
// Shared calendars map to calendar-family / calendar-birthdays / calendar-holidays.
window.MEMBERS = (function () {
  var people = [
    // { id: 'mum', name: 'Mum', color: 'coral', match: ['mum', 'jane'] },
  ];
  function keyFor(cal) {
    var n = String(cal || '').toLowerCase(), i, j;
    for (i = 0; i < people.length; i++) {
      for (j = 0; j < people[i].match.length; j++) if (n.indexOf(people[i].match[j]) !== -1) return 'member-' + people[i].color;
    }
    if (n.indexOf('birthday') !== -1) return 'calendar-birthdays';
    if (n.indexOf('holiday') !== -1) return 'calendar-holidays';
    return 'calendar-family';
  }
  return { people: people, keyFor: keyFor };
})();
