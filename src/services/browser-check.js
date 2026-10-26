/**
 * Lightpanda self-check (/admin/browser-check).
 *
 * Answers "does the crawl browser work on this server, and how does it present itself?"
 * — binary and version, start-up, JavaScript, cookies, the User-Agent it really sends and
 * the timezone it reports. For a website it also opens the base URL with that website's
 * proxy / User-Agent / headers / cookies and says whether a challenge page came back,
 * which Lightpanda cannot get past.
 *
 * Every check reports { name, ok, value, note } so the admin can act on it.
 */

const http = require('http');
const db = require('../models/database');
const lightpanda = require('./lightpanda');
const { getBrowser, createPage } = require('./browser');
const { detectCaptcha } = require('./captcha-detector');

const SITE_TIMEOUT_MS = 30000;

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

// Never show proxy credentials (user:pass@)
function hideCreds(proxy) {
  return String(proxy || '').replace(/\/\/[^@/]*@/, '//').replace(/^[^/@]*@/, '');
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

  // 2. The website itself, exactly as a crawl would open it
  if (website && p) {
    const proxyLabel = website.proxy ? ` lewat proxy ${hideCreds(website.proxy)}` : '';
    let browser;
    try {
      browser = await getBrowser(website.proxy || null, { timezone, waitTimeout: SITE_TIMEOUT_MS });
      const page = await createPage(browser, userAgent, customHeaders, parseJson(website.cookies, []), parseJson(website.local_storage, {}));
      const started = Date.now();
      const resp = await page.goto(website.base_url, { waitUntil: 'networkidle2', timeout: SITE_TIMEOUT_MS });
      const challenge = await detectCaptcha(page);
      raw.site = {
        url: page.url(),
        status: resp ? resp.status() : null,
        title: await page.title(),
        loadMs: Date.now() - started,
        challenge: challenge.detected ? { type: challenge.type, reason: challenge.reason } : null,
      };
      const status = raw.site.status;
      add('Website bisa dibuka', status !== null && status < 400,
        `HTTP ${status === null ? '?' : status} dalam ${raw.site.loadMs} ms${proxyLabel} — "${raw.site.title}"`,
        `Base URL menjawab HTTP ${status}. Cek URL-nya, atau situs menolak Lightpanda / IP server${website.proxy ? ' / proxy' : ''}.`);
      add('Tidak ada halaman challenge', !challenge.detected,
        challenge.detected ? `${challenge.type}: ${challenge.reason}` : 'tidak terdeteksi',
        'Situs ini memasang CAPTCHA/WAF (mis. Cloudflare). Lightpanda tidak bisa melewatinya — crawl situs ini dengan crawler berbasis Chrome seperti crawlkomik.');
    } catch (err) {
      add('Website bisa dibuka', false, `${err.message}${proxyLabel}`,
        `Gagal membuka ${website.base_url}. Cek URL${website.proxy ? ' dan proxy' : ''}-nya.`);
    } finally {
      if (browser) await browser.close();
    }
  }

  const problems = checks.filter(c => !c.ok);
  return {
    website: website ? { name: website.name, baseUrl: website.base_url, userAgentSet: !!website.user_agent, proxySet: !!website.proxy } : null,
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
