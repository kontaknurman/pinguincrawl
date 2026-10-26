FROM node:18-alpine

# Chromium + dependencies for Puppeteer.
# xvfb provides a virtual display so Chromium can run HEADFUL, which is needed to
# pass Cloudflare's environment checks (headless reload-loops even after a manual solve).
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    xvfb \
    dumb-init \
    su-exec

# Fonts. The stealth layer makes the browser present itself as Windows, so a machine
# with almost no fonts — and none of the Windows ones — is a mismatch that font
# fingerprinting (which Turnstile does) can see. Liberation is metric-compatible with
# Arial / Times New Roman / Courier New and fontconfig aliases them, so those resolve.
RUN apk add --no-cache ttf-liberation font-noto ttf-dejavu \
    || apk add --no-cache ttf-liberation \
    || echo "WARN: extra fonts unavailable; /admin/captcha/diagnose will flag the font mismatch"

# Software WebGL. A browser with NO WebGL context is a strong bot signal, and a
# GPU-less server has none unless SwiftShader is present (together with the
# --enable-unsafe-swiftshader flag set in services/browser.js).
# Installed on its own so an unrelated package problem can't skip it, and tolerantly
# so a future rename can't break the build — /admin/captcha/diagnose reports the result.
RUN apk add --no-cache chromium-swiftshader \
    || echo "WARN: chromium-swiftshader unavailable; /admin/captcha/diagnose will flag missing WebGL"

# Optional software rasterizer (llvmpipe) as an extra fallback for GL
RUN apk add --no-cache mesa-dri-gallium mesa-gl || true

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# PM2 for production process management
RUN npm install -g pm2

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY src/ ./src/

# Data directory for SQLite + image cache
RUN mkdir -p /app/data

# Non-root user for security
RUN addgroup -S crawlkomik && adduser -S crawlkomik -G crawlkomik
RUN chown -R crawlkomik:crawlkomik /app

# Entrypoint inline (avoids CRLF issues from Windows Git checkout).
# Starts a virtual X display (:99) so headful Chromium works; harmless when running headless.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'chown -R crawlkomik:crawlkomik /app/data 2>/dev/null || true' \
    'if command -v Xvfb >/dev/null 2>&1; then' \
    '  Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp >/dev/null 2>&1 &' \
    '  export DISPLAY=:99' \
    'fi' \
    'exec dumb-init -- su-exec crawlkomik "$@"' \
    > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["pm2-runtime", "src/app.js"]
