// Google Nest over the Smart Device Management (SDM) API: thermostat state + control, and live
// camera/doorbell streams (WebRTC — the browser makes the offer, SDM answers). Needs a Device Access
// project (console.nest.google.com/device-access). Env: NEST_PROJECT_ID, NEST_CLIENT_ID,
// NEST_CLIENT_SECRET, NEST_REFRESH_TOKEN (from `npm run nest-login`).
const API = 'https://smartdevicemanagement.googleapis.com/v1';
const T = 'sdm.devices.traits.';
let tok = { value: null, exp: 0 };

export function nestConfigured(env) {
  return !!(env.NEST_PROJECT_ID && env.NEST_CLIENT_ID && env.NEST_CLIENT_SECRET && env.NEST_REFRESH_TOKEN);
}

async function token(env) {
  if (tok.value && Date.now() < tok.exp - 60000) return tok.value;
  const r = await fetch('https://www.googleapis.com/oauth2/v4/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.NEST_CLIENT_ID, client_secret: env.NEST_CLIENT_SECRET, refresh_token: env.NEST_REFRESH_TOKEN, grant_type: 'refresh_token' })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error === 'invalid_grant' ? 'Nest sign-in expired or revoked — run "npm run nest-login" again' : 'Nest token error: ' + (j.error || 'HTTP ' + r.status));
  tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.value;
}

async function sdm(env, path, body) {
  const r = await fetch(API + '/enterprises/' + encodeURIComponent(env.NEST_PROJECT_ID) + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + await token(env), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error('Nest API: ' + ((j.error && (j.error.message || j.error.status)) || 'HTTP ' + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}

const kindOf = (t) => (/THERMOSTAT$/.test(t) ? 'thermostat' : /DOORBELL$/.test(t) ? 'doorbell' : /CAMERA$|DISPLAY$/.test(t) ? 'camera' : 'other');

// The device list is cached briefly and shared by every page, and the last good copy is served if Google
// rate-limits us — reloading the dashboard a few times in a minute must not blank the thermostat.
let listCache = { at: 0, data: null };
export async function nestDevices(env, fresh) {
  const age = Date.now() - listCache.at;
  if (listCache.data && age < (fresh ? 8000 : 20000)) return listCache.data;
  try {
    const data = await fetchDevices(env);
    listCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    if (listCache.data && e.status === 429) return listCache.data;
    throw e;
  }
}

async function fetchDevices(env) {
  const d = await sdm(env, '/devices');
  return (d.devices || []).map((dev) => {
    const tr = dev.traits || {}, kind = kindOf(dev.type);
    const room = ((dev.parentRelations || [])[0] || {}).displayName;
    const out = {
      id: dev.name.split('/devices/')[1],
      kind,
      name: (tr[T + 'Info'] || {}).customName || room || (kind === 'doorbell' ? 'Doorbell' : kind === 'thermostat' ? 'Thermostat' : 'Camera'),
      room: room || '',
      online: (tr[T + 'Connectivity'] || {}).status !== 'OFFLINE'
    };
    if (kind === 'thermostat') {
      const sp = tr[T + 'ThermostatTemperatureSetpoint'] || {}, eco = tr[T + 'ThermostatEco'] || {};
      Object.assign(out, {
        currentC: (tr[T + 'Temperature'] || {}).ambientTemperatureCelsius,
        humidity: (tr[T + 'Humidity'] || {}).ambientHumidityPercent,
        mode: (tr[T + 'ThermostatMode'] || {}).mode,
        modes: (tr[T + 'ThermostatMode'] || {}).availableModes || [],
        eco: eco.mode === 'MANUAL_ECO',
        hvac: (tr[T + 'ThermostatHvac'] || {}).status,
        heatC: sp.heatCelsius, coolC: sp.coolCelsius,
        scale: (tr[T + 'Settings'] || {}).temperatureScale || 'CELSIUS',
        // The API can only run the fan on a timer (1 s – 12 h); present only if the system has a fan wired.
        fan: tr[T + 'Fan'] ? { on: tr[T + 'Fan'].timerMode === 'ON', until: tr[T + 'Fan'].timerTimeout || null } : null
      });
    } else if (kind !== 'other') {
      out.protocols = (tr[T + 'CameraLiveStream'] || {}).supportedProtocols || [];
    }
    return out;
  });
}

// Only these commands ever reach Google, with sanity-checked params — the frame is a touch UI, not a general proxy.
const C = 'sdm.devices.commands.';
const temp = (v) => typeof v === 'number' && v >= 9 && v <= 32;
const RULES = {
  [C + 'ThermostatMode.SetMode']: (p) => ['HEAT', 'COOL', 'HEATCOOL', 'OFF'].includes(p.mode),
  [C + 'ThermostatEco.SetMode']: (p) => ['MANUAL_ECO', 'OFF'].includes(p.mode),
  [C + 'ThermostatTemperatureSetpoint.SetHeat']: (p) => temp(p.heatCelsius),
  [C + 'ThermostatTemperatureSetpoint.SetCool']: (p) => temp(p.coolCelsius),
  [C + 'ThermostatTemperatureSetpoint.SetRange']: (p) => temp(p.heatCelsius) && temp(p.coolCelsius) && p.heatCelsius < p.coolCelsius,
  [C + 'Fan.SetTimer']: (p) => ['ON', 'OFF'].includes(p.timerMode) && (p.duration === undefined || (/^\d{1,5}s$/.test(p.duration) && parseInt(p.duration, 10) >= 1 && parseInt(p.duration, 10) <= 43200)),
  [C + 'CameraLiveStream.GenerateWebRtcStream']: (p) => typeof p.offerSdp === 'string' && p.offerSdp.length < 20000,
  [C + 'CameraLiveStream.ExtendWebRtcStream']: (p) => typeof p.mediaSessionId === 'string',
  [C + 'CameraLiveStream.StopWebRtcStream']: (p) => typeof p.mediaSessionId === 'string'
};

export async function nestCommand(env, device, command, params) {
  if (!/^[\w-]+$/.test(String(device))) throw Object.assign(new Error('bad device id'), { status: 400 });
  const ok = RULES[command];
  if (!ok || !ok(params || {})) throw Object.assign(new Error('command not allowed'), { status: 400 });
  const j = await sdm(env, '/devices/' + device + ':executeCommand', { command, params: params || {} });
  return j.results || {};
}
