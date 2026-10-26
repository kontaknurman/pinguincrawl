const express = require('express');
const router = express.Router();
const crawler = require('../services/crawler');
const { getCachedImage, proxyImageOnDemand } = require('../services/image-proxy');
const db = require('../models/database');

// IP whitelist middleware — if admin sets ip_whitelist in settings, only listed IPs can access API
function checkIpWhitelist(req, res, next) {
  const whitelist = db.getSetting('ip_whitelist');
  if (!whitelist) return next(); // no whitelist = open access

  const allowed = whitelist.split(',').map(ip => ip.trim()).filter(Boolean);
  if (allowed.length === 0) return next();

  // Normalize req.ip (strip ::ffff: prefix for IPv4-mapped IPv6)
  const clientIp = (req.ip || '').replace(/^::ffff:/, '');
  if (!allowed.includes(clientIp)) {
    return res.status(403).json({ status: 'error', message: 'Access denied. IP not in whitelist.' });
  }
  next();
}

// API key middleware — if admin sets an api_key in settings, all crawl endpoints require it
function requireApiKey(req, res, next) {
  const apiKey = db.getSetting('api_key');
  if (!apiKey) return next(); // no key configured = open access

  const provided = req.query.api_key || req.headers['x-api-key'];
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ status: 'error', message: 'Invalid or missing API key' });
  }
  next();
}

// Validate URL to prevent SSRF (only allow http/https, block internal/private IPs)
function validateUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    const hostname = parsed.hostname.toLowerCase();

    // Block localhost variants
    if (['localhost', '0.0.0.0', '[::1]', '[::0]', '[::]'].includes(hostname)) return false;

    // Block .internal, .local, .localhost TLDs
    if (/\.(internal|local|localhost)$/.test(hostname)) return false;

    // Block private/reserved IPv4 ranges
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const [, a, b, , ] = ipv4Match.map(Number);
      if (a === 0) return false;                           // 0.0.0.0/8
      if (a === 10) return false;                          // 10.0.0.0/8
      if (a === 100 && b >= 64 && b <= 127) return false;  // 100.64.0.0/10 (CGNAT)
      if (a === 127) return false;                         // 127.0.0.0/8
      if (a === 169 && b === 254) return false;            // 169.254.0.0/16 (link-local + cloud metadata)
      if (a === 172 && b >= 16 && b <= 31) return false;   // 172.16.0.0/12
      if (a === 192 && b === 168) return false;            // 192.168.0.0/16
      if (a >= 224) return false;                          // 224.0.0.0+ (multicast/reserved)
    }

    // Block all bracketed IPv6 (prevent bypasses via IPv6 mapped addresses)
    if (hostname.startsWith('[')) return false;

    return true;
  } catch {
    return false;
  }
}

// Helper: log API request + response
function logApi(req, endpoint, statusCode, result, startTime) {
  const duration = Date.now() - startTime;
  const isError = statusCode >= 400;
  // Truncate response body for storage (max 5KB)
  let responseBody = null;
  try {
    const json = JSON.stringify(result);
    responseBody = json.length > 5120 ? json.slice(0, 5120) + '...' : json;
  } catch { /* skip */ }

  db.createApiLog({
    endpoint,
    website: req.query.website || null,
    url: req.query.url || null,
    status: isError ? 'error' : 'success',
    status_code: statusCode,
    error_message: isError ? result.message : null,
    response_body: responseBody,
    duration_ms: duration,
    ip: req.ip,
  });
}

// GET /api/katalog?website=<name>&url=<katalog_url>
router.get('/katalog', checkIpWhitelist, requireApiKey, async (req, res) => {
  const start = Date.now();
  try {
    const { website, url, html } = req.query;
    if (!website || !url) {
      const err = { status: 'error', message: 'Missing "website" or "url" query parameter' };
      logApi(req, '/api/katalog', 400, err, start);
      return res.status(400).json(err);
    }
    if (!validateUrl(url)) {
      const err = { status: 'error', message: 'Invalid URL. Only http/https URLs are allowed' };
      logApi(req, '/api/katalog', 400, err, start);
      return res.status(400).json(err);
    }
    const result = await crawler.crawlKatalog(website, url, { includeHtml: html === 'true' });
    logApi(req, '/api/katalog', 200, result, start);
    res.json(result);
  } catch (err) {
    const errObj = { status: 'error', message: err.message };
    logApi(req, '/api/katalog', 500, errObj, start);
    res.status(500).json(errObj);
  }
});

// GET /api/komik?website=<name>&url=<komik_detail_url>
router.get('/komik', checkIpWhitelist, requireApiKey, async (req, res) => {
  const start = Date.now();
  try {
    const { website, url, html } = req.query;
    if (!website || !url) {
      const err = { status: 'error', message: 'Missing "website" or "url" query parameter' };
      logApi(req, '/api/komik', 400, err, start);
      return res.status(400).json(err);
    }
    if (!validateUrl(url)) {
      const err = { status: 'error', message: 'Invalid URL. Only http/https URLs are allowed' };
      logApi(req, '/api/komik', 400, err, start);
      return res.status(400).json(err);
    }
    const apiBaseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await crawler.crawlKomikDetail(website, url, apiBaseUrl, { includeHtml: html === 'true' });
    logApi(req, '/api/komik', 200, result, start);
    res.json(result);
  } catch (err) {
    const errObj = { status: 'error', message: err.message };
    logApi(req, '/api/komik', 500, errObj, start);
    res.status(500).json(errObj);
  }
});

// GET /api/chapters?website=<name>&url=<komik_detail_url>
router.get('/chapters', checkIpWhitelist, requireApiKey, async (req, res) => {
  const start = Date.now();
  try {
    const { website, url, html } = req.query;
    if (!website || !url) {
      const err = { status: 'error', message: 'Missing "website" or "url" query parameter' };
      logApi(req, '/api/chapters', 400, err, start);
      return res.status(400).json(err);
    }
    if (!validateUrl(url)) {
      const err = { status: 'error', message: 'Invalid URL. Only http/https URLs are allowed' };
      logApi(req, '/api/chapters', 400, err, start);
      return res.status(400).json(err);
    }
    const apiBaseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await crawler.crawlChapterList(website, url, apiBaseUrl, { includeHtml: html === 'true' });
    logApi(req, '/api/chapters', 200, result, start);
    res.json(result);
  } catch (err) {
    const errObj = { status: 'error', message: err.message };
    logApi(req, '/api/chapters', 500, errObj, start);
    res.status(500).json(errObj);
  }
});

// GET /api/chapter?website=<name>&url=<chapter_url>
router.get('/chapter', checkIpWhitelist, requireApiKey, async (req, res) => {
  const start = Date.now();
  try {
    const { website, url, html } = req.query;
    if (!website || !url) {
      const err = { status: 'error', message: 'Missing "website" or "url" query parameter' };
      logApi(req, '/api/chapter', 400, err, start);
      return res.status(400).json(err);
    }
    if (!validateUrl(url)) {
      const err = { status: 'error', message: 'Invalid URL. Only http/https URLs are allowed' };
      logApi(req, '/api/chapter', 400, err, start);
      return res.status(400).json(err);
    }
    const apiBaseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await crawler.crawlChapter(website, url, apiBaseUrl, { includeHtml: html === 'true' });
    logApi(req, '/api/chapter', 200, result, start);
    res.json(result);
  } catch (err) {
    const errObj = { status: 'error', message: err.message };
    logApi(req, '/api/chapter', 500, errObj, start);
    res.status(500).json(errObj);
  }
});

// GET /api/custom/:pageType?website=<name>&url=<url> — dynamic endpoint for custom page types
router.get('/custom/:pageType', checkIpWhitelist, requireApiKey, async (req, res) => {
  const start = Date.now();
  const pageType = req.params.pageType;
  const endpointName = `/api/custom/${pageType}`;
  try {
    const { website, url, html } = req.query;
    if (!website || !url) {
      const err = { status: 'error', message: 'Missing "website" or "url" query parameter' };
      logApi(req, endpointName, 400, err, start);
      return res.status(400).json(err);
    }
    if (!validateUrl(url)) {
      const err = { status: 'error', message: 'Invalid URL. Only http/https URLs are allowed' };
      logApi(req, endpointName, 400, err, start);
      return res.status(400).json(err);
    }
    // Verify custom page type exists for this website
    const ws = db.getWebsiteByName(website);
    if (!ws) {
      const err = { status: 'error', message: `Website "${website}" not found` };
      logApi(req, endpointName, 404, err, start);
      return res.status(404).json(err);
    }
    const cpt = db.getCustomPageTypeByName(ws.id, pageType);
    if (!cpt) {
      const err = { status: 'error', message: `Custom page type "${pageType}" not found for website "${website}"` };
      logApi(req, endpointName, 404, err, start);
      return res.status(404).json(err);
    }
    const apiBaseUrl = `${req.protocol}://${req.get('host')}`;
    const result = await crawler.crawlCustom(website, url, pageType, apiBaseUrl, { includeHtml: html === 'true' });
    logApi(req, endpointName, 200, result, start);
    res.json(result);
  } catch (err) {
    const errObj = { status: 'error', message: err.message };
    logApi(req, endpointName, 500, errObj, start);
    res.status(500).json(errObj);
  }
});

// GET /api/image/v3/?url=... - lazy proxy: fetch, cache, and serve image on first access
// NOTE: must be defined BEFORE /image/:filename to avoid v3 being matched as a filename
router.get('/image/v3/', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).json({ status: 'error', message: 'Missing url parameter' });
  }

  try {
    new URL(imageUrl);
  } catch {
    return res.status(400).json({ status: 'error', message: 'Invalid url parameter' });
  }

  try {
    const result = await proxyImageOnDemand(imageUrl);
    if (!result) {
      return res.status(502).json({ status: 'error', message: 'Failed to fetch image from origin' });
    }
    res.set('Content-Type', result.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(result.filePath);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/image/:filename - serve cached/proxied image (e.g. /api/image/page-001-a3b5c7d9.jpg)
router.get('/image/:filename', (req, res) => {
  // Strip extension, then extract hash (last 16 hex chars after the last dash)
  const nameNoExt = req.params.filename.replace(/\.[a-z]+$/i, '');
  const match = nameNoExt.match(/-([a-f0-9]{16})$/);
  // Also support bare hash for backwards compatibility
  const hash = match ? match[1] : nameNoExt;
  if (!/^[a-f0-9]+$/.test(hash)) {
    return res.status(400).json({ status: 'error', message: 'Invalid image hash' });
  }
  const cached = getCachedImage(hash);
  if (!cached) {
    return res.status(404).json({ status: 'error', message: 'Image not found in cache' });
  }
  res.set('Content-Type', cached.contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(cached.filePath);
});

module.exports = router;
