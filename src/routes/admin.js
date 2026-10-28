const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const db = require('../models/database');
const { requireAuth, createAuthCookie, clearAuthCookie, create2faPendingCookie, pending2faUser, clear2faPendingCookie } = require('../middleware/auth');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const { clearAllImages } = require('../services/image-proxy');
const { getActiveBrowserCount } = require('../services/browser');
const lightpanda = require('../services/lightpanda');
const proxyPool = require('../services/proxy-pool');
const loginGuard = require('../services/login-guard');
const storage = require('../services/storage');
const backup = require('../services/backup');
const wireguard = require('../services/wireguard');


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
    password: 'Password changed — your other devices were logged out',
    password_set: 'New password saved — welcome!',
    user_created: 'Admin added — they choose their own password at their first login',
    user_deleted: 'Admin deleted',
    user_password_reset: 'Password reset — that admin was logged out everywhere and picks a new password at the next login',
    user_2fa_reset: '2FA turned off for that admin',
    totp_enabled: '2FA enabled! You will need a code from your authenticator app on every login.',
    totp_disabled: '2FA has been disabled.',
    cache_cleared: 'Image cache cleared: {n} images removed.',
    storage_settings: 'Image cache settings saved',
    cleanup: 'Cleanup started — the results appear on this page when it finishes',
    website_created: 'Website created — now set up its page configs below',
    website_saved: 'Website saved',
    website_deleted: 'Website deleted',
    website_restored: 'Website restored from the backup',
    wg_added: '{n} WireGuard config(s) added',
    wg_saved: 'WireGuard config saved — its tunnel restarts with it at the next crawl',
    wg_deleted: 'WireGuard config deleted',
    type_added: 'Custom page type added',
    type_deleted: 'Custom page type deleted',
    config_saved: 'Config saved!',
    logs_deleted: '{n} log(s) deleted',
  },
  err: {},
};

function flashFromQuery(query) {
  const fill = (text) => text.replace('{n}', String(parseInt(query.n) || 0));
  if (query.ok && FLASH.ok[query.ok]) return { type: 'success', text: fill(FLASH.ok[query.ok]) };
  if (query.err && FLASH.err[query.err]) return { type: 'danger', text: fill(FLASH.err[query.err]) };
  return null;
}

function apiBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

// --- Accounts: shared helpers ---

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const TOTP_SECRET_RE = /^[A-Z2-7]{16,64}$/;

// A form field as text: the body parser turns name[]=… or name[x]=… into arrays/objects
const formText = (value) => (typeof value === 'string' ? value : '');

/** Why a new password is not acceptable, or null. Without a confirmation field, pass none. */
function passwordProblem(password, username, confirm = password) {
  const pw = formText(password);
  if (pw.length < db.MIN_PASSWORD_LENGTH) return `Password must be at least ${db.MIN_PASSWORD_LENGTH} characters`;
  if (pw.length > 200) return 'Password must be at most 200 characters';
  if (pw !== formText(confirm)) return 'Passwords do not match';
  if (pw.toLowerCase() === username.toLowerCase()) return 'Password must not be the same as the username';
  return null;
}

function tooManyAttempts(waitMs) {
  const minutes = Math.ceil(waitMs / 60000);
  return `Too many failed attempts — try again in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Account changes (adding or removing admins, passwords, 2FA) ask for the signed-in admin's
 * own password again, so a browser left logged in isn't enough to take over accounts.
 * Wrong guesses count toward the login brake. Returns an error message, or null when right.
 */
function reauthProblem(req, password, wrongMessage = 'Your password is wrong') {
  const waitMs = loginGuard.retryAfterMs(req.ip);
  if (waitMs) return tooManyAttempts(waitMs);
  if (db.verifyPassword(formText(password), req.user.password_hash)) return null;
  loginGuard.recordFailure(req.ip);
  return wrongMessage;
}

/** What views may see of an account: no password hash, TOTP secret or session version. */
function publicUser(user) {
  const { password_hash, totp_secret, session_version, ...rest } = user;
  return rest;
}

function totpFor(username, secret) {
  return new OTPAuth.TOTP({
    issuer: 'PinguinCrawl',
    label: username,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: typeof secret === 'string' ? OTPAuth.Secret.fromBase32(secret) : secret,
  });
}

// Unknown usernames are checked against this, so they take as long as a wrong password
// and response time doesn't reveal which usernames exist
let dummyHash = null;
function passwordMatches(user, password) {
  if (!dummyHash) dummyHash = db.hashPassword(crypto.randomBytes(16).toString('hex'));
  return db.verifyPassword(formText(password), user ? user.password_hash : dummyHash) && !!user;
}

// --- Login (public) ---
function loginLocals(extra = {}) {
  // Until the first login replaces it, the only account of a fresh install is admin/admin
  const users = db.getUsers();
  const defaultLogin = users.length === 1 && users[0].username === 'admin' && !!users[0].must_change_password && !users[0].created_by;
  return { layout: 'layouts/minimal', page: 'login', error: null, username: '', defaultLogin, ...extra };
}

router.get('/login', (req, res) => {
  res.render('pages/login', loginLocals());
});

function completeLogin(req, res, user) {
  loginGuard.reset(req.ip);
  db.touchUserLogin(user.id);
  createAuthCookie(res, req, user);
  res.redirect(user.must_change_password ? '/admin/account/password' : '/admin');
}

router.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  const waitMs = loginGuard.retryAfterMs(req.ip);
  if (waitMs) {
    return res.status(429).render('pages/login', loginLocals({ error: tooManyAttempts(waitMs) }));
  }
  const { username, password, totp_code } = req.body;

  // Step 2: 2FA code — the password was accepted moments ago (signed pending cookie)
  if (totp_code) {
    const user = pending2faUser(req);
    if (!user || !user.totp_enabled) {
      return res.render('pages/login', loginLocals({ error: 'Login expired — enter your username and password again' }));
    }
    if (totpFor(user.username, user.totp_secret).validate({ token: String(totp_code), window: 1 }) === null) {
      loginGuard.recordFailure(req.ip);
      return res.render('pages/2fa-verify', { layout: 'layouts/minimal', page: 'login', error: 'Invalid authenticator code' });
    }
    clear2faPendingCookie(res);
    return completeLogin(req, res, user);
  }

  // Step 1: username + password
  const name = formText(username).trim().toLowerCase();
  const user = name ? db.getUserByUsername(name) : null;
  if (!passwordMatches(user, password)) {
    loginGuard.recordFailure(req.ip);
    return res.render('pages/login', loginLocals({ error: 'Wrong username or password', username: name }));
  }
  if (user.totp_enabled && user.totp_secret) {
    create2faPendingCookie(res, req, user);
    return res.render('pages/2fa-verify', { layout: 'layouts/minimal', page: 'login', error: null });
  }
  completeLogin(req, res, user);
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
    diskWarning: storage.diskWarning(),
  };
  res.locals.flash = flashFromQuery(req.query);
  next();
});

// --- Dashboard ---
router.get('/', (req, res) => {
  const websites = db.getAllWebsites();
  res.render('pages/dashboard', {
    page: 'dashboard',
    websites,
    // Proxy labels without credentials (host:port:user:pass would slip past a URL regex)
    proxyLabels: Object.fromEntries(websites.map((w) => [w.id, proxyPool.websiteProxies(w).map(proxyPool.displayOf)])),
    configCounts: db.getPageConfigCountsByWebsite(),
    browserStatus: getActiveBrowserCount(),
    logStats: db.getApiLogStats(),
    cache: db.getImageCacheTotals(),
    filesystems: storage.filesystems(),
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
    challengeDetection: db.getSetting('challenge_detection') !== '0',
    lightpanda: { executable: lightpanda.executablePath(), version: lightpanda.cachedVersion() },
    websites: db.getAllWebsites(),
    username: req.user.username,
    totpEnabled: !!req.user.totp_enabled,
    minPassword: db.MIN_PASSWORD_LENGTH,
    clientIp: (req.ip || '').replace(/^::ffff:/, ''),
    wg: wireguardLocals(),
    wgError: null,
    wgForm: {},
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

// --- WireGuard configs (Settings → WireGuard) ---
// Uploaded .conf files hold private keys: kept in memory, never written to the upload dir
const wgUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024, files: 100 } });

function wireguardLocals() {
  const usage = db.getWireguardUsage();
  const runtime = wireguard.runtimeStatus();
  return {
    executable: wireguard.executablePath(),
    version: wireguard.cachedVersion(),
    idleMinutes: Math.round(wireguard.IDLE_MS / 60000),
    configs: db.getWireguardConfigs().map((c) => ({
      id: c.id, name: c.name, ...wireguard.summarize(c.config), usedBy: usage[c.name] || [], runtime: runtime[c.name] || null,
    })),
  };
}

function renderWireguard(req, res, { error = null, ok = null, form = {} } = {}) {
  res.render('pages/settings', settingsLocals(req, {
    focusSection: 'wireguard', wgError: error, wgForm: form,
    flash: error ? { type: 'danger', text: error } : ok ? { type: 'success', text: ok } : null,
  }));
}

// Pasted config and/or .conf files; each file becomes a config named after the file
router.post('/wireguard', (req, res, next) => {
  wgUpload.array('files', 100)(req, res, (err) => (err ? renderWireguard(req, res, { error: `Upload failed: ${err.message}` }) : next()));
}, async (req, res) => {
  const name = formText(req.body.name).trim();
  const text = formText(req.body.config).trim();
  const items = [];
  if (text) items.push({ label: name || 'pasted config', name: wireguard.nameFrom(name), config: text, pasted: true });
  for (const f of req.files || []) items.push({ label: f.originalname, name: wireguard.nameFrom(f.originalname), config: f.buffer.toString('utf8').trim() });
  if (!items.length) return renderWireguard(req, res, { error: 'Paste a WireGuard config or choose .conf files' });

  const added = [];
  const problems = [];
  for (const item of items) {
    try {
      if (!item.name) throw new Error(item.pasted ? 'give the pasted config a name' : 'no usable name in the file name');
      if (db.getWireguardConfigByName(item.name)) throw new Error(`a config named "${item.name}" already exists`);
      wireguard.parseConfig(item.config);
      await wireguard.checkWithWireproxy(item.config);
      db.createWireguardConfig({ name: item.name, config: item.config + '\n' });
      added.push(item.name);
    } catch (err) {
      problems.push(`${item.label}: ${err.message}`);
    }
  }
  if (problems.length) {
    return renderWireguard(req, res, {
      error: `${added.length ? `Added ${added.join(', ')}. ` : ''}Not added — ${problems.join(' · ')}`,
      form: added.length ? {} : { name, config: text },
    });
  }
  res.redirect(`/admin/settings?ok=wg_added&n=${added.length}#wireguard`);
});

function wireguardEditLocals(cfg, extra = {}) {
  return {
    page: 'settings', cfg, summary: wireguard.summarize(cfg.config), usedBy: db.getWireguardUsage()[cfg.name] || [], error: null, ...extra,
  };
}

router.get('/wireguard/:id', (req, res) => {
  const cfg = db.getWireguardConfigById(req.params.id);
  if (!cfg) return res.redirect('/admin/settings#wireguard');
  res.render('pages/wireguard-edit', wireguardEditLocals(cfg));
});

router.post('/wireguard/:id', express.urlencoded({ extended: true }), async (req, res) => {
  const cfg = db.getWireguardConfigById(req.params.id);
  if (!cfg) return res.redirect('/admin/settings#wireguard');
  const name = wireguard.nameFrom(formText(req.body.name));
  const config = formText(req.body.config).trim();
  const fail = (message) => res.render('pages/wireguard-edit', wireguardEditLocals({ ...cfg, name: formText(req.body.name), config }, {
    error: message, flash: { type: 'danger', text: message },
  }));
  try {
    if (!name) return fail('Name is required — letters, numbers, dot, dash or underscore');
    const other = db.getWireguardConfigByName(name);
    if (other && other.id !== cfg.id) return fail(`A config named "${name}" already exists`);
    wireguard.parseConfig(config);
    await wireguard.checkWithWireproxy(config);
  } catch (err) {
    return fail(err.message);
  }
  db.updateWireguardConfig(cfg.id, { name, config: config + '\n' });
  await wireguard.stop(cfg.name); // the running tunnel still has the old config
  res.redirect('/admin/settings?ok=wg_saved#wireguard');
});

// Bring the tunnel up (handshake) — the same thing a crawl does first
router.post('/wireguard/:id/test', async (req, res) => {
  const cfg = db.getWireguardConfigById(req.params.id);
  if (!cfg) return res.redirect('/admin/settings#wireguard');
  try {
    const r = await wireguard.test(cfg.name);
    renderWireguard(req, res, { ok: `WireGuard "${cfg.name}": tunnel up, handshake OK (${(r.ms / 1000).toFixed(1)} s)` });
  } catch (err) {
    renderWireguard(req, res, { error: err.message });
  }
});

router.post('/wireguard/:id/delete', async (req, res) => {
  const cfg = db.getWireguardConfigById(req.params.id);
  if (!cfg) return res.redirect('/admin/settings#wireguard');
  const usedBy = db.getWireguardUsage()[cfg.name] || [];
  if (usedBy.length) {
    return renderWireguard(req, res, { error: `"${cfg.name}" is ticked on website(s) ${usedBy.join(', ')} — untick it there first` });
  }
  db.deleteWireguardConfig(cfg.id);
  await wireguard.stop(cfg.name);
  res.redirect('/admin/settings?ok=wg_deleted#wireguard');
});

// --- Change own password ---
// Also the page a default ("admin") or admin-issued password leads to: until it is
// replaced, requireAuth sends every other admin page here.
function accountPasswordLocals(req, extra = {}) {
  return { layout: 'layouts/minimal', page: 'account', username: req.user.username, minPassword: db.MIN_PASSWORD_LENGTH, error: null, ...extra };
}

router.get('/account/password', (req, res) => {
  if (!req.user.must_change_password) return res.redirect('/admin/settings#security');
  res.render('pages/account-password', accountPasswordLocals(req));
});

router.post('/change-password', express.urlencoded({ extended: true }), (req, res) => {
  const { current_password, confirm_password } = req.body;
  const new_password = formText(req.body.new_password);
  const forced = !!req.user.must_change_password;
  const fail = (message) => (forced
    ? res.render('pages/account-password', accountPasswordLocals(req, { error: message }))
    : renderSettingsError(req, res, 'security', 'pwError', message));

  const problem = reauthProblem(req, current_password, 'Current password is wrong')
    || passwordProblem(new_password, req.user.username, confirm_password);
  if (problem) return fail(problem);
  if (db.verifyPassword(new_password, req.user.password_hash)) {
    return fail('The new password must be different from the current one');
  }

  db.setUserPassword(req.user.id, new_password);
  // The new session version logs out every other device; this one gets a fresh cookie
  createAuthCookie(res, req, db.getUserById(req.user.id));
  res.redirect(forced ? '/admin?ok=password_set' : '/admin/settings?ok=password#security');
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
  // Checkbox: present ('on') = fail fast on challenge pages, absent = treat them as content
  db.setSetting('challenge_detection', req.body.challenge_detection === 'on' ? '1' : '0');
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

// The ticked WireGuard configs (checkboxes: none, one value or several), in Settings order.
// Kept while the proxy list is in use too, so switching the type back loses nothing.
function wireguardField(body) {
  const picked = new Set([].concat(body.wireguard || []).filter((v) => typeof v === 'string'));
  const names = db.getWireguardConfigs().map((c) => c.name).filter((n) => picked.has(n));
  if (body.proxy_type === 'wireguard' && !names.length) {
    throw new Error('Proxy type WireGuard: tick at least one WireGuard config (add them under Settings → WireGuard)');
  }
  return names.join('\n') || null;
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
    // One proxy per line; a typo is a form error, not a crawl that silently goes direct
    proxy: proxyPool.normalizeProxyList(body.proxy) || null,
    proxy_type: body.proxy_type === 'wireguard' ? 'wireguard' : 'proxy',
    wireguard: wireguardField(body),
    proxy_rotation: proxyPool.ROTATIONS.includes(body.proxy_rotation) ? body.proxy_rotation : 'round_robin',
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
    proxyStatus: proxyPool.status(proxyPool.websiteProxies(website)),
    wireguardConfigs: db.getWireguardConfigs().map((c) => ({ name: c.name, ...wireguard.summarize(c.config) })),
    wireproxyInstalled: !!wireguard.executablePath(),
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
    res.render('pages/website-form', websiteFormLocals(req, { ...req.body, image_proxy: req.body.image_proxy === 'on', wireguard: [].concat(req.body.wireguard || []).join('\n') }, {
      error: message, flash: { type: 'danger', text: message },
    }));
  }
});

// --- Website backup & restore ---
// Same file format as the full backup (see services/backup.js). A website can also be
// restored from a full backup: the website with its name is taken from it.

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// Website names are free text — keep a download name to safe characters
function fileSafe(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60) || 'website';
}

// Our own messages are meant for the admin as they are; anything else gets context
const restoreMessage = (err) => (err.code ? `Restore failed: ${err.message}` : err.message);

// New website from a backup (Add Website page): a website backup, or one website of a full backup.
// Registered before /websites/:id, which would take "restore" for an id.
router.post('/websites/restore', upload.single('dbfile'), (req, res) => {
  const name = formText(req.body.website).trim().toLowerCase() || null;
  const fail = (message) => res.render('pages/website-form', websiteFormLocals(req, null, {
    restore_error: message, restoreName: name || '', flash: { type: 'danger', text: message },
  }));
  if (!req.file) return fail('No file uploaded');
  try {
    const data = backup.readWebsiteBackup(req.file.path, name);
    if (db.getWebsiteByName(data.website.name)) {
      return fail(`A website named "${data.website.name}" already exists — open it and restore there (Backup & Restore)`);
    }
    const id = backup.restoreWebsite(data);
    res.redirect(`/admin/websites/${id}?ok=website_restored`);
  } catch (err) {
    fail(restoreMessage(err));
  } finally {
    fs.rmSync(req.file.path, { force: true });
  }
});

function renderWebsiteBackupError(req, res, website, message) {
  res.render('pages/website-form', websiteFormLocals(req, website, { backup_error: message, flash: { type: 'danger', text: message } }));
}

router.get('/websites/:id/backup', (req, res) => {
  const website = db.getWebsiteById(req.params.id);
  if (!website) return res.redirect('/admin');
  const downloadName = `pinguincrawl-backup-${fileSafe(website.name)}-${backupStamp()}.db`;
  // Unique on disk (two downloads in the same second); still matches the stale-file sweep
  const file = path.join(path.dirname(db.getDbPath()), downloadName.replace(/\.db$/, `-${crypto.randomBytes(4).toString('hex')}.db`));
  try {
    backup.exportWebsite(website.id, file);
    res.download(file, downloadName, () => fs.rmSync(file, { force: true }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    renderWebsiteBackupError(req, res, website, 'Backup failed: ' + err.message);
  }
});

// Replaces this website's settings, page configs and custom page types with the backup's;
// other websites, the image cache and logs stay as they are
router.post('/websites/:id/restore', upload.single('dbfile'), (req, res) => {
  const website = db.getWebsiteById(req.params.id);
  try {
    if (!website) return res.redirect('/admin');
    if (!req.file) return renderWebsiteBackupError(req, res, website, 'No file uploaded');
    const data = backup.readWebsiteBackup(req.file.path, website.name);
    backup.savePreRestoreSnapshot(); // same safety copy as the full restore
    backup.restoreWebsite(data, website.id);
    res.redirect(`/admin/websites/${website.id}?ok=website_restored`);
  } catch (err) {
    renderWebsiteBackupError(req, res, website, restoreMessage(err));
  } finally {
    if (req.file) fs.rmSync(req.file.path, { force: true });
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
    const edited = { ...website, ...req.body, image_proxy: req.body.image_proxy === 'on', active: req.body.active === 'on', wireguard: [].concat(req.body.wireguard || []).join('\n') };
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

// --- Lightpanda self-check ---
// Whether the crawl browser works here and what it sends; with ?website=<name> also
// opens that website's base URL through its proxy and reports a challenge page.
router.get('/browser-check', async (req, res) => {
  try {
    const { runBrowserCheck } = require('../services/browser-check');
    const report = await runBrowserCheck(req.query.website || undefined);
    res.json(report);
  } catch (err) {
    const notFound = /not found$/.test(err.message);
    res.status(notFound ? 404 : 500).json({ status: 'error', message: err.message });
  }
});

// --- Logout from all devices (this account only) ---
router.post('/logout-all', (req, res) => {
  db.bumpSessionVersion(req.user.id);
  clearAuthCookie(res);
  res.redirect('/admin/login');
});

// --- 2FA (per admin) ---
async function twoFactorSetupLocals(req, secret, extra = {}) {
  const uri = totpFor(req.user.username, secret).toString();
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(uri);
  } catch { /* QR generation failed — the page shows the secret too */ }
  return { page: 'settings', secret, qrDataUrl, uri, totpEnabled: !!req.user.totp_enabled, error: null, ...extra };
}

router.get('/2fa/setup', async (req, res, next) => {
  try {
    res.render('pages/2fa-setup', await twoFactorSetupLocals(req, new OTPAuth.Secret({ size: 20 }).base32));
  } catch (err) {
    next(err);
  }
});

router.post('/2fa/enable', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const secret = formText(req.body.secret);
    const totpCode = formText(req.body.totp_code);
    // Already on: turning it off first takes the password, so a session alone can't swap the secret
    if (req.user.totp_enabled || !TOTP_SECRET_RE.test(secret) || !totpCode) {
      return res.redirect('/admin/2fa/setup');
    }
    const problem = reauthProblem(req, req.body.current_password)
      || (totpFor(req.user.username, secret).validate({ token: totpCode, window: 1 }) === null ? 'Invalid code. Please try again.' : null);
    if (problem) {
      return res.render('pages/2fa-setup', await twoFactorSetupLocals(req, secret, {
        error: problem, flash: { type: 'danger', text: problem },
      }));
    }
    db.setUserTotp(req.user.id, secret);
    res.redirect('/admin/settings?ok=totp_enabled#security');
  } catch (err) {
    next(err);
  }
});

router.post('/2fa/disable', express.urlencoded({ extended: true }), (req, res) => {
  const problem = reauthProblem(req, req.body.current_password, 'Wrong password. Cannot disable 2FA.');
  if (problem) return renderSettingsError(req, res, 'security', 'totpError', problem);
  db.setUserTotp(req.user.id, null);
  res.redirect('/admin/settings?ok=totp_disabled#security');
});

// --- Admins ---
// Every admin has full access, managing the other admins included. Nobody can remove or
// reset their own account here (Settings → Security has their password, 2FA and sessions),
// so there is always at least one admin left.
function usersLocals(req, extra = {}) {
  return { page: 'users', users: db.getUsers(), me: req.user.id, minPassword: db.MIN_PASSWORD_LENGTH, error: null, form: {}, ...extra };
}

router.get('/users', (req, res) => {
  res.render('pages/users', usersLocals(req));
});

router.post('/users', express.urlencoded({ extended: true }), (req, res) => {
  const username = formText(req.body.username).trim().toLowerCase();
  const password = formText(req.body.password);
  const fail = (message) => res.render('pages/users', usersLocals(req, {
    error: message, form: { username }, flash: { type: 'danger', text: message },
  }));

  if (!USERNAME_RE.test(username)) {
    return fail('Username: 3–32 characters — lowercase letters, numbers, dot, dash or underscore, starting with a letter or number');
  }
  const problem = passwordProblem(password, username) || reauthProblem(req, req.body.your_password);
  if (problem) return fail(problem);
  try {
    // A temporary password: the new admin has to pick their own at the first login
    db.createUser({ username, password, mustChange: true, createdBy: req.user.username });
  } catch (err) {
    return fail(err.message.includes('UNIQUE') ? `An admin named "${username}" already exists` : err.message);
  }
  res.redirect('/admin/users?ok=user_created');
});

// Another admin's account, or null — your own isn't managed from here
function otherUser(req) {
  const user = db.getUserById(parseInt(req.params.id) || 0);
  return user && user.id !== req.user.id ? user : null;
}

function renderManage(req, res, target, error = null) {
  res.render('pages/user-manage', {
    page: 'users', target: publicUser(target), minPassword: db.MIN_PASSWORD_LENGTH, error,
    ...(error ? { flash: { type: 'danger', text: error } } : {}),
  });
}

router.get('/users/:id', (req, res) => {
  const target = otherUser(req);
  if (!target) return res.redirect('/admin/users');
  renderManage(req, res, target);
});

// Forgotten password: a new temporary one; that admin is logged out everywhere
router.post('/users/:id/password', express.urlencoded({ extended: true }), (req, res) => {
  const target = otherUser(req);
  if (!target) return res.redirect('/admin/users');
  const password = formText(req.body.password);
  const problem = passwordProblem(password, target.username) || reauthProblem(req, req.body.your_password);
  if (problem) return renderManage(req, res, target, problem);
  db.setUserPassword(target.id, password, { mustChange: true });
  res.redirect('/admin/users?ok=user_password_reset');
});

// Lost authenticator: the next login takes the password only
router.post('/users/:id/2fa/reset', express.urlencoded({ extended: true }), (req, res) => {
  const target = otherUser(req);
  if (!target) return res.redirect('/admin/users');
  const problem = reauthProblem(req, req.body.your_password);
  if (problem) return renderManage(req, res, target, problem);
  db.setUserTotp(target.id, null);
  res.redirect('/admin/users?ok=user_2fa_reset');
});

router.post('/users/:id/delete', express.urlencoded({ extended: true }), (req, res) => {
  const target = otherUser(req);
  if (!target) return res.redirect('/admin/users');
  const problem = reauthProblem(req, req.body.your_password);
  if (problem) return renderManage(req, res, target, problem);
  db.deleteUser(target.id); // their session cookies stop working with the row gone
  res.redirect('/admin/users?ok=user_deleted');
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
  const timestamp = backupStamp();
  const backupFile = path.join(path.dirname(dbPath), `pinguincrawl-backup-${timestamp}.db`);
  try {
    // VACUUM INTO creates a consistent snapshot (safe even with active connections)
    db.getDb().exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);

    res.download(backupFile, `pinguincrawl-backup-${timestamp}.db`, (err) => {
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
    // Validate: one of our SQLite files, with the core tables
    const info = backup.inspectBackup(tmpPath);
    // A website backup would replace everything with that one website (and no admins)
    if (info.scope === backup.WEBSITE_SCOPE) {
      fs.unlinkSync(tmpPath);
      return renderError(`This is a backup of one website ("${info.websites[0] || '?'}") — restore it on that website's page (Backup & Restore), or under Add Website if it no longer exists`);
    }

    // Warn-level: check for optional tables (they'll be created by migrations if missing)
    const optionalTables = ['image_cache', 'api_logs', 'custom_page_types'];
    const missingOptional = optionalTables.filter(t => !info.tables.includes(t));
    if (missingOptional.length > 0) {
      console.warn(`[Restore] Backup missing optional tables: ${missingOptional.join(', ')} — will be created empty`);
    }

    const dbPath = db.getDbPath();

    // Auto-backup current db before restore (consistent snapshot)
    backup.savePreRestoreSnapshot();

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

    // The restored DB has its own admins (and session secret — the next request may need
    // a fresh login), so render directly instead of redirecting
    res.render('pages/settings', settingsLocals(req, {
      focusSection: 'backup',
      flash: { type: 'success', text: 'Database restored successfully' },
    }));
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    renderError(restoreMessage(err));
  }
});

module.exports = router;
