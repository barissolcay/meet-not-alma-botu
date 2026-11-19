/**
 * Döküm analiz aracı — "hangi bozulma eklentiden, hangisi Meet'ten?"
 *
 * Kullanım:  node tools/analyze-transcript.js <döküm.txt>
 *
 * Google Meet canlı altyazıları cümleleri konuşma sırasında sürekli
 * revize eder. Bu, dökümde iki tür tekrara yol açar:
 *
 *  1) GRACE kaynaklı bölünme — altyazı, cümlenin devamı ~1-3 sn sonra
 *     geldiği için iki satıra bölünür. AYARLA DÜZELİR (grace süresi).
 *  2) KESİŞME kaynaklı bölünme — araya başka bir konuşmacı girer.
 *     AYARLA DÜZELMEZ; döküm konuşma turlarına sadık kalır.
 *
 * Bu araç ikisini ayırır ve hangi satırların hangi kaynaklı olduğunu gösterir.
 *
 * ÖNEMLİ — TEK KAYNAK KURALI:
 * "Birleşir mi?" sorusunun cevabı uydurulmaz; eklentinin gerçek transkript
 * motorundan (`extension/src/content/transcript-engine.js`) alınır. Araç,
 * motorun `isContinuation()` ve `normalizeText()` fonksiyonlarını kullanır.
 * Aksi halde araç, motorun asla birleştirmeyeceği çiftleri "birleştirilebilir"
 * diye raporlayıp yanlış yön gösterirdi.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// BİRLEŞTİRME KURALININ TEK KAYNAĞI: eklentinin transkript motoru.
const MNAEngine = require(
  path.join(__dirname, '..', 'extension', 'src', 'content', 'transcript-engine.js')
);

/** Motorun varsayılan grace süresi (ms). */
const DEFAULT_GRACE_MS = 2500;
/** Ayarlar sayfasının kabul ettiği grace aralığı (ms). */
const MIN_GRACE_MS = 500;
const MAX_GRACE_MS = 5000;
/** Grace aday taraması: başlangıç, bitiş, adım (ms). */
const GRACE_SCAN_START = 2500;
const GRACE_SCAN_END = 5000;
const GRACE_SCAN_STEP = 250;

/** Beklenen döküm satırı biçimi: [HH:MM:SS] Konuşmacı: metin */
const LINE_PATTERN = /^\[(\d{2}):(\d{2}):(\d{2})\]\s+(.+?):\s*(.*)$/;
/** Zaman damgalı görünen ama biçimi bozuk satır deseni. */
const BROKEN_TIMESTAMP_PATTERN = /^\[\d{1,2}:\d{2}(:\d{2})?\]/;
/** Meta başlığında beklenen alanlar. */
const EXPECTED_META_KEYS = ['Toplantı', 'Tarih', 'Süre', 'Katılımcılar'];
/** Zaman damgası yokken kullanılan uyarı metni. */
const NO_TIMESTAMP_WARNING =
  'Dökümde zaman damgalı satır bulunamadı — tekrarlar aranamıyor. ' +
  "Biçim 'Toplantı Not Alma Botu' TXT çıktısıyla aynı olmalı.";

/**
 * Döküm metnini çözümler.
 * @param {string} raw
 * @returns {Object} { meta, rows, orphanBodyLines, malformedTimestampLines }
 */
function parseTranscript(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const meta = {};
  const rows = [];
  let inBody = false;
  let orphanBodyLines = 0;
  let malformedTimestampLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      inBody = true;
      continue;
    }

    // 1) Zaman damgalı konuşma satırı (meta başlığından SONRA da gelebilir).
    const match = trimmed.match(LINE_PATTERN);
    if (match) {
      rows.push({
        index: rows.length,
        seconds: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]),
        time: match[1] + ':' + match[2] + ':' + match[3],
        speaker: match[4].trim(),
        text: match[5].trim()
      });
      continue;
    }

    // 2) Zaman damgalı görünüyor ama biçimi bozuk satır.
    if (BROKEN_TIMESTAMP_PATTERN.test(trimmed)) {
      malformedTimestampLines += 1;
      continue;
    }

    // 3) Başlık bloğu: "Toplantı: ...", "Tarih: ..." vb. (ilk boş satırdan önce).
    if (!inBody && trimmed.includes(':')) {
      const idx = trimmed.indexOf(':');
      meta[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      continue;
    }

    // 4) Çok satırlı metin, önceki satıra eklenir.
    if (rows.length && inBody) {
      rows[rows.length - 1].text += ' ' + trimmed;
      continue;
    }

    // 5) Hiçbir satıra bağlanamayan gövde satırı (biçim ihlali).
    orphanBodyLines += 1;
  }
  return { meta, rows, orphanBodyLines, malformedTimestampLines };
}

/**
 * Karşılaştırma yardımcıları — motorun kurallarıyla BİREBİR aynı.
 * Motorun normalizeText'i: boşlukları sadeleştirir ve kırpar (noktalama SİLMEZ).
 */
function normalize(value) {
  return MNAEngine.normalizeText(value);
}

/**
 * Yeni metin, eskinin devamı mı (Meet'in revizyonu)?
 * Motorun kuralı: metinlerden biri diğerinin öneki ya da uzantısı ise devam.
 * Motor, eski metnin sonundaki cümle işaretini atınca gövde yeni metnin
 * birebir önekiyse bunu da devam sayar.
 */
function isRevision(older, newer) {
  return MNAEngine.isContinuation(older, newer);
}

/** Motor konuşmacıyı birebir karşılaştırır; burada da aynı. */
function isSameSpeaker(a, b) {
  return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
}

/**
 * Motorun "revizyon penceresi" (kesinleşmiş satırın sonradan güncellenebildiği
 * süre). Kaynak: extension/src/content/transcript-engine.js
 */
const REVISION_WINDOW_MS = MNAEngine.REVISION_WINDOW_MS || 30000;

/**
 * Belirli bir grace değerinde çift birleşir mi?
 *
 * Motorun KURALI: yeni metin geldiğinde `now - lastChangedAt < graceMs` ise
 * aynı satıra birleşir. Döküm zaman damgaları SANİYE çözünürlüğünde olduğu
 * için gözlenen "gap" (sn), gerçek aralığın [gap*1000, (gap+1)*1000) bandına
 * düşer. Motorla aynı eşik: `gap*1000 < grace` -> birleşir.
 *
 * @param {number} gap Gözlenen aralık (saniye).
 * @param {number} graceMs Grace değeri (ms).
 * @returns {boolean}
 */
function mergesAtGrace(gap, graceMs) {
  return gap * 1000 < graceMs;
}

/**
 * Çift, grace yolu olmadan REVİZYON yoluyla birleşir mi?
 *
 * Motorun ikinci birleştirme yolu: satır grace dolduğu için kesinleşmiş olsa
 * bile, Meet aynı konuşmacıdan yeni bir blokla metni uzatırsa ve bu
 * REVISION_WINDOW_MS içinde olursa satır yerinde güncellenir (yeni satır
 * açılmaz). Satır `cur` anında kesinleştiği için kesinleşme anı en erken
 * `cur + grace` olur; dolayısıyla birleşme için
 * `gap*1000 - graceMs <= REVISION_WINDOW_MS` gerekir.
 *
 * Bu yol yalnızca İKİ SATIR ARDAŞIK ve aynı konuşmacıya aitse geçerlidir;
 * araya giren bir konuşmacı varsa motor birleştirmez.
 *
 * @param {number} gap Gözlenen aralık (saniye).
 * @param {number} graceMs Grace değeri (ms).
 * @returns {boolean}
 */
function mergesAtRevisionWindow(gap, graceMs) {
  return gap * 1000 - graceMs <= REVISION_WINDOW_MS;
}

/**
 * Çiftin herhangi bir yolla birleşip birleşmediği (motorun gerçek davranışı).
 * @param {number} gap
 * @param {number} graceMs
 * @returns {boolean}
 */
function mergesInEngine(gap, graceMs) {
  return mergesAtGrace(gap, graceMs) || mergesAtRevisionWindow(gap, graceMs);
}

/**
 * Bu çiftin KESİN birleşmesi için gereken grace değeri (ms).
 * Gerçek aralık daima (gap+1)*1000 ms'den küçük olduğundan, bu değer
 * garantiler.
 */
function mergeGuaranteedGraceMs(gap) {
  return (gap + 1) * 1000;
}

/**
 * Bu çiftin KESİN birleşmemesi için yeterli grace değeri (ms).
 * Gerçek aralık daima gap*1000 ms'den küçük olmadığından, bu değer
 * garantiler.
 */
function noMergeGuaranteedGraceMs(gap) {
  return gap * 1000;
}

/**
 * Tekrar desenlerini sınıflandırır.
 * @param {Object} parsed parseTranscript çıktısı
 */
function classify(parsed) {
  const rows = parsed.rows;
  const graceSplits = [];
  const interruptionSplits = [];

  for (let i = 0; i + 1 < rows.length; i += 1) {
    const cur = rows[i];
    const next = rows[i + 1];

    // (1) Aynı konuşmacı, sonraki satır öncekinin devamı -> grace kaynaklı.
    if (isSameSpeaker(cur.speaker, next.speaker) && isRevision(cur.text, next.text)) {
      graceSplits.push({ cur, next, gap: next.seconds - cur.seconds });
      continue;
    }

    // (2) A, B, A deseni: araya giren konuşmacı -> kesişme kaynaklı.
    if (i + 2 < rows.length) {
      const third = rows[i + 2];
      if (
        !isSameSpeaker(cur.speaker, next.speaker) &&
        isSameSpeaker(cur.speaker, third.speaker) &&
        isRevision(cur.text, third.text)
      ) {
        interruptionSplits.push({
          first: cur,
          middle: next,
          last: third,
          gap: third.seconds - cur.seconds
        });
      }
    }
  }
  return { graceSplits, interruptionSplits };
}

/**
 * Dökümdeki biçim sorunlarını toplar.
 * @param {Object} parsed parseTranscript çıktısı
 * @returns {string[]} Türkçe uyarı metinleri
 */
function collectWarnings(parsed) {
  const warnings = [];

  if (!parsed.rows.length) {
    warnings.push(NO_TIMESTAMP_WARNING);
  }
  if (parsed.orphanBodyLines) {
    warnings.push(
      parsed.orphanBodyLines +
        ' satır beklenen "[HH:MM:SS] Konuşmacı: metin" biçimine uymuyor.'
    );
  }
  if (parsed.malformedTimestampLines) {
    warnings.push(
      parsed.malformedTimestampLines + ' satır zaman damgalı görünüyor ama biçim bozuk.'
    );
  }

  const missingMeta = EXPECTED_META_KEYS.filter((key) => !parsed.meta[key]);
  if (missingMeta.length) {
    warnings.push('Meta başlığında eksik alanlar: ' + missingMeta.join(', ') + '.');
  }
  // Beklenmeyen meta alanları (örn. "Bağlantı") hataya sayılmaz: çıktı
  // biçimi zamanla genişleyebiliyor, eksik alanlar yeterince uyarıyor.

  return warnings;
}

/**
 * Tam analiz: dökümü çözümler ve tekrarları sınıflandırır.
 * @param {string} raw
 */
function analyzeTranscript(raw) {
  const parsed = parseTranscript(raw);
  const classified = classify(parsed);
  const speakers = [];
  for (const row of parsed.rows) {
    if (!speakers.includes(row.speaker)) {
      speakers.push(row.speaker);
    }
  }
  return {
    meta: parsed.meta,
    rows: parsed.rows,
    speakers,
    graceSplits: classified.graceSplits,
    interruptionSplits: classified.interruptionSplits,
    timestampedCount: parsed.rows.length,
    hasTimestamps: parsed.rows.length > 0,
    orphanBodyLines: parsed.orphanBodyLines,
    malformedTimestampLines: parsed.malformedTimestampLines,
    warnings: collectWarnings(parsed)
  };
}

/**
 * Analiz sonucunu okunabilir rapor satırlarına çevirir.
 * @param {Object} result analyzeTranscript çıktısı
 * @param {string} [fileName] Rapor başlığında gösterilecek dosya adı
 * @returns {string[]}
 */
function buildReport(result, fileName) {
  const out = [];
  const meta = result.meta || {};
  const rows = result.rows || [];
  const speakers = result.speakers || [];
  const graceSplits = result.graceSplits || [];
  const interruptionSplits = result.interruptionSplits || [];
  const warnings = result.warnings || [];

  out.push('');
  out.push('=== Döküm analizi: ' + (fileName || '(bellek)') + ' ===');
  out.push('');
  out.push('ÖZET');
  out.push('  Toplantı         : ' + (meta['Toplantı'] || '—'));
  out.push('  Tarih            : ' + (meta['Tarih'] || '—'));
  out.push('  Süre             : ' + (meta['Süre'] || '—'));
  out.push(
    '  Katılımcılar     : ' +
      (meta['Katılımcılar'] ||
        (speakers.length ? speakers.join(', ') + ' (başlıkta yok)' : '—'))
  );
  out.push('  Konuşma satırı   : ' + rows.length);
  out.push('  Konuşmacı sayısı : ' + speakers.length);
  out.push('  Zaman damgalı satır: ' + (result.timestampedCount || 0));
  out.push(
    '  Grace (motor)    : ' + DEFAULT_GRACE_MS + ' ms (izin verilen aralık ' +
      MIN_GRACE_MS + '-' + MAX_GRACE_MS + ' ms)'
  );
  out.push(
    '  Revizyon penceresi: ' + REVISION_WINDOW_MS + ' ms (kesinleşmiş satırın ' +
      'sonradan güncellenebildiği süre)'
  );
  out.push('');

  if (warnings.length) {
    out.push('UYARILAR');
    for (const w of warnings) {
      out.push('  - ' + w);
    }
    out.push('');
  }

  out.push('TEKRAR DESENLERİ');
  if (!graceSplits.length && !interruptionSplits.length) {
    if (rows.length) {
      out.push('  Tekrar yok — döküm temiz.');
    } else {
      out.push('  Tekrar aranamadı — dökümde zaman damgalı satır yok (uyarılara bakın).');
    }
  }

  let counter = 0;

  graceSplits.forEach((item) => {
    counter += 1;
    const guaranteed = mergeGuaranteedGraceMs(item.gap);
    const safe = noMergeGuaranteedGraceMs(item.gap);
    out.push('');
    out.push('  [' + counter + '] GRACE kaynaklı bölünme  → ayarla DÜZELİR');
    out.push('      ' + item.cur.time + ' ' + item.cur.speaker + ': ' + item.cur.text);
    out.push('      ' + item.next.time + ' ' + item.next.speaker + ': ' + item.next.text);
    out.push(
      '      -> ' + item.gap + ' sn arayla; ikinci satır birincinin devamı ' +
        '(motorun isContinuation kuralına uyar).'
    );
    out.push(
      '      -> KESİN birleşir: grace >= ' + guaranteed + ' ms | KESİN birleşmez: grace <= ' +
        safe + ' ms'
    );
    if (mergesAtGrace(item.gap, DEFAULT_GRACE_MS)) {
      out.push('      -> Şu anki grace ' + DEFAULT_GRACE_MS + ' ms: birleşir (grace yolu)');
    } else if (mergesAtRevisionWindow(item.gap, DEFAULT_GRACE_MS)) {
      out.push(
        '      -> Şu anki grace ' + DEFAULT_GRACE_MS + ' ms: birleşir (revizyon penceresi, ' +
          REVISION_WINDOW_MS + ' ms) — grace ayarına gerek yok.'
      );
    } else {
      out.push('      -> Şu anki grace ' + DEFAULT_GRACE_MS + ' ms: birleşmez');
    }
    if (guaranteed > MAX_GRACE_MS) {
      out.push(
        '      -> Not: güvence değeri ' + guaranteed + ' ms, izin verilen üst sınır ' +
          MAX_GRACE_MS + ' ms aşıyor; grace ayarıyla birleştirilemez.'
      );
      if (mergesAtRevisionWindow(item.gap, DEFAULT_GRACE_MS)) {
        out.push(
          '         Ancak motorun revizyon penceresi (' + REVISION_WINDOW_MS + ' ms) bu çifti ' +
            'zaten birleştiriyor.'
        );
      }
    }
    if (safe < MIN_GRACE_MS) {
      out.push(
        '      -> Not: güvenli değer ' + safe + ' ms izin verilen aralığın (' + MIN_GRACE_MS +
          '-' + MAX_GRACE_MS + ' ms) dışında; bu çift her izin verilen değerde birleşebilir.'
      );
    }
  });

  interruptionSplits.forEach((item) => {
    counter += 1;
    out.push('');
    out.push('  [' + counter + '] KESİŞME kaynaklı bölünme → ayarla DÜZELMEZ');
    out.push('      ' + item.first.time + ' ' + item.first.speaker + ': ' + item.first.text);
    out.push('      ' + item.middle.time + ' ' + item.middle.speaker + ': ' + item.middle.text);
    out.push('      ' + item.last.time + ' ' + item.last.speaker + ': ' + item.last.text);
    out.push(
      '      -> Araya giren konuşmacı yüzünden bölündü (' + item.gap + ' sn). Konuşma'
    );
    out.push('         turlarının sadakati korunuyor; bu kasıtlı bir davranış.');
    out.push('         (Benzer kısa ifadelerde yanlış eşleşme olabilir — elle teyit et.)');
  });

  out.push('');
  out.push('ÖNERİ');
  if (graceSplits.length) {
    const candidates = [];
    for (let grace = GRACE_SCAN_START; grace <= GRACE_SCAN_END; grace += GRACE_SCAN_STEP) {
      candidates.push({
        grace,
        merged: graceSplits.filter((s) => mergesAtGrace(s.gap, grace)).length
      });
    }
    const current = candidates.find((c) => c.grace === DEFAULT_GRACE_MS) || candidates[0];
    const firstAll = candidates.find((c) => c.merged === graceSplits.length) || null;

    const viaGrace = graceSplits.filter((s) => mergesAtGrace(s.gap, DEFAULT_GRACE_MS)).length;
    const viaRevision = graceSplits.filter(
      (s) =>
        !mergesAtGrace(s.gap, DEFAULT_GRACE_MS) &&
        mergesAtRevisionWindow(s.gap, DEFAULT_GRACE_MS)
    ).length;
    const notMerged = graceSplits.filter((s) => !mergesInEngine(s.gap, DEFAULT_GRACE_MS));

    out.push(
      '  Varsayılan grace ' + DEFAULT_GRACE_MS + ' ms ile birleşen çift: ' +
        (viaGrace + viaRevision) + '/' + graceSplits.length +
        ' (grace yolu ' + viaGrace + ', revizyon penceresi ' + viaRevision + ')'
    );
    for (const item of graceSplits) {
      if (!mergesInEngine(item.gap, DEFAULT_GRACE_MS)) {
        out.push(
          '    -> Varsayılanla birleşmeyen çift: ' + item.gap + ' sn aralık (kesin birleşme için grace >= ' +
            mergeGuaranteedGraceMs(item.gap) + ' ms gerekir; bu değer üst sınırı aşıyor).'
        );
      }
    }
    if (notMerged.length) {
      out.push(
        '  ' + notMerged.length + ' çift hiçbir ayarla birleşmiyor: Meet’in bloğu çok uzun süre ' +
          'açık kalıyor (revizyon penceresi de yetmiyor).'
      );
    } else {
      out.push(
        '  Tüm grace kaynaklı çiftler motorun mevcut davranışıyla birleşiyor — ayar değişikliği ' +
          'gerekmiyor.'
      );
    }
    if (firstAll && viaRevision > 0) {
      out.push(
        '  Not: ' + viaRevision + ' çift yalnızca grace artırılarak birleşiyor; motorun revizyon ' +
          'penceresi bunları zaten kapsıyor.'
      );
    }
    if (firstAll && viaRevision === 0) {
      out.push(
        '  Tüm grace kaynaklı çiftlerin birleşebildiği en küçük değer: ' + firstAll.grace + ' ms'
      );
      out.push('    -> Ayarlar → "Satır birleştirme süresi" = ' + firstAll.grace + ' ms');
    }
    out.push('  Grace değeri → GRACE YOLUYLA birleşen çift sayısı (motor eşiğiyle):');
    for (const c of candidates) {
      if (c.grace % 1000 === 0 || (firstAll && c.grace === firstAll.grace)) {
        out.push(
          '    ' + String(c.grace).padStart(4) + ' ms -> ' + c.merged + '/' + graceSplits.length
        );
      }
    }
    out.push(
      '  (Sınır kuralı: zaman damgaları saniye çözünürlüğünde olduğu için gözlenen "gap" sn,'
    );
    out.push(
      '   gerçek aralığın [gap*1000, (gap+1)*1000) bandındadır; KESİN birleşme için grace >= '
    );
    out.push('   (gap+1)*1000, KESİN birleşmeme için grace <= gap*1000.)');
    out.push(
      '   Motor ayrıca ' + REVISION_WINDOW_MS + ' ms\'lik bir revizyon penceresi tanır: kesinleşmiş ' +
        'satır, aynı konuşmacıdan gelen ve onun uzantısı olan yeni metinle yerinde güncellenir.'
    );
  } else {
    out.push('  Grace kaynaklı bölünme yok — mevcut ayar uygun.');
  }
  out.push('  (Kesişme kaynaklı bölünmeler ayarla düzelmez.)');
  out.push('');
  return out;
}

module.exports = {
  parseTranscript,
  classify,
  analyzeTranscript,
  buildReport,
  normalize,
  isRevision,
  isSameSpeaker,
  mergesAtGrace,
  mergesAtRevisionWindow,
  mergesInEngine,
  mergeGuaranteedGraceMs,
  noMergeGuaranteedGraceMs,
  DEFAULT_GRACE_MS,
  REVISION_WINDOW_MS,
  MIN_GRACE_MS,
  MAX_GRACE_MS,
  NO_TIMESTAMP_WARNING
};

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Kullanım: node tools/analyze-transcript.js <döküm.txt>');
    process.exit(1);
  }

  if (!fs.existsSync(file)) {
    console.error(`Dosya bulunamadı: ${file}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf8');
  const result = analyzeTranscript(raw);
  console.log(buildReport(result, path.basename(file)).join('\n'));
}
