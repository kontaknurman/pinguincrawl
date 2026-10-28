const { fetchPage, fetchPageSimple, extractCookies } = require('./browser');
const db = require('../models/database');
const { cacheImagesFromPage, cacheImage, cacheImageNode, cacheImageData, cacheImagesNode } = require('./image-proxy');
const proxyPool = require('./proxy-pool');

// Page types whose crawl never caches images (no cover / chapter / custom-field images)
const NO_IMAGE_PAGE_TYPES = ['katalog', 'chapter_list'];

// How many other proxies one request may fall back to after a proxy failure
const MAX_PROXY_SWITCHES = 3;

/**
 * Build options for fetchPage from website + page config.
 */
function buildFetchOptions(website, pageConfig) {
  // Per-config proxy override: 0=use website default, 1=force on, 2=force off
  const proxyOverride = pageConfig?.use_proxy ?? 0;
  // The website's choice: its own proxies / WireGuard configs, or the global default; the
  // rotation treats both kinds alike. Force ON on a website without any takes the default's.
  let selection = proxyOverride === 2 ? { entries: [], rotation: 'round_robin' } : proxyPool.selectionFor(website);
  if (proxyOverride === 1 && !selection.entries.length) selection = proxyPool.defaultSelection();

  const options = {
    // One per crawl attempt is picked from these in fetchPageAuto
    proxies: selection.entries,
    proxyRotation: selection.rotation,
    proxyKey: `website:${website.id}`,
    userAgent: website.user_agent || null,
    waitFor: pageConfig?.wait_for || null,
    waitTimeout: pageConfig?.wait_timeout || 30000,
    scrollToBottom: pageConfig?.scroll_to_bottom === 1,
    actions: [],
    customJs: pageConfig?.custom_js || null,
    customHeaders: {},
    cookies: [],
    blockImages: pageConfig?.block_images === 1,
    // The "browser" image cache downloads images with fetch() inside the page, which needs
    // a browser that can read cross-origin responses — only started that way when used
    crossOriginFetch: !!website.image_proxy
      && (website.image_cache_method || 'browser') === 'browser'
      && !NO_IMAGE_PAGE_TYPES.includes(pageConfig?.page_type),
    // Match the browser clock to the proxy's country
    timezone: website.timezone || null,
  };

  if (pageConfig?.actions) {
    try {
      options.actions = typeof pageConfig.actions === 'string'
        ? JSON.parse(pageConfig.actions)
        : pageConfig.actions;
    } catch { options.actions = []; }
  }

  if (website.custom_headers) {
    try {
      options.customHeaders = typeof website.custom_headers === 'string'
        ? JSON.parse(website.custom_headers)
        : website.custom_headers;
    } catch { options.customHeaders = {}; }
  }

  if (website.cookies) {
    try {
      options.cookies = typeof website.cookies === 'string'
        ? JSON.parse(website.cookies)
        : website.cookies;
    } catch { options.cookies = []; }
  }

  if (website.local_storage) {
    try {
      options.localStorage = typeof website.local_storage === 'string'
        ? JSON.parse(website.local_storage)
        : website.local_storage;
    } catch { options.localStorage = {}; }
  }

  return options;
}

/**
 * Save session cookies from page back to website record.
 */
async function saveSessionCookies(page, websiteId) {
  try {
    const cookies = await extractCookies(page);
    if (cookies.length > 0) {
      db.updateWebsiteCookies(websiteId, cookies);
    }
  } catch (err) {
    console.error('Failed to save session cookies:', err.message);
  }
}

function parseSelectors(pageConfig) {
  if (!pageConfig?.selectors) return {};
  try {
    return typeof pageConfig.selectors === 'string'
      ? JSON.parse(pageConfig.selectors)
      : pageConfig.selectors;
  } catch { return {}; }
}

function parseSelectorsRequired(pageConfig) {
  if (!pageConfig?.selectors_required) return {};
  try {
    return typeof pageConfig.selectors_required === 'string'
      ? JSON.parse(pageConfig.selectors_required)
      : pageConfig.selectors_required;
  } catch { return {}; }
}

/**
 * Check required fields against extracted result.
 */
function checkRequired(result, required, pageType) {
  for (const [field, isReq] of Object.entries(required)) {
    if (!isReq) continue;
    const val = result[field];
    const empty = val === null || val === undefined || val === '' ||
      (Array.isArray(val) && val.length === 0);
    if (empty) {
      throw new Error(`Required field "${field}" returned empty for ${pageType}`);
    }
  }
}

function checkRequiredCustomFields(customData, customFields, pageType) {
  for (const field of customFields) {
    if (!field.required || !field.key) continue;
    const val = customData[field.key];
    const empty = val === null || val === undefined || val === '' ||
      (Array.isArray(val) && val.length === 0);
    if (empty) {
      throw new Error(`Required custom field "${field.key}" returned empty for ${pageType}`);
    }
  }
}

function parseCustomFields(pageConfig) {
  if (!pageConfig?.custom_fields) return [];
  try {
    const fields = typeof pageConfig.custom_fields === 'string'
      ? JSON.parse(pageConfig.custom_fields)
      : pageConfig.custom_fields;
    return Array.isArray(fields) ? fields : [];
  } catch { return []; }
}

function parseRegexRules(pageConfig) {
  if (!pageConfig?.regex_replace) return [];
  try {
    const rules = typeof pageConfig.regex_replace === 'string'
      ? JSON.parse(pageConfig.regex_replace)
      : pageConfig.regex_replace;
    return Array.isArray(rules) ? rules : [];
  } catch { return []; }
}

function applyRegexReplace(result, rules) {
  if (!rules.length) return result;

  for (const rule of rules) {
    if (!rule.pattern) continue;
    const re = new RegExp(rule.pattern, rule.flags || 'g');
    const replacement = rule.replacement ?? '';

    if (rule.field === '*') {
      replaceInObj(result, re, replacement);
    } else if (rule.field) {
      applyToField(result, rule.field, re, replacement);
    }
  }
  return result;
}

function applyToField(obj, field, re, replacement) {
  if (field in obj) {
    const val = obj[field];
    if (typeof val === 'string') {
      obj[field] = val.replace(re, replacement);
    } else if (Array.isArray(val)) {
      obj[field] = val.map(v => typeof v === 'string' ? v.replace(re, replacement) : v);
    }
    return;
  }
  for (const key of Object.keys(obj)) {
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      applyToField(obj[key], field, re, replacement);
    } else if (Array.isArray(obj[key])) {
      for (const item of obj[key]) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          applyToField(item, field, re, replacement);
        }
      }
    }
  }
}

function replaceInObj(obj, re, replacement) {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      obj[key] = val.replace(re, replacement);
    } else if (Array.isArray(val)) {
      obj[key] = val.map(v => typeof v === 'string' ? v.replace(re, replacement) : v);
    } else if (val && typeof val === 'object') {
      replaceInObj(val, re, replacement);
    }
  }
}

/**
 * Extract custom fields from a page using field definitions.
 * Runs page.evaluate with the custom fields config.
 * Returns an object with key→value pairs to merge into the response.
 *
 * Field types:
 *   - "string": extract single text/attr from first matching element
 *   - "array": extract text/attr from all matching elements into an array
 *   - "object_array": extract array of objects, each with sub-fields
 *
 * Each field: { key, selector, type, attr?, fields?: [{key, selector, attr?}] }
 */
async function extractCustomFields(page, customFields) {
  if (!customFields.length) return {};

  return page.evaluate((fields) => {
    const _eval = (s) => { try { return eval(s); } catch { return null; } };

    function getValue(el, selector, attr) {
      if (!el) return null;
      if (attr === 'href') return el.href || el.getAttribute('href');
      if (attr === 'src') return el.src || el.getAttribute('src');
      if (attr) return el.getAttribute(attr);
      return el.textContent.trim();
    }

    function queryValue(root, selector, attr) {
      if (selector && selector.startsWith('js:')) {
        return _eval(selector.slice(3));
      }
      const el = root.querySelector(selector);
      return el ? getValue(el, selector, attr) : null;
    }

    function queryArrayValues(root, selector, attr) {
      if (selector && selector.startsWith('js:')) {
        return _eval(selector.slice(3)) || [];
      }
      const els = root.querySelectorAll(selector);
      return Array.from(els).map(el => getValue(el, selector, attr)).filter(v => v !== null);
    }

    const result = {};
    for (const field of fields) {
      if (!field.key || !field.selector) continue;

      if (field.type === 'array') {
        result[field.key] = queryArrayValues(document, field.selector, field.attr || null);

      } else if (field.type === 'object_array') {
        if (field.selector.startsWith('js:')) {
          result[field.key] = _eval(field.selector.slice(3)) || [];
        } else {
          const containers = document.querySelectorAll(field.selector);
          const subFields = field.fields || [];
          result[field.key] = Array.from(containers).map(container => {
            const obj = {};
            for (const sf of subFields) {
              if (!sf.key) continue;
              if (sf.type === 'array') {
                if (sf.selector) {
                  obj[sf.key] = queryArrayValues(container, sf.selector, sf.attr || null);
                } else {
                  obj[sf.key] = [];
                }
              } else {
                if (sf.selector) {
                  obj[sf.key] = queryValue(container, sf.selector, sf.attr || null);
                } else {
                  // No selector: extract from container element itself
                  obj[sf.key] = getValue(container, null, sf.attr || null);
                }
              }
            }
            return obj;
          });
        }

      } else {
        // default: string
        result[field.key] = queryValue(document, field.selector, field.attr || null);
      }
    }
    return result;
  }, customFields);
}

// ---- Image proxying for custom fields ----

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|jfif|heic)(\?|#|$)/i;

/** Heuristic: does this value look like an image URL? */
function looksLikeImageUrl(v) {
  if (typeof v !== 'string' || !v) return false;
  if (/^data:image\//i.test(v)) return true;
  if (/^blob:/i.test(v)) return true;
  return IMAGE_EXT_RE.test(v.split('#')[0]);
}

/** Resolve a possibly-relative URL against the page URL (blob:/data: left as-is). */
function toAbsoluteUrl(v, pageUrl) {
  if (typeof v !== 'string' || !v) return v;
  if (/^(data:|blob:)/i.test(v)) return v;
  try { return new URL(v, pageUrl).href; } catch { return v; }
}

/**
 * Proxy a list of image URLs, honouring the website's cache method.
 *
 * data: URLs (images inlined in the HTML) are always decoded and cached server-side:
 * they carry their own bytes, so there is nothing to download, and returning megabytes
 * of base64 in the JSON — or stuffing it into a lazy-proxy query string — is not viable.
 *
 * Returns an array of proxied URLs aligned with the input.
 */
async function proxyImageList(page, urls, ctx) {
  const { websiteName, apiBaseUrl, sourceUrl, useProxyMethod, useNodeMethod, forceRefresh = false } = ctx;
  const out = new Array(urls.length);
  const remaining = [];

  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    if (typeof u === 'string' && u.startsWith('data:')) {
      const cached = await cacheImageData(u, websiteName, apiBaseUrl, forceRefresh);
      out[i] = cached ? cached.proxyUrl : u;
    } else {
      remaining.push(i);
    }
  }

  if (remaining.length) {
    const restUrls = remaining.map(i => urls[i]);
    let proxied;
    if (useProxyMethod) {
      proxied = restUrls.map(u => `${apiBaseUrl}/api/image/v3/?url=${encodeURIComponent(u)}`);
    } else if (useNodeMethod) {
      proxied = await cacheImagesNode(restUrls, websiteName, apiBaseUrl, sourceUrl, forceRefresh);
    } else {
      proxied = await cacheImagesFromPage(page, restUrls, websiteName, apiBaseUrl, forceRefresh);
    }
    remaining.forEach((idx, k) => { out[idx] = proxied[k] || urls[idx]; });
  }

  return out;
}

/**
 * Route image URLs found in custom fields through the image proxy/cache, the same way
 * the built-in page types do for their cover/chapter images.
 *
 * A value is proxied when the field is explicitly marked (`"image": true` in the field
 * definition) or when the value looks like an image URL. Handles all three field
 * shapes: string, array, and object_array sub-fields.
 */
async function proxyCustomFieldImages(page, customFields, customData, ctx) {
  const { website, websiteName, apiBaseUrl, pageUrl, sourceUrl, useProxyMethod, useNodeMethod } = ctx;
  if (!website.image_proxy || !apiBaseUrl || !customFields.length) return;

  const targets = [];
  const shouldProxy = (def, v) =>
    typeof v === 'string' && v && (def.image === true || looksLikeImageUrl(v));

  const consider = (def, container, key) => {
    const raw = container[key];
    if (Array.isArray(raw)) {
      raw.forEach((v, i) => {
        if (shouldProxy(def, v)) targets.push({ url: toAbsoluteUrl(v, pageUrl), set: (nv) => { raw[i] = nv; } });
      });
    } else if (shouldProxy(def, raw)) {
      targets.push({ url: toAbsoluteUrl(raw, pageUrl), set: (nv) => { container[key] = nv; } });
    }
  };

  for (const field of customFields) {
    if (!field.key || customData[field.key] == null) continue;
    const val = customData[field.key];
    if (field.type === 'object_array' && Array.isArray(val)) {
      for (const obj of val) {
        if (!obj || typeof obj !== 'object') continue;
        for (const sf of (field.fields || [])) {
          if (sf.key) consider(sf, obj, sf.key);
        }
      }
    } else {
      consider(field, customData, field.key);
    }
  }

  if (!targets.length) return;

  const proxied = await proxyImageList(page, targets.map(t => t.url), {
    websiteName, apiBaseUrl, sourceUrl, useProxyMethod, useNodeMethod,
  });
  targets.forEach((t, i) => { if (proxied[i]) t.set(proxied[i]); });
}

/**
 * Fetch page using Lightpanda (JS rendering) or simple HTTP based on use_js config.
 *
 * With proxies, each attempt takes one from the rotation. When an attempt dies because of
 * its proxy, the next untried proxy gets a go straight away (up to MAX_PROXY_SWITCHES)
 * without using up a configured retry — a dead proxy in the list shouldn't fail a crawl.
 */
async function fetchPageAuto(url, options, config) {
  const useJs = config?.use_js !== 0;
  const retryCount = parseInt(db.getSetting('retry_count')) || 0;
  const retryDelay = parseInt(db.getSetting('retry_delay')) || 2000;
  const proxies = useJs ? (options.proxies || []) : []; // plain HTTP mode has no proxy support
  let switchesLeft = Math.min(Math.max(proxies.length - 1, 0), MAX_PROXY_SWITCHES);
  const tried = new Set();

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const proxy = proxyPool.pick(options.proxyKey, proxies, options.proxyRotation, tried);
    try {
      if (useJs) {
        const result = await fetchPage(url, { ...options, proxy });
        if (proxy) proxyPool.reportSuccess(proxy);
        return result;
      }
      return await fetchPageSimple(url, options);
    } catch (err) {
      if (proxy && err.proxyFailed) {
        proxyPool.reportFailure(proxy, err.message);
        tried.add(proxy);
        if (switchesLeft > 0) {
          switchesLeft--;
          attempt--; // same attempt, another proxy
          console.log(`[Proxy] ${proxyPool.displayOf(proxy)} failed (${err.message.split(' [proxy')[0]}) — trying another proxy`);
          continue;
        }
      }
      // A challenge page is not retried — every attempt would meet the same challenge
      if (err.captchaUnsolved) throw err;
      if (attempt < retryCount) {
        console.log(`[Retry] fetchPageAuto attempt ${attempt + 1}/${retryCount} failed: ${err.message}. Retrying in ${retryDelay}ms...`);
        await new Promise(r => setTimeout(r, retryDelay));
      } else {
        // Out of proxies too: say so, or it reads as if only the last one was tried
        if (err.proxyFailed && tried.size > 1) err.message = `All ${tried.size} proxies tried failed — last: ${err.message}`;
        throw err;
      }
    }
  }
}

// ---- Katalog Crawl ----

async function crawlKatalog(websiteName, url, { includeHtml = false } = {}) {
  const website = db.getWebsiteByName(websiteName);
  if (!website) throw new Error(`Website "${websiteName}" not found`);

  const config = db.getPageConfig(website.id, 'katalog');
  if (!config) throw new Error(`No katalog config for "${websiteName}"`);

  const selectors = parseSelectors(config);
  const regexRules = parseRegexRules(config);
  const required = parseSelectorsRequired(config);
  const customFields = parseCustomFields(config);
  const options = buildFetchOptions(website, config);
  const { page, browser, cfDetected } = await fetchPageAuto(url, options, config);

  try {
    const komikList = await page.evaluate((sel) => {
      // js: prefix helper — eval expression directly, otherwise use as CSS selector
      const _eval = (s) => { try { return eval(s); } catch { return null; } };

      if (sel.item && sel.item.startsWith('js:')) {
        // js: expression should return array of {title, url}
        return _eval(sel.item.slice(3)) || [];
      }

      const items = document.querySelectorAll(sel.item || '.bs .bsx a');
      return Array.from(items).map((el) => {
        if (sel.title && sel.title.startsWith('js:')) {
          return { title: _eval(sel.title.slice(3)), url: el.href || el.getAttribute('href') };
        }
        const titleEl = el.querySelector(sel.title || 'div.tt');
        return {
          title: titleEl ? titleEl.textContent.trim() : (el.getAttribute('title') || el.textContent.trim()),
          url: el.href || el.getAttribute('href'),
        };
      });
    }, selectors);

    if (required.item) checkRequired({ item: komikList }, { item: true }, 'katalog');
    if (required.title) {
      for (const item of komikList) {
        checkRequired({ title: item.title }, { title: true }, 'katalog');
      }
    }

    // Extract custom fields
    const customData = await extractCustomFields(page, customFields);
    checkRequiredCustomFields(customData, customFields, 'katalog');

    const result = {
      status: 'success',
      query: url,
      komik_finded: komikList.map(item => applyRegexReplace(item, regexRules)),
      ...customData,
    };

    if (includeHtml) result.html = await page.content();

    return result;
  } finally {
    if (cfDetected) await saveSessionCookies(page, website.id);
    await browser.close();
  }
}

// ---- Komik Detail Crawl ----

async function crawlKomikDetail(websiteName, url, apiBaseUrl, { includeHtml = false } = {}) {
  const website = db.getWebsiteByName(websiteName);
  if (!website) throw new Error(`Website "${websiteName}" not found`);

  const config = db.getPageConfig(website.id, 'komik_detail');
  if (!config) throw new Error(`No komik_detail config for "${websiteName}"`);

  const selectors = parseSelectors(config);
  const regexRules = parseRegexRules(config);
  const required = parseSelectorsRequired(config);
  const customFields = parseCustomFields(config);
  const useProxyMethod = website.image_cache_method === 'proxy';
  const useNodeMethod = website.image_cache_method === 'node' || config.use_js === 0;
  const options = buildFetchOptions(website, config);
  const { page, browser, cfDetected } = await fetchPageAuto(url, options, config);

  try {
    const detail = await page.evaluate((sel, sourceUrl) => {
      // js: prefix helper — eval expression directly, otherwise use as CSS selector
      const _eval = (s) => { try { return eval(s); } catch { return null; } };
      const getText = (s) => {
        if (s && s.startsWith('js:')) return _eval(s.slice(3));
        const el = document.querySelector(s);
        return el ? el.textContent.trim() : null;
      };
      const getAttr = (s, attr) => {
        if (s && s.startsWith('js:')) return _eval(s.slice(3));
        const el = document.querySelector(s);
        return el ? el.getAttribute(attr) : null;
      };
      const getTexts = (s) => {
        if (s && s.startsWith('js:')) return _eval(s.slice(3)) || [];
        return Array.from(document.querySelectorAll(s)).map(g => g.textContent.trim());
      };

      return {
        status: 'success',
        title: getText(sel.title || 'h1[itemprop="name"]'),
        genres: getTexts(sel.genres || 'a[itemprop="genre"]'),
        status_komik: getText(sel.status || '.imptdt:nth-child(1) i') || null,
        type: getText(sel.type || '.imptdt:nth-child(2) a') || null,
        author: getText(sel.author || '.fmed span') || null,
        released: getText(sel.released || '.fmed span') || null,
        sinopsis: getText(sel.sinopsis || '[itemprop="description"], .entry-content[itemprop="description"]') || null,
        url: sourceUrl,
        image: getAttr(sel.image || 'img.wp-post-image', 'src'),
      };
    }, selectors, url);

    const mappedRequired = {};
    for (const [key, val] of Object.entries(required)) {
      if (key === 'status') mappedRequired['status_komik'] = val;
      else mappedRequired[key] = val;
    }
    checkRequired(detail, mappedRequired, 'komik_detail');

    // Proxy cover image if image_proxy is enabled.
    // Resolve relative URLs first — the selector may yield e.g. "/cover.png", which
    // both the node downloader and the lazy /api/image/v3 proxy would reject.
    if (website.image_proxy && detail.image && apiBaseUrl) {
      const absImage = toAbsoluteUrl(detail.image, page.url());
      if (useProxyMethod) {
        detail.image = `${apiBaseUrl}/api/image/v3/?url=${encodeURIComponent(absImage)}`;
      } else {
        let cached;
        if (useNodeMethod) {
          cached = await cacheImageNode(absImage, websiteName, apiBaseUrl, url);
        } else {
          cached = await cacheImage(page, absImage, websiteName, apiBaseUrl);
        }
        if (cached) detail.image = cached.proxyUrl;
      }
    }

    // Extract custom fields
    const customData = await extractCustomFields(page, customFields);
    checkRequiredCustomFields(customData, customFields, 'komik_detail');
    Object.assign(detail, customData);

    const finalDetail = applyRegexReplace(detail, regexRules);
    if (includeHtml) finalDetail.html = await page.content();

    return finalDetail;
  } finally {
    if (cfDetected) await saveSessionCookies(page, website.id);
    await browser.close();
  }
}

// ---- Chapter List Crawl ----

async function crawlChapterList(websiteName, url, apiBaseUrl, { includeHtml = false } = {}) {
  const website = db.getWebsiteByName(websiteName);
  if (!website) throw new Error(`Website "${websiteName}" not found`);

  const config = db.getPageConfig(website.id, 'chapter_list');
  if (!config) throw new Error(`No chapter_list config for "${websiteName}"`);

  const selectors = parseSelectors(config);
  const regexRules = parseRegexRules(config);
  const required = parseSelectorsRequired(config);
  const customFields = parseCustomFields(config);
  const options = buildFetchOptions(website, config);
  const { page, browser, cfDetected } = await fetchPageAuto(url, options, config);

  try {
    const chapters = await page.evaluate((sel) => {
      // js: prefix — eval expression directly (should return array of URLs)
      if (sel.chapter_link && sel.chapter_link.startsWith('js:')) {
        try { return eval(sel.chapter_link.slice(3)) || []; } catch { return []; }
      }
      const links = document.querySelectorAll(sel.chapter_link || '.eph-num a, .clstyle li a');
      return Array.from(links).map((a) => a.href || a.getAttribute('href'));
    }, selectors);

    if (required.chapter_link) checkRequired({ chapter_link: chapters }, { chapter_link: true }, 'chapter_list');

    const chapterList = apiBaseUrl
      ? chapters.map((ch) => `${apiBaseUrl}/api/chapter?website=${websiteName}&url=${encodeURIComponent(ch)}`)
      : chapters;

    // Extract custom fields
    const customData = await extractCustomFields(page, customFields);
    checkRequiredCustomFields(customData, customFields, 'chapter_list');

    const result = {
      status: 'success',
      source_url: url,
      chapter_list: chapterList,
      ...customData,
    };

    const finalResult = applyRegexReplace(result, regexRules);
    if (includeHtml) finalResult.html = await page.content();

    return finalResult;
  } finally {
    if (cfDetected) await saveSessionCookies(page, website.id);
    await browser.close();
  }
}

// ---- Chapter Images Crawl ----

async function crawlChapter(websiteName, url, apiBaseUrl, { includeHtml = false } = {}) {
  const website = db.getWebsiteByName(websiteName);
  if (!website) throw new Error(`Website "${websiteName}" not found`);

  const config = db.getPageConfig(website.id, 'chapter');
  if (!config) throw new Error(`No chapter config for "${websiteName}"`);

  const selectors = parseSelectors(config);
  const regexRules = parseRegexRules(config);
  const required = parseSelectorsRequired(config);
  const customFields = parseCustomFields(config);
  const useProxyMethod = website.image_cache_method === 'proxy';
  const useNodeMethod = website.image_cache_method === 'node' || config.use_js === 0;
  const options = buildFetchOptions(website, config);
  const { page, browser, cfDetected } = await fetchPageAuto(url, options, config);

  try {
    const result = await page.evaluate((sel) => {
      // js: prefix helper — eval expression directly
      const _eval = (s) => { try { return eval(s); } catch { return null; } };

      // Title
      let title;
      if (sel.title && sel.title.startsWith('js:')) {
        title = _eval(sel.title.slice(3)) || document.title;
      } else {
        const titleEl = document.querySelector(sel.title || 'h1, .entry-title');
        title = titleEl ? titleEl.textContent.trim() : document.title;
      }

      // Images
      let imgSources;
      if (sel.images && sel.images.startsWith('js:')) {
        imgSources = _eval(sel.images.slice(3)) || [];
      } else {
        const images = document.querySelectorAll(sel.images || '#readerarea img, .reader-area img, section[data-image-data] img');
        imgSources = Array.from(images)
          .map((img) => img.getAttribute('src') || img.getAttribute('data-src'))
          .filter((src) => src && !src.includes('logo') && !src.includes('icon'));
      }

      // Chapter number
      let chapterNumber = null;
      if (sel.chapter_number) {
        if (sel.chapter_number.startsWith('js:')) {
          chapterNumber = _eval(sel.chapter_number.slice(3));
        } else {
          const numEl = document.querySelector(sel.chapter_number);
          if (numEl) chapterNumber = numEl.textContent.trim();
        }
      }

      return { title, imgSources, chapterNumber };
    }, selectors);

    checkRequired({ title: result.title, images: result.imgSources, chapter_number: result.chapterNumber }, required, 'chapter');

    // Resolve relative URLs to absolute. Inline data:image/ sources are kept as-is —
    // they get decoded + cached below like any other image.
    const pageUrl = page.url();
    const absoluteImages = result.imgSources.map(src => {
      if (typeof src !== 'string' || !src) return null;
      if (src.startsWith('data:')) return src.startsWith('data:image/') ? src : null;
      try { return new URL(src, pageUrl).href; } catch { return src; }
    }).filter(Boolean);

    // Proxy chapter images if image_proxy is enabled (always fresh)
    let finalImages = absoluteImages;
    if (website.image_proxy && apiBaseUrl) {
      finalImages = await proxyImageList(page, absoluteImages, {
        websiteName, apiBaseUrl, sourceUrl: url,
        useProxyMethod, useNodeMethod,
        forceRefresh: true, // chapter images are always re-fetched
      });
    }

    // Extract custom fields
    const customData = await extractCustomFields(page, customFields);
    checkRequiredCustomFields(customData, customFields, 'chapter');

    const chapterResult = {
      status: 'success',
      title: result.title,
      acf: {
        chapter_img_source: finalImages,
        chapter_number: result.chapterNumber || '',
      },
      ...customData,
    };

    const finalChapter = applyRegexReplace(chapterResult, regexRules);
    if (includeHtml) finalChapter.html = await page.content();

    return finalChapter;
  } finally {
    if (cfDetected) await saveSessionCookies(page, website.id);
    await browser.close();
  }
}

// ---- Custom Page Type Crawl (generic) ----

async function crawlCustom(websiteName, url, pageType, apiBaseUrl, { includeHtml = false } = {}) {
  const website = db.getWebsiteByName(websiteName);
  if (!website) throw new Error(`Website "${websiteName}" not found`);

  const config = db.getPageConfig(website.id, pageType);
  if (!config) throw new Error(`No "${pageType}" config for "${websiteName}"`);

  const regexRules = parseRegexRules(config);
  const customFields = parseCustomFields(config);
  const useProxyMethod = website.image_cache_method === 'proxy';
  const useNodeMethod = website.image_cache_method === 'node' || config.use_js === 0;
  const options = buildFetchOptions(website, config);
  const { page, browser, cfDetected } = await fetchPageAuto(url, options, config);

  try {
    // Custom page types extract data purely via custom_fields
    const customData = await extractCustomFields(page, customFields);
    checkRequiredCustomFields(customData, customFields, pageType);

    // Route any image URLs in the custom fields through the image proxy/cache
    await proxyCustomFieldImages(page, customFields, customData, {
      website, websiteName, apiBaseUrl,
      pageUrl: page.url(), sourceUrl: url,
      useProxyMethod, useNodeMethod,
    });

    const result = {
      status: 'success',
      page_type: pageType,
      source_url: url,
      ...customData,
    };

    const finalResult = applyRegexReplace(result, regexRules);
    if (includeHtml) finalResult.html = await page.content();

    return finalResult;
  } finally {
    if (cfDetected) await saveSessionCookies(page, website.id);
    await browser.close();
  }
}

module.exports = {
  crawlKatalog,
  crawlKomikDetail,
  crawlChapterList,
  crawlChapter,
  crawlCustom,
};
