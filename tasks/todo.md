# Task: Ganti browser crawler dari Chrome ke Lightpanda (repo baru pinguincrawl)

## Permintaan (user)
"crawlkomik repo ini gunanya untuk crawl komik, tapi saya ingin mengganti browser yang dipakai dari
chrome ke https://github.com/lightpanda-io/browser pada kontaknurman/pinguincrawl repo, hanya edit
pinguincrawl repo"

## Temuan (diuji langsung dengan Lightpanda 1.0.2 + puppeteer-core 25)
- Lightpanda adalah **server CDP** (`lightpanda serve`), bukan binary yang bisa di-`launch` Puppeteer.
  Satu koneksi = satu page. Start ±20 ms, puncak memori ±25 MB per proses.
- Jalan: goto/networkidle2, evaluate, XHR/fetch, cookies (`Network.getAllCookies`), extra headers,
  `evaluateOnNewDocument` (localStorage), click/type/select, request interception, proxy + `page.authenticate`.
- **`Emulation.setTimezoneOverride` diterima tapi tidak berefek** (stub) → timezone harus lewat flag
  `--timezone` saat proses start. Proxy & sub-resource juga opsi per proses → satu proses per crawl.
- **UA berisi "Mozilla" ditolak** (diam-diam) baik lewat `setUserAgent` maupun extra headers — kebijakan
  Lightpanda, tidak diakali. Stealth plugin tidak relevan lagi.
- `<img>` hanya dibaca ±16 KB (juga lewat Fetch interception tahap Response) → capture gambar ala Chrome
  menghasilkan gambar terpotong. `fetch()` di halaman membaca utuh, tapi CDN beda origin kena CORS
  → `--disable-features cors` + `--block-private-networks` (+ kecualikan IP proxy).
- Tidak ada `Page.startScreencast`, screenshot hanya rendering teks, canvas stub, tanpa WebGL →
  manual CAPTCHA takeover, fingerprint check, headful, canvas reader tidak mungkin.
- Binary Linux butuh glibc → image Docker pindah dari Alpine ke Debian slim.

## Plan
- [x] 1. Import snapshot crawlkomik (2562a1a) sebagai commit pertama
- [x] 2. `services/lightpanda.js`: spawn `serve --port 0`, baca alamat dari log, stop SIGTERM→SIGKILL,
       kill anak saat Node exit, sweep proses yatim (marker env `PINGUINCRAWL_OWNER_PID`)
- [x] 3. `browser.js`: puppeteer-core `connect`, opsi per proses (proxy, timezone, gambar, CORS),
       warning UA Mozilla, deteksi challenge → error jelas tanpa retry
- [x] 4. Cache gambar metode browser via `fetch()` di halaman; buang intercept
- [x] 5. Hapus takeover CAPTCHA (WS/registry/notifier), profil Chrome, fingerprint check, setelan
       headless; tambah toggle deteksi challenge + **Cek Lightpanda**
- [x] 6. Dockerfile Debian + binary Lightpanda (pin versi), package.json, README, branding PinguinCrawl
- [x] 7. Verifikasi end-to-end

## Review
E2E **63/63** (app asli + Lightpanda asli, situs manga tiruan + CDN hotlink-protected + proxy auth,
semua di scratchpad, tidak masuk repo):
- katalog JS-rendered + cookie + custom header + localStorage + UA website + proxy auth (407 → retry)
- detail (cover relatif di-cache utuh), chapter list dari XHR, chapter: gambar CDN beda origin 120 KB
  utuh (bukan 16 KB), lazy `data-src`, `data:`, `blob:`; Referer lolos hotlink check
- custom page type: gambar custom field, timezone `Asia/Jakarta`, UA website
- challenge Cloudflare: error jelas, 1 request walau retry_count=2, ±11.6 s; deteksi off → diproses biasa
- metode node & lazy proxy, block images (browser tidak me-request `<img>`), simple HTTP
- 6 crawl paralel dengan max_browsers=2, 0 proses tersisa; SIGKILL app → proses yatim → dibunuh saat
  start berikutnya; SIGTERM saat crawl → 0 proses tersisa
- binary hilang → error API jelas, warning startup, alert di Settings
- Situs nyata lewat proxy (Wikipedia): gambar upload.wikimedia.org ter-cache utuh (46 KB)
