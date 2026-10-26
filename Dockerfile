FROM node:22-bookworm-slim

# Lightpanda: the headless browser that renders crawled pages (replaces Chromium).
# Its Linux release binaries are linked against glibc, which is why this image is
# Debian-based — on Alpine (musl) the binary cannot even start.
# Bump LIGHTPANDA_VERSION to upgrade; /admin/settings → "Cek Lightpanda" shows the result.
ARG LIGHTPANDA_VERSION=1.0.2
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl dumb-init gosu \
    && case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
         amd64) LP_ARCH=x86_64 ;; \
         arm64) LP_ARCH=aarch64 ;; \
         *) echo "Lightpanda has no Linux build for ${TARGETARCH:-$(dpkg --print-architecture)}" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 --retry-delay 2 -o /usr/local/bin/lightpanda \
         "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-${LP_ARCH}-linux" \
    && chmod 755 /usr/local/bin/lightpanda \
    && /usr/local/bin/lightpanda version \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Lightpanda sends usage telemetry unless this is set (to anything). A self-hosted
# crawler shouldn't phone home by default — remove the line to allow it.
ENV LIGHTPANDA_DISABLE_TELEMETRY=true
# A crashing browser must not fill the disk with core dumps (ENOSPC is a known enemy here)
ENV LIGHTPANDA_DISABLE_CORE_DUMP=1

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
RUN groupadd --system pinguincrawl && useradd --system --gid pinguincrawl --home-dir /app pinguincrawl
RUN chown -R pinguincrawl:pinguincrawl /app

# Entrypoint inline (avoids CRLF issues from Windows Git checkout)
RUN printf '%s\n' \
    '#!/bin/sh' \
    'chown -R pinguincrawl:pinguincrawl /app/data 2>/dev/null || true' \
    'exec dumb-init -- gosu pinguincrawl "$@"' \
    > /app/entrypoint.sh \
    && chmod +x /app/entrypoint.sh

# Port the app listens on inside the container. docker-compose.yml feeds the same PORT
# to this build arg, the environment and both sides of the port mapping, so PORT=6000
# runs the app on 6000 and maps 6000:6000. `docker run -e PORT=…` overrides it too.
ARG PORT=3000
ENV PORT=${PORT}
EXPOSE ${PORT}

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["pm2-runtime", "src/app.js"]
