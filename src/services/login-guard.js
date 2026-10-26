/**
 * Brute-force brake for the admin login.
 *
 * Failed attempts — wrong username/password, a wrong 2FA code, or a wrong own password when
 * confirming an account change — are counted per client IP. After MAX_FAILURES within
 * WINDOW_MS that IP is refused until the window ends; a successful login clears it. Per IP rather than per username, so nobody can lock an
 * admin out just by typing their name. Behind nginx/Caddy set TRUST_PROXY=1, otherwise
 * every visitor shares the proxy's address.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const failures = new Map(); // client key -> { count, since }

// IPv6 users usually hold a whole /64 and could hop between its addresses, so failures
// count per /64 there; IPv4 (also as ::ffff:a.b.c.d) per address
function clientKey(ip) {
  const addr = String(ip || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!addr.includes(':')) return addr;
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(8 - h.length - t.length, 0)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

function current(key, now) {
  const e = failures.get(key);
  return e && now - e.since < WINDOW_MS ? e : null;
}

/** ms until this client may try again; 0 when it is not blocked. */
function retryAfterMs(ip) {
  const now = Date.now();
  const e = current(clientKey(ip), now);
  return e && e.count >= MAX_FAILURES ? WINDOW_MS - (now - e.since) : 0;
}

function recordFailure(ip) {
  const now = Date.now();
  const key = clientKey(ip);
  const e = current(key, now) || { count: 0, since: now };
  e.count++;
  failures.set(key, e);
  if (failures.size > 10000) {
    for (const [k, old] of failures) if (now - old.since >= WINDOW_MS) failures.delete(k);
  }
}

function reset(ip) {
  failures.delete(clientKey(ip));
}

module.exports = { retryAfterMs, recordFailure, reset, clientKey, MAX_FAILURES, WINDOW_MS };
