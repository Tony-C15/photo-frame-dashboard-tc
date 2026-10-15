// "Time to clinic": the drive from home to the clinic right now, with live traffic, from Mapbox's Directions API
// (driving-traffic profile; free tier). Only called when someone taps the card on Today, and cached for a minute.
// Config (.env.local): MAPBOX_TOKEN, HOME_ADDRESS, CLINIC_ADDRESS, CLINIC_NAME (optional). HOME_LAT/HOME_LON and
// CLINIC_LAT/CLINIC_LON can be given instead of an address. Addresses are turned into coordinates once (Mapbox
// geocoding) and kept in memory only. The token and the addresses never leave the server.
const places = new Map();          // "address" -> { lon, lat }
let cache = { at: 0, key: '', data: null };
const TTL = 60 * 1000;

const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
export const pick = (env, p) => {
  const lat = num(env[p + '_LAT']), lon = num(env[p + '_LON']);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  const address = String(env[p + '_ADDRESS'] || '').trim();
  return address ? { address } : null;
};

export function clinicMissing(env) {
  const missing = [];
  if (!env.MAPBOX_TOKEN) missing.push('MAPBOX_TOKEN');
  if (!pick(env, 'HOME')) missing.push('HOME_ADDRESS');
  if (!pick(env, 'CLINIC')) missing.push('CLINIC_ADDRESS');
  return missing;
}

// Error text must never include a URL: those carry the token.
export async function mapbox(path, token, fetchFn) {
  const r = await fetchFn('https://api.mapbox.com' + path + (path.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token));
  if (r.status === 401 || r.status === 403) throw new Error('Mapbox rejected the token');
  if (r.status === 429) throw new Error('Mapbox rate limit');
  if (!r.ok) throw new Error('Mapbox HTTP ' + r.status);
  return r.json();
}

export async function coords(p, token, fetchFn) {
  if (p.address === undefined) return p;
  if (places.has(p.address)) return places.get(p.address);
  const j = await mapbox('/search/geocode/v6/forward?limit=1&country=ca&q=' + encodeURIComponent(p.address), token, fetchFn);
  const c = j.features && j.features[0] && j.features[0].geometry && j.features[0].geometry.coordinates;
  if (!c) throw new Error('Address not found: ' + p.address.slice(0, 40));
  const found = { lon: c[0], lat: c[1] };
  places.set(p.address, found);
  return found;
}

// Up to two clinics: CLINIC_* and (optional) CLINIC2_*. Same variables for each: _ADDRESS (or _LAT/_LON) and _NAME.
const CLINICS = [['CLINIC', 'Clinic'], ['CLINIC2', 'Clinic 2']];

export async function clinicTime(env, fetchFn = fetch) {
  const missing = clinicMissing(env);
  if (missing.length) return { configured: false, missing };
  const dests = CLINICS.filter(([p]) => pick(env, p));
  const key = [env.HOME_ADDRESS, env.HOME_LAT].concat(...dests.map(([p]) => [env[p + '_ADDRESS'], env[p + '_LAT']])).join('|');
  if (cache.data && cache.key === key && Date.now() - cache.at < TTL) return cache.data;
  const from = await coords(pick(env, 'HOME'), env.MAPBOX_TOKEN, fetchFn);
  // one clinic failing (say, an address Mapbox can't find) shouldn't hide the other
  const clinics = await Promise.all(dests.map(async ([p, fallback]) => {
    const name = String(env[p + '_NAME'] || fallback);
    try {
      const to = await coords(pick(env, p), env.MAPBOX_TOKEN, fetchFn);
      const j = await mapbox('/directions/v5/mapbox/driving-traffic/' + from.lon + ',' + from.lat + ';' + to.lon + ',' + to.lat + '?overview=false', env.MAPBOX_TOKEN, fetchFn);
      const route = j.routes && j.routes[0];
      if (!route) throw new Error('No route found');
      return {
        name, minutes: Math.max(1, Math.round(route.duration / 60)),
        typical: route.duration_typical ? Math.max(1, Math.round(route.duration_typical / 60)) : null,
        km: Math.round(route.distance / 100) / 10
      };
    } catch (e) { return { name, error: e.message }; }
  }));
  if (clinics.every((c) => c.error)) throw new Error(clinics[0].error);
  const data = { configured: true, at: Date.now(), clinics };
  if (!clinics.some((c) => c.error)) cache = { at: Date.now(), key, data };
  return data;
}
