/**
 * Fingerprint self-check for the crawl browser.
 *
 * Launches a browser exactly the way crawling does, then reports the signals WAFs
 * (Cloudflare in particular) key on. Point of this module: when a challenge keeps
 * looping, stop guessing — see which signals are actually bad on THIS server.
 *
 * Every check reports { ok, value, note } so the admin can act on it.
 */

const http = require('http');
const db = require('../models/database');
const { getBrowser, createPage } = require('./browser');

const SOFTWARE_RENDERERS = /swiftshader|llvmpipe|softpipe|mesa offscreen|basic render/i;

/**
 * Run the probe against a throwaway local page rather than about:blank.
 * Two reasons: we get to see the request headers the browser really sends, and
 * 127.0.0.1 counts as a secure context — several APIs (navigator.userAgentData,
 * navigator.deviceMemory) simply don't exist on about:blank, which made a healthy
 * browser look like it was missing them.
 */
async function withProbePage(fn) {
  let captured = {};
  const srv = http.createServer((req, res) => {
    captured = { ...req.headers };
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><head><title>probe</title></head><body>probe</body></html>');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}/`, () => captured);
  } finally {
    srv.close();
  }
}

/**
 * @param {string} [websiteName] check using this website's User-Agent / custom headers
 *   / proxy, so a per-website override that breaks the fingerprint is visible too.
 */
async function runFingerprintCheck(websiteName) {
  const headlessSetting = db.getSetting('browser_headless') !== '0';

  let website = null;
  let customHeaders = {};
  if (websiteName) {
    website = db.getWebsiteByName(websiteName);
    if (!website) throw new Error(`Website "${websiteName}" not found`);
    try {
      const parsed = JSON.parse(website.custom_headers || '{}');
      if (parsed && typeof parsed === 'object') customHeaders = parsed;
    } catch { /* invalid JSON — treated as none */ }
  }

  const browser = await getBrowser(website ? (website.proxy || null) : null);

  try {
    return await withProbePage(async (probeUrl, getHeaders) => {
    const page = await createPage(browser, website ? (website.user_agent || null) : null, customHeaders, [], {}, website ? (website.timezone || null) : null);
    try {
      await page.goto(probeUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    } catch {
      await page.goto('about:blank'); // fall back; header checks will be skipped
    }
    const sentHeaders = getHeaders();

    const raw = await page.evaluate(() => {
      const gl = (() => {
        try {
          const canvas = document.createElement('canvas');
          const c = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (!c) return { hasWebgl: false, hasWebgl2: false, vendor: null, renderer: null };
          // A canvas keeps the first context type it was given, so webgl2 must be
          // probed on a SEPARATE canvas — otherwise it always looks unsupported.
          const hasWebgl2 = !!document.createElement('canvas').getContext('webgl2');
          const d = c.getExtension('WEBGL_debug_renderer_info');
          return {
            hasWebgl: true,
            hasWebgl2,
            vendor: d ? c.getParameter(d.UNMASKED_VENDOR_WEBGL) : null,
            renderer: d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null,
          };
        } catch { return { hasWebgl: false, hasWebgl2: false, vendor: null, renderer: null }; }
      })();
      // Font enumeration, the same way a fingerprinting script does it: render a
      // string in the candidate font and see whether the metrics differ from the
      // generic fallback. Names that fontconfig aliases (Arial -> Liberation Sans)
      // count as present, which is exactly what the fingerprint sees.
      const fonts = (() => {
        try {
          const BASES = ['monospace', 'sans-serif', 'serif'];
          const span = document.createElement('span');
          span.style.cssText = 'position:absolute;left:-9999px;font-size:72px;white-space:nowrap';
          span.textContent = 'mmmmmmmmmmlli';
          document.body.appendChild(span);
          const baseline = {};
          for (const base of BASES) {
            span.style.fontFamily = base;
            baseline[base] = [span.offsetWidth, span.offsetHeight];
          }
          const has = (font) => BASES.some((base) => {
            span.style.fontFamily = `'${font}',${base}`;
            return span.offsetWidth !== baseline[base][0] || span.offsetHeight !== baseline[base][1];
          });
          const win = ['Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Tahoma', 'Georgia', 'Segoe UI', 'Calibri'].filter(has);
          const other = ['DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'FreeSans', 'Ubuntu'].filter(has);
          span.remove();
          return { windows: win, other, total: win.length + other.length };
        } catch { return { windows: [], other: [], total: 0 }; }
      })();

      return {
        ua: navigator.userAgent,
        platform: navigator.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        tzOffsetMin: new Date().getTimezoneOffset(),
        fonts,
        webdriver: navigator.webdriver,
        inner: [window.innerWidth, window.innerHeight],
        outer: [window.outerWidth, window.outerHeight],
        screen: [screen.width, screen.height],
        dpr: window.devicePixelRatio,
        gl,
        cores: navigator.hardwareConcurrency,
        memory: navigator.deviceMemory || null,
        plugins: navigator.plugins.length,
        languages: navigator.languages,
        uaBrands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand) : null,
      };
    });

    const checks = [];
    const add = (name, ok, value, note) => checks.push({ name, ok, value, note: ok ? null : note });

    add('Mode browser', !headlessSetting, headlessSetting ? 'headless' : 'headful',
      'Headless hampir selalu gagal cek environment Cloudflare. Matikan "Headless browser" di Crawl Settings (butuh Xvfb di Docker).');

    add('User-Agent tanpa token "Headless"', !/headless/i.test(raw.ua), raw.ua,
      'UA mengandung "HeadlessChrome" — langsung dikenali bot.');

    add('navigator.webdriver = false', raw.webdriver === false || raw.webdriver === undefined,
      String(raw.webdriver), 'navigator.webdriver true = otomasi terdeteksi.');

    const vpGtScreen = raw.inner[0] > raw.screen[0] || raw.inner[1] > raw.screen[1];
    add('Viewport tidak lebih besar dari screen', !vpGtScreen,
      `viewport ${raw.inner.join('x')} vs screen ${raw.screen.join('x')}`,
      'Viewport lebih besar dari layar itu MUSTAHIL di browser nyata. Ini sinyal kuat dan hanya hilang kalau jalan headful (dengan display/Xvfb).');

    const outerLtInner = raw.outer[0] < raw.inner[0] || raw.outer[1] < raw.inner[1];
    add('Jendela luar tidak lebih kecil dari viewport', !outerLtInner,
      `outer ${raw.outer.join('x')} vs inner ${raw.inner.join('x')}`,
      'outer < inner juga mustahil di browser nyata (efek override viewport).');

    // Two different problems, two different fixes — don't conflate them:
    //  (a) no WebGL context at all  -> strong bot signal, fixable with launch flags
    //  (b) WebGL present but software-rendered -> weaker signal, unavoidable without a GPU
    if (!raw.gl.hasWebgl) {
      add('WebGL tersedia', false, '(tidak ada WebGL sama sekali)',
        'Browser tanpa WebGL = sinyal bot kuat (Chrome asli selalu punya WebGL). Sejak Chrome ~120 software WebGL perlu flag `--enable-unsafe-swiftshader` (sudah ditambahkan di kode — rebuild image). Di Alpine juga butuh paket chromium-swiftshader / mesa-dri-gallium.');
    } else {
      const software = SOFTWARE_RENDERERS.test(raw.gl.renderer || '');
      add('WebGL tersedia', true, raw.gl.renderer || '(renderer tidak terbaca)');
      add('GPU bukan software renderer', !software, raw.gl.renderer || '(renderer tidak terbaca)',
        'Renderer software (SwiftShader/llvmpipe) menandakan server tanpa GPU — dinilai agak mencurigakan, tapi jauh lebih baik daripada tidak ada WebGL. Sulit dihindari di VPS.');
    }

    if (raw.gl.hasWebgl) {
      add('WebGL2 tersedia', raw.gl.hasWebgl2 === true, String(raw.gl.hasWebgl2),
        'Chrome asli selalu mendukung WebGL2. Kalau tidak ada, library GL software di image kurang lengkap (paket chromium-swiftshader / mesa-dri-gallium).');
    }

    add('Jumlah CPU core wajar', (raw.cores || 0) >= 2, String(raw.cores),
      'hardwareConcurrency sangat rendah sering dipakai sebagai sinyal bot.');

    // The stealth layer presents the browser as Windows; the fonts on disk must not
    // contradict that, because font enumeration is a standard fingerprinting input.
    const claimsWindows = /Windows/i.test(raw.ua) || /Win/i.test(raw.platform || '');
    if (claimsWindows) {
      add('Font Windows tersedia (UA mengaku Windows)', raw.fonts.windows.length >= 2,
        `${raw.fonts.windows.length} font: ${JSON.stringify(raw.fonts.windows)}`,
        'Browser mengaku Windows tapi tidak punya font Windows — font fingerprinting (dipakai Turnstile) langsung melihat kontradiksi ini. Install paket font di image: ttf-liberation (alias Arial/Times New Roman/Courier New) + font-noto, lalu rebuild.');
    }
    add('Jumlah font wajar', raw.fonts.total >= 3,
      `${raw.fonts.total} terdeteksi (windows: ${raw.fonts.windows.length}, lain: ${raw.fonts.other.length})`,
      'Mesin nyata punya banyak font. Container dengan 1-2 font itu sendiri sudah mencurigakan — install ttf-liberation, font-noto, ttf-dejavu.');

    // Geo consistency: a proxy moves the apparent IP location, but the container clock
    // stays UTC — so IP geolocation and the page's timezone disagree. This is the gap a
    // residential proxy alone does NOT close.
    const tzIsUtc = /^(UTC|GMT|Etc\/(UTC|GMT|Greenwich))$/i.test(raw.timezone || '') || raw.tzOffsetMin === 0;
    const proxyConfigured = !!(website && website.proxy);
    if (proxyConfigured) {
      add('Timezone cocok dengan negara proxy', !tzIsUtc,
        `${raw.timezone} (UTC${raw.tzOffsetMin > 0 ? '-' : '+'}${Math.abs(raw.tzOffsetMin) / 60})`,
        'Proxy membuat IP terlihat dari negara lain, tapi jam browser masih UTC — geolokasi IP dan timezone bertentangan. Isi field Timezone di form website sesuai negara proxy (mis. Asia/Singapore untuk proxy SG).');
    } else {
      add('Timezone browser', true, `${raw.timezone} (UTC${raw.tzOffsetMin > 0 ? '-' : '+'}${Math.abs(raw.tzOffsetMin) / 60})`);
    }

    // Header-based checks — only meaningful when the probe page was actually reached
    const accLang = sentHeaders['accept-language'];
    if (accLang) {
      const headerTags = accLang.split(',').map(s => s.split(';')[0].trim()).filter(Boolean);
      const navTags = raw.languages || [];
      const extra = headerTags.filter(t => !navTags.includes(t));
      add('Accept-Language konsisten dengan navigator.languages', extra.length === 0,
        `header "${accLang}" vs navigator.languages ${JSON.stringify(navTags)}`,
        `Header memuat bahasa yang tidak ada di navigator.languages (${extra.join(', ')}). Di browser nyata keduanya selalu sama, jadi ini sinyal bot. Kosongkan Accept-Language di Custom Headers website, atau samakan dengan navigator.languages.`);
    }

    if (Object.keys(sentHeaders).length > 0) {
      add('Client hints (sec-ch-ua) terkirim', !!sentHeaders['sec-ch-ua'],
        sentHeaders['sec-ch-ua'] || '(tidak terkirim)',
        'Chrome asli selalu mengirim sec-ch-ua. Hilangnya biasanya karena User-Agent di-override tanpa metadata yang cocok — kosongkan field User Agent di website.');
    }

    add('Virtual display tersedia (DISPLAY)', !!process.env.DISPLAY, process.env.DISPLAY || '(tidak diset)',
      'Tanpa DISPLAY, mode headful tidak bisa jalan. Di Docker sudah otomatis (:99); di bare metal jalankan lewat xvfb-run.');

    const problems = checks.filter(c => !c.ok);
    return {
      website: website ? { name: website.name, userAgentSet: !!website.user_agent, proxySet: !!website.proxy } : null,
      status: problems.length === 0 ? 'clean' : 'issues',
      summary: problems.length === 0
        ? 'Fingerprint browser bersih. Kalau Cloudflare masih loop, penyebabnya kemungkinan besar di luar browser: reputasi IP (datacenter/VPS) atau fingerprint TLS. Pakai residential proxy, atau reuse cf_clearance dari browser asli (UA + IP harus sama).'
        : `${problems.length} sinyal bermasalah — perbaiki dari yang paling atas.`,
      problems: problems.length,
      checks,
      raw: { ...raw, sentHeaders },
    };
    });
  } finally {
    await browser.close();
  }
}

module.exports = { runFingerprintCheck };
