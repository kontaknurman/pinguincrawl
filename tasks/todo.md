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
- UI di browser sungguhan (Playwright, 1440px + 390px) **47/47**: login, form website (baris proxy
  salah → error + input tetap), status proxy, badge dashboard tanpa password, Cek Lightpanda per proxy
  di tab baru, tanpa error JS / horizontal overflow. Menemukan: di HP toast error (tidak hilang
  sendiri) menutupi tombol Save — sudah ada sejak crawlkomik; toast kini di atas bar Save.
- Migrasi **9/9**: DB buatan kode crawlkomik → Restore → login password lama, kolom
  `proxy_rotation` ditambahkan, crawl lewat proxy lama berhasil.

---

# Lanjutan: login multi-admin

## Permintaan (user)
"bisa buat user login simpel dan aman agar bisa menambahkan admin lain"

## Temuan
- Login lama: satu password global di `settings.admin_password` (+ 2FA global), "logout semua perangkat"
  me-reset secret sesi → semua orang ikut keluar. Tidak ada username, min. password 4 karakter, tidak
  ada rem brute-force.
- Password default `admin` hanya diperingatkan (dashboard), tidak dipaksa diganti.

## Plan
- [x] 1. Tabel `users` (username, hash scrypt, `must_change_password`, 2FA per user, `session_version`);
       migrasi otomatis dari `admin_password`/2FA lama (upgrade & restore backup crawlkomik) → user
       `admin`; instalasi baru: `ADMIN_PASSWORD` atau `admin`/`admin` yang wajib diganti
- [x] 2. Cookie sesi berisi user id + `session_version` (ganti password / logout semua / hapus user hanya
       memutus akun itu); halaman ganti password paksa; re-auth password sendiri untuk aksi akun
- [x] 3. Rem brute-force per IP (IPv6 per /64): 10 gagal / 15 menit, termasuk kode 2FA & re-auth;
       username tak dikenal tetap memakan waktu scrypt (tidak bisa ditebak dari waktu respons)
- [x] 4. Halaman Admins (tambah dengan password sementara + tombol acak, reset password, reset 2FA,
       hapus; akun sendiri tidak bisa dihapus/di-reset), Settings → keamanan akun sendiri, sidebar
- [x] 5. `src/reset-admin.js` untuk admin terakhir yang terkunci; README, `.env.example`, compose
- [x] 6. Verifikasi

## Review
- E2E auth **95/95** (app asli, DB baru tiap fase): admin/admin → wajib ganti (semua halaman & aksi
  diarahkan ke form), min. 8 karakter, konfirmasi, beda dari password lama & username; sesi lama putus
  setelah ganti; tambah admin (username dinormalisasi, duplikat, re-auth salah); admin setara tapi tidak
  bisa hapus/reset diri sendiri; 2FA per admin (perlu password, kode salah, secret tidak bisa ditukar
  saat aktif, token 2FA-pending tidak berlaku sebagai sesi, kode tanpa langkah password ditolak); reset
  2FA/password oleh admin lain (reset password memutus semua sesi target); logout semua hanya akun
  sendiri; hapus → sesi mati, id tidak dipakai ulang; cookie diubah/tanda tangan rusak ditolak; waktu
  login username tak dikenal ≈ password salah (40 vs 41 ms); rem 10x → 429 (juga untuk re-auth & kode
  2FA, login sukses me-reset, IPv6 satu /64, X-Forwarded-For palsu tanpa `TRUST_PROXY` tidak lolos);
  cookie `Secure` di balik proxy HTTPS; `reset-admin` saat app jalan (sesi target langsung putus);
  `ADMIN_PASSWORD` (dan yang < 8 karakter diabaikan + warning); upgrade dari versi sebelumnya dengan
  password + 2FA lama, dan dengan password default; restore backup format baru.
- Body form aneh (`password[]=…`, `password[x]=…`) **12/12** ditolak rapi tanpa 500.
- UI di browser sungguhan (Playwright, 1440px + 390px) **46/46**: login (fokus, username tetap setelah
  salah), halaman ganti password paksa, Admins (generate + copy ke clipboard, error, tambah, kelola,
  reset, hapus dengan konfirmasi), Settings, tanpa error JS / overflow. Menemukan: di HP toast error
  menutupi tombol "Add Admin" di dasar halaman — sekarang halaman menyisakan ruang setinggi toast.
- Suite lama diulang dengan Lightpanda 1.0.2: E2E **63/63**, rotasi **21/21**, UI **47/47**, migrasi
  crawlkomik **11/11** (kini juga 2FA lama ikut pindah).
- Docker (image dibangun ulang, `PORT=6000`): `ADMIN_PASSWORD` dari env, tambah admin, `docker exec -u
  pinguincrawl pinguincrawl node src/reset-admin.js admin` → sesi lama putus, password sementara
  memaksa ganti; file di `/app/data` tetap milik user `pinguincrawl`.

---

# Lanjutan: backup & restore per website

## Permintaan (user)
"Tambahkan fitur backup dan restore per web, samakan formatnya dengan backup yg sudah ada"

## Temuan
- Backup lengkap = `VACUUM INTO` seluruh database (`.db` SQLite); restore lengkap mengganti file
  database (termasuk akun admin dan settings).
- `websites.name` bebas (boleh `/`, spasi, kutip) → nama file unduhan harus disaring.
- Urutan kolom `websites` berbeda antar database (tergantung urutan migrasi) → salin per nama kolom.
- Backup per website yang ter-upload ke restore lengkap akan mengganti seluruh database dengan satu
  website tanpa admin → harus ditolak.

## Plan
- [x] 1. `services/backup.js`: ekspor satu website ke file baru dengan skema persis milik database
       (semua tabel + index, isi hanya baris website itu, page config, custom page type) + penanda
       `settings.backup_scope = website`; tanpa admin/API key/session secret/log/cache
- [x] 2. Baca website dari backup per website atau backup lengkap (dicocokkan per nama), kolom yang
       tidak ada → default, kolom tak dikenal diabaikan; file dibuka read-only + `trusted_schema=OFF`
- [x] 3. Restore di halaman website (ganti pengaturan + page config + custom type, id tetap, snapshot
       `.pre-restore` dulu); restore di Add Website untuk website terhapus / dari server lain
- [x] 4. Restore lengkap menolak backup per website; tombol unduh di Dashboard; README
- [x] 5. Verifikasi

## Review
- E2E **46/46** (app asli): file unduhan bernama `pinguincrawl-backup-<website>-<waktu>.db`, tabel/
  index/kolom identik dengan backup lengkap, hanya baris website itu, settings hanya penanda, tanpa
  admin/log/cache, byte file tidak memuat API key / session secret / hash password / website lain,
  file mandiri (tanpa `-wal`), tidak ada file sementara tertinggal; restore setelah website diubah →
  pengaturan, page config, custom type kembali (id sama), website lain + cache + log + API key + admin
  utuh, `.pre-restore` berisi keadaan sebelum restore, crawl jalan dengan config hasil restore; backup
  website lain ditolak; restore dari backup lengkap (dicocokkan nama) dan pesan jelas kalau tidak ada;
  restore lengkap menolak backup per website (database tidak berubah); Add Website: website terhapus
  kembali (id baru), duplikat ditolak, backup lengkap minta nama / nama salah / nama dari backup
  lengkap; file sampah/kosong/`websites` berupa VIEW ditolak di ketiga form; tanpa file; backup dengan
  kolom tambahan (versi lebih baru); backup crawlkomik asli (kolom `proxy_rotation` tidak ada →
  default, lalu crawl jalan) + impor via Add Website; nama website aneh → nama file aman.
- UI di browser sungguhan (Playwright, 1440px + 390px) **36/36**: download dari halaman website dan
  Dashboard, ubah → restore dengan konfirmasi → nilai lama kembali, error website lain di bagian
  Backup (ter-scroll, tombol tidak tertutup toast), hapus → Add Website → restore, tanpa error JS /
  overflow.
- Suite lain diulang: E2E **63/63**, rotasi **21/21**, migrasi **11/11**, auth **95/95**, body aneh
  **12/12**, UI **47/47**, UI auth **46/46**.

---

# Lanjutan: WireGuard sebagai jenis proxy kedua

## Permintaan (user)
"buat tipe proxy kedua yaitu memakai wireguard vpn config, per website bisa memilih config yang mau
dipakai dari sumber yang di input di setting. pastikan ringan dan berfungsi"

## Temuan (diuji dengan WireGuard sungguhan di sandbox)
- Lightpanda hanya bisa HTTP/SOCKS proxy; WireGuard kernel butuh root/NET_ADMIN dan membelokkan seluruh
  container → pakai **wireproxy** 1.1.3 (WireGuard userspace + SOCKS5), ±12 MB per proses, tanpa hak khusus.
- `/metrics` wireproxy memberi `last_handshake_time_sec` → tunnel mati (kunci salah / endpoint mati)
  terdeteksi dari handshake, bukan dari koneksi yang menggantung 40 detik.
- Tanpa traffic WireGuard tidak handshake → `PersistentKeepalive` dipasang (default 25 s) agar handshake
  langsung terjadi; handshake terbarui sendiri saat idle (diuji 200 s idle: request pertama 28 ms).
- Tanpa `DNS` di config, wireproxy gagal resolve nama (tidak jatuh ke resolver sistem) → default DNS
  publik lewat tunnel.
- Dua client dengan private key sama membuat server bolak-balik → koneksi tersendat 1–20 s. Maka satu
  proses per config, dipakai bersama.
- **`-c /dev/stdin` gagal kalau dijalankan dari Node** (stdio Node = socketpair, `open()` → ENXIO); di
  shell lolos karena `cat |` memakai pipe sungguhan → config lewat file 0600 di `/dev/shm` (RAM) yang
  dihapus begitu wireproxy membacanya.

## Plan
- [x] 1. Tabel `wireguard_configs`; kolom website `proxy_type` + `wireguard` (nama config, satu per baris)
- [x] 2. `services/wireguard.js`: parser wg-quick (PostUp dkk. dibuang), wireproxy on-demand per config,
       tunggu handshake 10 s, restart kalau handshake basi > 4 menit, idle stop, sweep yatim
- [x] 3. Rotasi/failover proxy yang ada dipakai apa adanya (entri `wireguard:<nama>`), `getBrowser` →
       SOCKS5 lokal; Cek Lightpanda, status per entri, badge dashboard
- [x] 4. Settings → WireGuard (upload banyak `.conf`, tempel, Test, Edit/ganti nama, hapus diblokir
       kalau dipakai); form website: Jenis proxy + centang config
- [x] 5. Dockerfile (versi dikunci + sha256), README, env `WIREPROXY_EXECUTABLE_PATH`,
       `WIREGUARD_IDLE_SECONDS`
- [x] 6. Verifikasi

## Review
- E2E WireGuard **51/51** (app asli + Lightpanda asli + dua "server VPN" wireproxy lokal dengan situs
  yang hanya ada di dalam tunnel `203.0.113.1`): upload 3 `.conf` sekaligus + tempel, kunci rusak /
  nama ganda ditolak per file, upload tidak menyentuh disk; crawl lewat tunnel (backend mencatat hit),
  1 proses ±12 MB, argumen tanpa kunci, file config di `/dev/shm` langsung hilang, PostUp tidak jalan;
  dipakai ulang (pid sama), 4 crawl paralel; Bergiliran A,B,A,B; Cadangan: config mati gagal handshake
  dalam 10 s → config berikutnya di request yang sama, lalu diistirahatkan; kunci salah → error jelas;
  config yang tidak ada (restore backup) dilewati; tombol Test; Cek Lightpanda per config; ganti nama
  ikut ke website, edit menghentikan tunnel lama; hapus saat dipakai ditolak; idle stop lalu hidup lagi;
  backup per website tanpa private key; SIGTERM tanpa sisa, SIGKILL → yatim → disapu saat start;
  wireproxy tidak ada → error/peringatan jelas.
- UI (Playwright, 1440px + 390px) **42/42**; Docker **7/7** (image dengan wireproxy terverifikasi
  checksum, crawl lewat tunnel dari container, wireproxy sebagai user non-root ±12 MB, tanpa capability
  tambahan, `/dev/shm` bersih).
- Suite lain diulang: E2E **63/63**, rotasi **21/21**, migrasi **11/11**, backup per website **46/46**,
  auth **95/95**, body aneh **12/12**, UI **47/47**, UI auth **46/46**, UI backup **36/36**.

---

# Lanjutan: Settings → Proxy (daftar global + default) dan pilihan proxy per website

## Permintaan (user)
"buat juga settingan global untuk proxy, dan pilih proxy per admin jadinya bisa milih seperti select,
jadi lebih proper dan rapi" — lalu: "jadi nanti per website bisa select proxy/vpn yang dimau".
Ditafsirkan: daftar proxy disimpan sekali di Settings (seperti config WireGuard) + default global; tiap
website memilih lewat select (proxy maupun VPN).

## Desain
- Tabel `proxies` (nama unik + alamat). Website menyimpan pilihannya di `websites.proxy_refs`: `default`,
  `none`, atau ref per baris `proxy:<nama>` / `wireguard:<nama>` (urutan = prioritas Cadangan).
  Default global di settings `proxy_default` + `proxy_default_rotation`.
- Ref memakai nama, bukan isi: ganti alamat/login cukup di satu tempat; ganti nama diteruskan ke semua
  website dan default; hapus ditolak selama masih dipakai.
- Migrasi otomatis (`convertLegacyProxies`): tiap baris proxy lama jadi entri (satu per baris yang
  sama, dipakai bersama), urutan + rotasi website tetap, pilihan WireGuard pindah jadi ref; website
  tanpa proxy → `default` (awalnya tanpa proxy). Gagal konversi → crawl tetap lewat daftar lama
  (`selectionFor`), tidak pernah diam-diam jadi koneksi langsung.
- Backup per website membawa entri proxy yang dipilih (alamat + login); restore memakai ulang alamat
  yang sama, nama bentrok → `nama-2`. Backup lama / crawlkomik dikonversi saat restore.

## Plan
- [x] 1. Model: `proxies`, `proxy_refs`, default global, konversi, rename/usage, import dari backup
- [x] 2. Crawl: `selectionFor` (website / default / none / fallback lama), resolve ref di `getBrowser`
- [x] 3. Admin: Settings → Proxy (default, tambah massal, Test lewat Lightpanda, Edit, Hapus), select
       picker di form website (baris tambahan + rotasi), badge dashboard, Cek Lightpanda per entri
- [x] 4. Backup/restore per website, README
- [x] 5. Verifikasi

## Review
- E2E daftar proxy **70/70** (app asli + Lightpanda asli + proxy HTTP/SOCKS5 lokal): database versi
  sebelumnya (dibuat kode versi itu sendiri) → 6 entri dari daftar lama (baris sama dipakai bersama,
  komentar dibuang, sesi `host:port:user:pass` dengan host-port sama → `-2`, `-3`), urutan + rotasi tetap,
  pilihan WireGuard pindah, restart tanpa konversi ulang; crawl Bergiliran A,B,C / Cadangan lewat entri
  hasil konversi; default global (D,B,D,B), `Tanpa proxy` dan Force OFF langsung, Force ON lewat default;
  validasi (entri tidak ada, keyword di baris tambahan, entri hilang yang sudah tersimpan tetap boleh
  disimpan); tambah massal (baris salah → nomor baris, duplikat beda penulisan ditolak); edit alamat →
  crawl ikut, ganti nama ikut ke website + default; Test lewat Lightpanda (OK / mati / alamat rusak);
  hapus ditolak selama dipakai; backup per website berisi entri yang dipilih saja → restore di server
  lain (nama bentrok → `-2`, alamat sama dipakai ulang), restore backup lama + full restore database lama
  dikonversi; config WireGuard yang tidak ada → crawl gagal jelas, tidak pernah langsung.
- UI (Playwright, 1440px + 390px) **70/70**: tambah massal + prefix, Test, default dengan 2 baris +
  Cadangan, select di form website (baris baru mulai dari entri yang belum dipilih, nomor urut, hapus
  baris, `Tanpa proxy` menyembunyikan baris lalu kembali), tersimpan sesuai urutan, crawl lewat nomor 1,
  badge dashboard, edit/ganti nama, hapus; tanpa overflow / error JS.
- Suite lain disesuaikan ke model baru lalu diulang: E2E **64/64**, rotasi **22/22**, migrasi crawlkomik
  **12/12**, backup per website **47/47**, UI **51/51**, UI backup **36/36**, WireGuard **51/51**,
  UI WireGuard **38/38**, Docker WireGuard **7/7**, auth **95/95**, body aneh **12/12**, UI auth **46/46**.
