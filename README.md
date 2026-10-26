# PinguinCrawl

Comic/Manga web crawler with admin panel. Pages are rendered with [Lightpanda](https://github.com/lightpanda-io/browser) — a headless browser built for automation — instead of Chrome.

PinguinCrawl is [crawlkomik](https://github.com/kontaknurman/crawlkomik) with the browser swapped: same API, same admin panel, same database schema. What changes is what the browser can and cannot do.

## Lightpanda vs Chrome (crawlkomik)

| | crawlkomik (Chrome) | PinguinCrawl (Lightpanda) |
|---|---|---|
| Browser per crawl | Chromium + profil di `/tmp` | satu proses `lightpanda serve`, ±25 MB, start ±20 ms, tanpa file di disk |
| Docker image | Alpine + Chromium + Xvfb + font | Debian slim + satu binary Lightpanda |
| Cloudflare / CAPTCHA | stealth, mode headful, manual takeover | **tidak bisa dilewati** — crawl gagal cepat dengan pesan jelas |
| User-Agent website | bebas | UA yang mengandung `Mozilla` **ditolak** Lightpanda (tidak mau menyamar jadi browser lain) |
| Reader berbasis `<canvas>` | didukung | tidak — Lightpanda tidak menggambar halaman |
| Action `screenshot` | gambar asli | rendering teks saja |

Situs di balik Cloudflare/CAPTCHA tetap butuh crawler berbasis Chrome (crawlkomik).

## Features
- **API endpoints** returning JSON (katalog, komik detail, chapter list, chapter images), optional `&html=true` to include raw scraped HTML
- **Lightpanda JS rendering** — runs the page's JavaScript (XHR/fetch, lazy-load, IntersectionObserver), cookies, localStorage, click/type/select actions
  - **Toggle JS rendering per page config** — disable to use simple HTTP fetch (like CURL), no browser at all
  - Each crawl gets its own Lightpanda process: proxy, timezone and cookies never leak between crawls, a crash only affects one crawl
- **Challenge detection** — Cloudflare/DDoS-Guard interstitials, Turnstile/reCAPTCHA/hCaptcha widgets and "verify you are human" pages make the crawl fail fast with a clear error (not retried), instead of returning the challenge page as data. Toggle in Settings
- **Cek Lightpanda** (Settings) — starts the browser and reports version, JS, cookies, the User-Agent it really sends and its timezone; per website it also opens the base URL through that website's proxy and says whether a challenge page came back
- **Custom headers & cookies** per website (optional) — session cookies auto-saved when a challenge page clears by itself
- **Proxy support** per website (`http://user:pass@host:port`)
- **Timezone per website** — the browser clock (`Date`/`Intl`); the container runs in UTC
- **Image proxy/cache** - caches images through server for blob URLs or referrer-restricted sources
  - Toggle per website in admin panel
  - 3 methods: Browser (downloaded inside the page by Lightpanda: same proxy, cookies, Referer), Node.js HTTP (with Referer), Lazy Proxy (cache on access)
  - **Lazy Proxy**: images not downloaded at crawl time, cached on first access via `/api/image/v3/?url=...`
  - Chapter images always fresh (re-downloaded on every API hit) for browser/node methods
  - Cover images cached with reuse
  - Retention (default 24 jam) dan batas ukuran (MB, terlama dibuang dulu) diatur dari `/admin/storage`; file cache yatim (tanpa record DB) dibersihkan otomatis
  - Handles blob: URLs, `data:` URLs, referrer-restricted images, normal URLs
  - JSON return auto-replaces image URLs with proxy URLs
  - Applies to built-in page types **and** custom page types (image URLs inside custom response fields)
- **Admin panel** (Bootstrap 5) to manage websites and crawl configs
  - **Responsive** — sidebar jadi menu geser di HP, tabel jadi kartu, tombol Simpan menempel di bawah form panjang
  - Light/dark mode, toast notifikasi, peringatan perubahan belum disimpan, validasi JSON langsung (+ tombol Rapikan)
  - Halaman terpisah: Dashboard (ringkasan), Settings (crawl, browser, akses API, keamanan, backup), Storage (disk)
  - **Uji API** dari form config — buka endpoint dengan URL contoh di tab baru
- **Disk housekeeping** (`/admin/storage`) — mencegah `ENOSPC: no space left on device`
  - Meter ruang **dan inode** untuk temp dan `data/` (database, cache gambar), peringatan di dashboard saat hampir penuh
  - Tombol **Bersihkan sekarang**: gambar kedaluwarsa/lewat batas, file cache yatim, upload/backup sementara
  - Docker: log container dibatasi 3 × 10 MB (`docker-compose.yml`), core dump Lightpanda dimatikan
- **Custom page types** — admin can create custom page types beyond the 4 defaults, each with its own API endpoint `/api/custom/{name}`
  - Data extraction via Custom Response Fields (fully configurable from admin)
  - Full feature support: actions, wait, scroll, regex replace, custom JS, retry
  - Manage from dashboard: create/delete custom types, configure per website
- **Configurable CSS selectors** per page type per website
  - **Required selector toggle** — mark any selector as required; API returns error if result is empty
  - **`js:` prefix** — use JavaScript expressions instead of CSS selectors for complex extraction (e.g. finding table rows by label)
- **Pre-scrape actions**: click, wait, scroll, type, select, evaluate JS, screenshot
- **Custom JavaScript** injection before scraping
- **Regex replace** per page config — transform extracted text in API response (fix entities, remove suffixes, etc.)
- **Custom response fields** per page config — add extra fields to API JSON response via admin repeater UI
  - 3 types: `string` (single value), `array` (multiple values), `object_array` (array of objects with sub-fields)
  - Image URLs in custom fields go through the image proxy/cache too (works for custom page types, not just the built-in ones) — auto-detected by extension, or force it with the **Img** toggle for extension-less CDN URLs
  - Supports CSS selectors, `js:` prefix, and attribute extraction
  - Visual repeater builder + direct JSON editing in admin panel
- **Admin login** with password protection (scrypt hash, signed cookie)
  - Default password: `admin` (change after first login)
  - Change password from dashboard
  - **Google Authenticator (TOTP 2FA)** — setup from dashboard, QR code scan, 6-digit code on login
  - **Logout from all devices** — invalidates all active sessions by regenerating session secret
- **Clear image cache** — manually purge all cached images from the Storage page
- **API request logs** (`/admin/logs`) — every API hit recorded with status, duration, error & response body
  - Filter by status/endpoint, stats cards (total, errors, today)
  - **Auto-cleanup**: logs older than 2 weeks (14 days) deleted automatically — runs at startup + every 12 hours
  - Manual delete buttons: all logs, error logs only, logs older than 2 weeks
- **SQLite database** for config storage (zero setup)
  - **Backup & Restore** — download/upload database from admin dashboard

## Tech Stack
- Runtime: Node.js 22.12+
- Framework: Express.js
- Browser: [Lightpanda](https://github.com/lightpanda-io/browser) 1.0.2, driven over CDP with `puppeteer-core`
- Database: SQLite (better-sqlite3)
- Admin UI: EJS + Bootstrap 5
- Process Manager: PM2 (production)

## Setup

### Docker (Recommended)
```bash
docker compose up -d      # http://localhost:3000
docker compose logs -f    # view logs
docker compose down       # stop
```
The image downloads the Lightpanda release binary (amd64 and arm64). Upgrade by changing `ARG LIGHTPANDA_VERSION` in the `Dockerfile` and rebuilding (`docker compose up -d --build`).

Running crawlkomik on the same server too? Both default to port 3000 — change the host port in `docker-compose.yml` (e.g. `"3001:3000"`).

### Manual
Lightpanda must be on `PATH` (or set `LIGHTPANDA_EXECUTABLE_PATH`). Linux x86_64:
```bash
curl -L -o /usr/local/bin/lightpanda https://github.com/lightpanda-io/browser/releases/download/1.0.2/lightpanda-x86_64-linux
chmod a+x /usr/local/bin/lightpanda
lightpanda version
```
Other builds: `lightpanda-aarch64-linux`, `lightpanda-aarch64-macos`, `lightpanda-x86_64-macos`. Windows: install inside WSL2. The Linux binaries need **glibc** — they do not run on Alpine/musl.

```bash
npm install
npm start        # http://localhost:3000
npm run dev      # with auto-reload
```

### Environment
| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `LIGHTPANDA_EXECUTABLE_PATH` | `lightpanda` on `PATH` | Lightpanda binary |
| `MAX_BROWSERS` | `3` | concurrent browsers when not set in Settings |
| `LIGHTPANDA_DISABLE_TELEMETRY` | set in Docker | Lightpanda sends usage telemetry unless this is set (to any value). The Docker image sets it; remove the `ENV` line to allow telemetry |
| `LIGHTPANDA_DISABLE_CORE_DUMP` | set in Docker | no core dumps when the browser crashes |
| `TRUST_PROXY` | – | `1` when behind nginx/Caddy |

## Pindah dari crawlkomik
1. crawlkomik: Settings → Backup & Restore → **Download Backup**.
2. PinguinCrawl: Settings → Backup & Restore → **Restore** file tadi. (Database PinguinCrawl ada di `data/pinguincrawl.db`, jadi menyalin folder `data/` crawlkomik saja tidak cukup.)
3. Website yang field **User Agent**-nya berisi `Mozilla/...`: kosongkan — Lightpanda mengabaikannya.
4. Jalankan **Cek Lightpanda** (Settings) per website. Yang terdeteksi memasang challenge tetap di crawlkomik.

Setelan headless, CAPTCHA takeover (timeout, webhook) dan fingerprint check sengaja tidak ada lagi.

## Cara kerja browser
- Tiap crawl menjalankan `lightpanda serve --port 0` sendiri, Puppeteer (`puppeteer-core`) terhubung lewat CDP, lalu prosesnya dihentikan begitu crawl selesai. Proxy, timezone, dan sub-resource yang dimuat adalah opsi per proses di Lightpanda, karena itu satu proses per crawl.
- Stylesheet selalu dimuat (computed style asli). Gambar `<img>` dimuat kecuali **Block Image Loading** aktif — dan Lightpanda hanya membaca ±16 KB pertama tiap gambar, cukup untuk event `load`/`error`.
- Cache gambar metode **Browser**: karena tidak ada gambar utuh yang bisa ditangkap, gambar diunduh dengan `fetch()` di dalam halaman. Gambar CDN beda origin, jadi crawl yang memakai metode ini berjalan dengan CORS dimatikan — dan **jaringan privat diblokir** (localhost, LAN, metadata cloud) supaya script halaman tidak bisa membaca layanan internal. Proxy di alamat privat (squid lokal, container VPN) otomatis dikecualikan.
- Proses Lightpanda yang tertinggal karena Node di-kill paksa (OOM, `SIGKILL`) dibunuh saat server start dan tiap 30 menit.

## Cloudflare, CAPTCHA & WAF
Lightpanda tidak punya mesin grafis dan selalu mengaku sebagai Lightpanda, jadi challenge Cloudflare/Turnstile/reCAPTCHA/hCaptcha **tidak bisa dilewati** — tidak ada mode headful, stealth, atau ambil-alih manual seperti di crawlkomik.

Dengan **Deteksi halaman CAPTCHA / challenge** aktif (Settings → Crawl & Browser, default aktif), crawl yang mendapat halaman challenge langsung gagal dengan error seperti:
```
Challenge page detected (cloudflare: Cloudflare challenge page markers). Lightpanda cannot pass CAPTCHA/WAF challenges — ...
```
Challenge yang murni JavaScript dan lolos sendiri ditunggu maksimal 10 detik; cookie-nya lalu disimpan ke website seperti biasa. Matikan deteksi hanya kalau halaman normal salah terdeteksi.

## API Endpoints (GET)
| Endpoint | Params | Returns |
|----------|--------|---------|
| `/api/katalog` | `website`, `url` | Manga listing |
| `/api/komik` | `website`, `url` | Manga detail |
| `/api/chapters` | `website`, `url` | Chapter list |
| `/api/chapter` | `website`, `url` | Chapter images |
| `/api/custom/:pageType` | `website`, `url` | Custom page type (admin-defined) |
| `/api/image/:hash` | - | Serve cached/proxied image |
| `/api/image/v3/` | `url` | Lazy proxy: fetch, cache, serve on access |

All crawl endpoints support optional `&html=true` — includes raw scraped HTML in the JSON response (useful for debugging selectors).

Example: `/api/katalog?website=mywebsite&url=https://example.com/latest/&html=true`

## Admin Panel
- URL: `http://localhost:3000/admin` (login required)
- Default password: `admin` — change from Settings → Keamanan after first login (dashboard shows a warning until you do)
- Works on phones: menu ☰ di kiri atas
- Add/edit/delete websites
- Configure CSS selectors per page type (katalog, komik_detail, chapter_list, chapter + custom types)
- Create custom page types from dashboard — each gets `/api/custom/{name}` endpoint
- Toggle "Required" per selector — API returns error when required field is empty
- Set pre-scrape actions (click, wait, scroll, type, evaluate JS)
- Set wait-for selector, timeout, scroll-to-bottom
- Inject custom JavaScript before scraping
- Regex replace rules per page type (post-scrape text transformation)
- Custom response fields — add extra fields to API response (string, array, object_array with sub-fields)
- Custom headers & cookies per website (JSON fields in website form)
- View API logs (`/admin/logs`) — filter, stats, delete all/errors/old; logs >2 weeks auto-deleted
- Settings (`/admin/settings`) — max browsers, retry, challenge detection, **Cek Lightpanda**, API key (+ generate), IP whitelist, password, 2FA, logout all devices
- Backup & restore database (Settings → Backup & Restore)
- Storage (`/admin/storage`) — disk & inode usage, cleanup, image cache retention / size cap

## Error `ENOSPC: no space left on device`
Disk (atau inode) server penuh. Lightpanda tidak menulis profil ke disk, jadi biasanya penyebabnya cache gambar — cek `/admin/storage`, turunkan retensi atau pasang batas MB, lalu **Bersihkan sekarang**.

Disk sudah 100% penuh sampai build gagal? Kosongkan dulu:
```bash
docker compose down          # hapus container lama
docker image prune -f        # image lama dari build sebelumnya juga makan disk
docker compose up -d --build
```

## Folder Structure
```
src/
  app.js              # Entry point
  models/database.js  # SQLite schema + CRUD
  services/lightpanda.js  # Lightpanda processes: start (port 0), stop, sweep orphans, version
  services/browser.js # Puppeteer-core over CDP: per-crawl browser, page setup, actions, challenge check
  services/browser-check.js # "Cek Lightpanda" self-check
  services/storage.js # Disk/inode report + cleanup jobs (Storage page)
  services/crawler.js    # Crawl logic per page type
  services/image-proxy.js # Image cache/proxy service
  services/captcha-detector.js # Detect CF/Turnstile/reCAPTCHA/hCaptcha/text challenges
  routes/api.js       # API endpoints
  middleware/auth.js  # Login auth middleware
  routes/admin.js     # Admin panel routes
  views/              # EJS templates
  public/             # admin.css + admin.js (layout, theme, toasts, JSON check)
json-return/          # Expected JSON format examples
```
