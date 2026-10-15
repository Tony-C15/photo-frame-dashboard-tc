#!/usr/bin/env bash
# launch-dashboard.sh
# Serves the dashboard from this folder and shows it on the frame over USB.
# Save it next to package.json. Run it with: ./launch-dashboard.sh   Stop it with: Ctrl+C
#
# What it does to the frame: an ADB port forward and a normal app launch. It never writes
# to /system, never changes settings, and never turns on Wi-Fi.
set -u
cd "$(dirname "$0")" || exit 1

PORT=4173
URL="http://127.0.0.1:${PORT}/#home"
BUILD_LOG="${TMPDIR:-/tmp}/dashboard-build.log"
SERVE_LOG="${TMPDIR:-/tmp}/dashboard-serve.log"

say() { printf '%s %s\n' "$(date +%T)" "$*"; }
die() { say "STOP: $*"; exit 1; }

[ -f package.json ] || die "package.json not found. Keep this script in the dashboard folder."
command -v adb >/dev/null || die "adb not found."
command -v npm >/dev/null || die "npm not found."
command -v curl >/dev/null || die "curl not found."

# 1. Wait for the frame
adb start-server >/dev/null 2>&1
say "Waiting for the frame over USB (up to 2 minutes)..."
for _ in $(seq 1 60); do
  [ "$(adb -d get-state 2>/dev/null)" = device ] && break
  sleep 2
done
[ "$(adb -d get-state 2>/dev/null)" = device ] \
  || die "Frame not found over ADB. Check the cable, then try: adb kill-server; adb start-server"
say "Frame connected."

# 2. Build
if [ ! -d node_modules ]; then
  say "Installing packages (npm ci)..."
  npm ci >"$BUILD_LOG" 2>&1 || { tail -20 "$BUILD_LOG"; die "npm ci failed (log: $BUILD_LOG)"; }
fi
say "Building the dashboard..."
npm run build >"$BUILD_LOG" 2>&1 || { tail -20 "$BUILD_LOG"; die "Build failed (log: $BUILD_LOG)"; }

# 3. Start the server (refuse to run if something already answers on the port)
if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
  die "Something is already serving on port ${PORT} (an old run?). Stop it first, then run this again."
fi
npm run preview -- --host 127.0.0.1 --port "$PORT" --strictPort >"$SERVE_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  say "Stopping the server and removing the port forward..."
  pkill -P "$SERVER_PID" 2>/dev/null
  kill "$SERVER_PID" 2>/dev/null
  adb -d reverse --remove "tcp:${PORT}" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 30); do
  curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null && break
  kill -0 "$SERVER_PID" 2>/dev/null || { tail -20 "$SERVE_LOG"; die "Server exited (log: $SERVE_LOG)"; }
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null \
  || die "Server did not answer on port ${PORT} (log: $SERVE_LOG)"
say "Server is up on port ${PORT}."

# 4. Forward the port and launch the kiosk
adb -d reverse "tcp:${PORT}" "tcp:${PORT}" >/dev/null || die "adb reverse failed."
adb -d reverse --list | grep -q "tcp:${PORT}" || die "Port forward is not active."
adb -d shell "am start -a android.intent.action.VIEW -d \"${URL}\" -n com.wesbos.homehq/.MainActivity" >/dev/null \
  || die "Could not start the kiosk (is com.wesbos.homehq installed?)."
say "Dashboard launched on the frame. Press Ctrl+C here to stop."

# 5. Keep going: re-create the port forward if ADB drops it (cable bump, reconnect)
while kill -0 "$SERVER_PID" 2>/dev/null; do
  sleep 10
  if ! adb -d reverse --list 2>/dev/null | grep -q "tcp:${PORT}"; then
    adb -d reverse "tcp:${PORT}" "tcp:${PORT}" >/dev/null 2>&1 && say "Port forward re-created."
  fi
done
die "The server stopped (log: $SERVE_LOG)"
