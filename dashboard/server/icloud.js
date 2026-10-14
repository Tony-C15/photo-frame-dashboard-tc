// iCloud calendars over CalDAV — including calendars other people shared with you, which have no
// public link. Auth is your Apple ID + an app-specific password (appleid.apple.com > Sign-In and
// Security). Env: ICLOUD_APPLE_ID, ICLOUD_APP_PASSWORD; optional
// ICLOUD_CALENDARS = [{"name":"Shared Family","color":"#2D5BFF","people":["jordan"]}] (match by
// calendar name; default: every event calendar on the account).
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
const arr = (x) => (x == null || x === '' ? [] : Array.isArray(x) ? x : [x]);
const hex = (c) => (/^#[0-9a-f]{6}/i.test(String(c || '')) ? String(c).slice(0, 7) : undefined); // Apple sends #RRGGBBAA
const NS = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"';
let home = null; // discovered calendar-home URL, kept for the life of the process/isolate

export function icloudConfigured(env) { return !!(env.ICLOUD_APPLE_ID && env.ICLOUD_APP_PASSWORD); }

async function dav(method, url, body, depth, env, fetchFn) {
  const r = await fetchFn(url, {
    method,
    headers: {
      Authorization: 'Basic ' + btoa(env.ICLOUD_APPLE_ID + ':' + env.ICLOUD_APP_PASSWORD),
      'Content-Type': 'application/xml; charset=utf-8', Depth: String(depth)
    },
    body
  });
  if (r.status === 401) throw new Error('iCloud sign-in failed — check ICLOUD_APPLE_ID and the app-specific password');
  if (!r.ok && r.status !== 207) throw new Error('iCloud HTTP ' + r.status);
  return xml.parse(await r.text()).multistatus;
}
const props = (ms) => arr(ms && ms.response).map((r) => ({ href: r.href, prop: Object.assign({}, ...arr(r.propstat).map((p) => p.prop || {})) }));

async function discover(env, fetchFn) {
  if (home) return home;
  const root = 'https://caldav.icloud.com/';
  const p1 = props(await dav('PROPFIND', root, `<d:propfind ${NS}><d:prop><d:current-user-principal/></d:prop></d:propfind>`, 0, env, fetchFn));
  const principal = p1[0] && p1[0].prop['current-user-principal'] && p1[0].prop['current-user-principal'].href;
  if (!principal) throw new Error('iCloud: could not find the account principal');
  const p2 = props(await dav('PROPFIND', new URL(principal, root).href, `<d:propfind ${NS}><d:prop><c:calendar-home-set/></d:prop></d:propfind>`, 0, env, fetchFn));
  const h = p2[0] && p2[0].prop['calendar-home-set'] && p2[0].prop['calendar-home-set'].href;
  if (!h) throw new Error('iCloud: could not find the calendar home');
  home = new URL(h, root).href;
  return home;
}

export async function icloudEvents(env, from, to, expand) {
  const base = await discover(env, fetch);
  const list = props(await dav('PROPFIND', base,
    `<d:propfind ${NS}><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/></d:prop></d:propfind>`, 1, env, fetch));
  let picks = null;
  if (env.ICLOUD_CALENDARS) picks = typeof env.ICLOUD_CALENDARS === 'string' ? JSON.parse(env.ICLOUD_CALENDARS) : env.ICLOUD_CALENDARS;

  const chosen = [];
  list.forEach((c) => {
    const rt = c.prop.resourcetype;
    if (!rt || typeof rt !== 'object' || !('calendar' in rt)) return;
    const comps = arr(c.prop['supported-calendar-component-set'] && c.prop['supported-calendar-component-set'].comp).map((x) => x['@_name']);
    if (comps.length && !comps.includes('VEVENT')) return; // reminders lists
    const name = String(c.prop.displayname || 'iCloud');
    if (picks) {
      const p = picks.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
      if (p) chosen.push({ href: c.href, name, people: Array.isArray(p.people) && p.people.length ? p.people : null, color: hex(p.color) || hex(c.prop['calendar-color']) });
    } else chosen.push({ href: c.href, name, people: null, color: hex(c.prop['calendar-color']) });
  });

  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const query = `<c:calendar-query ${NS}><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${stamp(from)}" end="${stamp(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const events = [], errors = [];
  await Promise.all(chosen.map(async (cal, i) => {
    try {
      const rows = props(await dav('REPORT', new URL(cal.href, base).href, query, 1, env, fetch));
      const source = { id: 'icloud' + i, name: cal.name, people: cal.people, color: cal.color };
      rows.forEach((r) => {
        const text = r.prop['calendar-data'];
        if (typeof text === 'string' && text.includes('BEGIN:VEVENT')) events.push(...expand(text, source, from, to));
      });
    } catch (e) { errors.push({ id: 'icloud' + i, name: cal.name, error: e.message }); }
  }));
  return { events, errors, count: chosen.length };
}
