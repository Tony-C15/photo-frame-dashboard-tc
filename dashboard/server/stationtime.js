// "Time to station": home -> where we park (live-traffic drive) -> the station (walk), from Mapbox Directions, so
// the total counts both legs. Same setup as the clinic card (server/clinic.js): MAPBOX_TOKEN and HOME_*, plus
// PARKING_ADDRESS (or PARKING_LAT / PARKING_LON) and optional PARKING_NAME for the main station (home=1).
// Any other station (the alternate route) uses PARKING_<CODE>_ADDRESS (e.g. PARKING_UN_ADDRESS) if set, and otherwise
// is a straight drive to the station itself with no walk. The station's own coordinates come from the
// GTFS timetable via the page (lat/lon query), so they need no config. Only called while the Transit tab is open.
import { pick, mapbox, coords } from './clinic.js';

let cache = { at: 0, key: '', data: null };
const TTL = 60 * 1000;

export async function stationTime(env, lat, lon, opts = {}, fetchFn = fetch) {
  const missing = [];
  if (!env.MAPBOX_TOKEN) missing.push('MAPBOX_TOKEN');
  if (!pick(env, 'HOME')) missing.push('HOME_ADDRESS');
  const code = /^[A-Za-z0-9]{2,6}$/.test(opts.code || '') ? opts.code.toUpperCase() : '';
  const pre = opts.home ? 'PARKING' : code ? 'PARKING_' + code : '';
  const spot = pre && pick(env, pre);
  if (opts.home && !spot) missing.push('PARKING_ADDRESS');
  if (missing.length) return { configured: false, missing };
  const st = { lat: Number(lat), lon: Number(lon) };
  if (!Number.isFinite(st.lat) || !Number.isFinite(st.lon) || Math.abs(st.lat) > 90 || Math.abs(st.lon) > 180) throw new Error('No station location');

  const key = [env.HOME_ADDRESS, env.HOME_LAT, env.PARKING_ADDRESS, env.PARKING_LAT, pre, env[pre + '_ADDRESS'], env[pre + '_LAT'], st.lat, st.lon].join('|');
  if (cache.data && cache.key === key && Date.now() - cache.at < TTL) return cache.data;
  const home = await coords(pick(env, 'HOME'), env.MAPBOX_TOKEN, fetchFn);
  const park = spot ? await coords(spot, env.MAPBOX_TOKEN, fetchFn) : st; // no parking spot given: drive to the station itself
  const route = async (profile, a, b) => {
    const j = await mapbox('/directions/v5/mapbox/' + profile + '/' + a.lon + ',' + a.lat + ';' + b.lon + ',' + b.lat + '?overview=false', env.MAPBOX_TOKEN, fetchFn);
    const r = j.routes && j.routes[0];
    if (!r) throw new Error('No ' + (profile === 'walking' ? 'walking' : 'driving') + ' route found');
    return r;
  };
  const [drive, walk] = await Promise.all([route('driving-traffic', home, park), spot ? route('walking', park, st) : null]);
  const m = (s) => Math.max(1, Math.round(s / 60));
  const data = {
    configured: true, at: Date.now(), park: spot ? String(env[pre + '_NAME'] || 'Parking') : '',
    drive: { minutes: m(drive.duration), typical: drive.duration_typical ? m(drive.duration_typical) : null, km: Math.round(drive.distance / 100) / 10 },
    walk: walk ? { minutes: m(walk.duration), m: Math.round(walk.distance / 10) * 10 } : null,
    total: m(drive.duration) + (walk ? m(walk.duration) : 0)
  };
  cache = { at: Date.now(), key, data };
  return data;
}
