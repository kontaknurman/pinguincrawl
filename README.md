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
- **Proxy & rotate proxy** — proxies (HTTP/HTTPS/SOCKS5 with login, `host:port:user:pass` lists) are kept once in Settings → Proxy, with a **global default**; each website picks from a select: *Default global*, *no proxy*, or one or more proxies / WireGuard configs in its own order. Several rotate (round-robin / random / failover), a failing one is swapped for the next within the same request and rested for 5 minutes — see [Proxy & rotasi proxy](#proxy--rotasi-proxy)
- **WireGuard (VPN)** as a second kind of proxy — configs (`.conf`) are added once in Settings and picked in the same select (mixable with proxies). Userspace via [wireproxy](https://github.com/whyvl/wireproxy): no root, no NET_ADMIN, ~12 MB per tunnel, started on demand — see [WireGuard (VPN)](#wireguard-vpn)
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
- **Admin login** with several admins, each with their own username + password (scrypt hash, signed cookie) — see [Admin & login](#admin--login)
  - First start: `admin` / `admin` (or `ADMIN_PASSWORD`), and the first login has to choose a new password
  - **Admins** page: add admins (temporary password, replaced at their first login), reset a forgotten password, reset 2FA, delete — each confirmed with your own password
  - **Google Authenticator (TOTP 2FA)** per admin — setup from Settings, QR code scan, 6-digit code on login
  - Brute-force brake: 10 failed attempts from one IP → that IP waits 15 minutes
  - **Logout from all devices** — ends every session of your own account
- **Clear image cache** — manually purge all cached images from the Storage page
- **API request logs** (`/admin/logs`) — every API hit recorded with status, duration, error & response body
  - Filter by status/endpoint, stats cards (total, errors, today)
  - **Auto-cleanup**: logs older than 2 weeks (14 days) deleted automatically — runs at startup + every 12 hours
  - Manual delete buttons: all logs, error logs only, logs older than 2 weeks
- **SQLite database** for config storage (zero setup)
  - **Backup & Restore** — download/upload database from admin dashboard
  - **Per website** too — the same `.db` format with just that website; restore it over the website, or bring back a deleted one — see [Backup & restore](#backup--restore)

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

### Custom port
One variable, `PORT`, sets the port the app listens on **inside** the container and **both sides** of the mapping — `PORT=6000` gives `6000:6000`:
```bash
echo "PORT=6000" > .env         # or: cp .env.example .env and edit it
docker compose up -d --build    # → 0.0.0.0:6000->6000/tcp, app on http://localhost:6000
```
- Without compose: `docker run -e PORT=6000 -p 6000:6000 <image>`. Manual: `PORT=6000 npm start`.
- `--build` makes the image's `EXPOSE` follow the new port too (hosting panels such as Coolify/Dokploy read it); the app itself already follows `PORT` at runtime.
- Running crawlkomik on the same server? It also defaults to 3000 — give PinguinCrawl another `PORT`.

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
| `PORT` | `3000` | HTTP port the app listens on (in Docker: inside the container, and both sides of the compose mapping) |
| `ADMIN_PASSWORD` | – | password of the first admin (`admin`, min. 8 characters) — only read while the database has no admin yet. Without it the first login is `admin`/`admin` |
| `LIGHTPANDA_EXECUTABLE_PATH` | `lightpanda` on `PATH` | Lightpanda binary |
| `MAX_BROWSERS` | `3` | concurrent browsers when not set in Settings |
| `LIGHTPANDA_DISABLE_TELEMETRY` | set in Docker | Lightpanda sends usage telemetry unless this is set (to any value). The Docker image sets it; remove the `ENV` line to allow telemetry |
| `LIGHTPANDA_DISABLE_CORE_DUMP` | set in Docker | no core dumps when the browser crashes |
| `WIREPROXY_EXECUTABLE_PATH` | `wireproxy` on `PATH` | wireproxy binary for WireGuard configs (in the Docker image) |
| `WIREGUARD_IDLE_SECONDS` | `300` | an unused WireGuard tunnel stops after this long; the next crawl starts it again (one handshake) |
| `PROXY_TEST_URL` | `https://example.com/` | what **Test** in Settings → Proxy opens through a proxy. An address echo such as `https://api.ipify.org/` also shows the proxy's exit IP |
| `TRUST_PROXY` | – | `1` when behind nginx/Caddy — the login brake then counts each visitor's IP instead of the proxy's. Never without such a proxy (clients could fake their IP) |

## Pindah dari crawlkomik
1. crawlkomik: Settings → Backup & Restore → **Download Backup**.
2. PinguinCrawl: Settings → Backup & Restore → **Restore** file tadi. (Database PinguinCrawl ada di `data/pinguincrawl.db`, jadi menyalin folder `data/` crawlkomik saja tidak cukup.) Setelahnya login dengan username `admin` + password crawlkomik (2FA ikut pindah).
3. Website yang field **User Agent**-nya berisi `Mozilla/...`: kosongkan — Lightpanda mengabaikannya.
4. Jalankan **Cek Lightpanda** (Settings) per website. Yang terdeteksi memasang challenge tetap di crawlkomik.

Setelan headless, CAPTCHA takeover (timeout, webhook) dan fingerprint check sengaja tidak ada lagi.

## Admin & login
- **Login** pakai username + password. Instalasi baru: `admin` / `admin`, dan login pertama langsung diminta membuat password baru. Panel langsung terbuka ke internet? Set `ADMIN_PASSWORD` (min. 8 karakter) sebelum start pertama supaya tidak ada jeda dengan password default.
- **Upgrade / restore** dari versi lama atau backup crawlkomik: password lama tetap berlaku dengan username `admin`, 2FA ikut.
- **Menambah admin**: menu **Admins** → *Tambah admin* — isi username, password sementara (tombol acak di sebelahnya membuatkan satu), dan password kamu sendiri. Berikan username + password sementara itu ke admin baru; saat login pertama dia wajib menggantinya, jadi kamu tidak tahu password akhirnya.
- **Semua admin setara** — akses penuh, termasuk menambah, me-reset, dan menghapus admin lain. Akun sendiri tidak bisa dihapus atau di-reset dari halaman Admins (password, 2FA, dan sesi kamu ada di Settings → Keamanan), jadi selalu tersisa minimal satu admin.
- **Lupa password / HP authenticator hilang**: admin lain membuka Admins → *Kelola* → **Reset password** (dia langsung keluar dari semua perangkat) atau **Reset 2FA**.
- **Satu-satunya admin terkunci**: jalankan di server — admin itu mendapat password sementara, keluar dari semua perangkat, dan 2FA-nya dimatikan:
  ```bash
  docker compose exec -u pinguincrawl pinguincrawl node src/reset-admin.js admin   # Docker
  npm run reset-admin -- admin                                                    # manual
  ```
  Tanpa username, perintah itu menampilkan daftar admin.
- **Keamanan**: password minimal 8 karakter (hash scrypt), cookie sesi `HttpOnly` + `SameSite=Strict` (+ `Secure` lewat HTTPS) berlaku 24 jam. Ganti password atau **Logout All Devices** hanya mengakhiri sesi akun itu; admin yang dihapus langsung keluar. Menambah/me-reset/menghapus admin, ganti password, dan menyalakan/mematikan 2FA meminta password kamu lagi. 10 percobaan gagal dari satu IP (IPv6: satu /64) dalam 15 menit → IP itu ditolak sampai 15 menit lewat (atau restart app); di belakang nginx/Caddy set `TRUST_PROXY=1`, kalau tidak semua pengunjung terhitung satu IP.
- File backup berisi akun admin (hash password + secret 2FA) — simpan di tempat aman.

## Backup & restore
Dua jenis backup, keduanya file SQLite `.db` dengan tabel yang sama:
- **Lengkap** — Settings → Backup & Restore: seluruh database (semua website, settings, akun admin, log).
  Restore mengganti semuanya.
- **Per website** — halaman website → **Backup & Restore** (atau ikon unduh di Dashboard): hanya website
  itu — pengaturan (termasuk cookie dan proxy yang dipilihnya, lengkap dengan alamat + login), page config,
  dan custom page type. Akun admin, API key, settings lain (termasuk default global proxy), log, dan cache
  gambar tidak ikut; config WireGuard hanya namanya. Nama file `pinguincrawl-backup-<website>-<waktu>.db`.
  Saat di-restore, proxy-nya masuk ke Settings → Proxy: yang alamat + login-nya sama dipakai ulang, begitu
  juga entri untuk akun yang sama (user + alamat sama, hanya password beda — yang di server ini dianggap terbaru);
  nama yang sudah dipakai proxy lain diberi akhiran `-2`. Toast restore menyebut berapa entri baru dibuat.

Restore per website:
- **Di halaman website**: upload backup website itu, atau backup lengkap — website dengan nama yang sama
  diambil darinya (backup crawlkomik juga bisa). Pengaturan, page config, dan custom page type website itu
  diganti; website lain, cache gambar, dan log tidak berubah. Sebelumnya seluruh database disalin ke
  `data/pinguincrawl.db.pre-restore`, sama seperti restore lengkap.
- **Website yang sudah dihapus / dari server lain**: Add Website → *Restore dari backup*. Dari backup
  lengkap, isi nama website yang mau diambil. Website yang namanya sudah ada di-restore dari halamannya.
- Backup per website tidak bisa di-restore lewat Settings (akan mengganti seluruh database dengan satu
  website itu saja) — ditolak dengan pesan jelas.

## Cara kerja browser
- Tiap crawl menjalankan `lightpanda serve --port 0` sendiri, Puppeteer (`puppeteer-core`) terhubung lewat CDP, lalu prosesnya dihentikan begitu crawl selesai. Proxy, timezone, dan sub-resource yang dimuat adalah opsi per proses di Lightpanda, karena itu satu proses per crawl.
- Stylesheet selalu dimuat (computed style asli). Gambar `<img>` dimuat kecuali **Block Image Loading** aktif — dan Lightpanda hanya membaca ±16 KB pertama tiap gambar, cukup untuk event `load`/`error`.
- Cache gambar metode **Browser**: karena tidak ada gambar utuh yang bisa ditangkap, gambar diunduh dengan `fetch()` di dalam halaman. Gambar CDN beda origin, jadi crawl yang memakai metode ini berjalan dengan CORS dimatikan — dan **jaringan privat diblokir** (localhost, LAN, metadata cloud) supaya script halaman tidak bisa membaca layanan internal. Proxy di alamat privat (squid lokal, container VPN) otomatis dikecualikan.
- Proses Lightpanda yang tertinggal karena Node di-kill paksa (OOM, `SIGKILL`) dibunuh saat server start dan tiap 30 menit.

## Proxy & rotasi proxy
Semua proxy disimpan sekali di **Settings → Proxy**, lalu tiap website memilihnya — tidak ada lagi daftar
proxy per website.
1. **Settings → Proxy → Tambah proxy**: satu alamat per baris (boleh banyak sekaligus). Nama otomatis dari
   host-port (`1.2.3.4-8080`), atau isi *Nama* — untuk beberapa baris jadi awalan (`sg-1`, `sg-2`, …).
   Proxy yang sama (alamat + login sama) tidak masuk dua kali.
   ```
   http://user:pass@1.2.3.4:8080
   socks5://user:pass@5.6.7.8:1080
   9.9.9.9:3128:user:pass
   ```
2. **Default global** (Settings → Proxy): tanpa proxy, atau satu / beberapa proxy dan config WireGuard +
   rotasinya. Dipakai semua website yang memilih *Default global* — termasuk website baru.
3. **Form website → Proxy / VPN** (select): *Default global*, *Tanpa proxy — koneksi langsung*, atau satu
   proxy / config WireGuard. **Tambah proxy / VPN lain** menambah baris berikutnya (nomor 2, 3, …) untuk
   rotasi atau cadangan, lalu pilih *Rotasi*.

- **Format**: `http://`, `https://`, `socks4://`, `socks5://` (DNS ikut di-resolve proxy), tanpa skema = HTTP, dan `host:port:user:pass` (format daftar dari penyedia proxy — password boleh berisi `:` atau `@`). Di format URL, karakter khusus ditulis ter-encode (`@` → `%40`). Baris kosong dan baris berawalan `#` diabaikan; baris yang salah ditolak dengan nomor barisnya.
- **Edit** proxy (alamat, login, nama) cukup di Settings → Proxy — semua website yang memakainya ikut, termasuk ganti nama. Proxy yang masih dipakai website atau default global tidak bisa dihapus.
- **Rotasi**: **Bergiliran** — tiap crawl yang berikutnya; **Acak**; **Cadangan** — selalu nomor 1, sisanya hanya saat itu gagal (urutan = urutan baris di select). Proxy dan config WireGuard boleh dicampur.
- **Proxy gagal** (tidak bisa dihubungi, login salah, terlalu lambat) langsung diganti yang lain di request yang sama — maks. 3 kali, tidak memakai jatah *Retry count* — lalu **diistirahatkan 5 menit**. Kalau semua sedang istirahat, semuanya tetap dicoba. Error API menyebut proxy-nya (tanpa password), mis. `CouldntConnect at https://… [proxy sg-1 (http://1.2.3.4:8080)]`.
- **Status**: Settings → Proxy dan halaman edit website menampilkan status tiap proxy (OK / gagal · istirahat / belum dipakai). **Test** (Settings → Proxy) membuka `PROXY_TEST_URL` lewat proxy itu dengan Lightpanda, persis seperti crawl; **Cek semua** di halaman website (atau Settings → Cek Lightpanda per website) membuka base URL lewat tiap proxy-nya. Status disimpan di memori, mulai dari nol setelah restart.
- **Yang lewat proxy**: halaman, semua request JavaScript-nya, dan cache gambar metode **Browser**. **Tidak** lewat proxy: metode **Node.js HTTP**, **Lazy Proxy**, dan mode HTTP biasa (JS off). Page config bisa mematikan proxy per page type (**Force OFF**) atau memaksanya (**Force ON** — di website yang memilih *Tanpa proxy*, memakai default global).
- **Upgrade dari versi lama** (atau restore backup lama / crawlkomik): daftar proxy tiap website otomatis dipindah ke Settings → Proxy dan website itu memilihnya dengan urutan + rotasi yang sama; pilihan WireGuard ikut pindah. Proxy yang sama (alamat + login sama, walau ditulis beda format) jadi satu entri. Website tanpa proxy jadi *Default global* (default awalnya: tanpa proxy), jadi crawl tetap sama persis — tapi begitu default global diisi, website itu ikut memakainya (bagian Default global menyebut website mana saja); pilih *Tanpa proxy* untuk yang harus tetap langsung. Daftar lama tetap tersimpan di database, jadi kalau kembali ke versi sebelumnya, website memakai daftar lamanya lagi.
- Kredensial proxy diteruskan ke Lightpanda di argumen `--http-proxy` — satu-satunya cara yang jalan untuk situs HTTPS (tunnel CONNECT) dan SOCKS. Artinya user lain di mesin yang sama bisa melihatnya lewat `ps`; di dalam container Docker hal ini tidak berlaku.

## WireGuard (VPN)
Jenis proxy kedua: crawl lewat VPN WireGuard (Mullvad, ProtonVPN, Surfshark, WARP, server sendiri, …).
1. **Settings → WireGuard**: upload file `.conf` dari penyedia VPN (boleh banyak sekaligus — nama config = nama file) atau tempel isinya dan beri nama. Config dicek saat disimpan (kunci, Address, Endpoint, AllowedIPs; juga oleh `wireproxy -n`).
2. **Form website → Proxy / VPN**: pilih config-nya di select (grup *WireGuard (VPN)*), atau jadikan **default global** di Settings → Proxy. Lebih dari satu (juga campur dengan proxy biasa) dirotasi sama seperti proxy (Bergiliran / Acak / Cadangan), dengan urutan yang kamu tentukan.
3. **Test** di daftar config (Settings) menyalakan tunnel dan menunggu handshake; **Cek semua** di halaman website membuka base URL lewat tiap config.

Cara kerjanya — ringan dan tanpa hak khusus:
- Tiap config dijalankan sebagai satu proses [wireproxy](https://github.com/whyvl/wireproxy) (WireGuard userspace + SOCKS5 di `127.0.0.1`, ±12 MB RAM), **hanya saat dipakai**: dinyalakan oleh crawl pertama, dipakai bersama semua crawl dan website yang memilih config itu, dan **berhenti sendiri setelah 5 menit** tidak dipakai (`WIREGUARD_IDLE_SECONDS`). Tidak butuh root, `NET_ADMIN`, modul kernel, atau `--cap-add` di Docker, dan lalu lintas container lain tidak terpengaruh.
- Lightpanda memakai tunnel itu sebagai proxy SOCKS5 — halaman, semua request-nya, dan **DNS** lewat VPN (DNS dari config; tanpa `DNS`, 1.1.1.1/9.9.9.9 lewat tunnel).
- Tunnel dianggap siap setelah **handshake WireGuard berhasil** — kunci salah atau server mati gagal dalam 10 detik dengan pesan jelas, lalu config berikutnya dicoba dan yang gagal diistirahatkan 5 menit (sama seperti proxy). Tunnel yang sudah jalan tapi tidak handshake lagi > 4 menit dinyalakan ulang.
- Private key tidak pernah ditulis ke disk: config diberikan ke wireproxy lewat file `0600` di `/dev/shm` (RAM) yang langsung dihapus setelah dibaca. `PostUp`/`PreDown` dan opsi wg-quick lain diabaikan — tidak ada perintah yang dijalankan.
- Proses yang tertinggal karena Node di-kill paksa dibunuh saat server start dan tiap 30 menit.

Catatan:
- Sama seperti proxy, yang lewat VPN hanya Lightpanda (dan cache gambar metode **Browser**); mode HTTP biasa (JS off), metode **Node.js HTTP**, dan **Lazy Proxy** tidak.
- Jangan pakai config yang sama di perangkat lain **pada waktu yang sama** — satu private key = satu peer; server VPN akan bolak-balik di antara keduanya dan koneksi tersendat.
- Server harus boleh mengirim UDP ke `Endpoint` (firewall/hosting yang memblokir UDP keluar → handshake gagal).
- Backup lengkap ikut menyimpan config (termasuk private key). Backup per website hanya menyimpan nama config yang dipilih; di server tujuan config dengan nama sama harus ada.
- Instalasi manual: unduh `wireproxy_linux_amd64.tar.gz` (atau `arm64`) dari [rilis wireproxy](https://github.com/whyvl/wireproxy/releases), ekstrak `wireproxy` ke `PATH` — atau set `WIREPROXY_EXECUTABLE_PATH`. Image Docker sudah memasangnya (versi dikunci + checksum).

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
- First login: `admin` / `admin` (or `ADMIN_PASSWORD`) — you are asked to choose a new password right away
- Admins (`/admin/users`) — add admins, reset password / 2FA, delete
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
- Proxy / VPN select per website (global default, no proxy, or proxies / WireGuard configs in order + rotation mode), with per-proxy status and "Cek semua"
- View API logs (`/admin/logs`) — filter, stats, delete all/errors/old; logs >2 weeks auto-deleted
- Settings (`/admin/settings`) — max browsers, retry, challenge detection, **Cek Lightpanda**, API key (+ generate), IP whitelist, proxies (+ test) and the global default proxy, WireGuard configs, your own password, 2FA, logout all devices
- Backup & restore database (Settings → Backup & Restore), or one website (its page → Backup & Restore)
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
  reset-admin.js      # CLI: temporary password for a locked-out admin
  models/database.js  # SQLite schema + CRUD
  services/lightpanda.js  # Lightpanda processes: start (port 0), stop, sweep orphans, version
  services/browser.js # Puppeteer-core over CDP: per-crawl browser, page setup, actions, challenge check
  services/browser-check.js # "Cek Lightpanda" self-check (per proxy for a website)
  services/proxy-pool.js # What a website crawls through (own choice / global default), rotation (round-robin/random/failover), cooldown of failing proxies
  services/proxy-refs.js # How websites refer to Settings proxies and WireGuard configs ("proxy:<name>", "wireguard:<name>", default, none)
  services/storage.js # Disk/inode report + cleanup jobs (Storage page)
  services/login-guard.js # Brute-force brake for login and password confirmations
  services/backup.js  # Backup files: website backup (same .db format as the full one), website restore, pre-restore snapshot
  services/wireguard.js # WireGuard configs: parse/validate, one on-demand wireproxy (SOCKS5) per config, handshake check, idle stop
  services/crawler.js    # Crawl logic per page type
  services/image-proxy.js # Image cache/proxy service
  services/captcha-detector.js # Detect CF/Turnstile/reCAPTCHA/hCaptcha/text challenges
  routes/api.js       # API endpoints
  middleware/auth.js  # Login sessions: signed cookies per admin, 2FA step, forced password change
  routes/admin.js     # Admin panel routes
  views/              # EJS templates
  public/             # admin.css + admin.js (layout, theme, toasts, JSON check)
json-return/          # Expected JSON format examples
```
