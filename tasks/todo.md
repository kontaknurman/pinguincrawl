# Task: Fix `ENOSPC: no space left on device, mkdtemp '/tmp/crawlkomik-XXXXXX'` + admin responsive

## Bug Report (user)
"error ENOSPC: no space left on device, mkdtemp '/tmp/crawlkomik-XXXXXX' — dan perbaiki tampilan
admin, buat agar responsive dan user friendly"

## Diagnosis (direproduksi dengan Chromium asli)
- **Setiap crawl membocorkan folder profil Chrome.** `getBrowser()` membuat
  `/tmp/crawlkomik-XXXXXX` lalu menghapusnya di event `disconnected` — event itu terjadi saat socket
  CDP tertutup, padahal Chrome masih menulis `Local State`/`Preferences` waktu shutdown. `fs.rm`
  kalah balapan (ENOTEMPTY) dan error-nya ditelan callback kosong. Repro: **8 dari 8 crawl** dalam
  satu proses meninggalkan foldernya. Ribuan folder × puluhan inode → disk/inode penuh → `mkdtemp`
  gagal dengan ENOSPC.
- Jalur bocor lain: `puppeteer.launch` gagal (folder tidak pernah dihapus); proses Node di-restart
  (pm2/docker) saat browser terbuka (folder 7–8 MB lengkap dengan cache tertinggal); Chrome yang
  di-kill meninggalkan `/tmp/.org.chromium.Chromium.*` (dir socket singleton).
- **Bug kedua (cache gambar):** `getExpiredImages()` membandingkan `created_at`
  (`"2026-10-02 23:55:00"`) dengan cutoff ISO (`"2026-10-02T…Z"`) sebagai string — spasi < `T`,
  jadi semua gambar dari hari UTC sebelumnya dianggap kedaluwarsa. Terbukti: gambar umur 35 menit
  terhapus saat cleanup jam 00:30 UTC → URL proxy yang baru dibagikan jadi 404.
- Pemakan disk lain tanpa batas: log container Docker (json-file tanpa rotasi), cache gambar tanpa
  batas ukuran, file cache yatim (restore DB / URL di-cache ulang), snapshot backup yang gagal.

## Plan
- [x] 1. `services/profile-dirs.js`: buat profil (ENOSPC → sweep sisa lalu coba lagi, error jelas
       kalau tetap penuh), hapus **setelah proses Chrome exit** dengan retry, `$TMPDIR` Chrome di
       dalam profil, sweep sisa (startup + tiap 30 menit) dengan cek "masih dipakai" via `/proc`
- [x] 2. `browser.js`: pakai modul itu; launch gagal → hapus profil; slot browser selalu dilepas
       walau `close()` throw
- [x] 3. Cache gambar: perbaiki perbandingan tanggal, retensi & batas ukuran bisa diatur, hapus file
       yatim; `services/storage.js` (laporan ruang + inode, pembersihan terjadwal); rotasi log Docker
- [x] 4. Admin responsive: layout baru (sidebar → offcanvas di HP), light/dark, toast (PRG),
       halaman Settings + Storage, form website/config/logs/captcha didesain ulang
- [x] 5. Verifikasi + README

## Implementasi singkat
- Profil dihapus di listener `exit` proses Chrome (bukan `disconnected`), `rm` di-retry untuk
  ENOTEMPTY/EBUSY. Sweep hanya menyentuh nama hasil mkdtemp (`crawlkomik-` + 6 karakter) yang isinya
  memang profil Chrome, milik uid sendiri, >1 menit, dan tidak dipakai proses mana pun
  (`--user-data-dir` di `/proc/*/cmdline`; fallback `SingletonLock`).
- Admin: Post/Redirect/Get — handler redirect dengan `?ok=<kode>`, halaman menampilkan toast dari
  teks tetap (bukan isi query). Validasi JSON (headers/cookies/localStorage) + timezone di server,
  validasi JSON langsung di browser. Form config: bar Simpan menempel, peringatan perubahan belum
  disimpan, panel **Uji API**. CAPTCHA: pointer events (tap di HP), kotak ketik, layar penuh;
  daftar sesi tidak lagi di-render ulang tiap detik (tap sempat hilang).

## Review
Bocor profil **8/8 → 0/8**. Test (semua di scratchpad, tidak masuk repo):
- Sweep 15/15 — sisa lama/kosong terhapus; folder muda, nama mirip yang bukan profil, file biasa,
  dan profil milik **proses lain yang masih hidup** tidak tersentuh; sweep paralel berbagi satu run.
- ENOSPC self-heal 3/3 di tmpfs dengan batas inode: 29 profil sisa dibersihkan lalu berhasil;
  disk penuh oleh file lain → error berisi sisa ruang/inode + petunjuk `/admin/storage`.
- Restart: proses di-SIGINT saat browser terbuka → sisa 7.7 MB → hilang oleh sweep saat start.
- Storage 19/19 — retensi (termasuk kasus bug string tanggal), retensi custom, batas ukuran
  (terlama dibuang, sampai ≤90%), file yatim (yang baru ditulis aman), laporan disk/inode,
  file temp basi.
- UI E2E 81/81 (desktop 1440px + iPhone 13): tanpa horizontal overflow di semua halaman, 0 error
  console/HTTP; alur buat website (JSON invalid diblok), config + visual editor, API, logs + modal,
  storage, settings, tema, menu HP — dan **CAPTCHA di-solve dengan tap di HP** sampai crawl selesai.
- Regresi 23/23: cache gambar metode node & browser (gambar tersaji), fingerprint check, backup
  (snapshot terhapus) + restore (+ file sampah ditolak), 2FA enable/disable, hapus log, auth;
  setelah semua crawl: **0** folder profil dan **0** `/tmp/.org.chromium.*`.

**Lesson (masuk lessons.md):** jangan bersihkan resource milik child process di event "koneksi
putus" — tunggu prosesnya benar-benar exit, dan jangan pernah menelan error cleanup.
