// Radar + base map for the weather page. The frame can't load third-party HTTPS, so our server fetches
// Environment Canada's radar mosaic (MSC GeoMet WMS, mm/h rain / cm/h snow, free, covers Ontario + US) and
// OpenFreeMap vector tiles (© OpenMapTiles, data © OpenStreetMap contributors), slims those down, and hands both on. Web-Mercator (EPSG:3857) throughout.
import { MVT } from './mvt.js';

const WMS = 'https://geo.weather.gc.ca/geomet';
const LAYER = 'RADAR_1KM_RRAI';
const FORECAST = 'HRDPS.CONTINENTAL.DIAG_PR_PT1H'; // Environment Canada's 2.5 km model: precipitation in the last hour (mm), hourly, out to 48 h
const PAST_STEP = 18 * 60 * 1000; // past radar every 18 minutes keeps the frame's memory use down
const PAST = 10;                  // 10 steps back = 3 hours
const AHEAD = 12;                 // hourly forecast frames
let cache = { at: 0, data: null };

const bin = (status, type, buf, maxAge) => ({
  status, body: buf,
  headers: { 'Content-Type': type, 'Cache-Control': maxAge ? 'public, max-age=' + maxAge : 'no-store' }
});
const err = (status, msg) => ({ status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: msg }) });

const dimEnd = async (layer, fetchFn) => {
  const r = await fetchFn(WMS + '?service=WMS&version=1.3.0&request=GetCapabilities&layer=' + layer);
  if (!r.ok) throw new Error('GeoMet HTTP ' + r.status);
  const m = /<Dimension name="time"[^>]*>([^<]+)</.exec(await r.text());
  const end = m && /\/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\//.exec(m[1]);
  if (!end) throw new Error('GeoMet returned no times for ' + layer);
  return Date.parse(end[1]);
};

// { past: [ms…] oldest first, ending at the newest radar scan; future: [ms…] on the hour after it }
export async function radarFrames(fetchFn = fetch) {
  if (cache.data && Date.now() - cache.at < 3 * 60 * 1000) return cache.data;
  const [last, modelEnd] = await Promise.all([dimEnd(LAYER, fetchFn), dimEnd(FORECAST, fetchFn).catch(() => 0)]);
  const past = [];
  for (let i = PAST; i >= 0; i--) past.push(last - i * PAST_STEP);
  const future = [];
  for (let t = Math.ceil((last + 1) / 3600e3) * 3600e3; future.length < AHEAD && t <= modelEnd; t += 3600e3) future.push(t);
  cache = { at: Date.now(), data: { past, future } };
  return cache.data;
}

// OpenFreeMap (openfreemap.org, free, no key) vector tiles. Their tile URLs carry a weekly planet version, so look it up (hourly).
let planet = { at: 0, url: '' };
async function vectorUrl(fetchFn) {
  if (planet.url && Date.now() - planet.at < 3600e3) return planet.url;
  const r = await fetchFn('https://tiles.openfreemap.org/planet/latest');
  if (!r.ok) throw new Error('OpenFreeMap HTTP ' + r.status);
  const url = (await r.json()).tiles[0];
  if (!/^https:\/\/tiles\.openfreemap\.org\//.test(url)) throw new Error('unexpected tile url');
  planet = { at: Date.now(), url };
  return url;
}

// A full vector tile is far more than a radar background needs (and several hundred KB at low zoom), so keep just
// water, major roads, borders and place names, thin the geometry, and send compact JSON the frame can draw directly.
const WANT = { water: [], waterway: ['class'], transportation: ['class'], place: ['class', 'name', 'rank'], boundary: ['admin_level', 'maritime', 'disputed'], water_name: ['name', 'class'] };
const ROADS = { motorway: 7, trunk: 7, primary: 9 };   // class -> lowest zoom it's drawn at
const PLACES = { city: 0, town: 9, village: 10, suburb: 11, state: 0 };
// Tile coordinates are rounded to a grid of 128 (zoomed out: 2 px steps) or 512 units (MVT uses 4096), and patches smaller than a few pixels are dropped.
const gridFor = (z) => (z >= 9 ? 512 : 128);
const quant = (paths, e, minLen, grid, tiny) => {
  const k = grid / e, out = [];
  for (const p of paths) {
    const q = [];
    for (let i = 0; i < p.length; i += 2) {
      const x = Math.round(p[i] * k), y = Math.round(p[i + 1] * k);
      if (!q.length || x !== q[q.length - 2] || y !== q[q.length - 1]) q.push(x, y);
    }
    if (q.length < minLen * 2) continue;
    if (tiny) { let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (let i = 0; i < q.length; i += 2) { x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]); y0 = Math.min(y0, q[i + 1]); y1 = Math.max(y1, q[i + 1]); } if ((x1 - x0) + (y1 - y0) < tiny * grid / 256) continue; }
    out.push(q);
  }
  return out;
};
export function slim(bytes, z) {
  const GRID = gridFor(z), tiny = z >= 9 ? 8 : 10, t = MVT.decode(bytes, WANT), out = { e: GRID, water: [], rivers: [], roads: {}, borders: [], provinces: [], lakes: [], places: [] };
  const each = (name, fn) => { const l = t[name]; if (l) for (const f of l.features) fn(f, l.extent); };
  each('water', (f, e) => { if (f.t === 3) out.water.push(...quant(f.g, e, 3, GRID, tiny / 2)); });
  each('waterway', (f, e) => { if (f.t === 2 && f.p.class === 'river' && z >= 8) out.rivers.push(...quant(f.g, e, 2, GRID, 0)); });
  each('transportation', (f, e) => {
    const c = f.p.class;
    if (f.t === 2 && ROADS[c] != null && z >= ROADS[c]) (out.roads[c] = out.roads[c] || []).push(...quant(f.g, e, 2, GRID, 0));
  });
  each('boundary', (f, e) => {
    if (f.t !== 2 || f.p.maritime === 1 || f.p.disputed === 1) return;
    if (f.p.admin_level === 2) out.borders.push(...quant(f.g, e, 2, GRID, 0));
    else if (f.p.admin_level >= 3 && f.p.admin_level <= 6) out.provinces.push(...quant(f.g, e, 2, GRID, 0));
  });
  each('water_name', (f, e) => { if (f.t === 1 && f.p.name && f.p.class === 'lake') out.lakes.push([f.p.name, Math.round(f.g[0][0] * GRID / e), Math.round(f.g[0][1] * GRID / e)]); });
  each('place', (f, e) => {
    const c = f.p.class;
    if (f.t === 1 && f.p.name && PLACES[c] != null && z >= PLACES[c]) out.places.push([f.p.name, c, f.p.rank || 99, Math.round(f.g[0][0] * GRID / e), Math.round(f.g[0][1] * GRID / e)]);
  });
  return out;
}

const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

export async function radarApi(path, params, fetchFn = fetch) {
  try {
    if (path === '/api/radar/frames') {
      return { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(await radarFrames(fetchFn)) };
    }
    if (path === '/api/radar/img') {
      const t = num(params.get('time'), 0, 4e12), w = num(params.get('w'), 64, 1600), h = num(params.get('h'), 64, 1200);
      const box = String(params.get('bbox') || '').split(',').map((v) => num(v, -2.1e7, 2.1e7));
      if (t == null || w == null || h == null || box.length !== 4 || box.includes(null)) return err(400, 'bad params');
      const iso = new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
      const url = WMS + '?service=WMS&version=1.3.0&request=GetMap&layers=' + (params.get('f') === '1' ? FORECAST : LAYER) + '&styles=&format=image/png&transparent=true' +
        '&crs=EPSG:3857&bbox=' + box.join(',') + '&width=' + Math.round(w) + '&height=' + Math.round(h) + '&time=' + iso;
      const r = await fetchFn(url);
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !type.startsWith('image/')) return err(502, 'GeoMet HTTP ' + r.status);
      return bin(200, type, await r.arrayBuffer(), 3600); // a given scan never changes
    }
    const vec = /^\/api\/map\/vec\/(\d{1,2})\/(\d{1,5})\/(\d{1,5})\.json$/.exec(path);
    if (vec) {
      const [z, x, y] = [vec[1], vec[2], vec[3]].map(Number);
      if (z < 3 || z > 12 || x >= 2 ** z || y >= 2 ** z) return err(400, 'bad tile');
      const r = await fetchFn((await vectorUrl(fetchFn)).replace('{z}', z).replace('{x}', x).replace('{y}', y));
      if (!r.ok) return err(502, 'tile HTTP ' + r.status);
      return bin(200, 'application/json', JSON.stringify(slim(new Uint8Array(await r.arrayBuffer()), z)), 86400); // a day: the planet version changes weekly
    }
  } catch (e) { return err(502, e.message); }
  return null;
}
