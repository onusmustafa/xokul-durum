// xokul durum sitesi: otomatik yoklama.
//
// GitHub Actions 5 dakikada bir çalıştırır (.github/workflows/yokla.yml).
// Sistemleri dışarıdan yoklar ve sonucu `gecmis.json` dosyasına işler:
//   guncel  : son yoklamanın sonucu (bileşen başına durum + yanıt süresi)
//   gunler  : son 90 günün günlük sayımı (toplam / başarısız yoklama)
//   kesinti : kendiliğinden saptanan kesintiler (başlangıç / bitiş)
//
// Bu dosya yalnız GÖSTERİM içindir. Uygulamadaki bakım ekranını AÇMAZ;
// onu yalnız durum.json'daki "bakim": true açar. Anlık bir bağlantı sorunu
// herkesin ekranını kilitlemesin diye iki iş bilerek ayrı.
//
// Bağımlılık yok (Node 20+). Kullanım: node yokla.mjs <gecmis.json yolu>

import { readFileSync, writeFileSync } from 'node:fs';

const GUN_SAYISI = 90;
const ZAMAN_ASIMI_MS = 12_000;
const KESINTI_SAKLA = 60; // en çok bu kadar kesinti kaydı tutulur

/**
 * Yoklanan bileşenler. `saglam(yanit, govde)` true dönerse çalışıyor.
 * Anahtarlar index.html'deki bileşen listesiyle AYNI olmalı.
 */
const BILESENLER = [
  {
    anahtar: 'panel',
    adres: 'https://app.xokul.co/login',
    saglam: (r) => r.status === 200,
  },
  {
    // API geçidi: anahtarsız istekte 401 döner; bu "sunucu ayakta" demektir.
    // 5xx ya da cevapsızlık = kapalı.
    anahtar: 'mobil',
    adres: 'https://supabase.xokul.co/auth/v1/health',
    saglam: (r) => r.status < 500,
  },
  {
    // Veritabanı: panelin sağlık ucu basit bir sorgu çalıştırır.
    // Uç henüz yayında değilse (yönlendirme / 404) ölçüm SAYILMAZ.
    anahtar: 'veritabani',
    adres: 'https://app.xokul.co/api/saglik',
    saglam: (r, g) => {
      if (r.status !== 200 && r.status !== 503) return null;
      try {
        return JSON.parse(g).db === true;
      } catch {
        return null;
      }
    },
  },
  {
    anahtar: 'medya',
    adres: 'https://supabase.xokul.co/storage/v1/status',
    saglam: (r) => r.status === 200,
  },
  {
    anahtar: 'site',
    adres: 'https://xokul.co/',
    saglam: (r) => r.status === 200,
  },
];

async function birKez(b) {
  const t0 = Date.now();
  try {
    const r = await fetch(b.adres, {
      redirect: 'manual',
      signal: AbortSignal.timeout(ZAMAN_ASIMI_MS),
      headers: { 'User-Agent': 'xokul-durum-yoklama', 'Cache-Control': 'no-cache' },
    });
    const govde = await r.text().catch(() => '');
    return { sonuc: b.saglam(r, govde), ms: Date.now() - t0 };
  } catch {
    return { sonuc: false, ms: Date.now() - t0 };
  }
}

/** Başarısızsa 8 sn sonra bir kez daha dener: anlık takılma kesinti sayılmasın. */
async function yokla(b) {
  let s = await birKez(b);
  if (s.sonuc === false) {
    await new Promise((r) => setTimeout(r, 8000));
    s = await birKez(b);
  }
  return s;
}

/** İstanbul saatine göre gün anahtarı (YYYY-AA-GG). */
function gunAnahtari(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);
}

function oku(yol) {
  try {
    const v = JSON.parse(readFileSync(yol, 'utf8'));
    if (v && typeof v === 'object') return v;
  } catch {
    // dosya yok / bozuk → baştan
  }
  return {};
}

const yol = process.argv[2];
if (!yol) {
  console.error('Kullanım: node yokla.mjs <gecmis.json>');
  process.exit(1);
}

const simdi = new Date();
const veri = oku(yol);
veri.gunler ??= {};
veri.kesinti ??= [];
const bugun = gunAnahtari(simdi);
veri.gunler[bugun] ??= {};

const sonuclar = await Promise.all(BILESENLER.map((b) => yokla(b)));
const guncel = {};

BILESENLER.forEach((b, i) => {
  const { sonuc, ms } = sonuclar[i];
  if (sonuc === null) {
    // Ölçülemedi: sayıma girmez, güncelde "bilinmiyor".
    guncel[b.anahtar] = { durum: 'bilinmiyor', ms: null };
    return;
  }
  guncel[b.anahtar] = { durum: sonuc ? 'calisiyor' : 'kapali', ms: sonuc ? ms : null };

  const g = (veri.gunler[bugun][b.anahtar] ??= { t: 0, h: 0 });
  g.t += 1;
  if (!sonuc) g.h += 1;

  // Kesinti kaydı: açık kayıt varsa ve düzeldiyse kapat; yoksa ve bozulduysa aç.
  const acik = veri.kesinti.find((k) => k.bilesen === b.anahtar && !k.bitis);
  if (!sonuc && !acik) {
    veri.kesinti.unshift({ bilesen: b.anahtar, baslangic: simdi.toISOString(), bitis: null });
  } else if (sonuc && acik) {
    acik.bitis = simdi.toISOString();
  }
});

// 90 günden eski günleri at.
const sinir = gunAnahtari(new Date(simdi.getTime() - GUN_SAYISI * 86_400_000));
for (const k of Object.keys(veri.gunler)) if (k < sinir) delete veri.gunler[k];
veri.kesinti = veri.kesinti.slice(0, KESINTI_SAKLA);

veri.guncel = { zaman: simdi.toISOString(), bilesenler: guncel };

writeFileSync(yol, JSON.stringify(veri));
console.log(
  simdi.toISOString(),
  Object.entries(guncel)
    .map(([k, v]) => `${k}=${v.durum}${v.ms ? `(${v.ms}ms)` : ''}`)
    .join(' '),
);
