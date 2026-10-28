const express = require('express');
const path = require('path');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy — only enable if behind a reverse proxy (nginx/Caddy)
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);

// Security headers (CSP disabled — admin panel uses CDN assets)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// View helpers
app.locals.fmtBytes = (bytes) => {
  let n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
};
app.locals.fmtNumber = (n) => Number(n || 0).toLocaleString('id-ID');
// "6.376 ms" (id-ID grouping) reads like six milliseconds — switch to seconds instead
app.locals.fmtDuration = (ms) => (ms < 1000 ? `${ms || 0} ms` : `${(ms / 1000).toFixed(1)} s`);

// Body parser for form submissions
app.use(express.urlencoded({ extended: true }));

// Layout helper - wraps page renders in layout
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view, locals = {}) => {
    const layout = locals.layout || 'layouts/main';
    originalRender(view, locals, (err, html) => {
      if (err) return next(err);
      originalRender(layout, { ...locals, body: html });
    });
  };
  next();
});

// Static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Routes
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);

// Root redirect
app.get('/', (req, res) => { res.redirect('/admin'); });

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.url}:`, err.message);
  if (req.path.startsWith('/api')) {
    res.status(500).json({ status: 'error', message: err.message });
  } else {
    res.status(500).send('Internal Server Error');
  }
});

// Disk housekeeping. Left alone, the image cache fills the disk until crawls die with ENOSPC.
//  - startup + every 6h: everything (image cache incl. orphaned files, stale
//    upload/backup temp files) — runs in the background, startup isn't blocked
//  - every 15 min: expired images (retention, default 24h) + image cache size cap
const storage = require('./services/storage');
storage.runFullCleanup();
setInterval(storage.runFullCleanup, 6 * 60 * 60 * 1000);
setInterval(storage.runCacheMaintenance, 15 * 60 * 1000);

// Lightpanda servers left running by a hard-killed earlier run (OOM, SIGKILL): at startup
// and every 30 min. Normal exits stop their own browsers.
const lightpanda = require('./services/lightpanda');
lightpanda.sweepOrphans();
setInterval(lightpanda.sweepOrphans, 30 * 60 * 1000);
// Say right away whether the browser works, instead of at the first crawl
lightpanda.getVersion().then((version) => {
  const bin = lightpanda.executablePath();
  if (version) console.log(`[Lightpanda] ${version} (${bin})`);
  else console.warn(`[Lightpanda] ${bin ? `${bin} cannot be run` : 'not installed'} — crawls with JS rendering on will fail until it works (see README)`);
});

// WireGuard tunnels (wireproxy) are started on demand by crawls; only leftovers of a
// hard-killed earlier run need sweeping here
const wireguard = require('./services/wireguard');
wireguard.sweepOrphans();
setInterval(wireguard.sweepOrphans, 30 * 60 * 1000);
wireguard.getVersion().then((version) => {
  if (version) {
    console.log(`[WireGuard] wireproxy ${version} (${wireguard.executablePath()})`);
  } else if (require('./models/database').getWireguardConfigs().length) {
    console.warn('[WireGuard] wireproxy is not installed — websites using WireGuard configs will fail to crawl (see README)');
  }
});

// API log cleanup — delete logs older than 2 weeks, runs every 12 hours
const { deleteOldApiLogs, LOG_RETENTION_DAYS } = require('./models/database');
function cleanOldApiLogs() {
  try {
    const result = deleteOldApiLogs();
    if (result.changes > 0) {
      console.log(`[ApiLogs] Cleanup: deleted ${result.changes} logs older than ${LOG_RETENTION_DAYS} days`);
    }
  } catch (err) {
    console.error('[ApiLogs] Cleanup failed:', err.message);
  }
}
setInterval(cleanOldApiLogs, 12 * 60 * 60 * 1000);
cleanOldApiLogs(); // run once at startup

const server = app.listen(PORT, () => {
  console.log(`PinguinCrawl running on http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  console.log(`API:   http://localhost:${PORT}/api/katalog?website=<name>&url=...`);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[${signal}] Shutting down gracefully...`);
  server.close(() => {
    const { closeDb } = require('./models/database');
    closeDb();
    console.log('Database closed. Bye.');
    process.exit(0);
  });
  // Force exit after 10s if connections are stuck
  setTimeout(() => { process.exit(1); }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
