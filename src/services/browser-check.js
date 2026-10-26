/**
 * Lightpanda self-check (/admin/browser-check).
 *
 * Answers "does the crawl browser work on this server, and how does it present itself?"
 * — binary and version, start-up, JavaScript, cookies, the User-Agent it really sends and
 * the timezone it reports. For a website it also opens the base URL with that website's
 * User-Agent / headers / cookies through each of its proxies (feeding the results into
 * the rotation's health state) and says whether a challenge page came back, which
 * Lightpanda cannot get past.
 *
 * Every check reports { name, ok, value, note } so the admin can act on it.
 */

const http = require('http');
const db = require('../models/database');
const lightpanda = require('./lightpanda');
const proxyPool = require('./proxy-pool');
const { getBrowser, createPage } = require('./browser');
const { detectCaptcha } = require('./captcha-detector');

const SITE_TIMEOUT_MS = 30000;
const MAX_PROXIES_CHECKED = 10;
const PROXY_CHECK_CONCURRENCY = 3;

/**
 * Serve a throwaway page on 127.0.0.1 so we see the request headers the browser really
 * sends, and can check that a Set-Cookie comes back through document.cookie.
 */
async function withProbePage(fn) {
  let captured = {};
  const srv = http.createServer((req, res) => {
    captured = { ...req.headers };
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Set-Cookie', 'pc_probe=1; Path=/');
    res.end('<html><head><title>probe</title></head><body>probe<script>window.__probe = 1 + 1;</script></body></html>');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/`, () => captured);
  } finally {
    srv.close();
  }
}

function parseJson(text, fallback) {
  try {
    const parsed = JSON.parse(text || '');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Run fn over items, at most `limit` at a time; results keep the input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Open a URL the way a crawl would, through one proxy (or none). */
async function openSite(url, proxy, { userAgent, customHeaders, cookies, localStorage, timezone }) {
  const browser = await getBrowser(proxy, { timezone, waitTimeout: SITE_TIMEOUT_MS });
  try {
    const page = await createPage(browser, userAgent, customHeaders, cookies, localStorage);
    const started = Date.now();
    const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: SITE_TIMEOUT_MS });
    const status = resp ? resp.status() : null;
    if (status === 407) throw new Error('Proxy rejected the credentials (HTTP 407)');
    const challenge = await detectCaptcha(page);
    return {
      url: page.url(),
      status,
      title: await page.title(),
      loadMs: Date.now() - started,
      challenge: challenge.detected ? { type: challenge.type, reason: challenge.reason } : null,
    };
  } finally {
    await browser.close();
  }
}

/**
 * @param {string} [websiteName] check with this website's User-Agent / custom headers /
 *   timezone, and open its base URL through its proxy.
 */
async function runBrowserCheck(websiteName) {
  let website = null;
  if (websiteName) {
    website = db.getWebsiteByName(websiteName);
    if (!website) throw new Error(`Website "${websiteName}" not found`);
  }
  const userAgent = website ? (website.user_agent || null) : null;
  const customHeaders = website ? parseJson(website.custom_headers, {}) : {};
  const timezone = website ? (website.timezone || null) : null;

  const checks = [];
  const add = (name, ok, value, note) => checks.push({ name, ok, value, note: ok ? null : note });
  const raw = { executable: lightpanda.executablePath(), version: null, probe: null, site: null };

  add('Lightpanda terpasang', !!raw.executable, raw.executable || '(tidak ditemukan)',
    'Binary "lightpanda" tidak ada di PATH. Image Docker sudah memasangnya (rebuild image); di bare metal unduh dari github.com/lightpanda-io/browser/releases atau set LIGHTPANDA_EXECUTABLE_PATH.');

  if (raw.executable) {
    raw.version = await lightpanda.getVersion();
    add('Versi Lightpanda', !!raw.version, raw.version || '(gagal dijalankan)',
      '`lightpanda version` gagal. Release Linux butuh glibc — di Alpine/musl tidak bisa jalan; pakai base image Debian/Ubuntu.');

    // 1. Local probe — no proxy, so it measures the browser itself
    try {
      raw.probe = await withProbePage(async (probeUrl, getHeaders) => {
        const started = Date.now();
        const browser = await getBrowser(null, { timezone });
        const startMs = Date.now() - started;
        try {
          const page = await createPage(browser, userAgent, customHeaders, [], {});
          await page.goto(probeUrl, { waitUntil: 'load', timeout: 15000 });
          const seen = await page.evaluate(() => ({
            ua: navigator.userAgent,
            languages: navigator.languages,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            tzOffsetMin: new Date().getTimezoneOffset(),
            js: window.__probe === 2,
            cookie: document.cookie,
          }));
          return { startMs, ...seen, sentHeaders: getHeaders() };
        } finally {
          await browser.close();
        }
      });
    } catch (err) {
      add('Browser bisa dijalankan', false, err.message,
        'Lightpanda gagal start atau gagal membuka halaman lokal. Lihat pesan error di atas.');
    }
  }

  const p = raw.probe;
  if (p) {
    add('Browser bisa dijalankan', true, `start ${p.startMs} ms`);
    add('JavaScript jalan', p.js, String(p.js), 'Script di halaman tidak dijalankan.');
    add('Cookie tersimpan', /(^|;\s*)pc_probe=1/.test(p.cookie || ''), p.cookie || '(kosong)',
      'Cookie dari Set-Cookie tidak terbaca lagi lewat document.cookie.');

    const sentUa = p.sentHeaders['user-agent'] || p.ua;
    if (userAgent && /mozilla/i.test(userAgent)) {
      add('User-Agent website dipakai', false, sentUa,
        `Lightpanda menolak User-Agent yang mengandung "Mozilla" (tidak mau menyamar jadi browser lain), jadi "${userAgent}" diabaikan. Kosongkan field User Agent, atau isi UA tanpa kata Mozilla.`);
    } else if (userAgent) {
      add('User-Agent website dipakai', sentUa === userAgent, sentUa, `UA "${userAgent}" tidak terkirim.`);
    } else {
      add('User-Agent', true, sentUa);
    }

    const tzLabel = `${p.timezone} (UTC${p.tzOffsetMin > 0 ? '-' : '+'}${Math.abs(p.tzOffsetMin) / 60})`;
    if (timezone) {
      add('Timezone website dipakai', p.timezone === timezone, tzLabel,
        `Timezone "${timezone}" tidak dipakai browser — cek ejaan nama IANA-nya (mis. Asia/Jakarta).`);
    } else {
      add('Timezone browser', true, tzLabel);
    }
  }

  // 2. The website itself, exactly as a crawl would open it — through each of its proxies
  if (website && p) {
    const proxies = proxyPool.parseProxyList(website.proxy);
    const targets = proxies.length ? proxies.slice(0, MAX_PROXIES_CHECKED) : [null];
    const pageSetup = { userAgent, customHeaders, cookies: parseJson(website.cookies, []), localStorage: parseJson(website.local_storage, {}), timezone };

    raw.site = await mapLimit(targets, PROXY_CHECK_CONCURRENCY, async (proxy) => {
      const via = proxy ? proxyPool.displayOf(proxy) : null;
      try {
        const result = await openSite(website.base_url, proxy, pageSetup);
        if (proxy) proxyPool.reportSuccess(proxy);
        return { proxy: via, ...result };
      } catch (err) {
        if (proxy) proxyPool.reportFailure(proxy, err.message); // the check counts as real use
        return { proxy: via, error: err.message };
      }
    });

    raw.site.forEach((r, i) => {
      const name = proxies.length ? `Website lewat proxy ${i + 1} (${r.proxy})` : 'Website bisa dibuka';
      if (r.error) {
        add(name, false, r.error, proxies.length
          ? 'Proxy ini tidak bisa dipakai — cek alamat, port dan user/password-nya, atau proxy-nya sedang mati. Saat crawl, proxy yang gagal otomatis dilewati.'
          : `Gagal membuka ${website.base_url}. Cek URL-nya.`);
        return;
      }
      add(name, r.status !== null && r.status < 400,
        `HTTP ${r.status === null ? '?' : r.status} dalam ${r.loadMs} ms — "${r.title}"${r.challenge ? ` — challenge ${r.challenge.type}` : ''}`,
        `Base URL menjawab HTTP ${r.status}. Cek URL-nya, atau situs menolak Lightpanda / IP ${proxies.length ? 'proxy ini' : 'server'}.`);
    });
    if (proxies.length > MAX_PROXIES_CHECKED) {
      add('Proxy lain', true, `${proxies.length - MAX_PROXIES_CHECKED} proxy berikutnya tidak dicek (maks. ${MAX_PROXIES_CHECKED})`);
    }

    const loaded = raw.site.filter((r) => !r.error);
    const challenged = loaded.filter((r) => r.challenge);
    if (loaded.length) {
      add('Tidak ada halaman challenge', !challenged.length,
        challenged.length
          ? `${challenged[0].challenge.type}: ${challenged[0].challenge.reason}${loaded.length > 1 ? ` (${challenged.length} dari ${loaded.length} proxy)` : ''}`
          : 'tidak terdeteksi',
        'Situs ini memasang CAPTCHA/WAF (mis. Cloudflare). Lightpanda tidak bisa melewatinya — crawl situs ini dengan crawler berbasis Chrome seperti crawlkomik.');
    }
  }

  const problems = checks.filter(c => !c.ok);
  return {
    website: website ? { name: website.name, baseUrl: website.base_url, userAgentSet: !!website.user_agent, proxies: proxyPool.parseProxyList(website.proxy).length, proxyRotation: website.proxy_rotation || 'round_robin' } : null,
    status: problems.length === 0 ? 'clean' : 'issues',
    summary: problems.length === 0
      ? 'Lightpanda siap dipakai untuk crawl.'
      : `${problems.length} pemeriksaan gagal — perbaiki dari yang paling atas.`,
    problems: problems.length,
    checks,
    raw,
  };
}

module.exports = { runBrowserCheck };
