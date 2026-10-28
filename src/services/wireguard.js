/**
 * WireGuard configs as the second kind of website proxy.
 *
 * Lightpanda only talks to HTTP/SOCKS proxies, and a kernel WireGuard interface would need
 * root (NET_ADMIN) and would reroute the whole container. So every config runs as one
 * wireproxy process — userspace WireGuard plus a SOCKS5 server on 127.0.0.1, ~12 MB — and
 * a crawl that picked the config gets socks5h://…@127.0.0.1:<port>: pages, their requests
 * and DNS lookups all go through the tunnel.
 *
 *   - Started on first use and shared by every crawl and website using that config; stopped
 *     after IDLE_MS unused. Never two processes for one config: two clients with the same
 *     private key make the server flip between them and connections stall.
 *   - Ready only after a WireGuard handshake (wireproxy's local /metrics), so a wrong key or
 *     a dead endpoint fails within HANDSHAKE_TIMEOUT_MS instead of hanging the crawl. A
 *     running tunnel whose last handshake is too old is restarted the same way.
 *   - wireproxy reads its config from a path, and Node's stdio "pipes" are sockets that can't
 *     be opened as /dev/stdin — so the config waits in a 0600 file on tmpfs (/dev/shm, RAM)
 *     and is deleted as soon as wireproxy has read it: the private key never reaches disk.
 *   - wg-quick extras (PostUp/PreDown scripts, Table, SaveConfig…) are dropped — nothing runs.
 *
 * Processes still alive when Node exits are killed; ones a hard kill of Node leaves behind
 * are swept at startup, recognised by OWNER_ENV in their environment.
 */

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const db = require('../models/database');

const PREFIX = 'wireguard:'; // how a config sits in a website's proxy rotation
const OWNER_ENV = 'PINGUINCRAWL_WIREGUARD_OWNER_PID';
// An unused tunnel stops after this long (a restart costs one handshake, ~1 RTT)
const IDLE_MS = (parseInt(process.env.WIREGUARD_IDLE_SECONDS, 10) || 300) * 1000;
const HANDSHAKE_TIMEOUT_MS = 10000;
// WireGuard renews the handshake every 2 minutes while packets flow (the keepalive below
// keeps them flowing); a session is dead after 3 minutes without one
const STALE_HANDSHAKE_S = 240;
const DEFAULT_KEEPALIVE = 25;
const DEFAULT_DNS = ['1.1.1.1', '9.9.9.9'];
const STOP_GRACE_MS = 2000;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_DIR = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();
const SECRET_RE = /^pinguincrawl-wg-[0-9a-f]{16}\.conf$/;

const live = new Set();       // wireproxy ChildProcesses started here
const instances = new Map();  // config name -> running (or starting) tunnel
const locks = new Map();      // config name -> tail of its serialized start/stop work
let versionCache = null;
let reaper = null;

// ---------- config parsing ----------

const IGNORED_KEYS = new Set(['listenport', 'table', 'preup', 'postup', 'predown', 'postdown', 'saveconfig', 'fwmark']);

function key32(value) {
  const buf = Buffer.from(value, 'base64');
  return buf.length === 32 && buf.toString('base64') === value;
}

function ipWithPrefix(value) {
  const [ip, prefix, extra] = value.split('/');
  const family = net.isIP(ip);
  if (!family || extra !== undefined) return false;
  if (prefix === undefined) return true;
  const n = Number(prefix);
  return /^\d{1,3}$/.test(prefix) && n <= (family === 4 ? 32 : 128);
}

function endpointOk(value) {
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 65535 && (!m[1].startsWith('[') || net.isIP(m[1].slice(1, -1)) === 6);
}

const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * A wg-quick config (what VPN providers hand out) → { iface, peers, warnings }.
 * Throws an Error naming the line for anything wireproxy couldn't use.
 */
function parseConfig(text) {
  const iface = { addresses: [], dns: [] };
  const peers = [];
  const warnings = [];
  let section = null;
  let sawInterface = false;
  const fail = (line, msg) => { throw new Error(line ? `Line ${line}: ${msg}` : msg); };

  String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/[#;].*$/, '').trim();
    if (!line) return;
    const head = /^\[\s*([A-Za-z]+)\s*\]$/.exec(line);
    if (head) {
      const name = head[1].toLowerCase();
      if (name === 'interface') {
        if (sawInterface) fail(n, 'a second [Interface] section');
        sawInterface = true;
        section = iface;
      } else if (name === 'peer') {
        section = { allowedIps: [] };
        peers.push(section);
      } else {
        fail(n, `unknown section [${head[1]}] — expected [Interface] or [Peer]`);
      }
      return;
    }
    const eq = line.indexOf('=');
    if (eq < 1) fail(n, 'expected "Key = value"');
    if (!section) fail(n, 'setting before [Interface] / [Peer]');
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    const inPeer = section !== iface;

    if (IGNORED_KEYS.has(key)) {
      if (/^(pre|post)(up|down)$/.test(key)) warnings.push(`${line.slice(0, eq).trim()} is ignored — no commands are run`);
      return;
    }
    if (!inPeer && key === 'privatekey') {
      if (!key32(value)) fail(n, 'PrivateKey must be a WireGuard key (44 characters of base64)');
      section.privateKey = value;
    } else if (!inPeer && key === 'address') {
      for (const a of list(value)) if (!ipWithPrefix(a)) fail(n, `invalid Address "${a}"`);
      section.addresses.push(...list(value));
    } else if (!inPeer && key === 'dns') {
      // wg-quick also takes search domains here; only resolver addresses mean anything to wireproxy
      for (const d of list(value)) {
        if (net.isIP(d)) section.dns.push(d);
        else warnings.push(`DNS entry "${d}" is not an IP address — ignored`);
      }
    } else if (!inPeer && key === 'mtu') {
      if (!/^\d+$/.test(value) || Number(value) < 576 || Number(value) > 9000) fail(n, 'MTU must be a number between 576 and 9000');
      section.mtu = Number(value);
    } else if (inPeer && key === 'publickey') {
      if (!key32(value)) fail(n, 'PublicKey must be a WireGuard key (44 characters of base64)');
      section.publicKey = value;
    } else if (inPeer && key === 'presharedkey') {
      if (!key32(value)) fail(n, 'PresharedKey must be a WireGuard key (44 characters of base64)');
      section.presharedKey = value;
    } else if (inPeer && key === 'endpoint') {
      if (!endpointOk(value)) fail(n, `invalid Endpoint "${value}" — use host:port`);
      section.endpoint = value;
    } else if (inPeer && key === 'allowedips') {
      for (const a of list(value)) if (!ipWithPrefix(a)) fail(n, `invalid AllowedIPs entry "${a}"`);
      section.allowedIps.push(...list(value));
    } else if (inPeer && key === 'persistentkeepalive') {
      const k = value.toLowerCase() === 'off' ? 0 : Number(value);
      if (!/^\d+$/.test(String(k)) || k > 65535) fail(n, 'PersistentKeepalive must be a number of seconds');
      section.keepalive = k;
    } else {
      warnings.push(`${line.slice(0, eq).trim()} is not used — ignored`);
    }
  });

  if (!sawInterface) fail(0, 'no [Interface] section — paste the whole WireGuard config');
  if (!iface.privateKey) fail(0, '[Interface] has no PrivateKey');
  if (!iface.addresses.length) fail(0, '[Interface] has no Address');
  if (!peers.length) fail(0, 'no [Peer] section');
  peers.forEach((p, i) => {
    const which = peers.length > 1 ? `[Peer] #${i + 1}` : '[Peer]';
    if (!p.publicKey) fail(0, `${which} has no PublicKey`);
    if (!p.endpoint) fail(0, `${which} has no Endpoint — the VPN server's host:port`);
    if (!p.allowedIps.length) fail(0, `${which} has no AllowedIPs`);
  });
  if (!iface.dns.length) warnings.push(`no DNS in the config — ${DEFAULT_DNS.join(', ')} is used, through the tunnel`);
  if (!peers.some((p) => p.allowedIps.includes('0.0.0.0/0'))) {
    warnings.push('AllowedIPs does not include 0.0.0.0/0 — only those addresses go through the tunnel, other sites fail');
  }
  return { iface, peers, warnings };
}

/** What the admin UI shows of a config: no keys. */
function summarize(text) {
  try {
    const { iface, peers, warnings } = parseConfig(text);
    return {
      ok: true,
      endpoint: peers[0].endpoint,
      peers: peers.length,
      address: iface.addresses.join(', '),
      dns: iface.dns.length ? iface.dns.join(', ') : null,
      warnings,
    };
  } catch (err) {
    return { ok: false, error: err.message, warnings: [] };
  }
}

/** The wireproxy config for a parsed wg-quick config: the WireGuard part plus our SOCKS5 server. */
function wireproxyConfig({ iface, peers }, { socksPort, username, password }) {
  const out = [
    '[Interface]',
    `PrivateKey = ${iface.privateKey}`,
    `Address = ${iface.addresses.join(', ')}`,
    `DNS = ${(iface.dns.length ? iface.dns : DEFAULT_DNS).join(', ')}`,
  ];
  if (iface.mtu) out.push(`MTU = ${iface.mtu}`);
  for (const p of peers) {
    out.push('', '[Peer]', `PublicKey = ${p.publicKey}`);
    if (p.presharedKey) out.push(`PresharedKey = ${p.presharedKey}`);
    out.push(`Endpoint = ${p.endpoint}`, `AllowedIPs = ${p.allowedIps.join(', ')}`);
    // Without traffic WireGuard never handshakes — and the handshake is how we know the
    // tunnel works. Keepalives also hold NAT mappings open.
    out.push(`PersistentKeepalive = ${p.keepalive || DEFAULT_KEEPALIVE}`);
  }
  out.push('', '[Socks5]', `BindAddress = 127.0.0.1:${socksPort}`, `Username = ${username}`, `Password = ${password}`, '');
  return out.join('\n');
}

/** A config name from free text (e.g. an uploaded file name), or '' when nothing is left. */
function nameFrom(text) {
  return String(text || '').toLowerCase().replace(/\.conf$/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '').slice(0, 64);
}

// ---------- the wireproxy binary ----------

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Absolute path of wireproxy, or null when it isn't installed. */
function executablePath() {
  const configured = process.env.WIREPROXY_EXECUTABLE_PATH;
  if (configured) return isExecutable(configured) ? path.resolve(configured) : null;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'wireproxy');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function notInstalledError() {
  return new Error(process.env.WIREPROXY_EXECUTABLE_PATH
    ? `wireproxy not found or not executable at WIREPROXY_EXECUTABLE_PATH=${process.env.WIREPROXY_EXECUTABLE_PATH}`
    : 'wireproxy is not installed: WireGuard configs need the "wireproxy" binary on PATH (see README) or WIREPROXY_EXECUTABLE_PATH');
}

/** `wireproxy --version` (cached per binary), or null. */
async function getVersion() {
  const bin = executablePath();
  if (!bin) return null;
  if (versionCache && versionCache.bin === bin) return versionCache.version;
  const version = await new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout) => resolve(err ? null : (String(stdout).match(/version\s+(\S+)/) || [])[1] || null));
  });
  if (version) versionCache = { bin, version };
  return version;
}

function cachedVersion() {
  return versionCache ? versionCache.version : null;
}

/** wireproxy's own check of a config (-n), when the binary is there. Resolves, or rejects with its message. */
function checkWithWireproxy(text) {
  const bin = executablePath();
  if (!bin) return Promise.resolve();
  const file = writeSecretFile(wireproxyConfig(parseConfig(text), { socksPort: 1, username: 'check', password: 'check' }));
  return new Promise((resolve, reject) => {
    execFile(bin, ['-n', '-c', file], { timeout: 5000 }, (err, stdout, stderr) => {
      fs.rmSync(file, { force: true });
      if (!err) return resolve();
      const msg = String(stderr || stdout).trim().split('\n').pop().replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, '');
      reject(new Error(`wireproxy rejected the config: ${msg || err.message}`));
    });
  });
}

/** A private (0600, unguessable name, tmpfs) file holding a config until wireproxy has read it. */
function writeSecretFile(text) {
  const file = path.join(SECRET_DIR, `pinguincrawl-wg-${crypto.randomBytes(8).toString('hex')}.conf`);
  fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  return file;
}

// ---------- tunnels ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function getMetrics(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/metrics', timeout: 1000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Seconds since the epoch of the latest handshake with any peer, 0 for none, null if unreadable. */
async function lastHandshake(port) {
  const body = await getMetrics(port);
  if (body === null) return null;
  const times = [...body.matchAll(/^last_handshake_time_sec=(\d+)$/gm)].map((m) => Number(m[1]));
  return times.length ? Math.max(...times) : 0;
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function stopProc(proc, graceMs = STOP_GRACE_MS) {
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

function tunnelError(name, message) {
  const err = new Error(`WireGuard "${name}": ${message}`);
  err.proxyFailed = true; // let the rotation try the website's next config
  return err;
}

/** Start wireproxy for one config and wait for its handshake. */
async function startTunnel(name, parsed) {
  const bin = executablePath();
  if (!bin) throw notInstalledError();
  const endpoint = parsed.peers[0].endpoint;

  for (let attempt = 1; ; attempt++) {
    const socksPort = await freePort();
    const infoPort = await freePort();
    const username = crypto.randomBytes(6).toString('hex');
    const password = crypto.randomBytes(12).toString('hex');
    const configFile = writeSecretFile(wireproxyConfig(parsed, { socksPort, username, password }));
    const proc = spawn(bin, ['-s', '-i', `127.0.0.1:${infoPort}`, '-c', configFile], {
      env: { ...process.env, [OWNER_ENV]: String(process.pid) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    live.add(proc);
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    proc.once('exit', (code, signal) => {
      live.delete(proc);
      if (proc._ready && !proc._stopping) {
        console.warn(`[WireGuard] "${name}" (pid ${proc.pid}) exited unexpectedly (${signal || 'code ' + code})${stderr.trim() ? ' — ' + stderr.trim().split('\n').pop() : ''}`);
      }
    });
    proc.once('error', () => { /* reported through the exit / timeout below */ });

    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    let handshakeAt = 0;
    try {
      while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null && !proc.killed) {
        await new Promise((r) => setTimeout(r, 150));
        const at = await lastHandshake(infoPort);
        // Its info server answering means the config has been read
        if (at !== null) fs.rmSync(configFile, { force: true });
        if (at && await canConnect(socksPort)) {
          handshakeAt = at;
          break;
        }
      }
    } finally {
      fs.rmSync(configFile, { force: true });
    }

    if (handshakeAt) {
      proc._ready = true;
      return { proc, infoPort, handshakeAt, server: `socks5h://${username}:${password}@127.0.0.1:${socksPort}` };
    }
    const exited = proc.exitCode !== null || proc.signalCode !== null;
    await stopProc(proc);
    const reason = stderr.trim().split('\n').pop().replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, '');
    // Lost the race for a port another process took between probing and binding
    if (exited && /address already in use/i.test(reason) && attempt < 3) continue;
    if (exited) throw tunnelError(name, `wireproxy stopped: ${reason || 'no output'}`);
    throw tunnelError(name, `no handshake with ${endpoint} within ${HANDSHAKE_TIMEOUT_MS / 1000} s — check the Endpoint and the keys (PrivateKey, the peer's PublicKey, PresharedKey), and that UDP to ${endpoint} is not blocked`);
  }
}

// One start/stop at a time per config: concurrent crawls wait for the same tunnel
function withLock(name, fn) {
  const run = (locks.get(name) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(name, tail);
  tail.then(() => { if (locks.get(name) === tail) locks.delete(name); });
  return run;
}

async function stopTunnel(name) {
  const t = instances.get(name);
  if (!t) return;
  instances.delete(name);
  await stopProc(t.proc);
}

function ensureReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [name, t] of instances) {
      if (t.active === 0 && now - t.lastUsed > IDLE_MS) {
        withLock(name, async () => {
          const cur = instances.get(name);
          if (cur === t && t.active === 0 && Date.now() - t.lastUsed > IDLE_MS) await stopTunnel(name);
        }).catch(() => {});
      }
    }
  }, Math.min(30000, Math.max(1000, IDLE_MS / 2)));
  reaper.unref();
}

/**
 * A working tunnel for the config `name`: { server, display, release() }. `server` is the
 * proxy URL for Lightpanda; call release() when the crawl is done with it. Throws with
 * err.proxyFailed when the tunnel can't be brought up.
 */
function acquire(name) {
  return withLock(name, async () => {
    const row = db.getWireguardConfigByName(name);
    // Only reachable through a restored website backup (deleting a ticked config is refused);
    // the website's next config gets its turn
    if (!row) throw tunnelError(name, 'not found — add it under Settings → WireGuard, or untick it on this website');
    const hash = crypto.createHash('sha256').update(row.config).digest('hex');
    let t = instances.get(name);
    const dead = t && (t.proc.exitCode !== null || t.proc.signalCode !== null);
    if (t && (dead || t.hash !== hash)) {
      await stopTunnel(name); // config edited, or the process died
      t = null;
    }
    if (t) {
      const at = await lastHandshake(t.infoPort);
      if (at && Date.now() / 1000 - at < STALE_HANDSHAKE_S) {
        t.handshakeAt = at;
      } else {
        await stopTunnel(name); // the server stopped answering — start over and find out
        t = null;
      }
    }
    if (!t) {
      const started = await startTunnel(name, parseConfig(row.config));
      t = { ...started, name, hash, active: 0, startedAt: Date.now(), lastUsed: Date.now(), display: `wireguard ${name}` };
      instances.set(name, t);
      ensureReaper();
    }
    t.active++;
    t.lastUsed = Date.now();
    let released = false;
    return {
      server: t.server,
      display: t.display,
      release() {
        if (released) return;
        released = true;
        t.active = Math.max(0, t.active - 1);
        t.lastUsed = Date.now();
      },
    };
  });
}

/** Bring a config's tunnel up (or confirm it is up) for the admin's "Test" button. */
async function test(name) {
  const started = Date.now();
  const tunnel = await acquire(name);
  tunnel.release();
  const t = instances.get(name);
  return { ms: Date.now() - started, handshakeAt: t ? t.handshakeAt : null };
}

/** Stop a config's tunnel now (edited or deleted config). */
function stop(name) {
  return withLock(name, () => stopTunnel(name));
}

/** { name: { pid, active, startedAt, lastUsed, handshakeAt } } of the running tunnels. */
function runtimeStatus() {
  const out = {};
  for (const [name, t] of instances) {
    out[name] = { pid: t.proc.pid, active: t.active, startedAt: t.startedAt, lastUsed: t.lastUsed, handshakeAt: t.handshakeAt };
  }
  return out;
}

// A tunnel outliving Node would keep its VPN session and memory until the container restarts
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
    return err.code === 'EPERM';
  }
}

/** Kill wireproxy processes whose PinguinCrawl process is gone (hard-killed earlier run). */
function sweepOrphans() {
  let pids;
  try {
    pids = fs.readdirSync('/proc');
  } catch {
    return 0;
  }
  const ours = new Set([...live].map((p) => p.pid));
  let killed = 0;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || ours.has(Number(pid))) continue;
    let environ;
    try {
      environ = fs.readFileSync(`/proc/${pid}/environ`, 'latin1');
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
  if (killed) console.log(`[WireGuard] Killed ${killed} orphaned wireproxy process(es) left by an earlier run`);
  // Config files a crash left between writing and wireproxy reading them
  try {
    for (const name of fs.readdirSync(SECRET_DIR)) {
      const file = path.join(SECRET_DIR, name);
      if (SECRET_RE.test(name) && Date.now() - fs.statSync(file).mtimeMs > 60000) fs.rmSync(file, { force: true });
    }
  } catch { /* not ours to read */ }
  return killed;
}

// ---------- rotation entries ----------

const isEntry = (entry) => typeof entry === 'string' && entry.startsWith(PREFIX);
const entryName = (entry) => entry.slice(PREFIX.length);

/** A website's selected configs (stored one name per line) as rotation entries. */
function websiteEntries(website) {
  return String(website.wireguard || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((n) => PREFIX + n);
}

module.exports = {
  PREFIX,
  NAME_RE,
  IDLE_MS,
  HANDSHAKE_TIMEOUT_MS,
  DEFAULT_DNS,
  parseConfig,
  summarize,
  wireproxyConfig,
  nameFrom,
  executablePath,
  getVersion,
  cachedVersion,
  checkWithWireproxy,
  acquire,
  test,
  stop,
  runtimeStatus,
  sweepOrphans,
  isEntry,
  entryName,
  websiteEntries,
};
