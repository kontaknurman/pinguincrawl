/**
 * Throwaway Chrome profiles (--user-data-dir) for the crawl browsers.
 *
 * Every browser gets a fresh profile under the OS temp dir — one shared profile would
 * hit SingletonLock conflicts between concurrent browsers. Those profiles MUST be
 * deleted reliably: each is several MB of cache/state plus dozens of inodes, crawls
 * create one per page, and once they pile up the server dies with
 *   ENOSPC: no space left on device, mkdtemp '/tmp/crawlkomik-XXXXXX'
 *
 * Why they used to leak: the dir was removed on the browser's 'disconnected' event,
 * which fires when the CDP socket closes — while Chrome is still flushing Local State
 * and Preferences on its way out. Those writes raced the rm, the rm failed and the
 * error was swallowed, so EVERY crawl left its profile behind. Now:
 *   - releaseProfileDir() deletes the dir only after the Chrome PROCESS has exited;
 *   - Chrome's $TMPDIR points inside the profile, so its own temp files (process
 *     singleton socket dir, shared-memory files) go away with it instead of piling up
 *     as /tmp/.org.chromium.Chromium.*;
 *   - sweepStaleProfiles() removes whatever crashes, kills and restarts leave behind
 *     (and everything older versions leaked). It runs at startup and periodically.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PREFIX = 'crawlkomik-';
// mkdtemp appends exactly 6 random characters — never touch anything not of that shape
const PROFILE_NAME_RE = /^crawlkomik-[A-Za-z0-9]{6}$/;
// Another instance sharing /tmp may have created a dir but not started Chrome yet
const SWEEP_MIN_AGE_MS = 60 * 1000;

const active = new Set(); // profiles owned by a browser of THIS process
let sweeping = null;      // in-flight sweep (sweeps never overlap)
let lastSweep = null;     // { at, durationMs, removed, failed, skipped }

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tmpRoot() {
  return os.tmpdir();
}

/** Where Chrome should put its own temp files for this profile ($TMPDIR). */
function chromeTmpDir(profileDir) {
  return path.join(profileDir, 'tmp');
}

/**
 * rm -rf that waits out a writer still finishing up. Resolves true when the dir is
 * gone; never rejects. Permission errors aren't retried — they won't fix themselves.
 */
async function removeDir(dir) {
  for (let attempt = 1; ; attempt++) {
    let code = null;
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      if (!fs.existsSync(dir)) return true;
      code = 'ENOTEMPTY'; // recreated underneath us
    } catch (err) {
      code = err.code;
    }
    if (attempt >= 4 || !['ENOTEMPTY', 'EBUSY'].includes(code)) return false;
    await delay(250 * attempt);
  }
}

/** Free space/inodes of the filesystem holding `dir`, for error messages. */
function freeSpaceNote(dir) {
  try {
    const s = fs.statfsSync(dir);
    const mb = Math.round((s.bavail * s.bsize) / 1024 / 1024);
    return ` (free: ${mb} MB, free inodes: ${s.ffree})`;
  } catch {
    return '';
  }
}

async function makeProfileDir() {
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot(), PREFIX));
  try {
    await fs.promises.mkdir(chromeTmpDir(dir));
  } catch (err) {
    await removeDir(dir);
    throw err;
  }
  return dir;
}

/**
 * Create a fresh profile dir. When the disk is full, leftover profiles are the usual
 * culprit: sweep them and retry once before giving up with an actionable error.
 */
async function createProfileDir() {
  let dir;
  try {
    dir = await makeProfileDir();
  } catch (err) {
    if (err.code !== 'ENOSPC') throw err;
    const swept = await sweepStaleProfiles();
    console.warn(`[Browser] Disk full creating a browser profile — swept ${swept.removed} leftover profile(s), retrying`);
    try {
      dir = await makeProfileDir();
    } catch (err2) {
      if (err2.code !== 'ENOSPC') throw err2;
      const e = new Error(
        `Disk full (ENOSPC): cannot create a browser profile in ${tmpRoot()}${freeSpaceNote(tmpRoot())}. ` +
        'Leftover browser profiles were already cleaned up, so something else is filling the disk — see /admin/storage.'
      );
      e.code = 'ENOSPC';
      throw e;
    }
  }
  active.add(dir);
  return dir;
}

/**
 * Delete a profile once its Chrome process has exited (immediately when there is no
 * live process, e.g. the launch failed). Never rejects; a dir that still can't be
 * removed is left for the sweep.
 */
function releaseProfileDir(dir, proc) {
  const remove = async () => {
    const ok = await removeDir(dir);
    active.delete(dir);
    if (!ok) console.warn(`[Browser] Could not remove profile ${dir} yet — the periodic sweep will retry`);
    return ok;
  };
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return remove();
  return new Promise((resolve) => proc.once('exit', () => resolve(remove())));
}

/** Profile dirs some running process was started with (--user-data-dir=…); null without /proc. */
function profilesInUse() {
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  const used = new Set();
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      continue; // exited meanwhile
    }
    const i = cmdline.indexOf('--user-data-dir=');
    if (i === -1) continue;
    const end = cmdline.indexOf('\0', i);
    used.add(path.resolve(cmdline.slice(i + '--user-data-dir='.length, end === -1 ? undefined : end)));
  }
  return used;
}

/** Fallback without /proc: Chrome's SingletonLock symlink reads "<hostname>-<pid>". */
function lockedByLiveProcess(dir) {
  let target;
  try {
    target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return false;
  }
  const m = /^(.+)-(\d+)$/.exec(target);
  if (!m) return false;
  if (m[1] !== os.hostname()) return true; // another host's lock — leave it alone
  try {
    process.kill(Number(m[2]), 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, just not ours to signal
  }
}

// A name like /tmp/crawlkomik-backup also fits the mkdtemp pattern — only delete dirs
// that actually look like a Chrome profile (or are empty, e.g. a launch that failed).
const PROFILE_MARKERS = ['Default', 'Local State', 'SingletonLock', 'tmp'];

async function looksLikeProfile(dir) {
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.length === 0 || entries.some((n) => PROFILE_MARKERS.includes(n));
  } catch {
    return false;
  }
}

/** Names of the profile dirs currently in the temp dir. */
async function listProfileDirs() {
  try {
    return (await fs.promises.readdir(tmpRoot())).filter((n) => PROFILE_NAME_RE.test(n)).map((n) => path.join(tmpRoot(), n));
  } catch {
    return [];
  }
}

async function runSweep(minAgeMs) {
  const started = Date.now();
  const result = { removed: 0, failed: 0, skipped: 0 };
  const dirs = await listProfileDirs();
  const inUse = dirs.length ? profilesInUse() : null;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;

  for (const dir of dirs) {
    if (active.has(dir)) { result.skipped++; continue; }
    let st;
    try {
      st = await fs.promises.lstat(dir);
    } catch {
      continue; // already gone
    }
    if (!st.isDirectory()) continue;
    const foreign = uid !== null && uid !== 0 && st.uid !== uid; // sticky /tmp: can't delete it anyway
    const tooNew = started - st.mtimeMs < minAgeMs;
    const used = inUse ? inUse.has(dir) : lockedByLiveProcess(dir);
    if (foreign || tooNew || used || !(await looksLikeProfile(dir))) { result.skipped++; continue; }
    if (await removeDir(dir)) result.removed++;
    else result.failed++;
  }

  lastSweep = { at: Date.now(), durationMs: Date.now() - started, ...result };
  if (result.removed || result.failed) {
    console.log(`[Browser] Profile sweep: removed ${result.removed} leftover browser profile(s) from ${tmpRoot()}` +
      (result.failed ? `, ${result.failed} could not be removed` : ''));
  }
  return result;
}

/**
 * Delete leftover profiles: ours by name, not owned by a browser of this process, not
 * used by any running process, and older than a minute. Concurrent calls share one run.
 */
function sweepStaleProfiles({ minAgeMs = SWEEP_MIN_AGE_MS } = {}) {
  if (!sweeping) {
    sweeping = runSweep(minAgeMs)
      .catch((err) => {
        console.error('[Browser] Profile sweep failed:', err.message);
        return { removed: 0, failed: 0, skipped: 0 };
      })
      .finally(() => { sweeping = null; });
  }
  return sweeping;
}

function getProfileState() {
  return { root: tmpRoot(), active: active.size, sweeping: !!sweeping, lastSweep };
}

module.exports = {
  createProfileDir,
  releaseProfileDir,
  chromeTmpDir,
  sweepStaleProfiles,
  listProfileDirs,
  getProfileState,
};
