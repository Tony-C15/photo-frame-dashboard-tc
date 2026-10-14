# Frame constraints (target: wall frame, Android 6, WebView 106.0.5249.126)
- The web app lives in dashboard/ (run npm scripts there). Repo is a fork: origin = Tony-C15/photo-frame-dashboard-tc, upstream = wesbos/photo-frame-dashboard.
- Screen 1280x800 landscape, DPR 1, touch only, no keyboard, 1 GiB RAM: keep it light.
- Do NOT use: :has(), color-mix(), oklch(), CSS nesting, #rrggbbaa colours.
- OK: @layer, @property, grid, flex gap, aspect-ratio, container queries,
  backdrop-filter, async/await, ?. ??, ES modules, fetch, WebSocket, EventSource.
- The frame's CA store is old: HTTPS sites using Let's Encrypt fail. Serve images/fonts
  from our own host; no third-party HTTPS assets. Plain http:// on the LAN is allowed.
- Clock may be wrong until the frame gets network time (default zone America/New_York).
- Kiosk retries a failed load every 5 s. Dev loading: adb -d reverse tcp:4173 tcp:4173
  then http://127.0.0.1:4173/#home
- Only edit the web app. Never run adb commands that write to the device
  without my explicit approval.
- Personal-use fork: only ever open PRs against origin (Tony-C15/photo-frame-dashboard-tc),
  never against wesbos/photo-frame-dashboard. Don't push to upstream.
- No demo mode. Calendar, thermostat, cameras, speakers and the Baby tab are live-only: when something
  isn't connected the UI says so instead of showing fake data. What's still placeholder data in
  dashboard/js/data.js: people/ETAs, weather, chores, shopping, lights/locks/garage/scenes, "on this day" photos.
