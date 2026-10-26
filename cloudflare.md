# Menembus Cloudflare

Panduan kalau crawl tertahan di halaman **"Performing security verification"** / **"Just a moment…"**,
termasuk cara memakai ulang `cf_clearance` dari browser sendiri.

## Langkah 0: diagnosa dulu, jangan menebak

Buka `/admin/captcha` → klik **Cek Fingerprint**. Perintah ini menjalankan browser crawler apa
adanya lalu melaporkan sinyal bot mana yang bermasalah di servermu:

```json
{
  "status": "issues",
  "problems": 2,
  "checks": [
    { "name": "Mode browser", "ok": false, "value": "headless" },
    { "name": "Viewport tidak lebih besar dari screen", "ok": false, "value": "viewport 1920x1080 vs screen 800x600" }
  ]
}
```

- Masih ada `"ok": false` → perbaiki itu dulu (lihat Langkah 1 & 2).
- Sudah `"status": "clean"` tapi tetap loop → masalahnya **bukan di browser**. Lanjut ke Langkah 3.

Pilih nama website di dropdown sebelah tombol untuk mengecek memakai **User-Agent, Custom
Headers, dan Proxy milik website itu** — berguna kalau override per-website justru yang merusak
fingerprint. Pilih `(setelan global)` untuk mengecek setelan dasar saja.

## Langkah 1: matikan Headless

Dashboard → **Crawl Settings** → hapus centang **Headless browser** → Save.

Headless hampir selalu gagal cek environment Cloudflare: tanpa display sungguhan, browser
melaporkan `screen` 800×600 padahal viewport 1920×1080 — viewport lebih besar dari layar itu
**mustahil** di browser nyata. Ini tidak bisa ditambal dari kode (sudah dicoba lewat CDP
`Emulation.setDeviceMetricsOverride`, `window.screen` tetap 800×600).

Di Docker sudah disiapkan virtual display (Xvfb), jadi cukup **rebuild image**:

```bash
docker compose build --no-cache && docker compose up -d
```

Di bare metal jalankan lewat display virtual:

```bash
xvfb-run -a -s "-screen 0 1920x1080x24" npm start
```

Setelah itu **Cek Fingerprint** lagi sampai `clean`.

## Langkah 1b: pastikan WebGL ada

Kalau Cek Fingerprint menunjukkan:

```json
{ "name": "WebGL tersedia", "ok": false, "value": "(tidak ada WebGL sama sekali)" }
```

itu sinyal bot yang **kuat** — Chrome asli selalu punya WebGL, dan Turnstile memakainya untuk
fingerprinting. Penyebabnya: sejak Chrome ~120, browser **tidak lagi otomatis** fallback ke
software WebGL di server tanpa GPU.

Sudah diperbaiki di kode dan di Dockerfile, tapi **wajib rebuild image**:

- flag `--enable-unsafe-swiftshader` (Chrome ~120+ butuh ini untuk software WebGL)
- `--disable-gpu` **tidak lagi dipakai saat headful** — SwiftShader berjalan di dalam GPU
  process, jadi flag itu justru bisa mematikan WebGL di mode yang kita andalkan
- paket Alpine `chromium-swiftshader` (+ Mesa sebagai fallback)

```bash
docker compose build --no-cache && docker compose up -d
```

Bedakan dua kondisi ini — beda masalah, beda solusi:

| Hasil Cek Fingerprint | Arti | Tindakan |
|---|---|---|
| `WebGL tersedia: ok=false` | Tidak ada WebGL sama sekali | Rebuild image (flag + paket sudah disiapkan) |
| `GPU bukan software renderer: ok=false` | WebGL ada, tapi dirender software | Wajar di VPS tanpa GPU, jauh lebih baik daripada tidak ada WebGL — bisa diabaikan |

## Langkah 1c: jangan set Accept-Language sendiri

Dulu crawler selalu mengirim `Accept-Language: en-US,en;q=0.9,id;q=0.8`, padahal
`navigator.languages` di browsernya tetap `["en-US","en"]` — header mengaku punya bahasa yang
tidak ada di JS-nya. Di browser nyata keduanya **selalu** konsisten, jadi itu sinyal bot.
Sudah dihapus dari kode; sekarang Chrome mengirim Accept-Language aslinya yang otomatis cocok.

Kalau kamu mengisi `Accept-Language` sendiri di **Custom Headers** website, mismatch itu kembali.
Cek Fingerprint akan menandainya:

```json
{ "name": "Accept-Language konsisten dengan navigator.languages", "ok": false,
  "value": "header \"en-US,en;q=0.9,id;q=0.8\" vs navigator.languages [\"en-US\",\"en\"]" }
```

Solusinya: hapus `Accept-Language` dari Custom Headers.

## Langkah 1d: font harus cocok dengan OS yang diklaim

Stealth membuat browser menyamar sebagai **Windows** (`navigator.platform: Win32`,
`sec-ch-ua-platform: "Windows"`). Masalahnya container Alpine hampir tidak punya font, dan
sama sekali tidak punya font Windows — sedangkan **font fingerprinting** (dipakai Turnstile)
bisa melihat kontradiksi itu: mengaku Windows tapi Arial/Times New Roman/Segoe UI tidak ada.

Sudah diperbaiki di Dockerfile: paket `ttf-liberation` (metric-compatible dengan Arial /
Times New Roman / Courier New, dan fontconfig meng-alias-kannya) + `font-noto` + `ttf-dejavu`.
**Wajib rebuild image.** Cek Fingerprint akan menampilkan:

```json
{ "name": "Font Windows tersedia (UA mengaku Windows)", "ok": true,
  "value": "3 font: [\"Arial\",\"Times New Roman\",\"Courier New\"]" }
```

Kalau masih `0 font`, paket font-nya belum terpasang — cek log build image.

## Langkah 1e: samakan Timezone dengan negara proxy (WAJIB kalau pakai proxy)

Ini celah yang **tidak tertutup oleh residential proxy**, dan sering jadi penyebab terakhir.

Container jalan di **UTC**. Kalau proxy-mu di Singapura, IP-mu terlihat dari SG (**UTC+8**)
tapi jam browser tetap UTC+0. Cloudflare membandingkan geolokasi IP dengan timezone browser —
selisih ini kontradiksi. Menambah proxy tanpa menyetel timezone justru **menciptakan** mismatch
baru yang sebelumnya tidak ada.

Isi field **Timezone** di form website sesuai negara proxy:

| Proxy di | Timezone |
|---|---|
| Singapura | `Asia/Singapore` |
| Indonesia (WIB) | `Asia/Jakarta` |
| Amerika (East) | `America/New_York` |
| Eropa (UK) | `Europe/London` |

Cek Fingerprint (**pilih nama website di dropdown**, bukan global) akan menandainya:

```json
{ "name": "Timezone cocok dengan negara proxy", "ok": false, "value": "UTC (UTC+0)" }
```
setelah diisi menjadi:
```json
{ "name": "Timezone cocok dengan negara proxy", "ok": true, "value": "Asia/Singapore (UTC+8)" }
```

**Catatan soal bahasa:** locale sengaja TIDAK diubah. Override locale membuat
`navigator.language` dan `navigator.languages` bertentangan (sudah diuji: header jadi
`id-ID,...` tapi `navigator.languages` tetap `["en-US","en"]`) — itu justru sinyal baru.
Untuk Singapura `en-US` memang wajar karena Inggris bahasa resmi di sana.

## Langkah 2: jangan paksa User-Agent

Biarkan field **User Agent** di form website **kosong** kecuali kamu memang punya alasan.
Kalau diisi sembarangan, UA bisa tidak konsisten dengan client hints (`sec-ch-ua-platform`) —
misalnya mengaku Windows padahal browsernya jalan di Linux, yang justru menaikkan kecurigaan.

Pengecualian: kalau kamu memakai cara `cf_clearance` di bawah, UA **wajib** diisi dan harus
sama persis dengan browser tempat kamu solve.

## Langkah 3: pakai ulang `cf_clearance` dari browser sendiri

Cara paling andal kalau fingerprint sudah bersih tapi Cloudflare tetap menantang (umum terjadi
pada IP datacenter/VPS). Idenya: solve **sekali** di browser sungguhan, lalu pinjamkan hasilnya
ke crawler.

`cf_clearance` terikat pada **tiga** hal sekaligus — semuanya harus cocok:

| Terikat pada | Harus |
|---|---|
| Cookie | `cf_clearance` disalin utuh |
| User-Agent | UA crawler **sama persis** dengan browser saat solve |
| Alamat IP | IP crawler **sama** dengan IP saat solve |

Kalau salah satu beda, cookie-nya langsung tidak berlaku dan challenge muncul lagi.

### 3a. Ambil cookie-nya

1. Buka situsnya di Chrome biasa, selesaikan challenge sampai halaman aslinya muncul.
2. Tekan **F12** → tab **Application** → panel kiri **Storage → Cookies** → pilih domain situs
   (mis. `https://mangafire.to`).
3. Cari baris **`cf_clearance`** → klik → **copy nilai `Value`**-nya.

> **Penting:** `cf_clearance` itu **HttpOnly**, jadi **tidak bisa** diambil dengan
> `document.cookie` di Console. Harus lewat tab Application (atau extension export cookie).

### 3b. Ambil User-Agent-nya

Di tab **Console** browser yang sama:

```js
navigator.userAgent
```

Copy hasilnya apa adanya (jangan diedit/dirapikan).

### 3c. Isi di admin panel

Admin → **edit website** → isi tiga field ini:

**Cookies** (JSON array — perhatikan titik di depan domain):

```json
[
  {
    "name": "cf_clearance",
    "value": "<tempel nilai dari langkah 3a>",
    "domain": ".mangafire.to",
    "path": "/",
    "secure": true,
    "httpOnly": true
  }
]
```

**User Agent**: tempel hasil langkah 3b.

**Proxy**: lihat 3d.

Klik **Save**, lalu tes crawl.

### 3d. Menyamakan IP (bagian tersulit)

Cookie hanya berlaku dari IP yang dipakai saat solve. Pilih salah satu:

| Situasi | Cara |
|---|---|
| Crawler jalan di komputer/jaringan yang sama dengan browser | Tidak perlu apa-apa — IP sudah sama. Kosongkan Proxy. |
| Crawler di VPS, kamu punya proxy (residential/rumah) | **Solve lewat proxy itu juga.** Set proxy yang sama di browser (extension proxy / setting sistem), solve challenge di situ, ambil cookie-nya, lalu isi proxy yang sama di field **Proxy** website. |
| Crawler di VPS, tanpa proxy | Tidak bisa. IP VPS ≠ IP rumahmu, cookie akan ditolak. Perlu proxy, atau jalankan crawler dari jaringan tempat kamu solve. |

Format Proxy: `http://user:pass@host:port`

## Langkah 4 (alternatif): residential proxy tanpa cookie

Kalau punya residential/mobile proxy, sering kali **tidak perlu** repot cookie: isi saja field
**Proxy** di website, biarkan UA kosong, dan pastikan mode headful. IP residential biasanya
lolos verifikasi otomatis tanpa challenge sama sekali.

Ini opsi paling nyaman untuk jangka panjang karena tidak perlu refresh cookie.

## Batasan yang perlu diterima

- **`cf_clearance` berumur pendek.** Umumnya ~30 menit sampai beberapa jam, tergantung setelan
  situs. Setelah itu challenge muncul lagi dan cookie harus diambil ulang. Jadi cara ini cocok
  untuk crawl batch/sesekali, bukan layanan yang jalan terus 24/7.
- **Satu cookie untuk satu IP + satu UA.** Tidak bisa dipakai bersamaan dari beberapa IP.
- **Sinyal di luar jangkauan kode.** Reputasi IP datacenter, fingerprint TLS/JA3, dan
  WebGL software-rendering tidak bisa diperbaiki dari sisi Puppeteer. Kalau Cek Fingerprint
  sudah `clean` dan cookie+UA+IP sudah cocok tapi masih ditolak, sisanya memang faktor ini.

## Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| Sudah tempel cookie, tetap challenge | UA tidak sama persis | Ambil ulang `navigator.userAgent`, tempel apa adanya |
| Sudah cookie + UA sama, tetap challenge | IP beda | Lihat Langkah 3d — solve lewat proxy yang sama |
| Tadi berhasil, sekarang challenge lagi | Cookie kedaluwarsa | Ambil ulang `cf_clearance` |
| Cookie tidak terlihat di `document.cookie` | `cf_clearance` HttpOnly | Normal. Ambil dari DevTools → Application → Cookies |
| Cek Fingerprint bilang `headless` | Toggle belum dimatikan / image belum di-rebuild | Langkah 1 |
| Cek Fingerprint bilang `DISPLAY (tidak diset)` | Xvfb belum jalan | Rebuild image Docker, atau pakai `xvfb-run` |

## Catatan teknis

- Cookie dari field **Cookies** dipasang sebelum navigasi (`page.setCookie`), jadi ikut terkirim
  pada request pertama — termasuk ke halaman challenge.
- Setelah challenge terlewati (otomatis atau manual), semua cookie clearance diambil via CDP
  `Network.getAllCookies` dan **disimpan otomatis** ke config website, lalu dipakai lagi pada
  crawl berikutnya. Cookie yang kamu tempel manual tidak hilang karena proses ini.
- Manual CAPTCHA takeover (`/admin/captcha`) tetap berguna untuk challenge yang **interaktif**
  (ada checkbox untuk diklik). Untuk challenge yang otomatis ("Verifying…" berputar sendiri
  tanpa checkbox), tidak ada yang bisa diklik — yang menentukan adalah fingerprint dan IP.
