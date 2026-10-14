// Tuya cloud API — Globe plugs paired through the Smart Life app. Needs a Tuya IoT cloud project with your
// Smart Life account linked (iot.tuya.com > Cloud > your project > Devices > Link Tuya App Account).
// Env: TUYA_ACCESS_ID, TUYA_ACCESS_SECRET, TUYA_REGION (us | us-east | eu | eu-west | in | sg | cn).
// Uses WebCrypto, so it runs in Node (dev server) and in the Cloudflare Worker alike.
const BASE = {
  us: 'https://openapi.tuyaus.com', 'us-east': 'https://openapi-ueaz.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com', 'eu-west': 'https://openapi-weaz.tuyaeu.com',
  in: 'https://openapi.tuyain.com', sg: 'https://openapi-sg.iotbing.com', cn: 'https://openapi.tuyacn.com'
};
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
let tok = { value: null, exp: 0 };

export function tuyaConfigured(env) { return !!(env.TUYA_ACCESS_ID && env.TUYA_ACCESS_SECRET) && !/PASTE/.test(env.TUYA_ACCESS_ID + env.TUYA_ACCESS_SECRET); }

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(text) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))).toUpperCase();
}

async function call(env, method, path, query, body, withToken = true) {
  const base = BASE[env.TUYA_REGION || 'us'];
  if (!base) throw new Error('TUYA_REGION must be one of: ' + Object.keys(BASE).join(', '));
  const qs = Object.keys(query || {}).sort().map((k) => k + '=' + query[k]).join('&');
  const url = path + (qs ? '?' + qs : '');
  const t = String(Date.now()), nonce = crypto.randomUUID();
  const payload = body ? JSON.stringify(body) : '';
  const stringToSign = [method, payload ? await sha256(payload) : EMPTY_SHA, '', url].join('\n');
  const access = withToken ? await token(env) : '';
  const sign = await hmac(env.TUYA_ACCESS_SECRET, env.TUYA_ACCESS_ID + access + t + nonce + stringToSign);
  const r = await fetch(base + url, {
    method,
    headers: { client_id: env.TUYA_ACCESS_ID, sign, t, nonce, sign_method: 'HMAC-SHA256', ...(access ? { access_token: access } : {}), 'Content-Type': 'application/json' },
    body: payload || undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) {
    const e = new Error('Tuya: ' + (j.msg || 'HTTP ' + r.status) + (j.code ? ' (code ' + j.code + ')' : ''));
    e.code = j.code;
    throw e;
  }
  return j.result;
}

async function token(env) {
  if (tok.value && Date.now() < tok.exp - 60000) return tok.value;
  const r = await call(env, 'GET', '/v1.0/token', { grant_type: 1 }, null, false);
  tok = { value: r.access_token, exp: Date.now() + r.expire_time * 1000 };
  return tok.value;
}

// Devices linked to the cloud project, trimmed to what the dashboard needs.
const SWITCH = /^switch(_\d+)?$/;
function shape(d) {
  const st = d.status || [];
  const sw = st.find((s) => SWITCH.test(s.code));
  const power = st.find((s) => s.code === 'cur_power');
  return {
    id: d.id, name: d.name, online: !!d.online, category: d.category, product: d.product_name || '',
    switchCode: sw ? sw.code : null, on: sw ? !!sw.value : null,
    watts: power && typeof power.value === 'number' ? power.value / 10 : null // cur_power is in 0.1 W
  };
}
let listCache = { at: 0, data: null };
export async function tuyaDevices(env, fresh) {
  if (listCache.data && Date.now() - listCache.at < (fresh ? 3000 : 15000)) return listCache.data;
  let r;
  try { r = await call(env, 'GET', '/v1.0/iot-01/associated-users/devices', { size: 100 }); }
  catch (e) { // older projects: list by project instead
    if (listCache.data) return listCache.data;
    r = await call(env, 'GET', '/v1.3/iot-03/devices', { page_size: 100 });
  }
  const data = (r.devices || r.list || []).map(shape);
  listCache = { at: Date.now(), data };
  return data;
}

export async function tuyaSwitch(env, id, on) {
  if (!/^[\w-]+$/.test(String(id))) throw Object.assign(new Error('bad device id'), { status: 400 });
  const dev = (await tuyaDevices(env)).find((d) => d.id === id);
  if (!dev || !dev.switchCode) throw Object.assign(new Error('not a switchable device'), { status: 400 });
  await call(env, 'POST', '/v1.0/devices/' + id + '/commands', null, { commands: [{ code: dev.switchCode, value: !!on }] });
  listCache.at = 0;
}
