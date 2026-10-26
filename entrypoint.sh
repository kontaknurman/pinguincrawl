#!/bin/sh
# Ensure data directory is writable by pinguincrawl user
chown -R pinguincrawl:pinguincrawl /app/data 2>/dev/null || true

exec dumb-init -- gosu pinguincrawl "$@"
