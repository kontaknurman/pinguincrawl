#!/bin/sh
# Ensure data directory is writable by crawlkomik user
chown -R crawlkomik:crawlkomik /app/data 2>/dev/null || true

# Start a virtual X display so headful Chromium (browser_headless=0) works.
# Harmless when running headless. Needed to pass Cloudflare's environment checks.
if command -v Xvfb >/dev/null 2>&1; then
  Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp >/dev/null 2>&1 &
  export DISPLAY=:99
fi

exec dumb-init -- su-exec crawlkomik "$@"
