// Calendar feed -> JSON. Shared by the Cloudflare Worker (worker/index.js) and the Vite dev server
// (vite.config.js), so `npm run dev` and the deployed app serve the same /api/calendar.
//
// Sources are private ICS links — Google ("Secret address in iCal format") and iCloud (a public
// calendar's share link, webcal://…) both give one. The links never reach the frame: the browser
// only ever sees the parsed events. Config is the CALENDAR_SOURCES env var (JSON), see .env.example.
import ICAL from 'ical.js';
import { icloudConfigured, icloudEvents } from './icloud.js';

const DAY = 864e5;
const MAX_RANGE_DAYS = 120;
const MAX_OCCURRENCES = 5000;

const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : undefined);

export function parseSources(raw) {
  if (!raw) return [];
  const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(list)) throw new Error('CALENDAR_SOURCES must be a JSON array');
  return list.map((s, i) => {
    if (!s || !s.url) throw new Error('CALENDAR_SOURCES[' + i + '] needs a "url"');
    return {
      id: s.id || 'cal' + i,
      name: s.name || s.id || 'Calendar ' + (i + 1),
      url: String(s.url).trim().replace(/^webcal(s?):\/\//i, 'https://'),
      people: Array.isArray(s.people) && s.people.length ? s.people : null, // null = whole family
      color: hex(s.color)
    };
  });
}

function cancelled(ev) { return String(ev.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED'; }

// One ICS document -> events overlapping [from, to). Handles recurrence rules, EXDATEs, edited
// single occurrences (RECURRENCE-ID), all-day events and TZID time zones.
export function expand(text, source, from, to) {
  ICAL.TimezoneService.reset();
  const root = new ICAL.Component(ICAL.parse(text));
  root.getAllSubcomponents('vtimezone').forEach((tz) => {
    try { ICAL.TimezoneService.register(tz); } catch { /* unusable zone: its events fall back to floating time */ }
  });
  const fromT = ICAL.Time.fromJSDate(from, true), toT = ICAL.Time.fromJSDate(to, true);
  const masters = new Map(), edits = [], out = [];
  root.getAllSubcomponents('vevent').forEach((v) => {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) edits.push(ev); else masters.set(ev.uid, ev);
  });
  edits.forEach((ex) => {
    const m = masters.get(ex.uid);
    if (m) m.relateException(ex); else masters.set(ex.uid + '|' + ex.recurrenceId, ex);
  });

  const push = (item, start, end, key) => {
    if (cancelled(item)) return;
    const allDay = start.isDate;
    out.push({
      id: source.id + ':' + key,
      title: item.summary || '(No title)',
      allDay,
      start: allDay ? start.toString() : start.toJSDate().toISOString(),
      end: allDay ? end.toString() : end.toJSDate().toISOString(),
      loc: (item.location || '').replace(/\s*\n\s*/g, ', ') || undefined,
      notes: (item.description || '').trim().slice(0, 300) || undefined,
      people: source.people,
      color: source.color,
      cal: source.name
    });
  };

  masters.forEach((ev) => {
    if (ev.isRecurring()) {
      const it = ev.iterator();
      let next, n = 0;
      while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
        if (next.compare(toT) >= 0) break;
        const d = ev.getOccurrenceDetails(next);
        if (d.endDate.compare(fromT) <= 0) continue;
        push(d.item, d.startDate, d.endDate, ev.uid + '|' + next.toString());
      }
    } else if (ev.endDate.compare(fromT) > 0 && ev.startDate.compare(toT) < 0) {
      push(ev, ev.startDate, ev.endDate, ev.uid);
    }
  });
  return out;
}

export async function loadEvents(sources, from, to, fetchFn = fetch) {
  const settled = await Promise.allSettled(sources.map(async (s) => {
    const r = await fetchFn(s.url, { headers: { 'User-Agent': 'home-dashboard-calendar' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return expand(await r.text(), s, from, to);
  }));
  const events = [], errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') events.push(...r.value);
    else errors.push({ id: sources[i].id, name: sources[i].name, error: String(r.reason && r.reason.message || r.reason) }); // never echo the URL
  });
  return { events, errors };
}


// ---------------------------------------------------------------- Google Calendar API (OAuth)
// Unlike a secret ICS link this sees every calendar the account can read, shared ones included.
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (from `npm run google-login`);
// optional GOOGLE_CALENDARS = [{"id":"you@gmail.com","people":["alex"]}, …] to pick calendars and
// assign them to people (default: every calendar ticked in Google Calendar, shown as family).
const G_API = 'https://www.googleapis.com/calendar/v3';
let gToken = { value: null, exp: 0 };

export function googleConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

async function googleToken(env, fetchFn) {
  if (gToken.value && Date.now() < gToken.exp - 60000) return gToken.value;
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token'
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(j.error === 'invalid_grant'
      ? 'Google sign-in expired or revoked — run "npm run google-login" again'
      : 'Google token error: ' + (j.error || 'HTTP ' + r.status));
  }
  gToken = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return gToken.value;
}

async function gget(path, params, env, fetchFn) {
  const r = await fetchFn(G_API + path + '?' + new URLSearchParams(params), { headers: { Authorization: 'Bearer ' + await googleToken(env, fetchFn) } });
  if (!r.ok) throw new Error('Google Calendar API HTTP ' + r.status);
  return r.json();
}

export async function googleEvents(env, from, to, fetchFn = fetch) {
  let picks = null;
  if (env.GOOGLE_CALENDARS) {
    picks = typeof env.GOOGLE_CALENDARS === 'string' ? JSON.parse(env.GOOGLE_CALENDARS) : env.GOOGLE_CALENDARS;
  }
  const list = (await gget('/users/me/calendarList', { minAccessRole: 'reader' }, env, fetchFn)).items || [];
  const chosen = [];
  list.forEach((c) => {
    if (picks) {
      const p = picks.find((x) => x.id === c.id || (x.id === 'primary' && c.primary));
      if (p) chosen.push({ cal: c, people: Array.isArray(p.people) && p.people.length ? p.people : null, color: hex(p.color) });
    } else if (c.selected) chosen.push({ cal: c, people: null });
  });

  const out = [], errors = [];
  await Promise.all(chosen.map(async ({ cal, people, color }) => {
    try {
      let token;
      for (let page = 0; page < 5; page++) {
        const params = { singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeMin: from.toISOString(), timeMax: to.toISOString() };
        if (token) params.pageToken = token;
        const d = await gget('/calendars/' + encodeURIComponent(cal.id) + '/events', params, env, fetchFn);
        (d.items || []).forEach((e) => {
          if (e.status === 'cancelled' || e.eventType === 'workingLocation' || !e.start || !e.end) return;
          const me = (e.attendees || []).find((a) => a.self);
          if (me && me.responseStatus === 'declined') return;
          const allDay = !!e.start.date;
          out.push({
            id: 'g:' + cal.id + ':' + e.id,
            title: e.summary || '(No title)',
            allDay,
            start: allDay ? e.start.date : new Date(e.start.dateTime).toISOString(),
            end: allDay ? e.end.date : new Date(e.end.dateTime).toISOString(),
            loc: (e.location || '').replace(/\s*\n\s*/g, ', ') || undefined,
            notes: (e.description || '').trim().slice(0, 300) || undefined,
            people,
            color: color || hex(cal.backgroundColor), // default: the colour the calendar has in Google Calendar
            cal: cal.summaryOverride || cal.summary
          });
        });
        token = d.nextPageToken;
        if (!token) break;
      }
    } catch (e) { errors.push({ id: 'google:' + cal.id, name: cal.summary || cal.id, error: e.message }); }
  }));
  return { events: out, errors, count: chosen.length };
}

// Framework-neutral request handler: ({ CALENDAR_SOURCES }, URLSearchParams) -> { status, headers, body }
export async function calendarResponse(env, params, fetchFn = fetch) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=120' };
  let sources;
  try { sources = parseSources(env.CALENDAR_SOURCES); } catch (e) {
    return { status: 500, headers, body: JSON.stringify({ configured: false, error: e.message }) };
  }
  const google = googleConfigured(env);
  const icloud = icloudConfigured(env);
  if (!sources.length && !google && !icloud) return { status: 200, headers, body: JSON.stringify({ configured: false, events: [], errors: [] }) };
  const now = Date.now();
  let from = new Date(params.get('from') || now - 14 * DAY), to = new Date(params.get('to') || now + 45 * DAY);
  if (isNaN(from) || isNaN(to) || to <= from) { from = new Date(now - 14 * DAY); to = new Date(now + 45 * DAY); }
  if (to - from > MAX_RANGE_DAYS * DAY) to = new Date(+from + MAX_RANGE_DAYS * DAY);
  const { events, errors } = await loadEvents(sources, from, to, fetchFn); // fetchFn: may cache — ICS feeds only
  const names = sources.map((s) => s.name);
  if (google) {
    names.push('Google');
    try {
      const g = await googleEvents(env, from, to); // plain fetch: authenticated, must never be cached
      events.push(...g.events); errors.push(...g.errors);
      // one entry in `sources` per failed unit, so the client can tell "everything failed" from "one calendar failed"
      for (let i = 1; i < g.count; i++) names.push('Google');
    } catch (e) { errors.push({ id: 'google', name: 'Google', error: e.message }); }
  }
  if (icloud) {
    names.push('iCloud');
    try {
      const c = await icloudEvents(env, from, to, expand);
      events.push(...c.events); errors.push(...c.errors);
      for (let i = 1; i < c.count; i++) names.push('iCloud');
    } catch (e) { errors.push({ id: 'icloud', name: 'iCloud', error: e.message }); }
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { status: 200, headers, body: JSON.stringify({ configured: true, events, errors, sources: names }) };
}
