import { defineConfig, loadEnv } from 'vite';
import { handleApi } from './server/api.js';

// Serves /api/* in `vite` / `vite preview` exactly as the Worker does in production.
// Reads secrets from .env.local (re-read per request, so edits apply without a restart).
function api() {
  const mount = (server) => { server.middlewares.use('/api', async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL('/api' + req.url, 'http://x');
    const env = loadEnv(server.config.mode, process.cwd(), '');
    const apiReq = {
      method: req.method, path: url.pathname, params: url.searchParams,
      body: Buffer.concat(chunks).toString(), headers: req.headers
    };
    // Cast speakers need the home LAN, so that route is served only here (dynamic import: Node-only libraries).
    const r = url.pathname.startsWith('/api/cast/') ? await (await import('./server/cast.js')).castApi(apiReq) : await handleApi(apiReq, env);
    res.statusCode = r ? r.status : 404;
    Object.entries(r ? r.headers : {}).forEach(([k, v]) => res.setHeader(k, v));
    res.end(r ? r.body : '');
  }); }; // no return value: Vite would run a returned function as a post-hook
  return { name: 'frame-api', configureServer: mount, configurePreviewServer: mount };
}

// The wall tablet runs Android WebView 106 — keep JS output within Chromium 106.
// CSS targets chrome61 on purpose: the tablet's WebView rejects 4/8-digit hex colours (#0000,
// #ffffffbf) even though Chrome 106 should support them, and a newer target lets the minifier
// rewrite transparent/rgba() into that form. Verified on-device with CSS.supports().
export default defineConfig({
  plugins: [api()],
  build: {
    target: 'chrome106',
    cssTarget: 'chrome61',
  },
  server: { host: true },
});
