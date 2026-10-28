/**
 * Proxy addresses: parsing, and telling when two differently written lines are the same
 * proxy. No dependencies, so the database layer can use it too.
 */

const PROXY_DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'socks4:': 1080, 'socks4a:': 1080, 'socks5:': 1080, 'socks5h:': 1080 };

/**
 * Parse one proxy. Accepts
 *   http://user:pass@host:port   socks5://user:pass@host:port   user:pass@host:port
 *   host:port                    host:port:user:pass (how proxy providers export lists)
 * Returns { server, display, hostname }: `server` is the URL handed to Lightpanda,
 * credentials included; `display` has no credentials and is safe to log or show.
 * Throws on anything else, so a typo is reported instead of crawling without a proxy.
 */
function parseProxy(proxy) {
  let s = String(proxy || '').trim();
  if (!s) return null;
  // host:port:user:pass — host and port first, so a password may contain ':' or '@'
  const hostPortUserPass = !s.includes('://') && /^([^:@\s/]+):(\d{1,5}):([^:\s]+):(.+)$/.exec(s);
  if (hostPortUserPass) {
    const [, host, port, user, pass] = hostPortUserPass;
    s = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  let parsed;
  try {
    parsed = new URL(s.includes('://') ? s : `http://${s}`);
  } catch {
    throw new Error(`Invalid proxy "${proxy}" — use http://user:pass@host:port, socks5://host:port or host:port:user:pass`);
  }
  if (!PROXY_DEFAULT_PORTS[parsed.protocol] || !parsed.hostname || parsed.pathname.length > 1) {
    throw new Error(`Invalid proxy "${parsed.protocol}//${parsed.host}" — supported: http, https, socks4, socks5`);
  }
  // Like Chrome, let a SOCKS5 proxy resolve hostnames itself: no DNS lookups leak past it
  const protocol = parsed.protocol === 'socks5:' ? 'socks5h:' : parsed.protocol;
  // Always explicit: libcurl assumes 1080 for a proxy without a port, URL parsing drops a default 80
  const hostPort = `${parsed.hostname}:${parsed.port || PROXY_DEFAULT_PORTS[parsed.protocol]}`;
  // username/password are still percent-encoded here, which is what a proxy URL needs
  const auth = parsed.username ? `${parsed.username}${parsed.password ? ':' + parsed.password : ''}@` : '';
  return {
    server: `${protocol}//${auth}${hostPort}`,
    display: `${protocol}//${hostPort}`,
    hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
  };
}

/** The same proxy however it is written (login included); unusable lines only match themselves. */
function sameProxyKey(line) {
  try {
    return (parseProxy(line) || {}).server || String(line || '').trim();
  } catch {
    return String(line || '').trim();
  }
}

/** The same proxy account whatever its password — scheme, user, host and port — or null. */
function accountKey(line) {
  try {
    const u = new URL(parseProxy(line).server);
    return `${u.protocol}//${u.username}@${u.host}`;
  } catch {
    return null;
  }
}

module.exports = { parseProxy, sameProxyKey, accountKey };
