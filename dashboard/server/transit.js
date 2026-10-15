// GO Transit live departures, from Metrolinx's Open Data API (api.openmetrolinx.com — free, needs an access key:
// register at https://api.openmetrolinx.com/OpenDataAPI/ and put it in METROLINX_KEY). The planned timetable ships
// with the app (public/transit/schedule.json, built by server/transit-build.mjs); this only adds what's live:
// predicted times, delays and platforms. The frame can't reliably load third-party HTTPS, so the server fetches it.
const BASE = 'https://api.openmetrolinx.com/OpenDataAPI/api/V1';
const TTL = 30 * 1000;
const cache = new Map(); // stop code -> { at, data }

export function transitConfigured(env) { return !!(env && env.METROLINX_KEY); }

// "2026-10-15 17:42:00" (Toronto local time) -> same string trimmed; the client reads it as local.
const when = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d/.test(v) ? v.replace('T', ' ').slice(0, 19) : '');
const pick = (o, ...keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return o[k]; return ''; };

async function nextService(env, code, fetchFn) {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const r = await fetchFn(BASE + '/Stop/NextService/' + encodeURIComponent(code) + '?key=' + encodeURIComponent(env.METROLINX_KEY), { headers: { Accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) { const e = new Error('Metrolinx rejected the access key'); e.status = 401; throw e; }
  if (!r.ok) throw new Error('Metrolinx HTTP ' + r.status);
  const j = await r.json();
  // Response shape: { Metadata: { ErrorCode: "200" | "204" (nothing running) … }, NextService: { Lines: [ … ] } }
  const lines = (j.NextService && j.NextService.Lines) || [];
  const data = (Array.isArray(lines) ? lines : [lines]).map((l) => ({
    line: String(pick(l, 'LineCode')), dir: String(pick(l, 'DirectionName', 'LineDirection')), trip: String(pick(l, 'TripNumber')),
    sched: when(pick(l, 'ScheduledDepartureTime')), live: when(pick(l, 'ComputedDepartureTime')),
    platform: String(pick(l, 'ActualPlatform', 'ScheduledPlatform')).trim(), status: String(pick(l, 'DepartureStatus'))
  }));
  cache.set(code, { at: Date.now(), data });
  return data;
}

// stops: array of station codes. Failures are per station, so one bad code doesn't blank the rest.
export async function transitLive(env, stops, fetchFn = fetch) {
  const out = { configured: true, now: Date.now(), stops: {} };
  await Promise.all(stops.map(async (code) => {
    try { out.stops[code] = { departures: await nextService(env, code, fetchFn) }; }
    catch (e) { out.stops[code] = { error: e.message }; if (e.status === 401) out.error = e.message; }
  }));
  return out;
}
