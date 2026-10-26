/**
 * Disk usage overview + housekeeping for everything CrawlKomik writes to disk.
 *
 * Powers /admin/storage — so a filling disk shows up (and can be fixed from the panel)
 * before crawls start failing with ENOSPC — and the periodic cleanup jobs in app.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../models/database');
const profileDirs = require('./profile-dirs');
const imageProxy = require('./image-proxy');

const DATA_DIR = path.dirname(db.getDbPath());
const UPLOAD_TMP_DIR = path.join(DATA_DIR, 'tmp');   // multer uploads for DB restore
const BACKUP_RE = /^crawlkomik-backup-.*\.db$/;       // VACUUM INTO snapshots for download
const STALE_MS = 60 * 60 * 1000;
// Warn when a filesystem gets this full — well before ENOSPC
const LOW_FREE_BYTES = 1024 * 1024 * 1024;
const HIGH_USED_PCT = 90;

let cleaning = null;
let lastCleanup = null;

/** Space + inode usage of the filesystem holding `dir` (null when unavailable). */
function filesystemUsage(dir) {
  let s;
  try {
    s = fs.statfsSync(dir);
  } catch {
    return null;
  }
  const used = (s.blocks - s.bfree) * s.bsize;
  const free = s.bavail * s.bsize; // what a non-root process can actually still use
  const usedPct = used + free > 0 ? Math.ceil((used / (used + free)) * 100) : 0;
  const inodesUsedPct = s.files > 0 ? Math.ceil(((s.files - s.ffree) / s.files) * 100) : null;
  const low = free < LOW_FREE_BYTES || usedPct >= HIGH_USED_PCT || (inodesUsedPct !== null && inodesUsedPct >= HIGH_USED_PCT);
  return {
    path: dir,
    totalBytes: s.blocks * s.bsize,
    usedBytes: used,
    freeBytes: free,
    usedPct,
    inodesTotal: s.files,
    inodesFree: s.ffree,
    inodesUsedPct,
    low,
  };
}

/** The filesystems CrawlKomik writes to: temp (browser profiles) and data (DB, cache). */
function filesystems() {
  const list = [];
  for (const [key, dir] of [['tmp', os.tmpdir()], ['data', DATA_DIR]]) {
    let dev;
    try { dev = fs.statSync(dir).dev; } catch { continue; }
    const sameFs = list.find((f) => f.dev === dev);
    if (sameFs) { sameFs.keys.push(key); continue; }
    const usage = filesystemUsage(dir);
    if (usage) list.push({ ...usage, dev, keys: [key] });
  }
  return list;
}

let warningCache = { at: 0, value: null };
/** Cheap "is a disk getting full?" check for the nav/dashboard (cached for a minute). */
function diskWarning() {
  if (Date.now() - warningCache.at > 60 * 1000) {
    warningCache = { at: Date.now(), value: filesystems().find((f) => f.low) || null };
  }
  return warningCache.value;
}

/** du-style size of a directory tree; stops early (partial: true) past `deadline`. */
async function dirUsage(dir, deadline = Infinity) {
  const out = { bytes: 0, files: 0, partial: false };
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) { out.partial = true; break; }
    const current = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      try {
        const st = await fs.promises.lstat(full);
        out.bytes += st.blocks ? st.blocks * 512 : st.size;
        out.files++;
      } catch { /* gone meanwhile */ }
    }
  }
  return out;
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

async function listBackups() {
  try {
    return (await fs.promises.readdir(DATA_DIR)).filter((n) => BACKUP_RE.test(n)).map((n) => path.join(DATA_DIR, n));
  } catch {
    return [];
  }
}

/** Everything the Storage page shows. Sizing stops after ~2.5s so the page stays fast. */
async function getStorageReport() {
  const deadline = Date.now() + 2500;

  const profileList = await profileDirs.listProfileDirs();
  const profiles = { count: profileList.length, bytes: 0, files: 0, partial: false, ...profileDirs.getProfileState() };
  for (const dir of profileList) {
    const r = await dirUsage(dir, deadline);
    profiles.bytes += r.bytes;
    profiles.files += r.files;
    if (r.partial) { profiles.partial = true; break; }
  }

  const dbPath = db.getDbPath();
  const backups = await listBackups();
  const uploads = await dirUsage(UPLOAD_TMP_DIR, deadline);

  return {
    filesystems: filesystems(),
    profiles,
    imageCache: {
      ...db.getImageCacheTotals(),
      dir: imageProxy.CACHE_DIR,
      maxAgeHours: Math.round(imageProxy.getCacheMaxAgeMs() / 3600000),
      maxMb: Math.round(imageProxy.getCacheMaxBytes() / 1048576),
    },
    database: {
      path: dbPath,
      bytes: fileSize(dbPath) + fileSize(dbPath + '-wal') + fileSize(dbPath + '-shm'),
      preRestoreBytes: fileSize(dbPath + '.pre-restore'),
      logCount: db.getApiLogCount(),
    },
    temp: {
      uploadFiles: uploads.files,
      uploadBytes: uploads.bytes,
      backupFiles: backups.length,
      backupBytes: backups.reduce((sum, f) => sum + fileSize(f), 0),
    },
    cleaning: !!cleaning,
    lastCleanup,
  };
}

/** Expired images + size cap. Cheap DB queries — runs every 15 minutes. */
function runCacheMaintenance() {
  const out = { expired: 0, evicted: 0 };
  try {
    out.expired = imageProxy.cleanExpiredImages();
    out.evicted = imageProxy.enforceCacheSizeLimit();
  } catch (err) {
    console.error('[Storage] Image cache maintenance failed:', err.message);
  }
  return out;
}

/** Leftovers of interrupted restore uploads and backup downloads. */
async function cleanStaleTempFiles({ minAgeMs = STALE_MS } = {}) {
  const now = Date.now();
  let removed = 0;
  const candidates = [...(await listBackups())];
  try {
    for (const name of await fs.promises.readdir(UPLOAD_TMP_DIR)) candidates.push(path.join(UPLOAD_TMP_DIR, name));
  } catch { /* no upload dir yet */ }
  for (const file of candidates) {
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile() || now - st.mtimeMs < minAgeMs) continue;
      await fs.promises.unlink(file);
      removed++;
    } catch { /* gone meanwhile */ }
  }
  if (removed) console.log(`[Storage] Removed ${removed} stale temp upload/backup file(s)`);
  return removed;
}

/**
 * Everything at once: leftover browser profiles, image cache (expired, over cap,
 * orphaned files) and stale temp files. Runs at startup, every 6 hours and from the
 * Storage page. Concurrent calls share one run.
 */
function runFullCleanup() {
  if (!cleaning) {
    cleaning = (async () => {
      const started = Date.now();
      try {
        const profiles = await profileDirs.sweepStaleProfiles();
        const cache = runCacheMaintenance();
        const orphans = await imageProxy.removeOrphanImages();
        const tempFiles = await cleanStaleTempFiles();
        lastCleanup = {
          at: Date.now(),
          durationMs: Date.now() - started,
          profiles: profiles.removed,
          expired: cache.expired,
          evicted: cache.evicted,
          orphans: orphans.removed,
          orphanBytes: orphans.bytes,
          tempFiles,
        };
      } catch (err) {
        console.error('[Storage] Cleanup failed:', err.message);
      }
      warningCache.at = 0; // re-check disk space on the next request
      return lastCleanup;
    })().finally(() => { cleaning = null; });
  }
  return cleaning;
}

module.exports = {
  getStorageReport,
  diskWarning,
  filesystems,
  runCacheMaintenance,
  runFullCleanup,
  cleanStaleTempFiles,
};
