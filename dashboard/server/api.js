// One router for every /api/* route, used by both the Vite dev server and the Cloudflare Worker.
// req: { method, path, params (URLSearchParams), body (string), headers (lowercase keys) }
import { calendarResponse } from './calendar.js';
import { nestConfigured, nestDevices, nestCommand } from './nest.js';
import { tuyaConfigured, tuyaDevices, tuyaSwitch } from './tuya.js';
import { wasteConfigured, wastePickups } from './waste.js';
import { weather } from './weather.js';
import { radarApi } from './radar.js';
import { clinicTime } from './clinic.js';
import { stationTime } from './stationtime.js';
import { transitConfigured, transitLive } from './transit.js';
import { todoistConfigured, shoppingList, shoppingWrite, shoppingHistory } from './todoist.js';

const JSON_H = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const send = (status, obj) => ({ status, headers: JSON_H, body: JSON.stringify(obj) });

export async function handleApi(req, env, icsFetch = fetch) {
  const { method, path } = req;
  if (path === '/api/calendar' && method === 'GET') return calendarResponse(env, req.params, icsFetch);

  // Speakers live on the home LAN, so only the dev server (server/cast.js) can serve them — not the Worker.
  if (path.startsWith('/api/cast/')) return send(200, { configured: false });

  if (path.startsWith('/api/nest/')) {
    if (!nestConfigured(env)) return send(200, { configured: false });
    try {
      if (path === '/api/nest/devices' && method === 'GET') return send(200, { configured: true, devices: await nestDevices(env, req.params.get('fresh') === '1') });
      if (path === '/api/nest/command' && method === 'POST') {
        // A custom header forces a CORS preflight, so other websites can't make your browser POST here.
        if (!req.headers['x-frame-app']) return send(403, { error: 'forbidden' });
        let b;
        try { b = JSON.parse(req.body || '{}'); } catch { return send(400, { error: 'bad json' }); }
        return send(200, { results: await nestCommand(env, b.device, b.command, b.params) });
      }
    } catch (e) { return send(e.status === 400 || e.status === 429 ? e.status : 502, { error: e.status === 429 ? 'rate limited' : e.message }); }
  }

  if (path === '/api/shopping/history' && method === 'GET') {
    if (!todoistConfigured(env)) return send(200, { configured: false });
    try { return send(200, await shoppingHistory(env)); } catch (e) { return send(502, { configured: true, error: e.message }); }
  }

  if (path === '/api/shopping') {
    if (!todoistConfigured(env)) return send(200, { configured: false });
    try {
      if (method === 'GET') return send(200, await shoppingList(env));
      if (method === 'POST') {
        if (!req.headers['x-frame-app']) return send(403, { error: 'forbidden' });
        let b;
        try { b = JSON.parse(req.body || '{}'); } catch { return send(400, { error: 'bad json' }); }
        return send(200, await shoppingWrite(env, b));
      }
    } catch (e) { return send(e.status === 400 || e.status === 429 ? e.status : 502, { configured: true, error: e.message }); }
  }

  if (path === '/api/waste' && method === 'GET') {
    if (!wasteConfigured(env)) return send(200, { configured: false });
    try { return send(200, await wastePickups(env)); } catch (e) { return send(502, { configured: true, error: e.message }); }
  }

  if (path === '/api/weather' && method === 'GET') {
    try { return send(200, await weather(env, icsFetch)); } catch (e) { return send(502, { configured: true, error: e.message }); }
  }

  if (path === '/api/transit' && method === 'GET') {
    if (!transitConfigured(env)) return send(200, { configured: false });
    const stops = (req.params.get('stops') || '').split(',').filter((c) => /^[A-Za-z0-9]{2,6}$/.test(c)).map((c) => c.toUpperCase()).slice(0, 6);
    try { return send(200, await transitLive(env, stops, icsFetch)); } catch (e) { return send(502, { configured: true, error: e.message }); }
  }

  if (path === '/api/station-time' && method === 'GET') {
    try { return send(200, await stationTime(env, req.params.get('lat'), req.params.get('lon'), { home: req.params.get('home') === '1', code: req.params.get('code') })); } catch (e) { return send(502, { configured: true, error: e.message }); }
  }

  if (path === '/api/clinic' && method === 'GET') {
    try { return send(200, await clinicTime(env)); } catch (e) { return send(502, { configured: true, error: e.message }); }
  }

  if ((path.startsWith('/api/radar/') || path.startsWith('/api/map/')) && method === 'GET') return radarApi(path, req.params, icsFetch);

  if (path.startsWith('/api/tuya/')) {
    if (!tuyaConfigured(env)) return send(200, { configured: false });
    try {
      if (path === '/api/tuya/devices' && method === 'GET') return send(200, { configured: true, devices: await tuyaDevices(env, req.params.get('fresh') === '1') });
      if (path === '/api/tuya/switch' && method === 'POST') {
        if (!req.headers['x-frame-app']) return send(403, { error: 'forbidden' });
        let b;
        try { b = JSON.parse(req.body || '{}'); } catch { return send(400, { error: 'bad json' }); }
        await tuyaSwitch(env, b.device, b.on);
        return send(200, { ok: true });
      }
    } catch (e) { return send(e.status === 400 ? 400 : 502, { error: e.message }); }
  }
  return null;
}
