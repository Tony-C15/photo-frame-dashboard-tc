// One-time Google sign-in (read-only calendar access). Run: npm run google-login
// Opens Google's consent page in your browser, catches the redirect on a local port, and saves
// GOOGLE_REFRESH_TOKEN into .env.local. The token is never printed.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { loadEnv } from 'vite';

const FILE = '.env.local';
const env = loadEnv('development', process.cwd(), '');
const id = env.GOOGLE_CLIENT_ID, secret = env.GOOGLE_CLIENT_SECRET;
if (!id || !secret || /PASTE/.test(id + secret)) {
  console.error('Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in ' + FILE + ' first.');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') { res.statusCode = 404; return res.end(); }
  const done = (code, msg) => { res.statusCode = code; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(msg); setTimeout(() => process.exit(code === 200 ? 0 : 1), 200); };
  if (url.searchParams.get('state') !== state) return done(400, 'State mismatch — start again.');
  if (url.searchParams.get('error')) return done(400, 'Google said: ' + url.searchParams.get('error'));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code'), client_id: id, client_secret: secret,
      redirect_uri: 'http://127.0.0.1:' + server.address().port + '/callback',
      grant_type: 'authorization_code', code_verifier: verifier
    })
  });
  const j = await r.json();
  if (!j.refresh_token) return done(400, 'No refresh token came back (' + (j.error || 'unknown') + '). Remove the app at myaccount.google.com/permissions and try again.');
  let text = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  text = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(text)
    ? text.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, 'GOOGLE_REFRESH_TOKEN=' + j.refresh_token)
    : text.replace(/\n?$/, '\n') + 'GOOGLE_REFRESH_TOKEN=' + j.refresh_token + '\n';
  fs.writeFileSync(FILE, text);
  console.log('Saved GOOGLE_REFRESH_TOKEN to ' + FILE);
  done(200, 'Done — Google Calendar is connected. You can close this tab.');
});

server.listen(0, '127.0.0.1', () => {
  const auth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: id, redirect_uri: 'http://127.0.0.1:' + server.address().port + '/callback',
    response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256'
  });
  console.log('Opening Google sign-in in your browser…\nIf nothing opens, copy this link into a browser:\n\n' + auth + '\n');
  execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [auth], () => {});
});
