// City of Toronto curbside collection (garbage, recycling, green bin, yard waste, Christmas trees), from the
// "Solid Waste Collection Schedule" open dataset (open.toronto.ca/dataset/solid-waste-pickup-schedule).
// Covers single-family homes (under 9 units) on daytime collection. Households are identified by a "calendar"
// such as Tuesday1 / Thursday2 (day of week + week 1 or 2). Set to Thursday2 below; TORONTO_CALENDAR overrides it.
// Contains information licensed under the Open Government Licence – Toronto.
const CKAN = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
const STREAMS = { GreenBin: 'greenBin', Garbage: 'garbage', Recycling: 'recycling', YardWaste: 'yardWaste', ChristmasTree: 'christmasTree' };
const DAY = { M: 0, T: 1, W: 2, R: 3, F: 4, S: 5 };
let cache = { at: 0, key: '', data: null };

const DEFAULT_CALENDAR = 'Thursday2';
const calendarOf = (env) => { const c = String((env && env.TORONTO_CALENDAR) || '').trim(); return /^[A-Za-z]+[12]$/.test(c) ? c : DEFAULT_CALENDAR; };
export function wasteConfigured() { return true; } // always on: the calendar is built in

const iso = (d) => d.toISOString().slice(0, 10);

// A row says, per stream, the weekday letter it is collected on that week ("0" = no collection). The
// WeekStarting date sits in the same Monday–Sunday week, so Monday + letter gives the real date (incl. holiday shifts).
function datesOf(row) {
  const [m, d, y] = row.WeekStarting.split('/').map(Number);
  const start = new Date(Date.UTC(2000 + y, m - 1, d));
  const monday = new Date(+start - ((start.getUTCDay() + 6) % 7) * 864e5);
  const out = {};
  Object.keys(STREAMS).forEach((k) => {
    const letter = String(row[k] || '0').toUpperCase();
    if (letter !== '0' && DAY[letter] != null) out[STREAMS[k]] = iso(new Date(+monday + DAY[letter] * 864e5));
  });
  return out;
}

async function json(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Toronto open data HTTP ' + r.status);
  return r.json();
}

export async function wastePickups(env) {
  const calendar = calendarOf(env);
  if (cache.data && cache.key === calendar && Date.now() - cache.at < 12 * 3600 * 1000) return cache.data;
  const pkg = (await json(CKAN + '/package_show?id=solid-waste-pickup-schedule')).result;
  const year = new Date().getFullYear();
  // yearly tables are datastore resources named pickup-schedule-YYYY; use this year and next (if published)
  const tables = (pkg.resources || [])
    .map((r) => ({ r, y: +(String(r.name).match(/^pickup-schedule-(\d{4})$/) || [])[1] }))
    .filter((x) => x.y && x.r.datastore_active && x.y >= year && x.y <= year + 1);
  if (!tables.length) throw new Error('No ' + year + ' schedule is published yet');
  const pickups = { greenBin: [], garbage: [], recycling: [], yardWaste: [], christmasTree: [] };
  const years = [];
  for (const t of tables) {
    const q = CKAN + '/datastore_search?resource_id=' + t.r.id + '&filters=' + encodeURIComponent(JSON.stringify({ Calendar: calendar })) + '&limit=200';
    const rows = (await json(q)).result.records;
    if (!rows.length) continue;
    years.push(t.y);
    rows.forEach((row) => { const d = datesOf(row); Object.keys(d).forEach((k) => pickups[k].push(d[k])); });
  }
  if (!years.length) throw new Error('No schedule found for calendar "' + calendar + '"');
  const from = iso(new Date(Date.now() - 2 * 864e5)); // keep it small: nothing older than two days
  Object.keys(pickups).forEach((k) => { pickups[k] = [...new Set(pickups[k])].filter((d) => d >= from).sort(); });
  const data = { configured: true, calendar, years, pickups, source: 'City of Toronto Open Data (Open Government Licence – Toronto)' };
  cache = { at: Date.now(), key: calendar, data };
  return data;
}
