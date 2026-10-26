const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const profileDirs = require('./profile-dirs');

puppeteer.use(StealthPlugin());

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const db = require('../models/database');
const { detectCaptcha } = require('./captcha-detector');
const captchaRegistry = require('./captcha-registry');
const captchaTakeover = require('./captcha-takeover');

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

// Number of sessions currently blocked waiting for a manual CAPTCHA solve. Each holds
// a browser slot, so we cap concurrent waits at (max - 1) to always reserve at least
// one slot for normal crawling — otherwise a burst of challenges freezes the pool.
let captchaWaiting = 0;
function captchaWaitCapacity() {
  return Math.max(1, getMaxConcurrent() - 1);
}

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
      host: `${parsed.hostname}:${parsed.port || 80}`,
      username: parsed.username ? decodeURIComponent(parsed.username) : null,
      password: parsed.password ? decodeURIComponent(parsed.password) : null,
    };
  } catch {
    // Fallback: treat as host:port
    return { host: proxy, username: null, password: null };
  }
}

async function getBrowser(proxy) {
  // Fresh throwaway profile per browser (a shared one hits SingletonLock conflicts).
  // It is deleted once Chrome has exited — see profile-dirs.js for why the old
  // cleanup leaked one dir per crawl until /tmp ran out of space.
  const userDataDir = await profileDirs.createProfileDir();

  const proxyInfo = parseProxy(proxy);

  // Headless is the default. Set browser_headless=0 to run headful — needed to pass
  // Cloudflare's environment checks (which reload-loop in headless even after a manual
  // solve). In Docker this requires a virtual display (Xvfb); see README.
  const headless = db.getSetting('browser_headless') === '0' ? false : true;

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-zygote',
    '--window-size=1920,1080',
    // Hides the navigator.webdriver / automation flag some WAFs (Cloudflare) key on
    '--disable-blink-features=AutomationControlled',
    // Chrome >= ~120 no longer falls back to software WebGL automatically, so on a
    // GPU-less server WebGL disappears entirely — and a browser with NO WebGL context
    // is a strong bot signal (real Chrome always has one). This restores it.
    '--enable-unsafe-swiftshader',
  ];
  // --disable-gpu kills the GPU process, and SwiftShader (software WebGL) runs inside
  // it — so in headful, where we're specifically trying to look like a real browser,
  // leave it off and let SwiftShader provide WebGL. Kept for headless, where it avoids
  // GPU-process trouble in containers and the fingerprint is already a lost cause.
  if (headless) {
    args.push('--disable-gpu');
  }
  if (proxyInfo) {
    args.push(`--proxy-server=${proxyInfo.host}`);
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless,
      args,
      userDataDir,
      // Chrome writes its own temp files (process-singleton socket dir, shared-memory
      // files under --disable-dev-shm-usage) to $TMPDIR. Inside the profile they are
      // deleted with it instead of piling up in /tmp when Chrome gets killed.
      env: { ...process.env, TMPDIR: profileDirs.chromeTmpDir(userDataDir) },
      // Headful: use the REAL window size (null) instead of an Emulation viewport override.
      // An override makes window.outerWidth/Height smaller than innerWidth/Height, which is
      // impossible in a real browser and is exactly the kind of mismatch Cloudflare flags —
      // so turning headless off alone would still fail the challenge.
      defaultViewport: headless ? { width: 1920, height: 1080 } : null,
    });
  } catch (err) {
    profileDirs.releaseProfileDir(userDataDir, null); // launch failed — don't leave the profile behind
    throw err;
  }

  // Store proxy auth info on browser instance for page.authenticate()
  browser._proxyAuth = proxyInfo?.username ? { username: proxyInfo.username, password: proxyInfo.password } : null;

  // Delete the profile once the Chrome process has exited (closed, crashed or killed)
  profileDirs.releaseProfileDir(userDataDir, browser.process());

  return browser;
}

// Build UA-client-hint metadata (sec-ch-ua*) that matches a UA string, so overriding
// the UA doesn't leave the client hints inconsistent (or absent) — a signal WAFs flag.
function uaClientHints(ua) {
  const platform = /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua) ? 'macOS'
    : /Android/i.test(ua) ? 'Android'
    : /(CrOS)/i.test(ua) ? 'Chrome OS'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Windows';
  const platformVersion = platform === 'Windows' ? '10.0.0'
    : platform === 'macOS' ? '13.0.0'
    : platform === 'Android' ? '13.0.0'
    : '';
  const mobile = /Mobile|Android/i.test(ua);
  const v = (ua.match(/Chrome\/([\d.]+)/) || [])[1];
  const major = v ? v.split('.')[0] : '';
  // CDP Network.setUserAgentOverride requires the full metadata shape
  const meta = {
    platform,
    platformVersion,
    architecture: mobile ? '' : 'x86',
    bitness: mobile ? '' : '64',
    model: '',
    mobile,
    wow64: false,
  };
  if (major) {
    meta.brands = [
      { brand: 'Google Chrome', version: major },
      { brand: 'Chromium', version: major },
      { brand: 'Not_A Brand', version: '24' },
    ];
    const full = v.includes('.') ? v : `${major}.0.0.0`;
    meta.fullVersionList = [
      { brand: 'Google Chrome', version: full },
      { brand: 'Chromium', version: full },
      { brand: 'Not_A Brand', version: '24.0.0.0' },
    ];
  }
  return meta;
}

async function createPage(browser, userAgent, customHeaders, cookies, localStorage, timezone) {
  const page = await browser.newPage();

  // Match the browser clock to where the traffic appears to come from. Containers run
  // in UTC, so a proxy in another country leaves IP geolocation and the page's timezone
  // disagreeing — a geo-consistency mismatch WAFs check, and one that a residential
  // proxy alone does NOT fix. Locale is deliberately left alone: overriding it makes
  // navigator.language and navigator.languages disagree, which is worse than the default.
  if (timezone) {
    try {
      await page.emulateTimezone(timezone);
    } catch (err) {
      console.warn(`[Browser] Invalid timezone "${timezone}": ${err.message}`);
    }
  }

  // Only override the UA when the admin explicitly configured one. Otherwise leave the
  // puppeteer-extra-stealth managed UA in place — it strips "HeadlessChrome" AND keeps
  // sec-ch-ua / sec-ch-ua-platform consistent. Forcing a bare UA string here previously
  // WIPED those client hints (and claimed Windows on a Linux box), which Cloudflare flags
  // as a bot → the challenge reload-loops even after a correct manual solve.
  if (userAgent) {
    await page.setUserAgent(userAgent, uaClientHints(userAgent));
  }

  // Authenticate proxy if credentials were provided
  if (browser._proxyAuth) {
    await page.authenticate(browser._proxyAuth);
  }

  // Only send headers the admin configured. We used to always inject
  // "Accept-Language: en-US,en;q=0.9,id;q=0.8", but navigator.languages stays
  // ["en-US","en"] — so the header advertised a language the JS environment didn't
  // have. Real browsers are always consistent there, and that mismatch is exactly
  // what a WAF compares. Chrome's own Accept-Language already matches.
  if (customHeaders && typeof customHeaders === 'object' && Object.keys(customHeaders).length > 0) {
    const headers = {};
    for (const [k, v] of Object.entries(customHeaders)) {
      headers[k] = String(v);
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
  const { proxy, userAgent, waitFor, waitTimeout, scrollToBottom, actions, customJs, customHeaders, cookies, localStorage, blockImages, sessionMeta, timezone } = options;

  // Manual CAPTCHA takeover — only active (and only adds overhead) when enabled in admin
  const manualCaptcha = db.getSetting('captcha_manual_enabled') === '1';

  // Wait for available browser slot
  await acquireBrowserSlot();

  let browser;
  try {
    browser = await getBrowser(proxy);
  } catch (err) {
    releaseBrowserSlot(); // never acquired a browser to close later
    throw err;
  }

  // Wrap browser.close to release the slot + finalize the captcha session (release once)
  const originalClose = browser.close.bind(browser);
  let slotReleased = false;
  browser.close = async () => {
    const s = browser._captchaSession;
    if (s) captchaRegistry.finish(s.id, 'done');
    try {
      await originalClose();
    } finally {
      // Even if closing throws — a leaked slot would eventually stall every crawl
      if (!slotReleased) { slotReleased = true; releaseBrowserSlot(); }
    }
  };

  // Everything from page creation onward is guarded so any early failure (createPage,
  // registration, request interception) still closes the browser and frees the slot,
  // and marks the session failed instead of leaving it stranded as 'running'.
  let captchaSession = null;
  try {
    const page = await createPage(browser, userAgent, customHeaders, cookies, localStorage, timezone);

    // Register the crawl session so the admin dashboard can see/queue it
    if (manualCaptcha) {
      captchaSession = captchaRegistry.register({
        website: sessionMeta?.website,
        pageType: sessionMeta?.pageType,
        url,
        page,
      });
      browser._captchaSession = captchaSession;
    }

    // Block image loading if configured (speeds up page load for non-image pages).
    // page._allowImages is flipped on during a manual CAPTCHA solve so challenge
    // assets (e.g. reCAPTCHA image tiles) still load.
    if (blockImages) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.resourceType() === 'image' && !page._allowImages) {
          req.abort();
        } else {
          req.continue();
        }
      });
    }

    await page.goto(url, { waitUntil: 'networkidle2', timeout: waitTimeout || 30000 });

    // Passive Cloudflare wait (stealth auto-resolve). Shortened when manual takeover
    // is enabled so the admin is handed control quickly instead of waiting the full timeout.
    let cfDetected = await waitForCloudflare(page, manualCaptcha ? 8000 : (waitTimeout || 30000));
    if (cfDetected) {
      // After CF resolves, wait for content to load
      await delay(1000);
    }

    // Manual CAPTCHA takeover — runs before waitFor so a challenge page doesn't
    // fail the selector wait. Handles CF/Turnstile/reCAPTCHA/hCaptcha/text challenges.
    if (manualCaptcha) {
      const detection = await detectCaptcha(page);
      if (detection.detected) {
        // Reserve a slot for normal crawling — refuse to wait if too many already are.
        if (captchaWaiting >= captchaWaitCapacity()) {
          const e = new Error(`CAPTCHA detected (${detection.type}) but manual-solve capacity is full (${captchaWaiting}/${captchaWaitCapacity()} slots waiting)`);
          e.captchaUnsolved = true; // non-retryable
          throw e;
        }
        if (blockImages) {
          // Let challenge assets load, and stop intercepting entirely: every intercepted
          // request round-trips to Node, and that added latency is measurable by the
          // challenge's own timing checks. Re-enabled after the solve.
          page._allowImages = true;
          try { await page.setRequestInterception(false); } catch { /* keep going */ }
        }
        const timeoutMs = parseInt(db.getSetting('captcha_timeout_ms')) || 180000;
        captchaWaiting++;
        let solve;
        try {
          solve = await captchaTakeover.waitForManualSolve(page, captchaSession, detection, { timeoutMs });
        } finally {
          captchaWaiting--;
          await captchaTakeover.teardownCdp(captchaSession);
        }
        if (!solve.solved) {
          const e = new Error(`CAPTCHA not solved (${detection.type}): ${solve.reason}`);
          e.captchaUnsolved = true; // non-retryable — don't re-run the whole wait
          throw e;
        }
        // Manual/auto solve succeeded — persist the session cookies the challenge set
        cfDetected = true;
        // Let Cloudflare finish its post-clearance reload/redirect before scraping,
        // so we don't extract a transitional page.
        await delay(1000);
        try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }); } catch { /* proceed anyway */ }
        // Restore image blocking for the rest of the crawl
        if (blockImages) {
          page._allowImages = false;
          try { await page.setRequestInterception(true); } catch { /* keep going */ }
        }
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
    if (captchaSession) captchaRegistry.finish(captchaSession.id, 'failed', err.message);
    await browser.close();
    throw err;
  }
}

/**
 * Fetch a page with simple HTTP (no Puppeteer, no JS rendering).
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
