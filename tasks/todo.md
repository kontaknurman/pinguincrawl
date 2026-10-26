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

---

# Lanjutan: port kustom, proxy, rotate proxy

## Permintaan (user)
"setelah selesai bantu juga agar support custom port, misalnya 6000:6000, bukan 6000:80 dan pastikan
fitur proxy jalan dengan baik serta tambahkan fitur rotate proxy setelahnya."

## Temuan
- Port: compose memakai `"3000:3000"` + `PORT=3000` tetap — ganti port berarti mengedit 3 tempat.
- **Proxy dengan login + situs HTTPS gagal total** (`CouldntConnect`): Lightpanda menjawab 407 lewat
  `page.authenticate()` hanya untuk request HTTP biasa; tunnel CONNECT (semua situs HTTPS) dan login
  SOCKS tidak pernah dapat kredensial. Ketahuan setelah diuji ke target HTTPS — uji awal hanya HTTP.
- Format `host:port:user:pass` (format daftar penyedia proxy) tidak dikenali; dashboard bisa
  membocorkan password di format itu (regex hanya mengenal `user:pass@`).

## Plan
- [x] 1. `PORT` tunggal: build arg + ENV + `EXPOSE`, compose `${PORT}:${PORT}`, `.env.example`
- [x] 2. Kredensial di URL `--http-proxy` (tanpa `page.authenticate`), `parseProxy` baru (http/https/
       socks4/socks5→socks5h, `host:port:user:pass`, validasi), error menyebut proxy tanpa password,
       407 → error jelas
- [x] 3. `services/proxy-pool.js`: daftar proxy, rotasi bergiliran/acak/cadangan, ganti proxy dalam
       request yang sama (maks. 3, tidak memakai retry), istirahat 5 menit untuk proxy gagal
- [x] 4. Form website (textarea + mode rotasi + status per proxy), dashboard, Cek Lightpanda per proxy
- [x] 5. Verifikasi + README

## Review
- Docker (daemon lokal di sandbox): image dibangun dengan `PORT=6000` → `EXPOSE 6000`, container
  `-p 6000:6000` jalan sebagai user non-root, Cek Lightpanda di dalam container bersih; `-e PORT=7000
  -p 7000:7000` dan compose dengan `.env` `PORT=6000` → `0.0.0.0:6000->6000/tcp`.
- Matriks proxy (kode asli, Lightpanda asli, proxy lokal yang meneruskan ke internet): HTTP tanpa/
  dengan login ke HTTPS, SOCKS5 tanpa/dengan login, `host:port:user:pass` (password berisi `@` dan
  `:`), cache gambar metode Browser lewat HTTP+login dan SOCKS5+login (Wikipedia, 46 KB utuh),
  password salah / proxy mati → `proxyFailed` + `[proxy …]` tanpa password, 407 → pesan jelas.
- E2E rotasi **21/21**: bergiliran A→B→C dengan proxy mati dilewati (1x coba lalu istirahat), 8/8
  crawl sukses; acak menyebar; cadangan tetap di A, A dimatikan → B; Cek per proxy; semua mati →
  "All 4 proxies tried failed — last: …"; Force OFF tetap langsung; 0 kredensial di log/HTML.
- E2E utama diulang: **63/63**.
