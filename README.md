# PredictGoldDelano

Terminal analisis emas statis berbahasa Indonesia. Aplikasi berjalan di browser tanpa backend dan berisi lima modul web yang terhubung: `index.html`, `style.css`, `data-service.js`, `quant-engine.js`, dan `chart-ui.js`.

## Menjalankan

Untuk pratinjau lokal, sajikan folder ini melalui server file statis (misalnya ekstensi Live Server di editor, atau `python -m http.server 8000` dari folder ini), lalu buka alamat lokal yang ditampilkan. Browser membatasi modul JavaScript dan permintaan data bila halaman dibuka langsung sebagai `file://`.

Untuk GitHub Pages, unggah file dalam folder ini ke repositori, lalu aktifkan Pages dari branch `main`.

## Data dan batasan

- Harga emas memakai Binance PAXG/USDT sebagai proksi spot satu troy ounce. Kurs USD/IDR dicoba dari ExchangeRate-API; DXY, WTI, perak, dan yield dicoba dari endpoint grafik Yahoo Finance.
- Endpoint publik bisa diblokir oleh jaringan atau kebijakan CORS. Jika terjadi, aplikasi beralih ke feed simulasi dan menandainya di header.
- Harga Antam tanpa input manual adalah estimasi dari harga spot dan premi contoh. Harga jual dan buyback resmi dapat dimasukkan lewat tombol **Input Harga Antam Pagi**; nilainya disimpan lokal pada browser.
- Radar berita memakai jadwal contoh, bukan kalender ekonomi resmi. Validasi jadwal aktual sebelum dipakai.
- Skor, indikator, fan chart, dan zona beli aman adalah simulasi statistik berbasis browser, bukan rekomendasi atau jaminan hasil investasi.

## Berkas

- `index.html` — antarmuka terminal dan struktur halaman.
- `style.css` — tema Obsidian Dark dan tata letak responsif.
- `data-service.js` — sumber data publik, fallback, kalender contoh, dan penyimpanan lokal.
- `quant-engine.js` — EMA, RSI, MACD, ATR, Bollinger Bands, GARCH, Monte Carlo, dan skor strategi.
- `chart-ui.js` — grafik, indikator, horizon proyeksi, berita, dan kontrol simulasi.
