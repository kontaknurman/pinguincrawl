const dns = require('dns');
const net = require('net');
const puppeteer = require('puppeteer-core');
const lightpanda = require('./lightpanda');

// Only used by fetchPageSimple (plain HTTP mode). Lightpanda sends its own
// "Lightpanda/1.0" User-Agent and refuses any value containing "Mozilla".
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const db = require('../models/database');
const { detectCaptcha } = require('./captcha-detector');

// Concurrency limit — dynamic from admin settings, fallback to env, then default 3
let activeBrowsers = 0;
const waitQueue = [];

function getMaxConcurrent() {
  const fromDb = parseInt(db.getSetting('max_browsers'));
  if (fromDb > 0) return fromDb;
  return parseInt(process.env.MAX_BROWSERS) || 3;
}

function acquireBrowserSlot() {
  if (activeBrowsers < getMaxConcurrent()) {
    activeBrowsers++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitQueue.push(resolve));
}

function releaseBrowserSlot() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift();
    next();
  } else {
    activeBrowsers--;
  }
}

// A JS-only interstitial that clears on its own does so within a few seconds. Lightpanda
// can't pass the interactive kind at all, so waiting the page's full timeout for one
// (30 s by default) only delays the error.
const CF_WAIT_MS = 10000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse proxy URL into components.
 * Supports: http://user:pass@host:port, http://host:port, host:port
 */
function parseProxy(proxy) {
  if (!proxy) return null;
  try {
    // Ensure protocol prefix for URL parsing
    const withProto = proxy.includes('://') ? proxy : `http://${proxy}`;
    const parsed = new URL(withProto);
    return {
      server: `${parsed.protocol}//${parsed.hostname}:${parsed.port || 80}`,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      username: parsed.username ? decodeURIComponent(parsed.username) : null,
      password: parsed.password ? decodeURIComponent(parsed.password) : null,
    };
  } catch {
    // Fallback: treat as host:port
    return { server: `http://${proxy}`, hostname: proxy.split(':')[0], username: null, password: null };
  }
}

/** The zone if Intl knows it — Lightpanda silently ignores one it doesn't. */
function validTimezone(timezone) {
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    console.warn(`[Browser] Invalid timezone "${timezone}" — using the server's`);
    return null;
  }
}

/**
 * --block-private-networks also stops Lightpanda from reaching a proxy on a private
 * address (squid on localhost, a VPN container on the Docker network), so exempt exactly
 * the addresses the proxy host resolves to.
 */
async function proxyCidrs(proxyInfo) {
  if (!proxyInfo) return [];
  const host = proxyInfo.hostname;
  const family = net.isIP(host);
  const addrs = family ? [{ address: host, family }] : await dns.promises.lookup(host, { all: true }).catch(() => []);
  return addrs.map((a) => `${a.address}/${a.family === 6 ? 128 : 32}`);
}

/**
 * Start a Lightpanda server for one crawl and connect Puppeteer to it.
 *
 * Unlike Chrome, these are process-wide Lightpanda options, which is why every crawl gets
 * its own process:
 *   timezone          Date/Intl zone (CDP Emulation.setTimezoneOverride is a no-op in Lightpanda)
 *   blockImages       don't request <img> at all (when loaded, Lightpanda reads ≤16 KB of each,
 *                     enough for load/error events and naturalWidth, never the whole image)
 *   crossOriginFetch  the "browser" image cache downloads images with fetch() inside the page;
 *                     CDN images are cross-origin, so CORS is switched off for the crawl. That
 *                     would let the page's own scripts read any reachable URL, so private
 *                     networks (localhost, LAN, cloud metadata) are blocked at the same time.
 *   waitTimeout       page timeout; single transfers may take as long (Lightpanda default 15 s)
 */
async function getBrowser(proxy, { timezone = null, blockImages = false, crossOriginFetch = false, waitTimeout = 0 } = {}) {
  const proxyInfo = parseProxy(proxy);

  // Stylesheets so computed styles (visibility checks, CSS-driven scripts) are real
  const loadResources = blockImages ? ['stylesheet'] : ['stylesheet', 'image'];

  const lp = await lightpanda.launch({
    proxy: proxyInfo ? proxyInfo.server : null,
    timezone: validTimezone(timezone),
    loadResources,
    httpTimeoutMs: Math.max(15000, waitTimeout || 0),
    disableCors: crossOriginFetch,
    blockPrivateNetworks: crossOriginFetch,
    allowCidrs: crossOriginFetch ? await proxyCidrs(proxyInfo) : [],
  });

  let browser;
  try {
    // defaultViewport null: Lightpanda reports a fixed 1920x1080 window; no emulation needed
    browser = await puppeteer.connect({ browserWSEndpoint: lp.wsEndpoint, defaultViewport: null });
  } catch (err) {
    await lightpanda.stop(lp.proc);
    throw err;
  }

  // Store proxy auth info on browser instance for page.authenticate()
  browser._proxyAuth = proxyInfo?.username ? { username: proxyInfo.username, password: proxyInfo.password } : null;
  browser._lightpanda = lp;

  // Closing means disconnecting AND stopping the server — Lightpanda keeps running after
  // its client leaves, and Puppeteer's own close() only sends Browser.close over CDP.
  browser.close = async () => {
    try {
      await browser.disconnect();
    } catch { /* connection already gone */ }
    await lightpanda.stop(lp.proc);
  };

  return browser;
}

// Lightpanda refuses to impersonate another browser: a User-Agent containing "Mozilla"
// is silently dropped (from setUserAgent and from extra headers alike) and the request
// goes out as Lightpanda. Say so once per value instead of letting it look applied.
const refusedUserAgents = new Set();
function warnRefusedUserAgent(ua) {
  if (refusedUserAgents.has(ua)) return;
  refusedUserAgents.add(ua);
  console.warn(`[Browser] Lightpanda ignores User-Agents containing "Mozilla" — "${ua}" is not used, requests identify as Lightpanda`);
}

async function createPage(browser, userAgent, customHeaders, cookies, localStorage) {
  const page = await browser.newPage();

  // Only override the UA when the admin explicitly configured one
  if (userAgent) {
    if (/mozilla/i.test(userAgent)) warnRefusedUserAgent(userAgent);
    else await page.setUserAgent(userAgent);
  }

  // Authenticate proxy if credentials were provided
  if (browser._proxyAuth) {
    await page.authenticate(browser._proxyAuth);
  }

  // Only send headers the admin configured
  if (customHeaders && typeof customHeaders === 'object' && Object.keys(customHeaders).length > 0) {
    const headers = {};
    for (const [k, v] of Object.entries(customHeaders)) {
      headers[k] = String(v);
      if (k.toLowerCase() === 'user-agent' && /mozilla/i.test(headers[k])) warnRefusedUserAgent(headers[k]);
    }
    await page.setExtraHTTPHeaders(headers);
  }

  // Set cookies if provided (must have name + domain for pre-navigation setCookie)
  if (cookies && Array.isArray(cookies) && cookies.length > 0) {
    const valid = cookies.filter(c => c.name && c.domain);
    if (valid.length > 0) await page.setCookie(...valid);
  }

  // Inject localStorage before page loads (runs on every navigation)
  if (localStorage && typeof localStorage === 'object' && Object.keys(localStorage).length > 0) {
    await page.evaluateOnNewDocument((items) => {
      for (const [key, value] of Object.entries(items)) {
        window.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }, localStorage);
  }

  return page;
}

/**
 * Execute pre-configured actions on a page (click, scroll, wait, type, etc.)
 * actions: Array of { type, selector?, value?, delay? }
 */
async function executeActions(page, actions) {
  if (!actions || !Array.isArray(actions)) return;

  for (const action of actions) {
    try {
      switch (action.type) {
        case 'wait':
          await delay(action.value || 1000);
          break;
        case 'wait_selector':
          await page.waitForSelector(action.selector, { timeout: action.timeout || 10000 });
          break;
        case 'click':
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
          }, action.selector);
          await delay(200);
          await page.click(action.selector);
          if (action.delay) await delay(action.delay);
          break;
        case 'scroll_to_bottom':
          await autoScroll(page);
          break;
        case 'scroll_by':
          await page.evaluate((y) => window.scrollBy(0, y), action.value || 500);
          if (action.delay) await delay(action.delay);
          break;
        case 'type':
          await page.type(action.selector, action.value, { delay: action.delay || 50 });
          break;
        case 'select':
          await page.select(action.selector, action.value);
          break;
        case 'evaluate':
          if (action.value) await page.evaluate(action.value);
          break;
        case 'screenshot':
          // Lightpanda has no graphical engine: this is a text-only rendering of the page
          await page.screenshot({ path: action.value || 'debug.png', fullPage: true });
          break;
        default:
          console.warn(`Unknown action type: ${action.type}`);
      }
    } catch (err) {
      console.error(`Action failed [${action.type}]: ${err.message}`);
    }
  }
}

async function autoScroll(page, maxDuration = 30000) {
  await page.evaluate(async (timeout) => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const start = Date.now();
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight || Date.now() - start > timeout) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  }, maxDuration);
}

/**
 * Detect Cloudflare challenge page and wait for it to resolve.
 */
async function waitForCloudflare(page, timeout = 30000) {
  const title = await page.title();
  const isCfChallenge = title.includes('Just a moment') || title.includes('Attention Required');
  if (!isCfChallenge) return false;

  console.log('[CF] Cloudflare challenge detected, waiting for resolution...');
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await delay(2000);
    const currentTitle = await page.title();
    if (!currentTitle.includes('Just a moment') && !currentTitle.includes('Attention Required')) {
      console.log('[CF] Challenge resolved');
      return true;
    }
  }
  console.warn('[CF] Challenge timeout - may not have resolved');
  return true;
}

/**
 * Extract cookies from the page for session persistence.
 *
 * Uses CDP Network.getAllCookies instead of page.cookies(): page.cookies() only
 * returns cookies whose path matches the current URL, so a cf_clearance (or any
 * cookie set on a different path/subdomain during the challenge) can be missed.
 * We keep only cookies for the page's domain and its parents (drop unrelated
 * third-party cookies from challenge iframes/analytics) and map them to the
 * shape page.setCookie() accepts on reuse.
 */
async function extractCookies(page) {
  let host = '';
  try { host = new URL(page.url()).hostname; } catch { /* keep '' */ }

  const domainMatches = (cookieDomain) => {
    if (!host) return true;
    const d = (cookieDomain || '').replace(/^\./, '');
    return !!d && (host === d || host.endsWith('.' + d));
  };
  const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
  const toPuppeteer = (c) => {
    const out = {
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly,
    };
    if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
    if (SAME_SITE.has(c.sameSite)) out.sameSite = c.sameSite;
    return out;
  };

  try {
    const client = await page.target().createCDPSession();
    const { cookies } = await client.send('Network.getAllCookies');
    await client.detach().catch(() => {});
    if (Array.isArray(cookies) && cookies.length) {
      const kept = cookies.filter(c => domainMatches(c.domain)).map(toPuppeteer);
      // If the domain filter left nothing (odd cookie domains), fall back to all cookies
      return kept.length ? kept : cookies.map(toPuppeteer);
    }
  } catch { /* CDP unavailable — fall back below */ }

  return page.cookies();
}

/**
 * Fetch a page with full JS rendering.
 * Returns the page object (caller must close browser).
 */
async function fetchPage(url, options = {}) {
  const { proxy, userAgent, waitFor, waitTimeout, scrollToBottom, actions, customJs, customHeaders, cookies, localStorage, blockImages, crossOriginFetch, timezone } = options;

  // Fail fast with a clear message on CAPTCHA/WAF interstitials (Settings → Crawl & Browser)
  const detectChallenges = db.getSetting('challenge_detection') !== '0';

  // Wait for available browser slot
  await acquireBrowserSlot();

  let browser;
  try {
    browser = await getBrowser(proxy, { timezone, blockImages, crossOriginFetch, waitTimeout });
  } catch (err) {
    releaseBrowserSlot(); // never acquired a browser to close later
    throw err;
  }

  // Wrap browser.close to release the slot (once)
  const originalClose = browser.close;
  let slotReleased = false;
  browser.close = async () => {
    try {
      await originalClose();
    } finally {
      // Even if closing throws — a leaked slot would eventually stall every crawl
      if (!slotReleased) { slotReleased = true; releaseBrowserSlot(); }
    }
  };

  // Everything from page creation onward is guarded so any early failure still closes
  // the browser (stopping its Lightpanda process) and frees the slot.
  try {
    const page = await createPage(browser, userAgent, customHeaders, cookies, localStorage);

    await page.goto(url, { waitUntil: 'networkidle2', timeout: waitTimeout || 30000 });

    let cfDetected = await waitForCloudflare(page, Math.min(waitTimeout || 30000, CF_WAIT_MS));
    if (cfDetected) {
      // After CF resolves, wait for content to load
      await delay(1000);
    }

    // Before waitFor, so a challenge page reports itself instead of failing the selector wait
    if (detectChallenges) {
      const detection = await detectCaptcha(page);
      if (detection.detected) {
        const e = new Error(`Challenge page detected (${detection.type}: ${detection.reason}). Lightpanda cannot pass CAPTCHA/WAF challenges — crawl this site with a Chrome-based crawler such as crawlkomik.`);
        e.captchaUnsolved = true; // non-retryable — every retry meets the same challenge
        throw e;
      }
    }

    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: waitTimeout || 30000 });
    }

    if (actions && actions.length > 0) {
      await executeActions(page, actions);
    }

    if (scrollToBottom) {
      await autoScroll(page);
    }

    if (customJs) {
      await page.evaluate(customJs);
    }

    return { page, browser, cfDetected };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * Fetch a page with simple HTTP (no browser, no JS rendering).
 * Returns a mock { page, browser, cfDetected } compatible with crawler.js.
 * Uses linkedom for DOM parsing + vm for evaluate() compatibility.
 */
async function fetchPageSimple(url, options = {}) {
  const { parseHTML } = require('linkedom');
  const vm = require('vm');
  const { userAgent, waitTimeout, customHeaders, cookies } = options;

  const headers = {
    'User-Agent': userAgent || DEFAULT_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
  };

  if (customHeaders && typeof customHeaders === 'object') {
    for (const [k, v] of Object.entries(customHeaders)) {
      headers[k] = String(v);
    }
  }

  if (cookies && Array.isArray(cookies) && cookies.length > 0) {
    headers['Cookie'] = cookies.filter(c => c.name).map(c => `${c.name}=${c.value}`).join('; ');
  }

  const response = await fetch(url, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(waitTimeout || 30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  const html = await response.text();
  const { document, window } = parseHTML(html);

  // Build vm context with DOM globals for page.evaluate() compatibility
  const context = vm.createContext({
    document, window,
    Array, Object, JSON, console, RegExp, Map, Set, Date, Math,
    Number, String, Boolean, Error, TypeError, RangeError,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    undefined, NaN, Infinity,
    setTimeout, clearTimeout, setInterval, clearInterval,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    URL, URLSearchParams,
  });

  const mockPage = {
    evaluate: async (fn, ...args) => {
      const code = `(${fn.toString()})(${args.map(a => JSON.stringify(a)).join(', ')})`;
      return vm.runInContext(code, context);
    },
    content: async () => html,
    url: () => url,
    cookies: async () => [],
  };

  const mockBrowser = {
    close: async () => {},
  };

  return { page: mockPage, browser: mockBrowser, cfDetected: false };
}

function getActiveBrowserCount() {
  return { active: activeBrowsers, queued: waitQueue.length, max: getMaxConcurrent() };
}

module.exports = {
  getBrowser,
  createPage,
  executeActions,
  autoScroll,
  fetchPage,
  fetchPageSimple,
  extractCookies,
  delay,
  DEFAULT_USER_AGENT,
  getActiveBrowserCount,
};
