// Cloudflare Worker: static assets (the dashboard) plus the /api/* routes (server/api.js).
// Secrets (wrangler secret put …): CALENDAR_SOURCES, GOOGLE_*, ICLOUD_*, NEST_*.
import { handleApi } from '../server/api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      // Cloudflare caches ICS feeds for 5 minutes so Google/Apple aren't hit on every poll.
      const cached = (u, o) => fetch(u, { ...o, cf: { cacheTtl: 300, cacheEverything: true } });
      const r = await handleApi({
        method: request.method, path: url.pathname, params: url.searchParams,
        body: request.method === 'POST' ? await request.text() : '',
        headers: Object.fromEntries(request.headers)
      }, env, cached);
      if (r) return new Response(r.body, { status: r.status, headers: r.headers });
    }
    return env.ASSETS.fetch(request);
  }
};
