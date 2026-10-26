const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const db = require('../models/database');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'image_cache');
const DEFAULT_MAX_AGE_HOURS = 24;

/** Image cache retention in ms (admin setting image_cache_max_age_hours, default 24h). */
function getCacheMaxAgeMs() {
  const hours = parseInt(db.getSetting('image_cache_max_age_hours'));
  return (hours > 0 ? hours : DEFAULT_MAX_AGE_HOURS) * 60 * 60 * 1000;
}

/** Image cache size cap in bytes (admin setting image_cache_max_mb); 0 = no cap. */
function getCacheMaxBytes() {
  const mb = parseInt(db.getSetting('image_cache_max_mb'));
  return mb > 0 ? mb * 1024 * 1024 : 0;
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

function ensureCacheDir(websiteName) {
  const dir = path.join(CACHE_DIR, websiteName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function extractOriginalName(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const basename = path.basename(pathname);
    const name = basename.replace(/\.[^.]+$/, '');
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return sanitized || 'image';
  } catch {
    return 'image';
  }
}

function extractExtFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
    if (match) {
      const ext = match[1].toLowerCase();
      const valid = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tiff', 'tif'];
      if (valid.includes(ext)) return ext;
    }
  } catch {}
  return null;
}

function buildProxyFilename(imageUrl, hash, contentType) {
  // data: URLs carry the bytes themselves — there's no path to derive a name from
  if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
    return `canvas-${hash}.${extFromContentType(contentType)}`;
  }
  const originalName = extractOriginalName(imageUrl);
  const ext = extractExtFromUrl(imageUrl) || extFromContentType(contentType);
  return `${originalName}-${hash}.${ext}`;
}

function extFromContentType(ct) {
  if (!ct) return 'jpg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('svg')) return 'svg';
  return 'jpg';
}

/**
 * Single attempt to download image via Node.js HTTP/HTTPS request.
 */
function downloadImageOnce(imageUrl, referer) {
  return new Promise((resolve) => {
    const client = imageUrl.startsWith('https') ? https : http;
    const req = client.get(imageUrl, {
      headers: {
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      timeout: 15000,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImageOnce(res.headers.location, referer).then(resolve);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) return resolve(null);
        resolve({ buffer, contentType: res.headers['content-type'] || 'image/jpeg' });
      });
      res.on('error', () => resolve(null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Download image via Node.js HTTP/HTTPS request with Referer header.
 * Supports configurable retry from settings.
 */
async function downloadImageNode(imageUrl, referer) {
  const retryCount = parseInt(db.getSetting('retry_count')) || 0;
  const retryDelay = parseInt(db.getSetting('retry_delay')) || 2000;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const result = await downloadImageOnce(imageUrl, referer);
    if (result) return result;
    if (attempt < retryCount) {
      console.log(`[Retry] downloadImageNode attempt ${attempt + 1}/${retryCount} failed for ${imageUrl}. Retrying in ${retryDelay}ms...`);
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }
  return null;
}

/**
 * Download an image with fetch() inside the page, so it goes out the way the page's own
 * requests do: same proxy, cookies, Referer. Also the only way to read a blob: URL.
 *
 * This replaces Chrome's "capture the image as it loads" approach: Lightpanda never reads
 * more than the first 16 KB of an <img>, so there is no full image to capture. Cross-origin
 * CDN images work because the crawl's browser runs with CORS off (see getBrowser).
 * Returns { buffer, contentType } or null.
 */
async function fetchImageInPage(page, imageUrl) {
  let data = null;
  try {
    data = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return null;
        const ct = r.headers.get('content-type') || 'image/jpeg';
        const bytes = new Uint8Array(await r.arrayBuffer());
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return { base64: btoa(binary), contentType: ct };
      } catch { return null; }
    }, imageUrl);
  } catch { /* page may be closed */ }
  if (!data || !data.base64) return null;
  const buffer = Buffer.from(data.base64, 'base64');
  return buffer.length ? { buffer, contentType: data.contentType } : null;
}

/**
 * Save a single image to cache, downloaded through the browser (fetchImageInPage).
 * Returns { hash, proxyUrl } or null on failure.
 */
async function cacheImage(page, imageUrl, websiteName, apiBaseUrl, forceRefresh = false) {
  const hash = hashUrl(imageUrl);

  // Return cached if exists, not expired, and not forcing refresh
  if (!forceRefresh) {
    const existing = db.getImageByHash(hash);
    if (existing && fs.existsSync(existing.file_path)) {
      const proxyName = buildProxyFilename(imageUrl, hash, existing.content_type);
      return { hash, proxyUrl: `${apiBaseUrl}/api/image/${proxyName}` };
    }
  }

  try {
    const data = await fetchImageInPage(page, imageUrl);
    if (!data) return null;
    const { buffer: imgBuffer, contentType } = data;

    const dir = ensureCacheDir(websiteName);
    const proxyName = buildProxyFilename(imageUrl, hash, contentType);
    const filePath = path.join(dir, proxyName);

    fs.writeFileSync(filePath, imgBuffer);

    db.createImageCache({
      hash,
      original_url: imageUrl,
      website_name: websiteName,
      file_path: filePath,
      content_type: contentType,
      size: imgBuffer.length,
    });

    return { hash, proxyUrl: `${apiBaseUrl}/api/image/${proxyName}` };
  } catch (err) {
    console.error(`[ImageCache] Failed to cache ${imageUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Cache a single image using Node.js HTTP download (old method).
 * Uses Referer header from the page URL. Works when browser intercept is blocked.
 */
async function cacheImageNode(imageUrl, websiteName, apiBaseUrl, referer, forceRefresh = false) {
  const hash = hashUrl(imageUrl);

  // Return cached if exists, not expired, and not forcing refresh
  if (!forceRefresh) {
    const existing = db.getImageByHash(hash);
    if (existing && fs.existsSync(existing.file_path)) {
      const proxyName = buildProxyFilename(imageUrl, hash, existing.content_type);
      return { hash, proxyUrl: `${apiBaseUrl}/api/image/${proxyName}` };
    }
  }

  try {
    const data = await downloadImageNode(imageUrl, referer);
    if (!data) return null;

    const dir = ensureCacheDir(websiteName);
    const proxyName = buildProxyFilename(imageUrl, hash, data.contentType);
    const filePath = path.join(dir, proxyName);

    fs.writeFileSync(filePath, data.buffer);

    db.createImageCache({
      hash,
      original_url: imageUrl,
      website_name: websiteName,
      file_path: filePath,
      content_type: data.contentType,
      size: data.buffer.length,
    });

    return { hash, proxyUrl: `${apiBaseUrl}/api/image/${proxyName}` };
  } catch (err) {
    console.error(`[ImageCache] Node download failed for ${imageUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Cache an inline data: URL (an image embedded in the HTML or produced by page JS).
 * The bytes are already in the string, so this decodes straight to disk — no network,
 * no browser.
 */
async function cacheImageData(dataUrl, websiteName, apiBaseUrl, forceRefresh = false) {
  const hash = hashUrl(dataUrl);

  if (!forceRefresh) {
    const existing = db.getImageByHash(hash);
    if (existing && fs.existsSync(existing.file_path)) {
      const proxyName = buildProxyFilename(dataUrl, hash, existing.content_type);
      return { hash, proxyUrl: `${apiBaseUrl}/api/image/${proxyName}` };
    }
  }

  try {
    const match = /^data:([^;,]*)(;base64)?,/i.exec(dataUrl);
    if (!match) return null;
    const contentType = match[1] || 'image/png';
    if (!contentType.startsWith('image/')) return null;
    const payload = dataUrl.slice(match[0].length);
    const buffer = match[2]
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'binary');
    if (!buffer.length) return null;

    const dir = ensureCacheDir(websiteName);
    const proxyName = buildProxyFilename(dataUrl, hash, contentType);
    const filePath = path.join(dir, proxyName);
    fs.writeFileSync(filePath, buffer);

    db.createImageCache({
      hash,
      // Storing the whole data: payload would bloat the DB — keep a short marker
      original_url: `data:${contentType};len=${buffer.length}`,
      website_name: websiteName,
      file_path: filePath,
      content_type: contentType,
      size: buffer.length,
    });

    return { hash, proxyUrl: `${apiBaseUrl}/api/image/${proxyName}` };
  } catch (err) {
    console.error(`[ImageCache] data: URL decode failed: ${err.message}`);
    return null;
  }
}

/**
 * Cache multiple images using Node.js HTTP download (old method).
 * Throws error if any image fails to cache.
 */
async function cacheImagesNode(imageUrls, websiteName, apiBaseUrl, referer, forceRefresh = false) {
  const results = [];
  const failedUrls = [];
  for (const url of imageUrls) {
    const result = await cacheImageNode(url, websiteName, apiBaseUrl, referer, forceRefresh);
    if (result) {
      results.push(result.proxyUrl);
    } else {
      failedUrls.push(url);
    }
  }
  if (failedUrls.length > 0) {
    throw new Error(`Failed to cache ${failedUrls.length} of ${imageUrls.length} images (node method). First failed: ${failedUrls[0]}`);
  }
  return results;
}

/**
 * Cache multiple images in batch (browser method).
 * Throws error if any image fails to cache (no fallback to original URL).
 */
async function cacheImagesFromPage(page, imageUrls, websiteName, apiBaseUrl, forceRefresh = false) {
  const results = [];
  const failedUrls = [];
  for (const url of imageUrls) {
    const result = await cacheImage(page, url, websiteName, apiBaseUrl, forceRefresh);
    if (result) {
      results.push(result.proxyUrl);
    } else {
      failedUrls.push(url);
    }
  }
  if (failedUrls.length > 0) {
    throw new Error(`Failed to cache ${failedUrls.length} of ${imageUrls.length} images. First failed: ${failedUrls[0]}`);
  }
  return results;
}

/**
 * Serve a cached image by hash.
 * Returns { filePath, contentType } or null.
 */
function getCachedImage(hash) {
  const record = db.getImageByHash(hash);
  if (!record) return null;
  if (!fs.existsSync(record.file_path)) return null;
  return { filePath: record.file_path, contentType: record.content_type };
}

/**
 * Delete cached images older than the retention period (default 24 hours).
 * Returns the number of images deleted.
 */
function cleanExpiredImages() {
  const expired = db.getExpiredImages(getCacheMaxAgeMs());
  if (!expired.length) return 0;
  for (const record of expired) unlinkQuiet(record.file_path);
  // Delete exactly the rows whose files were removed (a second age query could match
  // rows that expired in between and orphan their files)
  db.deleteImageCacheByIds(expired.map((r) => r.id));
  console.log(`[ImageCache] Cleanup: deleted ${expired.length} expired images`);
  return expired.length;
}

/**
 * Keep the cache under the admin-set size cap by evicting the oldest images until it is
 * back under 90% of the cap (the margin stops this from firing after every crawl).
 * Returns the number of images evicted.
 */
function enforceCacheSizeLimit() {
  const maxBytes = getCacheMaxBytes();
  if (!maxBytes) return 0;
  let { bytes } = db.getImageCacheTotals();
  if (bytes <= maxBytes) return 0;
  const target = maxBytes * 0.9;
  let evicted = 0;
  while (bytes > target) {
    const batch = db.getOldestImages(500);
    if (!batch.length) break;
    const ids = [];
    for (const record of batch) {
      unlinkQuiet(record.file_path);
      ids.push(record.id);
      bytes -= record.size || 0;
      if (bytes <= target) break;
    }
    db.deleteImageCacheByIds(ids);
    evicted += ids.length;
  }
  console.log(`[ImageCache] Size cap ${Math.round(maxBytes / 1048576)} MB reached: evicted ${evicted} oldest images`);
  return evicted;
}

/**
 * Delete files in the cache dir that no DB record points to. Images are only ever
 * served through a DB lookup, so these are unreachable — and nothing else would delete
 * them: left by a DB restore, a crash between write and insert, or a URL re-cached
 * under another name. Files younger than minAgeMs are left alone (still being written).
 */
async function removeOrphanImages({ minAgeMs = 60 * 60 * 1000 } = {}) {
  const result = { removed: 0, bytes: 0 };
  if (!fs.existsSync(CACHE_DIR)) return result;
  const known = new Set(db.getAllImageCachePaths());
  const now = Date.now();
  const walk = async (dir) => {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || known.has(full)) continue;
      try {
        const st = await fs.promises.stat(full);
        if (now - st.mtimeMs < minAgeMs) continue;
        await fs.promises.unlink(full);
        result.removed++;
        result.bytes += st.size;
      } catch { /* gone meanwhile */ }
    }
  };
  await walk(CACHE_DIR);
  if (result.removed) {
    console.log(`[ImageCache] Removed ${result.removed} orphaned cache files (${(result.bytes / 1048576).toFixed(1)} MB)`);
  }
  return result;
}

/**
 * Delete ALL cached images (files + DB records).
 * Returns { deletedFiles, deletedRecords }.
 */
function clearAllImages() {
  // Delete all files in cache directory
  let deletedFiles = 0;
  if (fs.existsSync(CACHE_DIR)) {
    const entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(CACHE_DIR, entry.name);
      if (entry.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
      deletedFiles++;
    }
  }

  // Delete all DB records
  const result = db.deleteAllImageCache();
  console.log(`[ImageCache] Cleared all: ${deletedFiles} directories/files, ${result.changes} DB records`);
  return { deletedFiles, deletedRecords: result.changes };
}

/**
 * On-demand proxy: fetch, cache, and return image data for a given URL.
 * Used by /api/image/v3/?url=... — caches on first access.
 * Returns { filePath, contentType } or null.
 */
async function proxyImageOnDemand(imageUrl) {
  const hash = hashUrl(imageUrl);

  // Return cached if exists and file still on disk
  const existing = db.getImageByHash(hash);
  if (existing && fs.existsSync(existing.file_path)) {
    return { filePath: existing.file_path, contentType: existing.content_type };
  }

  // Derive Referer from the image URL's origin
  let referer;
  try { referer = new URL(imageUrl).origin + '/'; } catch { referer = imageUrl; }

  const data = await downloadImageNode(imageUrl, referer);
  if (!data) return null;

  const dir = ensureCacheDir('_proxy');
  const proxyName = buildProxyFilename(imageUrl, hash, data.contentType);
  const filePath = path.join(dir, proxyName);

  fs.writeFileSync(filePath, data.buffer);

  db.createImageCache({
    hash,
    original_url: imageUrl,
    website_name: '_proxy',
    file_path: filePath,
    content_type: data.contentType,
    size: data.buffer.length,
  });

  return { filePath, contentType: data.contentType };
}

module.exports = {
  cacheImage,
  cacheImageNode,
  cacheImageData,
  cacheImagesFromPage,
  cacheImagesNode,
  getCachedImage,
  cleanExpiredImages,
  enforceCacheSizeLimit,
  removeOrphanImages,
  getCacheMaxAgeMs,
  getCacheMaxBytes,
  clearAllImages,
  proxyImageOnDemand,
  hashUrl,
  CACHE_DIR,
};
