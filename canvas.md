# Scraping Reader Berbasis `<canvas>`

Panduan mengambil gambar dari situs yang menggambar halaman ke `<canvas>`, bukan `<img>`.

## Kapan panduan ini dipakai

Gunakan kalau menemui salah satu ciri berikut:

- Selector gambar selalu mengembalikan kosong padahal gambar terlihat di browser.
- HTML halaman (cek dengan `&html=true`) berisi `<canvas>` tanpa `src`, misalnya:

  ```html
  <div class="rpage-page" data-page="40" style="aspect-ratio: 900 / 1648;">
    <canvas class="rpage-page__img" width="900" height="1648" aria-label="Page 40"></canvas>
  </div>
  ```

- Gambar hanya muncul saat di-scroll ke halaman itu, lalu **hilang lagi** setelah dilewati.

## Kenapa ini sulit

Ada dua hambatan terpisah:

1. **`<canvas>` tidak punya `src`.** Gambarnya digambar lewat JavaScript, jadi tidak ada URL
   untuk diambil selector. Satu-satunya jalan keluar: ekspor pikselnya dengan `toDataURL()`.

2. **Reader-nya *virtualized*.** Halaman digambar saat masuk viewport lalu **dikosongkan
   kembali** saat keluar (untuk hemat memori). Akibatnya pendekatan "scroll sampai bawah dulu,
   baru konversi semua canvas" gagal — saat konversi dijalankan, halaman yang sudah terlewat
   sudah kosong lagi. Pada pengujian, pendekatan itu hanya menangkap **2 dari 10 halaman**.

Solusinya: **tangkap tiap halaman saat itu juga selagi scroll**, lalu simpan hasilnya di wadah
terpisah yang tidak ikut dibersihkan reader.

## Cara pakai

### 1. Aktifkan Image Proxy

Admin → edit website → centang **Enable Image Proxy**. Tanpa ini, hasil `toDataURL()` (yang
berupa base64 raksasa) akan ikut masuk mentah-mentah ke JSON.

Method mana pun boleh (`browser` / `node` / `proxy`) — gambar hasil canvas selalu di-decode
dan disimpan langsung ke cache, karena datanya sudah ada di dalam string, tidak perlu diunduh.

### 2. Tempel snippet ke Custom JavaScript

Buka config page type (mis. `chapter`) → kolom **Custom JavaScript** → tempel:

```js
(async () => {
  const PAGE_SEL = '.rpage-page';        // wadah per halaman (yang punya data-page)
  const CANVAS_SEL = 'canvas';           // canvas di dalam wadah
  const MIME = 'image/jpeg', QUALITY = 0.9;   // 'image/png' kalau butuh transparansi
  const SETTLE = 260;                    // jeda setelah scroll, beri waktu menggambar
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Canvas sudah ada isinya? (sampling 4x4 titik, cek alpha)
  const painted = (c) => {
    if (!c || !c.width || !c.height) return false;
    try {
      const g = c.getContext('2d');
      for (let i = 1; i <= 4; i++) for (let j = 1; j <= 4; j++) {
        if (g.getImageData(Math.floor(c.width * i / 5), Math.floor(c.height * j / 5), 1, 1).data[3] !== 0) return true;
      }
      return false;
    } catch (e) { return false; }        // tainted (CORS) -> tak bisa dibaca/diekspor
  };

  const grabbed = new Map();             // data-page -> dataURL
  let tainted = 0;

  // Tangkap semua halaman yang SEDANG tergambar
  const captureNow = () => {
    const conts = document.querySelectorAll(PAGE_SEL);
    for (let i = 0; i < conts.length; i++) {
      const el = conts[i];
      const key = el.getAttribute('data-page') || String(i);
      if (grabbed.has(key)) continue;
      const c = el.matches(CANVAS_SEL) ? el : el.querySelector(CANVAS_SEL);
      if (!painted(c)) continue;
      try { grabbed.set(key, c.toDataURL(MIME, QUALITY)); } catch (e) { tainted++; }
    }
  };

  // Susuri halaman dan tangkap SAAT ITU JUGA (turun, lalu naik untuk menyapu sisa)
  const H = () => document.documentElement.scrollHeight;
  const step = Math.max(200, Math.round(innerHeight * 0.6));
  for (let y = 0; y <= H(); y += step) { scrollTo(0, y); await sleep(SETTLE); captureNow(); }
  for (let y = H(); y >= 0; y -= step) { scrollTo(0, y); await sleep(SETTLE); captureNow(); }
  scrollTo(0, 0);

  // Simpan di wadah terpisah supaya tidak ikut dibersihkan reader
  const prev = document.getElementById('__canvas_extract');
  if (prev) prev.remove();
  const box = document.createElement('div');
  box.id = '__canvas_extract';
  box.style.display = 'none';
  let keys = Array.from(grabbed.keys());
  if (keys.every(k => /^\d+$/.test(k))) keys.sort((a, b) => a - b);   // urut nomor halaman
  for (const k of keys) {
    const img = new Image();
    img.src = grabbed.get(k);
    img.setAttribute('data-page', k);
    img.setAttribute('data-from-canvas', '1');
    box.appendChild(img);
  }
  document.body.appendChild(box);

  return { captured: grabbed.size, tainted };
})()
```

### 3. Arahkan selector gambar ke hasil ekstraksi

Di config page type yang sama, isi selector gambar dengan:

```
#__canvas_extract img
```

Untuk `chapter`, isi di field **images**. Untuk custom page type, pakai custom field:

```json
{ "key": "images", "selector": "#__canvas_extract img", "type": "array", "attr": "src" }
```

### 4. Naikkan wait timeout

Snippet ini menyusuri seluruh halaman dua kali, jadi butuh waktu. Untuk chapter ~40 halaman,
set **Wait Timeout** minimal `60000` (60 detik).

## Menyesuaikan dengan situsmu

| Variabel | Fungsi | Kapan diubah |
|---|---|---|
| `PAGE_SEL` | Wadah per halaman | Wajib disesuaikan. Cari elemen yang punya `data-page`. Kalau tidak ada wadah, isi langsung selector canvas-nya (mis. `canvas.rpage-page__img`). |
| `CANVAS_SEL` | Canvas di dalam wadah | Ubah kalau canvas-nya punya class khusus dan ada beberapa canvas per wadah. |
| `SETTLE` | Jeda tiap langkah scroll | Naikkan ke `400`–`600` kalau masih ada halaman kosong (reader lambat menggambar). |
| `step` | Jarak tiap langkah scroll | Perkecil (`innerHeight * 0.4`) kalau ada halaman terlewat. |
| `QUALITY` | Kualitas JPEG | Turunkan ke `0.8` untuk chapter panjang agar lebih ringan. |
| `MIME` | Format keluaran | Pakai `'image/png'` hanya kalau butuh transparansi (ukurannya jauh lebih besar). |

## Memastikan berhasil

Snippet mengembalikan `{ captured, tainted }`. Cek lewat log crawl, atau langsung lihat hasil API:

```
/api/chapter?website=<nama>&url=<url-chapter>
```

Yang benar: jumlah URL sesuai jumlah halaman, dan formatnya URL proxy pendek — **bukan** base64:

```json
{
  "acf": {
    "chapter_img_source": [
      "http://localhost:3000/api/image/canvas-51a1dc57f875668b.jpg",
      "http://localhost:3000/api/image/canvas-24f453f019fb93d1.jpg"
    ]
  }
}
```

Kalau muncul string `data:image/jpeg;base64,...` yang sangat panjang, berarti **Enable Image
Proxy belum aktif** di website tersebut.

## Troubleshooting

| Gejala | Penyebab | Solusi |
|---|---|---|
| `captured: 0`, `tainted: 0` | `PAGE_SEL` tidak cocok | Cek HTML dengan `&html=true`, sesuaikan `PAGE_SEL`. |
| `captured: 0`, `tainted > 0` | Canvas **tainted** (CORS) | Tidak bisa lewat jalur ini — lihat bagian Batasan di bawah. |
| Sebagian halaman saja | Reader lambat menggambar | Naikkan `SETTLE`, perkecil `step`, naikkan Wait Timeout. |
| Crawl timeout | Halaman terlalu banyak | Naikkan Wait Timeout; turunkan `QUALITY`. |
| JSON isinya base64 panjang | Image Proxy belum aktif | Centang **Enable Image Proxy** di website. |
| Urutan halaman acak | `data-page` tidak numerik | Snippet mengurutkan numerik hanya bila semua key angka; kalau tidak, urutannya mengikuti urutan scroll (atas→bawah). |

## Batasan

**Canvas "tainted" (paling penting).** Kalau gambar digambar ke canvas dari domain lain tanpa
header CORS (`crossOrigin`), browser **melarang** `toDataURL()` dan melempar `SecurityError`.
Ini aturan keamanan browser — tidak bisa diakali dari sisi kode, termasuk oleh Puppeteer.

Kalau itu terjadi (`tainted > 0`, `captured: 0`), tempuh jalur lain:

- Buka DevTools → tab **Network** → filter **Img**, lalu lihat request gambar aslinya. Sering
  kali ada endpoint yang mengembalikan daftar URL gambar; pakai itu di selector `js:` biasa.
- Atau cari data halaman di dalam JS situs (mis. variabel global / JSON di `<script>`), lalu
  ambil dengan selector `js:`.

**Konsumsi memori.** Tiap halaman jadi string base64 (~ratusan KB). Chapter 40+ halaman bisa
memakai puluhan MB di memori browser saat proses berlangsung. Turunkan `QUALITY` bila perlu.

**Kualitas.** Hasilnya adalah re-encode dari piksel canvas, jadi bukan file asli dari server.
Dengan `QUALITY: 0.9` selisihnya kecil, tapi tetap bukan bit-per-bit sama dengan sumbernya.

## Catatan teknis

- Hasil `toDataURL()` (`data:` URL) di-decode langsung ke disk oleh image cache tanpa lewat
  jaringan, disimpan sebagai `canvas-<hash>.<ext>` di folder cache website.
- Cache-nya *content-addressed* (hash dari isi). Dua halaman yang isinya identik akan berbagi
  satu file — ini normal, bukan halaman yang hilang.
- Snippet ini juga aman dipakai pada reader **non-virtualized** (sudah diuji): halaman yang
  sudah tergambar akan langsung tertangkap pada lintasan pertama.
- Wadah `#__canvas_extract` sengaja `display:none` agar tidak mengubah tampilan/layout halaman;
  selector tetap bisa membacanya.
