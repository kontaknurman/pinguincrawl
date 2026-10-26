# CrawlKomik

Comic/Manga web crawler with admin panel. Uses Puppeteer for full JS rendering.

## Features
- **API endpoints** returning JSON (katalog, komik detail, chapter list, chapter images), optional `&html=true` to include raw scraped HTML
- **Puppeteer + Stealth** for full JavaScript rendering like human visit
  - **Toggle JS rendering per page config** — disable to use simple HTTP fetch (like CURL), faster and lighter
  - When JS disabled: no Puppeteer browser, Wait/Scroll/Actions/Custom JS hidden in config UI
- **Cloudflare WAF bypass** — auto-detect challenge page, wait for resolution, save session cookies
- **Manual CAPTCHA takeover** — when a crawl hits a CAPTCHA that stealth can't auto-solve, an admin solves it live from the dashboard
  - Detects Cloudflare/DDoS-Guard interstitials, Turnstile/reCAPTCHA/hCaptcha widgets, and "verify you are human" text challenges
  - Live view via CDP screencast (`Page.startScreencast`) streamed over WebSocket to `/admin/captcha`
  - Admin clicks & types directly on the streamed screen; input is relayed back with `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`
  - Auto-continues when the challenge clears (DOM polling) or when admin clicks **Selesai**; crawl resumes normally and session cookies are saved
  - In-memory session registry maps every crawl to a status (`running` / `waiting_captcha` / `solving` / `done` / `failed`) so multiple parallel workers can queue for attention
  - Timeout (default 3 min, configurable) marks the session failed → flows into the existing retry logic
  - Optional webhook notification (Slack/Discord `{text}`, or Telegram) when a session needs a manual solve
  - Toggle on/off from the dashboard — when off, the crawler behaves exactly as before (passive Cloudflare wait only), zero overhead
  - **Fingerprint self-check** — one click reports which bot signals are failing (headless mode, viewport vs screen, webdriver, WebGL/GPU, DISPLAY) with a fix for each
- **Custom headers & cookies** per website (optional) — session cookies auto-saved after CF bypass
- **Proxy support** per website
- **Timezone per website** — samakan jam browser dengan negara proxy; container jalan di UTC, jadi proxy di negara lain bikin geolokasi IP dan timezone bertentangan (sinyal yang dicek Cloudflare)
- **Image proxy/cache** - caches images through server for blob URLs or referrer-restricted sources
  - Toggle per website in admin panel
  - 3 methods: Browser Intercept, Node.js HTTP (with Referer), Lazy Proxy (cache on access)
  - **Lazy Proxy**: images not downloaded at crawl time, cached on first access via `/api/image/v3/?url=...`
  - Chapter images always fresh (re-downloaded on every API hit) for browser/node methods
  - Cover images cached with reuse
  - Retention (default 24 jam) dan batas ukuran (MB, terlama dibuang dulu) diatur dari `/admin/storage`; file cache yatim (tanpa record DB) dibersihkan otomatis
  - Handles blob: URLs, `data:` URLs (canvas exports), referrer-restricted images, normal URLs
  - JSON return auto-replaces image URLs with proxy URLs
  - Applies to built-in page types **and** custom page types (image URLs inside custom response fields)
  - Canvas-based readers supported — see [canvas.md](canvas.md)
- **Admin panel** (Bootstrap 5) to manage websites and crawl configs
  - **Responsive** — sidebar jadi menu geser di HP, tabel jadi kartu, tombol Simpan menempel di bawah form panjang
  - Light/dark mode, toast notifikasi, peringatan perubahan belum disimpan, validasi JSON langsung (+ tombol Rapikan)
  - Halaman terpisah: Dashboard (ringkasan), Settings (crawl, akses API, keamanan, backup), Storage (disk)
  - **Uji API** dari form config — buka endpoint dengan URL contoh di tab baru
- **Disk housekeeping** (`/admin/storage`) — mencegah `ENOSPC: no space left on device`
  - Meter ruang **dan inode** untuk `/tmp` (profil browser) dan `data/` (database, cache gambar), peringatan di dashboard saat hampir penuh
  - Profil Chrome per crawl (`/tmp/crawlkomik-*`) dihapus setelah proses Chrome benar-benar keluar; sisa crash/restart dibersihkan saat start + tiap 30 menit
  - Tombol **Bersihkan sekarang**: profil sisa, gambar kedaluwarsa/lewat batas, file cache yatim, upload/backup sementara
  - Docker: log container dibatasi 3 × 10 MB (`docker-compose.yml`)
- **Custom page types** — admin can create custom page types beyond the 4 defaults, each with its own API endpoint `/api/custom/{name}`
  - Data extraction via Custom Response Fields (fully configurable from admin)
  - Full feature support: actions, wait, scroll, regex replace, custom JS, retry
  - Manage from dashboard: create/delete custom types, configure per website
- **Configurable CSS selectors** per page type per website
  - **Required selector toggle** — mark any selector as required; API returns error if result is empty
  - **`js:` prefix** — use JavaScript expressions instead of CSS selectors for complex extraction (e.g. finding table rows by label)
- **Pre-scrape actions**: click, wait, scroll, type, select, evaluate JS
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
- Runtime: Node.js 18+
- Framework: Express.js
- Browser: Puppeteer + puppeteer-extra-plugin-stealth
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

### Manual
```bash
npm install
npm start        # http://localhost:3000
npm run dev      # with auto-reload
```

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

WebSocket: `/admin/captcha/ws` — admin-only (same auth cookie), relays screencast frames & input for manual CAPTCHA takeover.

All crawl endpoints support optional `&html=true` — includes raw scraped HTML in the JSON response (useful for debugging selectors).

Example: `/api/katalog?website=mywebsite&url=https://example.com/latest/&html=true`

## Admin Panel
- URL: `http://localhost:3000/admin` (login required)
- Default password: `admin` — change from Settings → Keamanan after first login (dashboard shows a warning until you do)
- Works on phones: menu ☰ di kiri atas, CAPTCHA bisa di-solve dengan tap + kotak ketik
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
- Manual CAPTCHA takeover (`/admin/captcha`) — enable/disable, set timeout & notify webhook, watch live sessions, take over and solve challenges by hand
- **Cek Fingerprint** (`/admin/captcha` → button) — reports which bot signals are bad on this server, so a looping Cloudflare challenge can be diagnosed instead of guessed at
- Settings (`/admin/settings`) — max browsers, retry, headless, API key (+ generate), IP whitelist, password, 2FA, logout all devices
- Backup & restore database (Settings → Backup & Restore)
- Storage (`/admin/storage`) — disk & inode usage, cleanup, image cache retention / size cap

## Error `ENOSPC: no space left on device, mkdtemp '/tmp/crawlkomik-XXXXXX'`
Disk (atau inode) server penuh. Penyebab utama di versi lama: tiap crawl meninggalkan folder profil Chrome di `/tmp` — cleanup jalan saat koneksi CDP putus, padahal Chrome masih menulis `Local State`/`Preferences` saat shutdown, jadi penghapusan gagal diam-diam. Sekarang profil dihapus setelah proses Chrome keluar, dan sisa lama dibersihkan **otomatis saat server start** (lalu tiap 30 menit).

Setelah update: restart/rebuild (`docker compose up -d --build`), lalu cek `/admin/storage`. Kalau masih penuh, lihat bagian mana yang besar (cache gambar → turunkan retensi / pasang batas MB). Kalau pembuatan profil tetap gagal karena disk penuh, error API menyebutkan sisa ruang & inode.

Disk sudah 100% penuh sampai build gagal? Kosongkan dulu:
```bash
docker exec crawlkomik sh -c 'rm -rf /tmp/crawlkomik-*'   # profil sisa versi lama
docker compose down          # hapus container lama (sekaligus seluruh /tmp-nya)
docker image prune -f        # image lama dari build sebelumnya juga makan disk
docker compose up -d --build
```

## Reader pakai `<canvas>` (bukan `<img>`)
Sebagian reader menggambar halaman ke `<canvas>`, jadi tidak ada `src` yang bisa diambil selector — dan biasanya juga *virtualized* (halaman dihapus lagi setelah keluar layar).

Solusinya: snippet **Custom JavaScript** yang menangkap tiap halaman saat scroll, lalu selector diarahkan ke `#__canvas_extract img`. Hasilnya (`data:` URL) otomatis di-cache jadi file gambar asli, jadi JSON tetap ramping.

**Panduan lengkap + snippet siap pakai: [canvas.md](canvas.md)**

## Manual CAPTCHA Takeover
When a crawl hits a CAPTCHA that stealth can't pass, an admin can solve it live instead of the request just failing.

1. Enable it at `/admin/captcha` (**Enable manual takeover**). Set a timeout and, optionally, a Slack/Discord/Telegram webhook.
2. Trigger a crawl as usual. If a challenge is detected, the crawl pauses and the session appears on `/admin/captcha` as **waiting captcha** (and a webhook fires if configured).
3. Click **Ambil Alih** to open the live screen. Click and type directly on it — your mouse/keyboard go straight to the headless browser via CDP.
4. When the challenge clears it auto-continues, or press **Selesai** to continue immediately (**Gagal** to abort). The crawl then finishes normally and returns its JSON.
5. If nobody solves it within the timeout, the session is marked **failed** and the request errors out (honoring the configured retry count).

When the toggle is off, crawling behaves exactly as before (passive Cloudflare wait only) with no added overhead.

**Note on concurrency:** a session waiting for a manual solve keeps its browser open, so it occupies one of the `max_browsers` slots until it's solved or times out. If you expect several simultaneous challenges, raise **Max concurrent browsers** (Settings → Crawl & Browser) and/or keep the timeout modest so stuck sessions free their slot.

### Cloudflare masih loop setelah di-solve?
Challenge Cloudflare punya dua lapis: interaktif (checkbox) **dan** cek environment/fingerprint. Klik checkbox melewati lapis 1, tapi kalau lapis 2 menilai browsernya otomatis, halaman challenge muncul lagi — jadi masalahnya bukan di klik.

Mulai dari `/admin/captcha` → **Cek Fingerprint** untuk melihat sinyal mana yang bermasalah, lalu ikuti urutan perbaikannya (matikan Headless → jangan paksa UA → reuse `cf_clearance` atau residential proxy).

**Panduan lengkap, termasuk cara memakai ulang `cf_clearance` dari browser sendiri: [cloudflare.md](cloudflare.md)**

### Session cookies persist per website
Setelah challenge terlewati (otomatis atau manual), semua cookie clearance (mis. `cf_clearance`) diambil via CDP dan disimpan ke config website, lalu dipakai lagi pada crawl berikutnya. Ini hanya terjadi kalau crawl **selesai** — kalau loop terus, cookie tidak pernah tersimpan. `cf_clearance` terikat User-Agent + IP, jadi keduanya harus stabil.

## Folder Structure
```
src/
  app.js              # Entry point
  models/database.js  # SQLite schema + CRUD
  services/browser.js # Puppeteer + stealth + proxy (+ manual CAPTCHA hook)
  services/profile-dirs.js # Chrome profile dirs in /tmp: create, delete after exit, sweep leftovers
  services/storage.js # Disk/inode report + cleanup jobs (Storage page)
  services/crawler.js    # Crawl logic per page type
  services/image-proxy.js # Image cache/proxy service
  services/captcha-detector.js # Detect CF/Turnstile/reCAPTCHA/hCaptcha/text challenges
  services/captcha-registry.js # In-memory crawl-session registry (status per session)
  services/captcha-takeover.js # CDP screencast + mouse/keyboard input relay
  services/captcha-ws.js  # WebSocket relay (dashboard <-> Puppeteer)
  services/notifier.js    # Optional Slack/Telegram webhook on manual-solve needed
  services/fingerprint-check.js # Bot-signal self-check for the crawl browser
  routes/api.js       # API endpoints
  middleware/auth.js  # Login auth middleware (+ WS handshake auth)
  routes/admin.js     # Admin panel routes
  views/              # EJS templates
  public/             # admin.css + admin.js (layout, theme, toasts, JSON check)
json-return/          # Expected JSON format examples
canvas.md             # Panduan scraping reader berbasis <canvas>
cloudflare.md         # Panduan menembus Cloudflare (+ reuse cf_clearance)
```
