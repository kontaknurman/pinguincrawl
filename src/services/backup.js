/**
 * Backup files.
 *
 * The full backup (Settings → Backup & Restore) is a VACUUM INTO snapshot of the database.
 * A website backup is the same kind of SQLite file — the same tables and indexes — holding
 * one website: its row, page configs, custom page types and the Settings → Proxy entries it
 * picked, plus a settings marker (backup_scope = website). Admin accounts, the other
 * settings (API key, session secret, the global default proxy), WireGuard configs (private
 * keys — the website names them), API logs and the image cache never go into it.
 *
 * A website can be restored from either kind of file: the website with its name is taken
 * from it. Backups of older versions (or crawlkomik) lack newer columns; those get the
 * column defaults, and a website's own old proxy list moves to Settings → Proxy.
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const db = require('../models/database');
const refs = require('./proxy-refs');

// The Settings → Proxy names a website picked ("proxy:<name>" refs)
const proxyNamesOf = (website) => refs.refList(website.proxy_refs).map(refs.parseRef).filter((r) => r && r.type === 'proxy').map((r) => r.name);

const REQUIRED_TABLES = ['websites', 'page_configs', 'settings'];
const WEBSITE_SCOPE = 'website';

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const columns = (conn, table) => conn.prepare(`PRAGMA table_info(${quote(table)})`).all();

function listNames(names) {
  return names.length > 10 ? `${names.slice(0, 10).join(', ')}, …` : names.join(', ');
}

/** An uploaded backup, opened read-only; throws a readable error unless it looks like ours. */
function openBackup(file) {
  let src = null;
  try {
    src = new Database(file, { readonly: true, fileMustExist: true });
    // The schema of an uploaded file (views, triggers, defaults) must not run SQL functions
    src.pragma('trusted_schema = OFF');
    const tables = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length) throw new Error(`Invalid backup: missing required tables (${missing.join(', ')})`);
    return { src, tables };
  } catch (err) {
    if (src) src.close();
    if (err.code === 'SQLITE_NOTADB') throw new Error('Invalid backup: not a database file');
    throw err;
  }
}

function describe(src) {
  const marker = src.prepare("SELECT value FROM settings WHERE key = 'backup_scope'").get();
  return {
    scope: marker && marker.value === WEBSITE_SCOPE ? WEBSITE_SCOPE : 'full',
    websites: src.prepare('SELECT name FROM websites ORDER BY name').pluck().all(),
  };
}

/** What a backup file holds: { tables, scope: 'full' | 'website', websites: [names] }. */
function inspectBackup(file) {
  const { src, tables } = openBackup(file);
  try {
    return { tables, ...describe(src) };
  } finally {
    src.close();
  }
}

/**
 * The website called `name` from a backup file — a website backup or a full one — or,
 * without a name, the only website in it: { scope, website, pageConfigs, customPageTypes,
 * proxies } (proxies: the Settings → Proxy entries it picked, { name, url }).
 */
function readWebsiteBackup(file, name = null) {
  const { src, tables } = openBackup(file);
  try {
    const { scope, websites } = describe(src);
    if (!websites.length) throw new Error('This backup has no websites');
    if (!name && websites.length > 1) {
      throw new Error(`This backup has ${websites.length} websites (${listNames(websites)}) — enter the name of the one to restore`);
    }
    if (name && !websites.includes(name)) {
      throw new Error(scope === WEBSITE_SCOPE
        ? `This is a backup of website "${websites[0]}", not "${name}"`
        : `This backup has no website named "${name}" — it has: ${listNames(websites)}`);
    }
    const website = src.prepare('SELECT * FROM websites WHERE name = ?').get(name || websites[0]);
    // Very old versions kept custom page types for all websites together — those can't be matched
    const perWebsiteTypes = tables.includes('custom_page_types') && columns(src, 'custom_page_types').some((c) => c.name === 'website_id');
    const proxyNames = tables.includes('proxies') ? proxyNamesOf(website) : [];
    return {
      scope,
      website,
      pageConfigs: src.prepare('SELECT * FROM page_configs WHERE website_id = ?').all(website.id),
      customPageTypes: perWebsiteTypes ? src.prepare('SELECT * FROM custom_page_types WHERE website_id = ?').all(website.id) : [],
      proxies: proxyNames.length ? src.prepare(`SELECT name, url FROM proxies WHERE name IN (${proxyNames.map(() => '?').join(', ')})`).all(...proxyNames) : [],
    };
  } finally {
    src.close();
  }
}

// Rows (all with the same keys) by column name — the same table can have its columns in
// another order elsewhere. Columns `conn` doesn't know are dropped, missing ones get defaults.
function insertRows(conn, table, rows, skip = []) {
  if (!rows.length) return null;
  const cols = columns(conn, table).map((c) => c.name).filter((c) => !skip.includes(c) && c in rows[0]);
  const stmt = conn.prepare(`INSERT INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  let result = null;
  for (const row of rows) result = stmt.run(cols.map((c) => row[c]));
  return result;
}

/** Writes the backup of website `id` to `file`, which must not exist yet. Returns the website. */
function exportWebsite(id, file) {
  const live = db.getDb();
  const website = live.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (!website) throw new Error('Website not found');
  // The full backup's schema: all tables first, then their indexes (and any views/triggers)
  const schema = live.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type <> 'table', rowid").pluck().all();
  const out = new Database(file);
  try {
    out.transaction(() => {
      for (const sql of schema) out.exec(sql);
      insertRows(out, 'websites', [website]);
      insertRows(out, 'page_configs', live.prepare('SELECT * FROM page_configs WHERE website_id = ?').all(id));
      insertRows(out, 'custom_page_types', live.prepare('SELECT * FROM custom_page_types WHERE website_id = ?').all(id));
      // Address and login included, so the website crawls the same way wherever it is restored
      insertRows(out, 'proxies', proxyNamesOf(website).map((n) => live.prepare('SELECT * FROM proxies WHERE name = ?').get(n)).filter(Boolean));
      const mark = out.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      mark.run('backup_scope', WEBSITE_SCOPE);
      mark.run('backup_website', website.name);
    })();
  } finally {
    out.close();
  }
  return website;
}

/**
 * Puts a website read from a backup into this database: over website `targetId`, or as a
 * new website when that is null. Its page configs and custom page types replace the
 * current ones and its proxies join Settings → Proxy (see db.importProxy for which existing
 * entries are reused); nothing else changes (other websites, image cache, logs). Columns
 * the backup lacks get their defaults, ids are this database's own.
 * Returns { id, proxiesAdded } — proxiesAdded: entries it created in Settings → Proxy.
 */
function restoreWebsite({ website, pageConfigs, customPageTypes, proxies = [] }, targetId = null) {
  const live = db.getDb();
  return live.transaction(() => {
    let id = targetId;
    if (id) {
      const cols = columns(live, 'websites').filter((c) => !['id', 'created_at', 'updated_at'].includes(c.name));
      const sets = cols.map((c) => `${quote(c.name)} = ${c.name in website ? '?' : (c.dflt_value ?? 'NULL')}`);
      const values = cols.filter((c) => c.name in website).map((c) => website[c.name]);
      live.prepare(`UPDATE websites SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
      live.prepare('DELETE FROM page_configs WHERE website_id = ?').run(id);
      live.prepare('DELETE FROM custom_page_types WHERE website_id = ?').run(id);
    } else {
      id = Number(insertRows(live, 'websites', [website], ['id', 'created_at', 'updated_at']).lastInsertRowid);
    }
    insertRows(live, 'page_configs', pageConfigs.map((row) => ({ ...row, website_id: id })), ['id']);
    insertRows(live, 'custom_page_types', customPageTypes.map((row) => ({ ...row, website_id: id })), ['id']);
    // Its proxies by the names they have here (one may exist under another name, or its
    // name may be taken by another proxy)
    const here = new Map();
    let proxiesAdded = 0;
    for (const p of proxies) {
      const got = db.importProxy(p);
      if (!got) continue;
      here.set(refs.proxyRef(p.name), refs.proxyRef(got.name));
      if (got.added) proxiesAdded++;
    }
    if (website.proxy_refs != null && [...here].some(([from, to]) => from !== to)) {
      const text = refs.refList(website.proxy_refs).map((r) => here.get(r) || r).join('\n');
      live.prepare('UPDATE websites SET proxy_refs = ? WHERE id = ?').run(text, id);
    }
    // A backup from before Settings → Proxy: the website's own list moves there now
    const before = live.prepare('SELECT COUNT(*) AS c FROM proxies').get().c;
    db.convertLegacyProxies([id]);
    proxiesAdded += live.prepare('SELECT COUNT(*) AS c FROM proxies').get().c - before;
    return { id, proxiesAdded };
  })();
}

/** The whole database as it is now, in data/<db>.pre-restore (replaced each time). */
function savePreRestoreSnapshot() {
  const dbPath = db.getDbPath();
  const file = dbPath + '.pre-restore';
  fs.rmSync(file, { force: true }); // VACUUM INTO refuses an existing file
  try {
    db.getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch {
    // Fallback: checkpoint + copy if VACUUM INTO fails
    try {
      db.getDb().pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, file);
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
  }
  return file;
}

module.exports = { REQUIRED_TABLES, WEBSITE_SCOPE, inspectBackup, readWebsiteBackup, exportWebsite, restoreWebsite, savePreRestoreSnapshot };
