// Weather for the Today page and idle screen, from Open-Meteo (open-meteo.com — free, no key). The frame
// can't reliably load third-party HTTPS, so the dashboard's own server fetches it and passes it on.
// Location is Scarborough, Ontario; WEATHER_LAT / WEATHER_LON / WEATHER_NAME override it. Celsius.
let cache = { at: 0, key: '', data: null };
const TTL = 10 * 60 * 1000;

const DEFAULT = { lat: 43.7764, lon: -79.2318, name: 'Scarborough, ON', tz: 'America/Toronto' };
export function weatherConfigured() { return true; } // always on: the location is built in

const place = (env) => {
  const lat = Number(env && env.WEATHER_LAT), lon = Number(env && env.WEATHER_LON);
  return Number.isFinite(lat) && Number.isFinite(lon) && env.WEATHER_LAT && env.WEATHER_LON
    ? { ...DEFAULT, lat, lon, name: String(env.WEATHER_NAME || 'Home') } : DEFAULT;
};

// WMO weather code -> the dashboard's icon names + a label.
function describe(code, day) {
  if (code === 0) return day ? { c: 'sun', label: 'Sunny' } : { c: 'moon', label: 'Clear' };
  if (code === 1) return day ? { c: 'sun', label: 'Mostly sunny' } : { c: 'moon', label: 'Mostly clear' };
  if (code === 2) return { c: 'partly', label: 'Partly cloudy' };
  if (code === 3) return { c: 'cloud', label: 'Overcast' };
  if (code === 45 || code === 48) return { c: 'cloud', label: 'Fog' };
  if (code >= 51 && code <= 57) return { c: 'rain', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { c: 'rain', label: 'Rain' };
  if (code >= 71 && code <= 77) return { c: 'snow', label: 'Snow' };
  if (code >= 80 && code <= 82) return { c: 'rain', label: 'Showers' };
  if (code === 85 || code === 86) return { c: 'snow', label: 'Snow showers' };
  if (code >= 95) return { c: 'rain', label: 'Thunderstorms' };
  return { c: 'cloud', label: 'Cloudy' };
}

export async function weather(env, fetchFn = fetch) {
  const p = place(env), key = p.lat + ',' + p.lon;
  if (cache.data && cache.key === key && Date.now() - cache.at < TTL) return cache.data;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + p.lat + '&longitude=' + p.lon +
    '&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,relative_humidity_2m,wind_speed_10m,weather_code,is_day' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset' +
    '&timezone=' + encodeURIComponent(p.tz) + '&forecast_days=7&timeformat=unixtime';
  const r = await fetchFn(url);
  if (!r.ok) throw new Error('Open-Meteo HTTP ' + r.status);
  const d = await r.json();
  const h = d.hourly;
  if (!h || !h.time) throw new Error('Open-Meteo returned no hourly data');
  // hourly is only used for "now" and the rain outlook, so keep two days of it
  const hours = h.time.slice(0, 48).map((t, i) => {
    const w = describe(h.weather_code[i], h.is_day[i] === 1);
    return {
      ts: t * 1000, t: Math.round(h.temperature_2m[i]), fl: Math.round(h.apparent_temperature[i]), p: h.precipitation_probability[i] || 0,
      mm: Math.round((h.precipitation[i] || 0) * 10) / 10, hum: Math.round(h.relative_humidity_2m[i]), wind: Math.round(h.wind_speed_10m[i]), c: w.c, label: w.label
    };
  });
  const data = {
    configured: true, place: p.name, lat: p.lat, lon: p.lon, now: Date.now(), hours,
    days: d.daily.time.map((t, i) => ({
      ts: t * 1000, hi: Math.round(d.daily.temperature_2m_max[i]), lo: Math.round(d.daily.temperature_2m_min[i]),
      p: d.daily.precipitation_probability_max[i] || 0, mm: Math.round((d.daily.precipitation_sum[i] || 0) * 10) / 10,
      rise: d.daily.sunrise[i] * 1000, set: d.daily.sunset[i] * 1000, ...describe(d.daily.weather_code[i], true)
    }))
  };
  cache = { at: Date.now(), key, data };
  return data;
}
