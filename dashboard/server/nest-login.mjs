// One-time Nest sign-in. Run: npm run nest-login
// Google sends Device Access consent back to https://www.google.com (a fixed redirect), so there's no
// local listener: approve in the browser, copy the address bar from the page you land on, paste it here.
// Saves NEST_REFRESH_TOKEN into .env.local — the token itself is never printed.
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { execFile } from 'node:child_process';
import { loadEnv } from 'vite';

const FILE = '.env.local';
const env = loadEnv('development', process.cwd(), '');
const need = ['NEST_PROJECT_ID', 'NEST_CLIENT_ID', 'NEST_CLIENT_SECRET'];
if (need.some((k) => !env[k] || /PASTE/.test(env[k]))) {
  console.error('Fill in ' + need.join(', ') + ' in ' + FILE + ' first.');
  process.exit(1);
}
const REDIRECT = 'https://www.google.com';
const auth = 'https://nestservices.google.com/partnerconnections/' + env.NEST_PROJECT_ID + '/auth?' + new URLSearchParams({
  redirect_uri: REDIRECT, access_type: 'offline', prompt: 'consent', client_id: env.NEST_CLIENT_ID,
  response_type: 'code', scope: 'https://www.googleapis.com/auth/sdm.service'
});
console.log('Opening Google in your browser. Pick the account that owns your Nest devices, turn on the\ndevices to share, and approve. You\'ll land on a Google search page — that\'s expected.\n\nIf nothing opens, copy this link into a browser:\n\n' + auth + '\n');
execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [auth], () => {});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const pasted = (await rl.question('Paste the full address from the browser here, then press Enter:\n> ')).trim();
rl.close();
let code;
try { code = new URL(pasted).searchParams.get('code'); } catch { /* not a URL */ }
if (!code) { console.error('No "code" found in that address. Copy the whole address bar, starting with https://www.google.com/?code=…'); process.exit(1); }

const r = await fetch('https://www.googleapis.com/oauth2/v4/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: env.NEST_CLIENT_ID, client_secret: env.NEST_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: REDIRECT })
});
const j = await r.json();
if (!j.refresh_token) { console.error('Google refused the code (' + (j.error_description || j.error || 'unknown') + '). Codes work once — run this again for a fresh one.'); process.exit(1); }

let text = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
text = /^NEST_REFRESH_TOKEN=.*$/m.test(text)
  ? text.replace(/^NEST_REFRESH_TOKEN=.*$/m, 'NEST_REFRESH_TOKEN=' + j.refresh_token)
  : text.replace(/\n?$/, '\n') + 'NEST_REFRESH_TOKEN=' + j.refresh_token + '\n';
fs.writeFileSync(FILE, text);
console.log('\nSaved NEST_REFRESH_TOKEN to ' + FILE);

// First devices.list call "activates" the link on Google's side.
const d = await fetch('https://smartdevicemanagement.googleapis.com/v1/enterprises/' + env.NEST_PROJECT_ID + '/devices', { headers: { Authorization: 'Bearer ' + j.access_token } });
const dj = await d.json();
console.log(d.ok ? 'Found ' + (dj.devices || []).length + ' device(s): ' + (dj.devices || []).map((x) => x.type.split('.').pop()).join(', ') : 'Devices call failed: ' + (dj.error && dj.error.message));
