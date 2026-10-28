/**
 * How websites (and the global default) refer to what they crawl through: one ref per line,
 *   proxy:<name>       an entry of Settings → Proxy (HTTP/HTTPS/SOCKS, credentials included)
 *   wireguard:<name>   a config of Settings → WireGuard
 * or a single keyword:
 *   default            whatever Settings → Proxy sets as the default for all websites
 *   none               no proxy, connect directly
 * Refs name entries rather than holding them, so a proxy's address or password lives in one
 * place and a rename there follows into every website.
 */

const PROXY = 'proxy:';
const WIREGUARD = 'wireguard:';
const DEFAULT = 'default';
const NONE = 'none';

/** One ref per line, blank lines dropped, duplicates removed (first one wins). */
function refList(text) {
  const seen = new Set();
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !seen.has(s) && seen.add(s));
}

/** { type: 'proxy' | 'wireguard', name } for a ref, or null for anything else. */
function parseRef(ref) {
  if (typeof ref !== 'string') return null;
  if (ref.startsWith(PROXY) && ref.length > PROXY.length) return { type: 'proxy', name: ref.slice(PROXY.length) };
  if (ref.startsWith(WIREGUARD) && ref.length > WIREGUARD.length) return { type: 'wireguard', name: ref.slice(WIREGUARD.length) };
  return null;
}

const proxyRef = (name) => PROXY + name;
const wireguardRef = (name) => WIREGUARD + name;

module.exports = { PROXY, WIREGUARD, DEFAULT, NONE, refList, parseRef, proxyRef, wireguardRef };
