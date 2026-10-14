// Google Cast speakers (Nest Mini / Audio, …) on the home network: what's playing, play/pause/skip, volume.
// Node-only (mDNS discovery + Cast sockets), so it runs in the Vite dev server on a machine at home —
// the deployed Cloudflare Worker can't reach devices on your LAN. Group devices are left out: each
// speaker is controlled individually.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Bonjour } from 'bonjour-service';
const { Client, DefaultMediaReceiver } = createRequire(import.meta.url)('castv2-client');

const devices = new Map(); // id -> { id, name, model, host, port }
let browser = null, firstSeen = null;
const arts = new Map();    // token -> image url (the frame only ever fetches art through us)
const cache = new Map();   // id -> { at, data }
const TTL = 3000;

function discover() {
  if (browser) return firstSeen;
  const bonjour = new Bonjour();
  firstSeen = new Promise((r) => setTimeout(r, 3500)); // speakers answer mDNS at different speeds: give them all a moment
  browser = bonjour.find({ type: 'googlecast' }, (s) => {
    const t = s.txt || {};
    if (!t.id || t.md === 'Google Cast Group') return;
    const host = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (!host) return;
    devices.set(t.id, { id: t.id, name: t.fn || s.name, model: t.md || '', host, port: s.port });
  });
  browser.on('down', (s) => { const t = s.txt || {}; if (t.id) devices.delete(t.id); });
  return firstSeen;
}

function connect(dev) {
  return new Promise((resolve, reject) => {
    const c = new Client();
    const t = setTimeout(() => { try { c.close(); } catch { /* ignore */ } reject(new Error('timeout')); }, 7000);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.connect({ host: dev.host, port: dev.port }, () => { clearTimeout(t); resolve(c); });
  });
}
const call = (obj, method, ...args) => new Promise((resolve, reject) => obj[method](...args, (e, r) => (e ? reject(e) : resolve(r))));

function artToken(url) {
  const tok = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  arts.set(tok, url);
  if (arts.size > 60) arts.delete(arts.keys().next().value);
  return tok;
}

// Join the running app's media session (read-only until we send a command on it).
async function session(c) {
  const st = await call(c, 'getStatus');
  const app = (st.applications || [])[0];
  if (!app || !app.transportId || app.isIdleScreen) return { st, app: null };
  try {
    const player = await call(c, 'join', app, DefaultMediaReceiver);
    const ms = await call(player, 'getStatus');
    return { st, app, player, ms };
  } catch { return { st, app, player: null, ms: null }; }
}

async function readOne(dev) {
  const c = await connect(dev);
  try {
    const { st, app, ms } = await session(c);
    const md = (ms && ms.media && ms.media.metadata) || {};
    const img = md.images && md.images[0] && md.images[0].url;
    const cmds = (ms && ms.supportedMediaCommands) || 0;
    return {
      id: dev.id, name: dev.name, model: dev.model,
      volume: st.volume ? st.volume.level : null, muted: !!(st.volume && st.volume.muted),
      app: app ? app.displayName : null,
      media: ms ? {
        state: ms.playerState, title: md.title || '', artist: md.artist || md.albumArtist || '', album: md.albumName || '',
        art: img ? '/api/cast/art/' + artToken(img) : null,
        duration: (ms.media && ms.media.duration) || 0, position: ms.currentTime || 0, rate: ms.playbackRate || 1,
        canPause: !!(cmds & 1), canNext: !!(cmds & 64), canPrev: !!(cmds & 128)
      } : null
    };
  } finally { try { c.close(); } catch { /* ignore */ } }
}

async function speakers() {
  await discover();
  const list = [...devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(list.map(async (dev) => {
    const hit = cache.get(dev.id);
    if (hit && Date.now() - hit.at < TTL) return hit.data;
    let data;
    try { data = await readOne(dev); } catch (e) { data = { id: dev.id, name: dev.name, model: dev.model, error: 'unreachable' }; }
    cache.set(dev.id, { at: Date.now(), data });
    return data;
  }));
}

async function command(id, action, value) {
  const dev = devices.get(id);
  if (!dev) throw Object.assign(new Error('unknown speaker'), { status: 400 });
  const c = await connect(dev);
  try {
    if (action === 'mute') {
      await call(c, 'setVolume', { muted: !!value });
    } else if (action === 'volume') {
      const v = Math.max(0, Math.min(1, Number(value)));
      if (!isFinite(v)) throw Object.assign(new Error('bad volume'), { status: 400 });
      await call(c, 'setVolume', { level: v });
    } else {
      const { player } = await session(c);
      if (!player) throw Object.assign(new Error('nothing is playing'), { status: 409 });
      if (action === 'play') await call(player, 'play');
      else if (action === 'pause') await call(player, 'pause');
      else if (action === 'next') await call(player, 'sessionRequest', { type: 'QUEUE_NEXT' });
      else if (action === 'prev') await call(player, 'sessionRequest', { type: 'QUEUE_PREV' });
      else throw Object.assign(new Error('unknown action'), { status: 400 });
    }
  } finally { try { c.close(); } catch { /* ignore */ } }
  cache.delete(id);
}

const J = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const send = (status, obj) => ({ status, headers: J, body: JSON.stringify(obj) });

export async function castApi(req) {
  const { method, path } = req;
  try {
    if (path === '/api/cast/speakers' && method === 'GET') return send(200, { configured: true, speakers: await speakers() });
    if (path === '/api/cast/command' && method === 'POST') {
      if (!req.headers['x-frame-app']) return send(403, { error: 'forbidden' }); // forces a CORS preflight for other sites
      const b = JSON.parse(req.body || '{}');
      await command(String(b.id), String(b.action), b.value);
      return send(200, { ok: true });
    }
    const m = path.match(/^\/api\/cast\/art\/([0-9a-f]{16})$/);
    if (m && method === 'GET') {
      const url = arts.get(m[1]);
      if (!url) return { status: 404, headers: {}, body: '' };
      const r = await fetch(url);
      if (!r.ok) return { status: 502, headers: {}, body: '' };
      return { status: 200, headers: { 'Content-Type': r.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }, body: Buffer.from(await r.arrayBuffer()) };
    }
  } catch (e) { return send(e.status || 502, { error: e.message }); }
  return null;
}
