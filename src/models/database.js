const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'pinguincrawl.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS websites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      image_proxy INTEGER DEFAULT 0,
      proxy TEXT DEFAULT NULL,
      user_agent TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS page_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER NOT NULL,
      page_type TEXT NOT NULL CHECK(page_type IN ('katalog','komik_detail','chapter_list','chapter')),
      selectors TEXT NOT NULL DEFAULT '{}',
      actions TEXT NOT NULL DEFAULT '[]',
      wait_for TEXT DEFAULT NULL,
      wait_timeout INTEGER DEFAULT 30000,
      scroll_to_bottom INTEGER DEFAULT 0,
      custom_js TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
      UNIQUE(website_id, page_type)
    );

    CREATE TABLE IF NOT EXISTS image_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      original_url TEXT NOT NULL,
      website_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_type TEXT DEFAULT 'image/jpeg',
      size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      website TEXT,
      url TEXT,
      status TEXT NOT NULL,
      status_code INTEGER NOT NULL DEFAULT 200,
      error_message TEXT,
      response_body TEXT,
      duration_ms INTEGER DEFAULT 0,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add image_proxy column if missing
  const cols = db.prepare("PRAGMA table_info(websites)").all();
  if (!cols.find(c => c.name === 'image_proxy')) {
    db.exec("ALTER TABLE websites ADD COLUMN image_proxy INTEGER DEFAULT 0");
  }

  // Migration: add regex_replace column if missing
  const pcCols = db.prepare("PRAGMA table_info(page_configs)").all();
  if (!pcCols.find(c => c.name === 'regex_replace')) {
    db.exec("ALTER TABLE page_configs ADD COLUMN regex_replace TEXT DEFAULT '[]'");
  }

  // Migration: add selectors_required column if missing
  const pcCols2 = db.prepare("PRAGMA table_info(page_configs)").all();
  if (!pcCols2.find(c => c.name === 'selectors_required')) {
    db.exec("ALTER TABLE page_configs ADD COLUMN selectors_required TEXT DEFAULT '{}'");
  }

  // Migration: add block_images and use_proxy columns to page_configs
  const pcCols3 = db.prepare("PRAGMA table_info(page_configs)").all();
  if (!pcCols3.find(c => c.name === 'block_images')) {
    db.exec("ALTER TABLE page_configs ADD COLUMN block_images INTEGER DEFAULT 0");
  }
  if (!pcCols3.find(c => c.name === 'use_proxy')) {
    db.exec("ALTER TABLE page_configs ADD COLUMN use_proxy INTEGER DEFAULT 0");
  }

  // Migration: add image_cache_method column if missing (browser or node)
  const wColsMethod = db.prepare("PRAGMA table_info(websites)").all();
  if (!wColsMethod.find(c => c.name === 'image_cache_method')) {
    db.exec("ALTER TABLE websites ADD COLUMN image_cache_method TEXT DEFAULT 'browser'");
  }

  // Migration: add custom_headers and cookies columns if missing
  const wCols = db.prepare("PRAGMA table_info(websites)").all();
  if (!wCols.find(c => c.name === 'custom_headers')) {
    db.exec("ALTER TABLE websites ADD COLUMN custom_headers TEXT DEFAULT '{}'");
  }
  if (!wCols.find(c => c.name === 'cookies')) {
    db.exec("ALTER TABLE websites ADD COLUMN cookies TEXT DEFAULT '[]'");
  }

  // Migration: add local_storage column if missing
  const wCols2 = db.prepare("PRAGMA table_info(websites)").all();
  if (!wCols2.find(c => c.name === 'local_storage')) {
    db.exec("ALTER TABLE websites ADD COLUMN local_storage TEXT DEFAULT '{}'");
  }

  // Migration: add timezone column (IANA name, e.g. Asia/Singapore). Containers run in
  // UTC, so a proxy in another country leaves IP geolocation and the browser clock
  // disagreeing — a geo-consistency signal Cloudflare checks.
  const wCols3 = db.prepare("PRAGMA table_info(websites)").all();
  if (!wCols3.find(c => c.name === 'timezone')) {
    db.exec("ALTER TABLE websites ADD COLUMN timezone TEXT DEFAULT NULL");
  }

  // Migration: add proxy_rotation column. The proxy column may hold several proxies, one
  // per line; this says how crawls take turns: round_robin | random | failover
  const wCols4 = db.prepare("PRAGMA table_info(websites)").all();
  if (!wCols4.find(c => c.name === 'proxy_rotation')) {
    db.exec("ALTER TABLE websites ADD COLUMN proxy_rotation TEXT DEFAULT 'round_robin'");
  }

  // Migration: second kind of proxy. proxy_type 'wireguard' crawls through the WireGuard
  // configs named in `wireguard` (one per line, from Settings → WireGuard) instead of the
  // proxy list; both are kept, so switching back and forth loses nothing.
  const wCols5 = db.prepare("PRAGMA table_info(websites)").all();
  if (!wCols5.find(c => c.name === 'proxy_type')) {
    db.exec("ALTER TABLE websites ADD COLUMN proxy_type TEXT DEFAULT 'proxy'");
  }
  if (!wCols5.find(c => c.name === 'wireguard')) {
    db.exec("ALTER TABLE websites ADD COLUMN wireguard TEXT DEFAULT NULL");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS wireguard_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      config TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Migration: add use_js column to page_configs (1=browser render, 0=simple HTTP)
  const pcCols4 = db.prepare("PRAGMA table_info(page_configs)").all();
  if (!pcCols4.find(c => c.name === 'use_js')) {
    db.exec("ALTER TABLE page_configs ADD COLUMN use_js INTEGER DEFAULT 1");
  }

  // Migration: add custom_fields column to page_configs (JSON array of custom response fields)
  const pcCols5 = db.prepare("PRAGMA table_info(page_configs)").all();
  if (!pcCols5.find(c => c.name === 'custom_fields')) {
    db.exec("ALTER TABLE page_configs ADD COLUMN custom_fields TEXT DEFAULT '[]'");
  }

  // Migration: remove CHECK constraint on page_type to allow custom page types
  // SQLite can't ALTER CHECK, so we recreate the table without it
  const checkInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='page_configs'").get();
  if (checkInfo && checkInfo.sql && checkInfo.sql.includes("CHECK(page_type IN")) {
    db.exec(`
      CREATE TABLE page_configs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        website_id INTEGER NOT NULL,
        page_type TEXT NOT NULL,
        selectors TEXT NOT NULL DEFAULT '{}',
        actions TEXT NOT NULL DEFAULT '[]',
        wait_for TEXT DEFAULT NULL,
        wait_timeout INTEGER DEFAULT 30000,
        scroll_to_bottom INTEGER DEFAULT 0,
        custom_js TEXT DEFAULT NULL,
        regex_replace TEXT DEFAULT '[]',
        selectors_required TEXT DEFAULT '{}',
        block_images INTEGER DEFAULT 0,
        use_proxy INTEGER DEFAULT 0,
        use_js INTEGER DEFAULT 1,
        custom_fields TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        UNIQUE(website_id, page_type)
      );
      INSERT INTO page_configs_new SELECT id, website_id, page_type, selectors, actions, wait_for, wait_timeout, scroll_to_bottom, custom_js, regex_replace, selectors_required, block_images, use_proxy, use_js, custom_fields, created_at, updated_at FROM page_configs;
      DROP TABLE page_configs;
      ALTER TABLE page_configs_new RENAME TO page_configs;
    `);
  }

  // Expiry and size-cap eviction both scan image_cache by age
  db.exec('CREATE INDEX IF NOT EXISTS idx_image_cache_created_at ON image_cache(created_at)');

  // Create custom_page_types table for admin-defined page types (per website)
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_page_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
      UNIQUE(website_id, name)
    );
  `);

  // Migration: add website_id column if missing (existing global table → per-website)
  const cptCols = db.prepare("PRAGMA table_info(custom_page_types)").all();
  if (!cptCols.find(c => c.name === 'website_id')) {
    // Drop old global table and recreate with website_id
    db.exec(`
      DROP TABLE IF EXISTS custom_page_types;
      CREATE TABLE custom_page_types (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        website_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE,
        UNIQUE(website_id, name)
      );
    `);
  }

  // Admin accounts. session_version is part of every login cookie: bumping it (new
  // password, logout everywhere) ends all sessions of that one account.
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      must_change_password INTEGER DEFAULT 0,
      totp_enabled INTEGER DEFAULT 0,
      totp_secret TEXT DEFAULT NULL,
      session_version INTEGER DEFAULT 1,
      created_by TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_login_at TEXT DEFAULT NULL
    );
  `);
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) seedFirstUser();
}

/**
 * The first account, "admin". A database from before multi-user login (or a crawlkomik
 * backup) keeps its single password and 2FA, so upgrading or restoring keeps the same
 * login. A fresh install takes ADMIN_PASSWORD, or else "admin" — which must be changed at
 * the first login.
 */
function seedFirstUser() {
  const setting = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  };
  const legacyHash = setting('admin_password');
  const envPassword = process.env.ADMIN_PASSWORD || '';
  if (envPassword && envPassword.length < MIN_PASSWORD_LENGTH) {
    console.warn(`[Auth] ADMIN_PASSWORD ignored: shorter than ${MIN_PASSWORD_LENGTH} characters`);
  }
  let hash;
  let mustChange;
  if (legacyHash) {
    hash = legacyHash;
    mustChange = verifyPassword('admin', legacyHash); // still the default password
  } else if (envPassword.length >= MIN_PASSWORD_LENGTH) {
    hash = hashPassword(envPassword);
    mustChange = false;
  } else {
    hash = hashPassword('admin');
    mustChange = true;
  }
  const totpSecret = setting('totp_enabled') === '1' ? setting('totp_secret') : null;
  db.transaction(() => {
    db.prepare('INSERT INTO users (username, password_hash, must_change_password, totp_enabled, totp_secret) VALUES (?, ?, ?, ?, ?)')
      .run('admin', hash, mustChange ? 1 : 0, totpSecret ? 1 : 0, totpSecret);
    // Now on the user — don't keep a second copy of the secrets in settings
    db.prepare("DELETE FROM settings WHERE key IN ('admin_password', 'totp_enabled', 'totp_secret')").run();
  })();
}

// --- Website CRUD ---

function getAllWebsites() {
  return getDb().prepare('SELECT * FROM websites ORDER BY name').all();
}

function getActiveWebsites() {
  return getDb().prepare('SELECT * FROM websites WHERE active = 1 ORDER BY name').all();
}

function getWebsiteById(id) {
  return getDb().prepare('SELECT * FROM websites WHERE id = ?').get(id);
}

function getWebsiteByName(name) {
  return getDb().prepare('SELECT * FROM websites WHERE name = ?').get(name);
}

function createWebsite({ name, base_url, proxy, proxy_type, wireguard, proxy_rotation, user_agent, image_proxy, image_cache_method, custom_headers, cookies, local_storage, timezone }) {
  const stmt = getDb().prepare(
    `INSERT INTO websites (name, base_url, proxy, proxy_type, wireguard, proxy_rotation, user_agent, image_proxy, image_cache_method, custom_headers, cookies, local_storage, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return stmt.run(name, base_url, proxy || null, proxy_type === 'wireguard' ? 'wireguard' : 'proxy', wireguard || null, proxy_rotation || 'round_robin', user_agent || null, image_proxy ? 1 : 0, image_cache_method || 'browser', custom_headers || '{}', cookies || '[]', local_storage || '{}', timezone || null);
}

function updateWebsite(id, { name, base_url, active, proxy, proxy_type, wireguard, proxy_rotation, user_agent, image_proxy, image_cache_method, custom_headers, cookies, local_storage, timezone }) {
  const stmt = getDb().prepare(
    `UPDATE websites SET name=?, base_url=?, active=?, proxy=?, proxy_type=?, wireguard=?, proxy_rotation=?, user_agent=?, image_proxy=?, image_cache_method=?, custom_headers=?, cookies=?, local_storage=?, timezone=?, updated_at=datetime('now') WHERE id=?`
  );
  return stmt.run(name, base_url, active ? 1 : 0, proxy || null, proxy_type === 'wireguard' ? 'wireguard' : 'proxy', wireguard || null, proxy_rotation || 'round_robin', user_agent || null, image_proxy ? 1 : 0, image_cache_method || 'browser', custom_headers || '{}', cookies || '[]', local_storage || '{}', timezone || null, id);
}

function updateWebsiteCookies(id, cookies) {
  getDb().prepare('UPDATE websites SET cookies=?, updated_at=datetime(\'now\') WHERE id=?').run(JSON.stringify(cookies), id);
}

function deleteWebsite(id) {
  return getDb().prepare('DELETE FROM websites WHERE id = ?').run(id);
}

// --- Page Config CRUD ---

function getPageConfigs(websiteId) {
  return getDb().prepare('SELECT * FROM page_configs WHERE website_id = ? ORDER BY page_type').all(websiteId);
}

function getPageConfig(websiteId, pageType) {
  return getDb().prepare('SELECT * FROM page_configs WHERE website_id = ? AND page_type = ?').get(websiteId, pageType);
}

function upsertPageConfig(websiteId, pageType, config) {
  const existing = getPageConfig(websiteId, pageType);
  const selectors = typeof config.selectors === 'string' ? config.selectors : JSON.stringify(config.selectors || {});
  const actions = typeof config.actions === 'string' ? config.actions : JSON.stringify(config.actions || []);
  const regexReplace = typeof config.regex_replace === 'string' ? config.regex_replace : JSON.stringify(config.regex_replace || []);
  const selectorsRequired = typeof config.selectors_required === 'string' ? config.selectors_required : JSON.stringify(config.selectors_required || {});
  const customFields = typeof config.custom_fields === 'string' ? config.custom_fields : JSON.stringify(config.custom_fields || []);

  const blockImages = config.block_images ? 1 : 0;
  const useProxy = parseInt(config.use_proxy) || 0;
  const useJs = config.use_js !== undefined ? (config.use_js ? 1 : 0) : 1;

  if (existing) {
    const stmt = getDb().prepare(
      `UPDATE page_configs SET selectors=?, actions=?, wait_for=?, wait_timeout=?, scroll_to_bottom=?, custom_js=?, regex_replace=?, selectors_required=?, block_images=?, use_proxy=?, use_js=?, custom_fields=?, updated_at=datetime('now')
       WHERE website_id=? AND page_type=?`
    );
    return stmt.run(selectors, actions, config.wait_for || null, config.wait_timeout || 30000, config.scroll_to_bottom ? 1 : 0, config.custom_js || null, regexReplace, selectorsRequired, blockImages, useProxy, useJs, customFields, websiteId, pageType);
  } else {
    const stmt = getDb().prepare(
      `INSERT INTO page_configs (website_id, page_type, selectors, actions, wait_for, wait_timeout, scroll_to_bottom, custom_js, regex_replace, selectors_required, block_images, use_proxy, use_js, custom_fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    return stmt.run(websiteId, pageType, selectors, actions, config.wait_for || null, config.wait_timeout || 30000, config.scroll_to_bottom ? 1 : 0, config.custom_js || null, regexReplace, selectorsRequired, blockImages, useProxy, useJs, customFields);
  }
}

function deletePageConfig(id) {
  return getDb().prepare('DELETE FROM page_configs WHERE id = ?').run(id);
}

/** { website_id: number of page configs } for the dashboard list. */
function getPageConfigCountsByWebsite() {
  const rows = getDb().prepare('SELECT website_id, COUNT(*) AS c FROM page_configs GROUP BY website_id').all();
  return Object.fromEntries(rows.map((r) => [r.website_id, r.c]));
}

// --- Image Cache ---

function getImageByHash(hash) {
  return getDb().prepare('SELECT * FROM image_cache WHERE hash = ?').get(hash);
}

function createImageCache({ hash, original_url, website_name, file_path, content_type, size }) {
  const stmt = getDb().prepare(
    `INSERT INTO image_cache (hash, original_url, website_name, file_path, content_type, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(hash) DO UPDATE SET file_path=excluded.file_path, content_type=excluded.content_type, size=excluded.size, created_at=datetime('now')`
  );
  return stmt.run(hash, original_url, website_name, file_path, content_type || 'image/jpeg', size || 0);
}

function getImageCacheStats() {
  return getDb().prepare('SELECT website_name, COUNT(*) as count, SUM(size) as total_size FROM image_cache GROUP BY website_name').all();
}

function getImageCacheTotals() {
  return getDb().prepare('SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as bytes FROM image_cache').get();
}

// created_at is stored via datetime('now') (UTC, "YYYY-MM-DD HH:MM:SS"), so compare with
// datetime('now', ...) to keep the string formats identical. An ISO cutoff ("…T…Z")
// compared as a string marked every image from the previous UTC day as expired — some
// only minutes old.
function getExpiredImages(maxAgeMs) {
  return getDb().prepare("SELECT * FROM image_cache WHERE created_at < datetime('now', ?)")
    .all(`-${Math.round(maxAgeMs / 1000)} seconds`);
}

function getOldestImages(limit) {
  return getDb().prepare('SELECT id, file_path, size FROM image_cache ORDER BY created_at ASC, id ASC LIMIT ?').all(limit);
}

function getAllImageCachePaths() {
  return getDb().prepare('SELECT file_path FROM image_cache').pluck().all();
}

function deleteImageCacheByIds(ids) {
  const stmt = getDb().prepare('DELETE FROM image_cache WHERE id = ?');
  getDb().transaction((list) => { for (const id of list) stmt.run(id); })(ids);
}

function deleteAllImageCache() {
  return getDb().prepare('DELETE FROM image_cache').run();
}

function getImageCacheCount() {
  return getDb().prepare('SELECT COUNT(*) as count FROM image_cache').get().count;
}

// --- API Logs ---

function createApiLog({ endpoint, website, url, status, status_code, error_message, response_body, duration_ms, ip }) {
  const stmt = getDb().prepare(
    `INSERT INTO api_logs (endpoint, website, url, status, status_code, error_message, response_body, duration_ms, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  return stmt.run(endpoint, website || null, url || null, status, status_code || 200, error_message || null, response_body || null, duration_ms || 0, ip || null);
}

function apiLogFilterSql({ status, endpoint, website } = {}) {
  let sql = ' WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (endpoint) { sql += ' AND endpoint = ?'; params.push(endpoint); }
  if (website) { sql += ' AND website = ?'; params.push(website); }
  return { sql, params };
}

function getApiLogs({ limit = 50, offset = 0, ...filters } = {}) {
  const where = apiLogFilterSql(filters);
  return getDb().prepare(`SELECT * FROM api_logs${where.sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...where.params, limit, offset);
}

function getApiLogCount(filters = {}) {
  const where = apiLogFilterSql(filters);
  return getDb().prepare(`SELECT COUNT(*) as count FROM api_logs${where.sql}`).get(...where.params).count;
}

/** Distinct endpoints / websites seen in the logs, for the filter dropdowns. */
function getApiLogFacets() {
  return {
    endpoints: getDb().prepare('SELECT DISTINCT endpoint FROM api_logs ORDER BY endpoint').pluck().all(),
    websites: getDb().prepare('SELECT DISTINCT website FROM api_logs WHERE website IS NOT NULL ORDER BY website').pluck().all(),
  };
}

function getApiLogStats() {
  return {
    total: getDb().prepare('SELECT COUNT(*) as c FROM api_logs').get().c,
    errors: getDb().prepare("SELECT COUNT(*) as c FROM api_logs WHERE status = 'error'").get().c,
    today: getDb().prepare("SELECT COUNT(*) as c FROM api_logs WHERE created_at >= date('now')").get().c,
    todayErrors: getDb().prepare("SELECT COUNT(*) as c FROM api_logs WHERE status = 'error' AND created_at >= date('now')").get().c,
    old: getOldApiLogCount(),
  };
}

function deleteAllApiLogs() {
  return getDb().prepare('DELETE FROM api_logs').run();
}

function deleteApiLogsByStatus(status) {
  return getDb().prepare('DELETE FROM api_logs WHERE status = ?').run(status);
}

// Log retention — created_at is stored via datetime('now') (UTC), so compare with
// datetime('now', '-N days') to keep the string formats identical
const LOG_RETENTION_DAYS = 14;

function getOldApiLogCount(days = LOG_RETENTION_DAYS) {
  return getDb().prepare("SELECT COUNT(*) as c FROM api_logs WHERE created_at < datetime('now', ?)").get(`-${days} days`).c;
}

function deleteOldApiLogs(days = LOG_RETENTION_DAYS) {
  return getDb().prepare("DELETE FROM api_logs WHERE created_at < datetime('now', ?)").run(`-${days} days`);
}

// --- Settings ---

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

// --- Custom Page Types (per website) ---

function getCustomPageTypes(websiteId) {
  return getDb().prepare('SELECT * FROM custom_page_types WHERE website_id = ? ORDER BY name').all(websiteId);
}

function getCustomPageTypeByName(websiteId, name) {
  return getDb().prepare('SELECT * FROM custom_page_types WHERE website_id = ? AND name = ?').get(websiteId, name);
}

function createCustomPageType({ website_id, name, label }) {
  return getDb().prepare('INSERT INTO custom_page_types (website_id, name, label) VALUES (?, ?, ?)').run(website_id, name, label);
}

function deleteCustomPageType(id) {
  const cpt = getDb().prepare('SELECT website_id, name FROM custom_page_types WHERE id = ?').get(id);
  if (cpt) {
    // Also delete page_configs for this website + page_type
    getDb().prepare('DELETE FROM page_configs WHERE website_id = ? AND page_type = ?').run(cpt.website_id, cpt.name);
  }
  return getDb().prepare('DELETE FROM custom_page_types WHERE id = ?').run(id);
}

// --- Password Hashing (scrypt) ---

const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 8;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
  const hashBuf = Buffer.from(hash, 'hex');
  const testBuf = Buffer.from(testHash, 'hex');
  if (hashBuf.length !== testBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, testBuf);
}

// --- Admin users ---

// What lists and views get: never the password hash or the TOTP secret
const USER_PUBLIC_COLUMNS = 'id, username, must_change_password, totp_enabled, created_by, created_at, last_login_at';

function getUsers() {
  return getDb().prepare(`SELECT ${USER_PUBLIC_COLUMNS} FROM users ORDER BY username`).all();
}

/** Full row, password hash and TOTP secret included — for authentication only. */
function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function createUser({ username, password, mustChange = true, createdBy = null }) {
  return getDb().prepare('INSERT INTO users (username, password_hash, must_change_password, created_by) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), mustChange ? 1 : 0, createdBy);
}

/** New password. Ends every session of that user (session_version bump). */
function setUserPassword(id, password, { mustChange = false } = {}) {
  return getDb().prepare("UPDATE users SET password_hash = ?, must_change_password = ?, session_version = session_version + 1, updated_at = datetime('now') WHERE id = ?")
    .run(hashPassword(password), mustChange ? 1 : 0, id);
}

/** Turn 2FA on with this secret, or off with null. */
function setUserTotp(id, secret) {
  return getDb().prepare("UPDATE users SET totp_enabled = ?, totp_secret = ?, updated_at = datetime('now') WHERE id = ?")
    .run(secret ? 1 : 0, secret || null, id);
}

/** Log the user out on every device. */
function bumpSessionVersion(id) {
  return getDb().prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(id);
}

function touchUserLogin(id) {
  getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(id);
}

function deleteUser(id) {
  return getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

// --- WireGuard configs (Settings → WireGuard) ---
// Websites refer to them by name (websites.wireguard, one per line), so a website backup
// restored on another server finds configs with the same names there.

const wgNames = (text) => String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

function getWireguardConfigs() {
  return getDb().prepare('SELECT * FROM wireguard_configs ORDER BY name').all();
}

function getWireguardConfigById(id) {
  return getDb().prepare('SELECT * FROM wireguard_configs WHERE id = ?').get(id);
}

function getWireguardConfigByName(name) {
  return getDb().prepare('SELECT * FROM wireguard_configs WHERE name = ?').get(name);
}

function createWireguardConfig({ name, config }) {
  return getDb().prepare('INSERT INTO wireguard_configs (name, config) VALUES (?, ?)').run(name, config);
}

/** New name and/or text. A new name is carried into the websites that use the config. */
function updateWireguardConfig(id, { name, config }) {
  const d = getDb();
  return d.transaction(() => {
    const old = getWireguardConfigById(id);
    d.prepare("UPDATE wireguard_configs SET name = ?, config = ?, updated_at = datetime('now') WHERE id = ?").run(name, config, id);
    if (old && old.name !== name) {
      for (const w of d.prepare('SELECT id, wireguard FROM websites WHERE wireguard IS NOT NULL').all()) {
        const names = wgNames(w.wireguard);
        if (names.includes(old.name)) {
          d.prepare('UPDATE websites SET wireguard = ? WHERE id = ?').run(names.map((n) => (n === old.name ? name : n)).join('\n'), w.id);
        }
      }
    }
  })();
}

function deleteWireguardConfig(id) {
  return getDb().prepare('DELETE FROM wireguard_configs WHERE id = ?').run(id);
}

/** { config name: [website names that selected it] } — whatever their current proxy type. */
function getWireguardUsage() {
  const usage = {};
  for (const w of getDb().prepare('SELECT name, wireguard FROM websites WHERE wireguard IS NOT NULL ORDER BY name').all()) {
    for (const n of wgNames(w.wireguard)) (usage[n] = usage[n] || []).push(w.name);
  }
  return usage;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function getDbPath() {
  return DB_PATH;
}

module.exports = {
  getDb,
  closeDb,
  getDbPath,
  getAllWebsites,
  getActiveWebsites,
  getWebsiteById,
  getWebsiteByName,
  createWebsite,
  updateWebsite,
  updateWebsiteCookies,
  deleteWebsite,
  getPageConfigs,
  getPageConfig,
  upsertPageConfig,
  deletePageConfig,
  getPageConfigCountsByWebsite,
  getImageByHash,
  createImageCache,
  getImageCacheStats,
  getImageCacheTotals,
  getExpiredImages,
  getOldestImages,
  getAllImageCachePaths,
  deleteImageCacheByIds,
  deleteAllImageCache,
  getImageCacheCount,
  createApiLog,
  getApiLogs,
  getApiLogCount,
  getApiLogFacets,
  getApiLogStats,
  deleteAllApiLogs,
  deleteApiLogsByStatus,
  deleteOldApiLogs,
  getOldApiLogCount,
  LOG_RETENTION_DAYS,
  getSetting,
  setSetting,
  hashPassword,
  verifyPassword,
  MIN_PASSWORD_LENGTH,
  getUsers,
  getUserById,
  getUserByUsername,
  createUser,
  setUserPassword,
  setUserTotp,
  bumpSessionVersion,
  touchUserLogin,
  deleteUser,
  getWireguardConfigs,
  getWireguardConfigById,
  getWireguardConfigByName,
  createWireguardConfig,
  updateWireguardConfig,
  deleteWireguardConfig,
  getWireguardUsage,
  getCustomPageTypes,
  getCustomPageTypeByName,
  createCustomPageType,
  deleteCustomPageType,
};
