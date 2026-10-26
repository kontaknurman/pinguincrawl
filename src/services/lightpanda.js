/**
 * Lightpanda browser processes — one `lightpanda serve` CDP server per crawl.
 *
 * Puppeteer cannot launch Lightpanda the way it launched Chrome; Lightpanda is a server
 * to connect to. So this module starts one, hands back its WebSocket endpoint, and
 * stops it again:
 *   - One process per crawl, not one shared server: proxy, timezone and which
 *     sub-resources to load are process-wide options (Emulation.setTimezoneOverride is
 *     accepted but does nothing), and a process each keeps cookies and crashes isolated.
 *     A start costs ~20 ms and ~25 MB.
 *   - Port 0, reading the bound address from Lightpanda's own "server running" log line —
 *     probing for a free port first would let two concurrent crawls race for it.
 *   - Lightpanda keeps serving after its CDP client disconnects, so it is always stopped
 *     here (SIGTERM, then SIGKILL). Children still alive when Node exits are killed; the
 *     ones a hard kill of Node leaves behind are swept at startup and every 30 minutes,
 *     recognised by the PINGUINCRAWL_OWNER_PID marker in their environment.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const OWNER_ENV = 'PINGUINCRAWL_OWNER_PID';
const READY_RE = /\$msg="server running"[^\n]*?\baddress=(\S+)/;
const START_TIMEOUT_MS = 10000;
const STOP_GRACE_MS = 2000;
const LOG_LINES = 40;

const live = new Set(); // ChildProcess objects started by this Node process
let lastSweep = null;   // { at, killed }
let versionCache = null;

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Absolute path of the Lightpanda binary, or null when it isn't installed. */
function executablePath() {
  const configured = process.env.LIGHTPANDA_EXECUTABLE_PATH;
  if (configured) return isExecutable(configured) ? path.resolve(configured) : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'lightpanda');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function notInstalledError() {
  const configured = process.env.LIGHTPANDA_EXECUTABLE_PATH;
  return new Error(configured
    ? `Lightpanda not found or not executable at LIGHTPANDA_EXECUTABLE_PATH=${configured}`
    : 'Lightpanda is not installed: no "lightpanda" binary on PATH. Install it (see README) or set LIGHTPANDA_EXECUTABLE_PATH.');
}

/**
 * Arguments for `lightpanda serve`.
 * @param {object} o
 * @param {string} [o.proxy]          proxy URL without credentials (those go through page.authenticate)
 * @param {string} [o.timezone]       IANA zone for Date/Intl
 * @param {string[]} [o.loadResources] sub-resources Lightpanda should actually request
 * @param {number} [o.httpTimeoutMs]  per-transfer timeout
 * @param {boolean} [o.disableCors]   let in-page fetch() read cross-origin responses
 * @param {boolean} [o.blockPrivateNetworks]
 * @param {string[]} [o.allowCidrs]   exemptions from the private-network block, e.g. "10.0.0.5/32"
 */
function serveArgs(o = {}) {
  const args = ['serve', '--host', '127.0.0.1', '--port', '0', '--log-format', 'logfmt'];
  if (o.proxy) args.push('--http-proxy', o.proxy);
  if (o.timezone) args.push('--timezone', o.timezone);
  for (const r of o.loadResources || []) args.push('--load-resources', r);
  if (o.httpTimeoutMs) args.push('--http-timeout', String(Math.round(o.httpTimeoutMs)));
  if (o.disableCors) args.push('--disable-features', 'cors');
  if (o.blockPrivateNetworks) {
    args.push('--block-private-networks');
    for (const cidr of o.allowCidrs || []) args.push('--block-cidrs', `-${cidr}`);
  }
  return args;
}

/**
 * Start a CDP server. Resolves with { proc, wsEndpoint, recentLog() } once it listens.
 */
function launch(options = {}) {
  const bin = executablePath();
  if (!bin) return Promise.reject(notInstalledError());

  const args = serveArgs(options);
  const proc = spawn(bin, args, {
    env: { ...process.env, [OWNER_ENV]: String(process.pid) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(proc);

  // Both pipes must be drained for the whole life of the process, or it blocks once one
  // fills up. The tail is kept for error messages.
  const lines = [];
  let partial = '';
  const onOutput = (chunk) => {
    const parts = (partial + chunk).split('\n');
    partial = parts.pop().slice(-4096);
    for (const line of parts) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > LOG_LINES) lines.shift();
    }
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);
  const recentLog = () => [...lines, partial].filter(Boolean).join('\n');

  proc.once('exit', (code, signal) => {
    live.delete(proc);
    if (proc._ready && !proc._stopping) {
      const tail = lines.slice(-3).join(' | ');
      console.warn(`[Lightpanda] pid ${proc.pid} exited unexpectedly (${signal || 'code ' + code})${tail ? ' — ' + tail : ''}`);
    }
  });

  return new Promise((resolve, reject) => {
    let buffered = '';
    const finish = (err, address) => {
      clearTimeout(timer);
      proc.stderr.off('data', onReady);
      proc.stdout.off('data', onReady);
      proc.off('exit', onExit);
      proc.off('error', onError);
      if (err) {
        if (proc.pid) stop(proc);
        else live.delete(proc); // never started, so no 'exit' event will remove it
        return reject(err);
      }
      proc._ready = true;
      resolve({ proc, wsEndpoint: `ws://${address}/`, recentLog });
    };
    const onReady = (chunk) => {
      buffered = (buffered + chunk).slice(-8192);
      const m = READY_RE.exec(buffered);
      if (m) finish(null, m[1]);
    };
    const onExit = (code, signal) => {
      const out = recentLog();
      let msg = `Lightpanda exited during startup (${signal || 'code ' + code})`;
      if (out) msg += `: ${out.split('\n').slice(-5).join(' | ')}`;
      finish(new Error(msg));
    };
    const onError = (err) => {
      // ENOENT for a file that exists means its ELF interpreter is missing: the release
      // binaries are linked against glibc and will not run on musl (Alpine).
      const hint = err.code === 'ENOENT' && fs.existsSync(bin)
        ? ' — the binary exists but cannot run here. Lightpanda releases need glibc; on Alpine/musl use a Debian or Ubuntu base image.'
        : '';
      finish(new Error(`Could not start Lightpanda (${bin}): ${err.message}${hint}`));
    };
    const timer = setTimeout(() => {
      finish(new Error(`Lightpanda did not start within ${START_TIMEOUT_MS / 1000}s${recentLog() ? ': ' + recentLog().split('\n').slice(-3).join(' | ') : ''}`));
    }, START_TIMEOUT_MS);

    proc.stderr.on('data', onReady);
    proc.stdout.on('data', onReady);
    proc.once('exit', onExit);
    proc.once('error', onError);
  });
}

/** Stop a server: SIGTERM, SIGKILL after a grace period. Never rejects. */
function stop(proc, graceMs = STOP_GRACE_MS) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  proc._stopping = true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, graceMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

// A server outliving Node would hold its memory until the container restarts
process.on('exit', () => {
  for (const proc of live) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, just not ours to signal
  }
}

/**
 * Kill Lightpanda servers whose PinguinCrawl process is gone (Node was SIGKILLed / OOM-
 * killed, so its exit hook never ran). Servers of another live instance and the ones this
 * process is using are left alone. Without /proc (macOS) this is a no-op.
 */
function sweepOrphans() {
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return { killed: 0 };
  }
  const ours = new Set([...live].map((p) => p.pid));
  let killed = 0;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || ours.has(Number(pid))) continue;
    let environ;
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`, 'latin1'); // only readable for our own uid
    } catch {
      continue;
    }
    const m = new RegExp(`(?:^|\\0)${OWNER_ENV}=(\\d+)(?:\\0|$)`).exec(environ);
    if (!m) continue;
    const owner = Number(m[1]);
    if (owner !== process.pid && isAlive(owner)) continue;
    try {
      process.kill(Number(pid), 'SIGKILL');
      killed++;
    } catch { /* exited meanwhile */ }
  }
  lastSweep = { at: Date.now(), killed };
  if (killed) console.log(`[Lightpanda] Killed ${killed} orphaned browser process(es) left by an earlier run`);
  return lastSweep;
}

/** `lightpanda version` (cached per binary path), or null when it can't be run. */
async function getVersion() {
  const bin = executablePath();
  if (!bin) return null;
  if (versionCache && versionCache.bin === bin) return versionCache.version;
  const version = await new Promise((resolve) => {
    execFile(bin, ['version'], { timeout: 5000 }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null));
  });
  if (version) versionCache = { bin, version };
  return version;
}

/** The version from an earlier getVersion() call, without running anything. */
function cachedVersion() {
  return versionCache ? versionCache.version : null;
}

function getProcessState() {
  return { running: live.size, lastSweep };
}

module.exports = {
  executablePath,
  serveArgs,
  launch,
  stop,
  sweepOrphans,
  getVersion,
  cachedVersion,
  getProcessState,
};
