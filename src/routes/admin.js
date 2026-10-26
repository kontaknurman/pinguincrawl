const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const Database = require('better-sqlite3');
const router = express.Router();
const db = require('../models/database');
const { requireAuth, createAuthCookie, clearAuthCookie, resetSessionSecret, create2faPendingCookie, verify2faPendingToken, clear2faPendingCookie } = require('../middleware/auth');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const { clearAllImages } = require('../services/image-proxy');
const { getActiveBrowserCount } = require('../services/browser');
const captchaRegistry = require('../services/captcha-registry');
const storage = require('../services/storage');


const DEFAULT_PAGE_TYPES = ['katalog', 'komik_detail', 'chapter_list', 'chapter'];
const IMAGE_CACHE_METHODS = ['browser', 'node', 'proxy'];

// Dynamic: merge default 4 + custom page types for a specific website
function getPageTypesForWebsite(websiteId) {
  if (!websiteId) return [...DEFAULT_PAGE_TYPES];
  const customTypes = db.getCustomPageTypes(websiteId).map(ct => ct.name);
  return [...DEFAULT_PAGE_TYPES, ...customTypes];
}
const tmpDir = path.join(__dirname, '..', '..', 'data', 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
const upload = multer({ dest: tmpDir, limits: { fileSize: 50 * 1024 * 1024 } });

// --- Flash messages (Post/Redirect/Get) ---
// Handlers redirect with ?ok=<code> (or ?err=<code>) and the next page shows the matching
// toast, so a refresh never re-submits a form. Codes map to fixed texts — nothing from
// the query string is rendered except the number in &n=.
const FLASH = {
  ok: {
    api_key: 'API key updated',
    ip_whitelist: 'IP whitelist updated',
    crawl_settings: 'Crawl settings updated',
    password: 'Password changed successfully',
    totp_enabled: '2FA enabled! You will need a code from your authenticator app on every login.',
    totp_disabled: '2FA has been disabled.',
    cache_cleared: 'Image cache cleared: {n} images removed.',
    storage_settings: 'Image cache settings saved',
    cleanup: 'Cleanup started — the results appear on this page when it finishes',
    website_created: 'Website created — now set up its page configs below',
    website_saved: 'Website saved',
    website_deleted: 'Website deleted',
    type_added: 'Custom page type added',
    type_deleted: 'Custom page type deleted',
    config_saved: 'Config saved!',
    logs_deleted: '{n} log(s) deleted',
    captcha_settings: 'CAPTCHA settings updated',
  },
  err: {},
};

function flashFromQuery(query) {
  const fill = (text) => text.replace('{n}', String(parseInt(query.n) || 0));
  if (query.ok && FLASH.ok[query.ok]) return { type: 'success', text: fill(FLASH.ok[query.ok]) };
  if (query.err && FLASH.err[query.err]) return { type: 'danger', text: fill(FLASH.err[query.err]) };
  return null;
}

// scrypt is deliberately slow (~50ms) — don't redo it on every dashboard view
let defaultPasswordCache = null;
function isDefaultPassword() {
  if (defaultPasswordCache === null) {
    const stored = db.getAdminPassword();
    defaultPasswordCache = !stored || db.verifyPassword('admin', stored);
  }
  return defaultPasswordCache;
}

function apiBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// --- Login (public) ---
router.get('/login', (req, res) => {
  // Check if using default password
  const stored = db.getAdminPassword();
  const isDefault = !stored || db.verifyPassword('admin', stored);
  res.render('pages/login', { layout: 'layouts/minimal', page: 'login', isDefault });
});

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  // Ensure default password exists
  if (!db.getAdminPassword()) {
    db.setAdminPassword('admin');
  }

  const { password, totp_code } = req.body;
  const stored = db.getAdminPassword();
  const totpEnabled = db.getSetting('totp_enabled') === '1';

  // Step 2: TOTP verification (password already verified via signed cookie)
  if (totp_code && totpEnabled && verify2faPendingToken(req)) {
    const totpSecret = db.getSetting('totp_secret');
    if (!totpSecret) {
      clear2faPendingCookie(res);
      createAuthCookie(res, req);
      return res.redirect('/admin');
    }
    const totp = new OTPAuth.TOTP({
      issuer: 'CrawlKomik',
      label: 'Admin',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(totpSecret),
    });
    const valid = totp.validate({ token: totp_code, window: 1 });
    if (valid === null) {
      return res.render('pages/2fa-verify', {
        layout: 'layouts/minimal', page: 'login',
        error: 'Invalid authenticator code',
      });
    }
    clear2faPendingCookie(res);
    createAuthCookie(res, req);
    return res.redirect('/admin');
  }

  // Step 1: Password verification
  if (password && db.verifyPassword(password, stored)) {
    if (totpEnabled) {
      // Password OK, set signed pending cookie and show 2FA page
      create2faPendingCookie(res, req);
      return res.render('pages/2fa-verify', {
        layout: 'layouts/minimal', page: 'login',
        error: null,
      });
    }
    createAuthCookie(res, req);
    return res.redirect('/admin');
  }

  const isDefault = db.verifyPassword('admin', stored);
  res.render('pages/login', { layout: 'layouts/minimal', page: 'login', error: 'Wrong password', isDefault });
});

// --- Logout ---
router.get('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect('/admin/login');
});

// --- All routes below require auth ---
router.use(requireAuth);

// Shared locals for every admin page: nav badges + the flash toast
router.use((req, res, next) => {
  res.locals.nav = {
    captchaWaiting: captchaRegistry.waitingCount(),
    diskWarning: storage.diskWarning(),
  };
  res.locals.flash = flashFromQuery(req.query);
  next();
});

// --- Dashboard ---
router.get('/', (req, res) => {
  res.render('pages/dashboard', {
    page: 'dashboard',
    websites: db.getAllWebsites(),
    configCounts: db.getPageConfigCountsByWebsite(),
    browserStatus: getActiveBrowserCount(),
    logStats: db.getApiLogStats(),
    cache: db.getImageCacheTotals(),
    filesystems: storage.filesystems(),
    isDefaultPassword: isDefaultPassword(),
    apiKeySet: !!db.getSetting('api_key'),
    apiBase: apiBaseUrl(req),
  });
});

// --- Settings (crawl, API access, security, backup) ---
function settingsLocals(req, extra = {}) {
  return {
    page: 'settings',
    apiKey: db.getSetting('api_key') || '',
    ipWhitelist: db.getSetting('ip_whitelist') || '',
    retryCount: parseInt(db.getSetting('retry_count')) || 0,
    retryDelay: parseInt(db.getSetting('retry_delay')) || 2000,
    maxBrowsers: parseInt(db.getSetting('max_browsers')) || parseInt(process.env.MAX_BROWSERS) || 3,
    browserHeadless: db.getSetting('browser_headless') !== '0',
    totpEnabled: db.getSetting('totp_enabled') === '1',
    isDefaultPassword: isDefaultPassword(),
    clientIp: (req.ip || '').replace(/^::ffff:/, ''),
    pwError: null,
    totpError: null,
    backupError: null,
    focusSection: null,
    ...extra,
  };
}

function renderSettingsError(req, res, section, field, message) {
  res.render('pages/settings', settingsLocals(req, {
    [field]: message,
    focusSection: section,
    flash: { type: 'danger', text: message },
  }));
}

router.get('/settings', (req, res) => {
  res.render('pages/settings', settingsLocals(req));
});

// --- Change Password ---
router.post('/change-password', express.urlencoded({ extended: true }), (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const stored = db.getAdminPassword();

  if (!db.verifyPassword(String(current_password || ''), stored)) {
    return renderSettingsError(req, res, 'security', 'pwError', 'Current password is wrong');
  }
  if (!new_password || new_password.length < 4) {
    return renderSettingsError(req, res, 'security', 'pwError', 'New password must be at least 4 characters');
  }
  if (new_password !== confirm_password) {
    return renderSettingsError(req, res, 'security', 'pwError', 'Passwords do not match');
  }

  db.setAdminPassword(new_password);
  defaultPasswordCache = null;
  createAuthCookie(res, req);
  res.redirect('/admin/settings?ok=password#security');
});

// --- API Key Management ---
router.post('/api-key', express.urlencoded({ extended: true }), (req, res) => {
  const { api_key } = req.body;
  if (api_key && api_key.trim()) {
    db.setSetting('api_key', api_key.trim());
  } else {
    db.setSetting('api_key', '');
  }
  res.redirect('/admin/settings?ok=api_key#api');
});

// --- IP Whitelist ---
router.post('/ip-whitelist', express.urlencoded({ extended: true }), (req, res) => {
  const { ip_whitelist } = req.body;
  db.setSetting('ip_whitelist', (ip_whitelist || '').trim());
  res.redirect('/admin/settings?ok=ip_whitelist#api');
});

// --- Crawl Settings (max browsers + retry) ---
router.post('/crawl-settings', express.urlencoded({ extended: true }), (req, res) => {
  let maxBrowsers = parseInt(req.body.max_browsers) || 3;
  if (maxBrowsers < 1) maxBrowsers = 1;
  if (maxBrowsers > 50) maxBrowsers = 50;
  let count = parseInt(req.body.retry_count) || 0;
  if (count < 0) count = 0;
  if (count > 5) count = 5;
  let delay = parseInt(req.body.retry_delay) || 2000;
  if (delay < 500) delay = 500;
  if (delay > 30000) delay = 30000;
  db.setSetting('max_browsers', String(maxBrowsers));
  db.setSetting('retry_count', String(count));
  db.setSetting('retry_delay', String(delay));
  // Checkbox: present ('on') = headless, absent = headful
  db.setSetting('browser_headless', req.body.browser_headless === 'on' ? '1' : '0');
  res.redirect('/admin/settings?ok=crawl_settings#crawl');
});

// --- Websites: form helpers ---

// Reject malformed JSON up front — the crawler silently ignores it (falling back to no
// headers / cookies), which is far harder to notice than a form error.
function jsonField(value, label, kind) {
  const text = (value || '').trim();
  if (!text) return kind === 'array' ? '[]' : '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${label}: invalid JSON — ${e.message}`);
  }
  const ok = kind === 'array' ? Array.isArray(parsed) : (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
  if (!ok) throw new Error(`${label} must be a JSON ${kind === 'array' ? 'array [ ... ]' : 'object { ... }'}`);
  return text;
}

// An unknown zone would only surface as a warning in the logs at crawl time
function timezoneField(value) {
  const tz = (value || '').trim();
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`Unknown timezone "${tz}" — use an IANA name such as Asia/Jakarta or Asia/Singapore`);
  }
  return tz;
}

function websiteFromBody(body) {
  const name = (body.name || '').trim().toLowerCase();
  const baseUrl = (body.base_url || '').trim();
  if (!name) throw new Error('Name is required');
  if (!baseUrl) throw new Error('Base URL is required');
  return {
    name,
    base_url: baseUrl,
    active: body.active === 'on',
    proxy: body.proxy,
    user_agent: body.user_agent,
    image_proxy: body.image_proxy === 'on',
    image_cache_method: IMAGE_CACHE_METHODS.includes(body.image_cache_method) ? body.image_cache_method : 'browser',
    custom_headers: jsonField(body.custom_headers, 'Custom Headers', 'object'),
    cookies: jsonField(body.cookies, 'Cookies', 'array'),
    local_storage: jsonField(body.local_storage, 'LocalStorage', 'object'),
    timezone: timezoneField(body.timezone),
  };
}

function websiteFormLocals(req, website, extra = {}) {
  const isEdit = !!(website && website.id);
  return {
    website,
    pageConfigs: isEdit ? db.getPageConfigs(website.id) : [],
    pageTypes: getPageTypesForWebsite(isEdit ? website.id : null),
    customPageTypes: isEdit ? db.getCustomPageTypes(website.id) : [],
    page: isEdit ? 'website-edit' : 'websites',
    apiBase: apiBaseUrl(req),
    apiKeySet: !!db.getSetting('api_key'),
    ...extra,
  };
}

// --- Add Website Form ---
router.get('/websites/new', (req, res) => {
  res.render('pages/website-form', websiteFormLocals(req, null));
});

// --- Create Website ---
router.post('/websites', express.urlencoded({ extended: true }), (req, res) => {
  try {
    const info = db.createWebsite(websiteFromBody(req.body));
    res.redirect(`/admin/websites/${info.lastInsertRowid}?ok=website_created`);
  } catch (err) {
    const message = err.message.includes('UNIQUE') ? `A website named "${(req.body.name || '').trim().toLowerCase()}" already exists` : err.message;
    res.render('pages/website-form', websiteFormLocals(req, { ...req.body, image_proxy: req.body.image_proxy === 'on' }, {
      error: message, flash: { type: 'danger', text: message },
    }));
  }
});

// --- Edit Website ---
router.get('/websites/:id', (req, res) => {
  const website = db.getWebsiteById(req.params.id);
  if (!website) return res.redirect('/admin');
  res.render('pages/website-form', websiteFormLocals(req, website));
});

// --- Update Website ---
router.post('/websites/:id', express.urlencoded({ extended: true }), (req, res) => {
  const website = db.getWebsiteById(req.params.id);
  if (!website) return res.redirect('/admin');
  try {
    db.updateWebsite(req.params.id, websiteFromBody(req.body));
    res.redirect(`/admin/websites/${req.params.id}?ok=website_saved`);
  } catch (err) {
    const message = err.message.includes('UNIQUE') ? `A website named "${(req.body.name || '').trim().toLowerCase()}" already exists` : err.message;
    // Keep what the admin typed — checkboxes are absent from the body when unchecked
    const edited = { ...website, ...req.body, image_proxy: req.body.image_proxy === 'on', active: req.body.active === 'on' };
    res.render('pages/website-form', websiteFormLocals(req, edited, {
      error: message, flash: { type: 'danger', text: message },
    }));
  }
});

// --- Delete Website ---
router.post('/websites/:id/delete', (req, res) => {
  db.deleteWebsite(req.params.id);
  res.redirect('/admin?ok=website_deleted');
});

// --- Page Config Form ---
function configFormLocals(req, website, extra) {
  return {
    website,
    pageTypes: getPageTypesForWebsite(website.id),
    isCustomType: !DEFAULT_PAGE_TYPES.includes(req.params.pageType),
    pageType: req.params.pageType,
    page: 'config',
    apiBase: apiBaseUrl(req),
    apiKey: db.getSetting('api_key') || '',
    ...extra,
  };
}

router.get('/websites/:id/config/:pageType', (req, res) => {
  const website = db.getWebsiteById(req.params.id);
  if (!website) return res.redirect('/admin');
  if (!getPageTypesForWebsite(website.id).includes(req.params.pageType)) return res.redirect(`/admin/websites/${req.params.id}`);

  const config = db.getPageConfig(website.id, req.params.pageType);

  let selectors = {};
  let actions = [];
  let regexRules = [];
  let selectorsRequired = {};
  let customFields = [];
  if (config) {
    try { selectors = JSON.parse(config.selectors); } catch {}
    try { actions = JSON.parse(config.actions); } catch {}
    try { regexRules = JSON.parse(config.regex_replace || '[]'); } catch {}
    try { selectorsRequired = JSON.parse(config.selectors_required || '{}'); } catch {}
    try { customFields = JSON.parse(config.custom_fields || '[]'); } catch {}
  }

  res.render('pages/config-form', configFormLocals(req, website, {
    config, selectors, actions, regexRules, selectorsRequired, customFields,
  }));
});

// --- Save Page Config ---
router.post('/websites/:id/config/:pageType', express.urlencoded({ extended: true }), (req, res) => {
  if (!getPageTypesForWebsite(parseInt(req.params.id)).includes(req.params.pageType)) {
    return res.status(400).json({ status: 'error', message: 'Invalid page type' });
  }

  try {
    const { wait_for, wait_timeout, scroll_to_bottom, custom_js, block_images, use_proxy, use_js } = req.body;

    // Parse selectors from individual fields
    const selectors = {};
    const selectors_required = {};
    for (const key of Object.keys(req.body)) {
      if (key.startsWith('sel_')) {
        const selectorName = key.replace('sel_', '');
        if (req.body[key].trim()) selectors[selectorName] = req.body[key].trim();
      }
      if (key.startsWith('req_')) {
        const selectorName = key.replace('req_', '');
        selectors_required[selectorName] = true;
      }
    }

    // Parse actions from JSON textarea
    let actions = [];
    if (req.body.actions_json) {
      try { actions = JSON.parse(req.body.actions_json); } catch (e) {
        throw new Error('Invalid actions JSON: ' + e.message);
      }
    }

    // Parse regex replace rules from JSON textarea
    let regex_replace = [];
    if (req.body.regex_replace_json) {
      try { regex_replace = JSON.parse(req.body.regex_replace_json); } catch (e) {
        throw new Error('Invalid regex replace JSON: ' + e.message);
      }
    }

    // Parse custom fields from JSON textarea
    let custom_fields = [];
    if (req.body.custom_fields_json) {
      try { custom_fields = JSON.parse(req.body.custom_fields_json); } catch (e) {
        throw new Error('Invalid custom fields JSON: ' + e.message);
      }
    }

    db.upsertPageConfig(req.params.id, req.params.pageType, {
      selectors,
      selectors_required,
      actions,
      regex_replace,
      wait_for: wait_for || null,
      wait_timeout: parseInt(wait_timeout) || 30000,
      scroll_to_bottom: scroll_to_bottom === 'on',
      custom_js: custom_js || null,
      block_images: block_images === 'on',
      use_proxy: parseInt(use_proxy) || 0,
      use_js: use_js === 'on',
      custom_fields,
    });

    res.redirect(`/admin/websites/${req.params.id}/config/${req.params.pageType}?ok=config_saved`);
  } catch (err) {
    const website = db.getWebsiteById(req.params.id);
    if (!website) return res.redirect('/admin');
    const config = db.getPageConfig(website.id, req.params.pageType);

    // Reload actions/regexRules/selectorsRequired/customFields from DB so fields aren't wiped on error
    let actions = [];
    let regexRules = [];
    let selectorsRequired = {};
    let customFields = [];
    if (config) {
      try { actions = JSON.parse(config.actions || '[]'); } catch {}
      try { regexRules = JSON.parse(config.regex_replace || '[]'); } catch {}
      try { selectorsRequired = JSON.parse(config.selectors_required || '{}'); } catch {}
      try { customFields = JSON.parse(config.custom_fields || '[]'); } catch {}
    }

    // Re-show what the admin submitted: selector inputs are named sel_<key> / req_<key>,
    // simple fields override the saved config, and the JSON textareas get their raw text
    // back so a typo can be fixed instead of the edits being lost.
    const selectors = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (key.startsWith('sel_')) selectors[key.slice(4)] = value;
      if (key.startsWith('req_')) selectorsRequired[key.slice(4)] = true;
    }
    const b = req.body;
    const submitted = {
      ...(config || {}),
      wait_for: b.wait_for || null,
      wait_timeout: parseInt(b.wait_timeout) || 30000,
      scroll_to_bottom: b.scroll_to_bottom === 'on' ? 1 : 0,
      custom_js: b.custom_js || null,
      block_images: b.block_images === 'on' ? 1 : 0,
      use_proxy: parseInt(b.use_proxy) || 0,
      use_js: b.use_js === 'on' ? 1 : 0,
    };

    res.render('pages/config-form', configFormLocals(req, website, {
      config: submitted, selectors, actions, regexRules, selectorsRequired, customFields,
      rawJson: { actions: b.actions_json, regex: b.regex_replace_json, customFields: b.custom_fields_json },
      error: err.message,
      flash: { type: 'danger', text: err.message },
    }));
  }
});

// --- Custom Page Types CRUD (per website) ---
router.post('/websites/:id/custom-types', express.urlencoded({ extended: true }), (req, res) => {
  const website = db.getWebsiteById(req.params.id);
  if (!website) return res.redirect('/admin');

  const fail = (message) => res.render('pages/website-form', websiteFormLocals(req, website, {
    cpt_error: message, flash: { type: 'danger', text: message },
  }));

  try {
    let { name, label } = req.body;
    if (!name || !label) return fail('Name and label are required');
    // Sanitize name: lowercase, alphanumeric + underscore only
    name = name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (!name) return fail('Invalid name. Use letters, numbers, underscores only.');
    // Don't allow default page type names
    if (DEFAULT_PAGE_TYPES.includes(name)) return fail(`"${name}" is a built-in page type and cannot be used.`);
    db.createCustomPageType({ website_id: website.id, name, label: label.trim() });
    res.redirect(`/admin/websites/${website.id}?ok=type_added#page-types`);
  } catch (err) {
    fail(err.message.includes('UNIQUE') ? 'A custom page type with that name already exists for this website.' : err.message);
  }
});

router.post('/websites/:id/custom-types/:cptId/delete', (req, res) => {
  db.deleteCustomPageType(req.params.cptId);
  res.redirect(`/admin/websites/${req.params.id}?ok=type_deleted#page-types`);
});

// --- API Logs ---
router.get('/logs', (req, res) => {
  const perPage = 50;
  const filters = {
    status: ['success', 'error'].includes(req.query.status) ? req.query.status : null,
    endpoint: req.query.endpoint || null,
    website: req.query.website || null,
  };

  const totalCount = db.getApiLogCount(filters);
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
  const currentPage = Math.min(Math.max(parseInt(req.query.page) || 1, 1), totalPages);
  const logs = db.getApiLogs({ limit: perPage, offset: (currentPage - 1) * perPage, ...filters });

  res.render('pages/api-logs', {
    logs, filters, currentPage, totalPages, totalCount,
    stats: db.getApiLogStats(),
    facets: db.getApiLogFacets(),
    retentionDays: db.LOG_RETENTION_DAYS,
    page: 'logs',
  });
});

router.post('/logs/delete-all', (req, res) => {
  const result = db.deleteAllApiLogs();
  res.redirect(`/admin/logs?ok=logs_deleted&n=${result.changes}`);
});

router.post('/logs/delete-errors', (req, res) => {
  const result = db.deleteApiLogsByStatus('error');
  res.redirect(`/admin/logs?ok=logs_deleted&n=${result.changes}`);
});

router.post('/logs/delete-old', (req, res) => {
  const result = db.deleteOldApiLogs();
  res.redirect(`/admin/logs?ok=logs_deleted&n=${result.changes}`);
});

// --- Manual CAPTCHA Takeover Dashboard ---
function captchaLocals(extra = {}) {
  return {
    page: 'captcha',
    sessions: captchaRegistry.publicList(),
    waitingCount: captchaRegistry.waitingCount(),
    websites: db.getAllWebsites(),
    settings: {
      enabled: db.getSetting('captcha_manual_enabled') === '1',
      timeoutSecs: Math.round((parseInt(db.getSetting('captcha_timeout_ms')) || 180000) / 1000),
      notifyUrl: db.getSetting('captcha_notify_url') || '',
      telegramChatId: db.getSetting('captcha_notify_telegram_chat_id') || '',
    },
    ...extra,
  };
}

router.get('/captcha', (req, res) => {
  res.render('pages/captcha-sessions', captchaLocals());
});

// Fingerprint self-check — shows which bot signals are bad on this server, so a
// looping Cloudflare challenge can be diagnosed instead of guessed at.
router.get('/captcha/diagnose', async (req, res) => {
  try {
    const { runFingerprintCheck } = require('../services/fingerprint-check');
    // ?website=<name> checks with that website's UA / custom headers / proxy
    const report = await runFingerprintCheck(req.query.website || undefined);
    res.json(report);
  } catch (err) {
    const notFound = /not found$/.test(err.message);
    res.status(notFound ? 404 : 500).json({ status: 'error', message: err.message });
  }
});

router.post('/captcha/settings', express.urlencoded({ extended: true }), (req, res) => {
  const { manual_enabled, timeout_secs, notify_url, telegram_chat_id } = req.body;

  db.setSetting('captcha_manual_enabled', manual_enabled === 'on' ? '1' : '0');

  let secs = parseInt(timeout_secs) || 180;
  if (secs < 30) secs = 30;
  if (secs > 1800) secs = 1800;
  db.setSetting('captcha_timeout_ms', String(secs * 1000));

  db.setSetting('captcha_notify_url', (notify_url || '').trim());
  db.setSetting('captcha_notify_telegram_chat_id', (telegram_chat_id || '').trim());

  res.redirect('/admin/captcha?ok=captcha_settings');
});

// --- Logout from All Devices ---
router.post('/logout-all', (req, res) => {
  resetSessionSecret();
  clearAuthCookie(res);
  res.redirect('/admin/login');
});

// --- 2FA Setup ---
router.get('/2fa/setup', async (req, res) => {
  const totpEnabled = db.getSetting('totp_enabled') === '1';
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: 'CrawlKomik',
    label: 'Admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  const uri = totp.toString();
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(uri);
  } catch { /* QR generation failed */ }

  res.render('pages/2fa-setup', {
    page: 'settings',
    secret: secret.base32,
    qrDataUrl,
    uri,
    totpEnabled,
    error: null,
  });
});

router.post('/2fa/enable', express.urlencoded({ extended: true }), async (req, res) => {
  const { secret, totp_code } = req.body;
  if (!secret || !totp_code) {
    return res.redirect('/admin/2fa/setup');
  }

  const totp = new OTPAuth.TOTP({
    issuer: 'CrawlKomik',
    label: 'Admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  const uri = totp.toString();
  let qrDataUrl = '';
  try { qrDataUrl = await QRCode.toDataURL(uri); } catch {}

  const valid = totp.validate({ token: totp_code, window: 1 });
  if (valid === null) {
    return res.render('pages/2fa-setup', {
      page: 'settings', secret, qrDataUrl, uri,
      totpEnabled: db.getSetting('totp_enabled') === '1',
      error: 'Invalid code. Please try again.',
      flash: { type: 'danger', text: 'Invalid code. Please try again.' },
    });
  }

  // Save secret and enable 2FA
  db.setSetting('totp_secret', secret);
  db.setSetting('totp_enabled', '1');

  res.redirect('/admin/settings?ok=totp_enabled#security');
});

router.post('/2fa/disable', express.urlencoded({ extended: true }), (req, res) => {
  const { current_password } = req.body;
  const stored = db.getAdminPassword();

  if (!db.verifyPassword(String(current_password || ''), stored)) {
    return renderSettingsError(req, res, 'security', 'totpError', 'Wrong password. Cannot disable 2FA.');
  }

  db.setSetting('totp_enabled', '0');
  db.setSetting('totp_secret', '');

  res.redirect('/admin/settings?ok=totp_disabled#security');
});

// --- Storage (disk usage + cleanup) ---
router.get('/storage', async (req, res, next) => {
  try {
    res.render('pages/storage', { page: 'storage', report: await storage.getStorageReport() });
  } catch (err) {
    next(err);
  }
});

router.post('/storage/settings', express.urlencoded({ extended: true }), (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.body.max_age_hours) || 24, 1), 720);
  const mb = Math.min(Math.max(parseInt(req.body.max_mb) || 0, 0), 1024 * 1024);
  db.setSetting('image_cache_max_age_hours', String(hours));
  db.setSetting('image_cache_max_mb', String(mb));
  storage.runCacheMaintenance(); // apply the new limits right away
  res.redirect('/admin/storage?ok=storage_settings');
});

router.post('/storage/cleanup', (req, res) => {
  storage.runFullCleanup(); // runs in the background; the page shows progress + results
  res.redirect('/admin/storage?ok=cleanup');
});

// --- Clear Image Cache ---
router.post('/clear-cache', (req, res) => {
  const result = clearAllImages();
  res.redirect(`/admin/storage?ok=cache_cleared&n=${result.deletedRecords}`);
});

// --- Backup Database ---
router.get('/backup', (req, res) => {
  const dbPath = db.getDbPath();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupFile = path.join(path.dirname(dbPath), `crawlkomik-backup-${timestamp}.db`);
  try {
    // VACUUM INTO creates a consistent snapshot (safe even with active connections)
    db.getDb().exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);

    res.download(backupFile, `crawlkomik-backup-${timestamp}.db`, (err) => {
      // Clean up temp backup file after download
      try { fs.unlinkSync(backupFile); } catch {}
    });
  } catch (err) {
    // A failed VACUUM INTO (e.g. disk full) can leave a partial snapshot behind
    try { fs.unlinkSync(backupFile); } catch {}
    renderSettingsError(req, res, 'backup', 'backupError', 'Backup failed: ' + err.message);
  }
});

// --- Restore Database ---
router.post('/restore', upload.single('dbfile'), (req, res) => {
  const renderError = (msg) => renderSettingsError(req, res, 'backup', 'backupError', msg);

  if (!req.file) return renderError('No file uploaded');

  const tmpPath = req.file.path;

  try {
    // Validate: try opening uploaded file as SQLite
    const testDb = new Database(tmpPath, { readonly: true });
    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => t.name);
    testDb.close();

    // Must have our core tables
    const requiredTables = ['websites', 'page_configs', 'settings'];
    const missing = requiredTables.filter(t => !tableNames.includes(t));
    if (missing.length > 0) {
      fs.unlinkSync(tmpPath);
      return renderError(`Invalid backup: missing required tables (${missing.join(', ')})`);
    }

    // Warn-level: check for optional tables (they'll be created by migrations if missing)
    const optionalTables = ['image_cache', 'api_logs', 'custom_page_types'];
    const missingOptional = optionalTables.filter(t => !tableNames.includes(t));
    if (missingOptional.length > 0) {
      console.warn(`[Restore] Backup missing optional tables: ${missingOptional.join(', ')} — will be created empty`);
    }

    const dbPath = db.getDbPath();

    // Auto-backup current db before restore (consistent snapshot)
    const backupPath = dbPath + '.pre-restore';
    try {
      db.getDb().exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    } catch {
      // Fallback: checkpoint + copy if VACUUM INTO fails
      db.getDb().pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, backupPath);
    }

    // Close current connection before replacing file
    db.closeDb();

    // Replace db file
    fs.copyFileSync(tmpPath, dbPath);
    fs.unlinkSync(tmpPath);

    // Remove WAL/SHM files from old database
    for (const ext of ['-wal', '-shm']) {
      const f = dbPath + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    // The restored DB may have a different password (and session secret — the next
    // request may need a fresh login), so render directly instead of redirecting
    defaultPasswordCache = null;
    res.render('pages/settings', settingsLocals(req, {
      focusSection: 'backup',
      flash: { type: 'success', text: 'Database restored successfully' },
    }));
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    renderError('Restore failed: ' + err.message);
  }
});

module.exports = router;
