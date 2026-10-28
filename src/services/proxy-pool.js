/**
 * Proxy rotation per website.
 *
 * A website picks one or more entries of Settings → Proxy / WireGuard (or follows the global
 * default — see selectionFor); every crawl attempt asks pick() for one of them:
 *   round_robin  the next one in the list, crawl after crawl
 *   random       any of them
 *   failover     always the first; the next ones only while it is failing
 * A proxy whose attempt died because of the proxy (unreachable, wrong login, too slow —
 * see fetchPage) is skipped for COOLDOWN_MS, unless every proxy is cooling down; then they
 * are all tried anyway rather than crawling without one.
 *
 * State is in memory only: after a restart rotation starts over and nothing is cooling
 * down, which costs at most one failed attempt per dead proxy.
 */

const { parseProxy } = require('./proxy-url');
const db = require('../models/database');
const refs = require('./proxy-refs');

const ROTATIONS = ['round_robin', 'random', 'failover'];
const COOLDOWN_MS = 5 * 60 * 1000;

const cursors = new Map();  // website key -> index of the next round_robin proxy
// entry -> { okAt, failedAt, failures, error }, per Settings entry: rotating residential
// gateways hand out one host:port with a different user per session, so each login is its
// own entry and one dead session must not rest the others. Never leaves this module.
const health = new Map();

/**
 * What a website crawls through: { entries, rotation, source }. `entries` are refs
 * ("proxy:<name>", "wireguard:<name>"), resolved when a browser starts; `source` says whether
 * they are the website's own choice, the global default, or none at all.
 */
function selectionFor(website) {
  const rotation = (website && website.proxy_rotation) || 'round_robin';
  // proxy_refs NULL: a website whose old proxy list couldn't be moved to Settings yet (see
  // convertLegacyProxies) keeps crawling through that list, as before the upgrade
  if (website && website.proxy_refs == null) {
    const wg = website.proxy_type === 'wireguard' ? parseProxyList(website.wireguard).map(refs.wireguardRef) : [];
    const own = wg.length ? wg : parseProxyList(website.proxy);
    if (own.length) return { entries: own, rotation, source: 'website' };
  }
  const choice = String((website && website.proxy_refs) || refs.DEFAULT).trim();
  if (choice === refs.NONE) return { entries: [], rotation: 'round_robin', source: 'none' };
  if (choice === refs.DEFAULT) return defaultSelection();
  return { entries: refs.refList(choice).filter((r) => refs.parseRef(r)), rotation, source: 'website' };
}

/** The global default (Settings → Proxy), in the same shape. */
function defaultSelection() {
  const d = db.getDefaultProxy();
  return { entries: d.refs, rotation: d.rotation, source: 'default' };
}

/** A proxy list as text: one per line, blank lines and # comments ignored. */
function parseProxyList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function displayOf(proxy) {
  const ref = refs.parseRef(proxy);
  if (ref) return ref.type === 'wireguard' ? `wireguard ${ref.name}` : ref.name;
  try {
    return parseProxy(proxy).display;
  } catch {
    return '(invalid proxy)';
  }
}

function keyOf(proxy) {
  if (refs.parseRef(proxy)) return proxy;
  try {
    return parseProxy(proxy).server;
  } catch {
    return String(proxy);
  }
}

function coolingDown(proxy, now = Date.now()) {
  const h = health.get(keyOf(proxy));
  return !!(h && h.failedAt && now - h.failedAt < COOLDOWN_MS && (!h.okAt || h.okAt < h.failedAt));
}

/**
 * Choose the proxy for one crawl attempt.
 * @param {string} key      rotation state key (the website)
 * @param {string[]} list   the website's proxies
 * @param {string} mode     round_robin | random | failover
 * @param {Set<string>} [exclude] proxies this request already tried
 */
function pick(key, list, mode, exclude = new Set()) {
  if (!list.length) return null;
  const fresh = list.filter((p) => !exclude.has(p));
  const pool = fresh.length ? fresh : list;
  const healthy = pool.filter((p) => !coolingDown(p));
  const candidates = healthy.length ? healthy : pool;

  if (mode === 'random') return candidates[Math.floor(Math.random() * candidates.length)];
  if (mode === 'failover') return list.find((p) => candidates.includes(p));

  // round_robin: walk the list from the cursor to the first candidate
  const start = cursors.get(key) || 0;
  for (let i = 0; i < list.length; i++) {
    const idx = (start + i) % list.length;
    if (candidates.includes(list[idx])) {
      cursors.set(key, (idx + 1) % list.length);
      return list[idx];
    }
  }
  return candidates[0];
}

function reportSuccess(proxy) {
  const k = keyOf(proxy);
  health.set(k, { ...(health.get(k) || {}), okAt: Date.now(), failures: 0 });
}

function reportFailure(proxy, message) {
  const k = keyOf(proxy);
  const h = health.get(k) || {};
  health.set(k, { ...h, failedAt: Date.now(), failures: (h.failures || 0) + 1, error: String(message || '').slice(0, 300) });
}

/** An entry that changed (new address, config or name): what it did before no longer counts. */
function forget(proxy) {
  health.delete(keyOf(proxy));
}

/** Per-proxy state for the admin UI — displays only, never credentials. */
function status(list) {
  const now = Date.now();
  return list.map((proxy) => {
    const h = health.get(keyOf(proxy)) || {};
    return {
      display: displayOf(proxy),
      coolingDown: coolingDown(proxy, now),
      cooldownLeftMs: coolingDown(proxy, now) ? COOLDOWN_MS - (now - h.failedAt) : 0,
      okAt: h.okAt || null,
      failedAt: h.failedAt || null,
      failures: h.failures || 0,
      error: h.error || null,
    };
  });
}

module.exports = {
  ROTATIONS,
  COOLDOWN_MS,
  selectionFor,
  defaultSelection,
  parseProxyList,
  displayOf,
  pick,
  reportSuccess,
  reportFailure,
  forget,
  status,
};
