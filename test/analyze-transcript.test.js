/**
 * Döküm analiz aracı testleri.
 *
 * Çalıştırma: node --test test/analyze-transcript.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  analyzeTranscript,
  parseTranscript,
  buildReport,
  isRevision,
  normalize,
  isSameSpeaker,
  mergesAtGrace,
  mergesAtRevisionWindow,
  mergesInEngine,
  mergeGuaranteedGraceMs,
  noMergeGuaranteedGraceMs,
  DEFAULT_GRACE_MS,
  REVISION_WINDOW_MS,
  NO_TIMESTAMP_WARNING
} = require('../tools/analyze-transcript.js');

// Araç, birleştirme kuralını motorun kendisinden almalı.
const MNAEngine = require('../extension/src/content/transcript-engine.js');

const TOOL_PATH = path.join(__dirname, '..', 'tools', 'analyze-transcript.js');

const SAMPLE = `Toplantı: Haftalık Sync
Tarih: 06.11.2026 17:00
Süre: 00:00:30
Katılımcılar: Kerem, Elif

[00:00:00] Kerem: Merhaba.
[00:00:02] Kerem: Merhaba. Nasılsın?
[00:00:05] Elif: İyiyim.
[00:00:09] Kerem: Teşekkürler.
[00:00:09] Elif: Ben de.
[00:00:10] Kerem: Teşekkürler. Görüşürüz.
`;

/** Zaman damgası olmayan (yanlış biçimli) döküm. */
const TIMELESS = `Merhaba.
Nasılsın?
Teşekkürler.
`;

test('başlık bloğu ve konuşma satırları ayrıştırılır', () => {
  const parsed = parseTranscript(SAMPLE);
  assert.equal(parsed.meta['Toplantı'], 'Haftalık Sync');
  assert.equal(parsed.meta['Süre'], '00:00:30');
  assert.equal(parsed.meta['Katılımcılar'], 'Kerem, Elif');
  assert.equal(parsed.rows.length, 6);
  assert.equal(parsed.rows[0].speaker, 'Kerem');
  assert.equal(parsed.rows[0].text, 'Merhaba.');
  assert.equal(parsed.rows[0].seconds, 0);
  assert.equal(parsed.rows[2].seconds, 5);
});

test('konuşmacılar benzersiz listelenir', () => {
  const result = analyzeTranscript(SAMPLE);
  assert.deepEqual(result.speakers, ['Kerem', 'Elif']);
});

test('aynı konuşmacının ön eki olan satırlar grace kaynaklı sayılır', () => {
  const result = analyzeTranscript(SAMPLE);
  assert.equal(result.graceSplits.length, 1);
  assert.equal(result.graceSplits[0].gap, 2);
  assert.equal(result.graceSplits[0].cur.text, 'Merhaba.');
});

test('araya giren konuşmacı kesişme olarak sınıflanır', () => {
  const result = analyzeTranscript(SAMPLE);
  // Kerem "Teşekkürler." / Elif "Ben de." / Kerem "Teşekkürler. Görüşürüz."
  assert.ok(result.interruptionSplits.length >= 1);
  const item = result.interruptionSplits[0];
  assert.equal(item.first.speaker, 'Kerem');
  assert.equal(item.middle.speaker, 'Elif');
  assert.equal(item.last.speaker, 'Kerem');
});

test('temiz dökümde tekrar bulunmaz', () => {
  const clean = `Toplantı: X
Tarih: 06.11.2026
Süre: 00:00:10
Katılımcılar: A

[00:00:00] A: Tamam.
[00:00:03] B: Anladım.
[00:00:06] A: Haydi.
`;
  const result = analyzeTranscript(clean);
  assert.equal(result.graceSplits.length, 0);
  assert.equal(result.interruptionSplits.length, 0);
});

test('isRevision motorun isContinuation kuralıyla birebir aynı sonucu verir', () => {
  const pairs = [
    ['Merhaba.', 'Merhaba. Nasılsın?'],
    ['Merhaba.', 'merhaba nasılsın'],
    ['Merhaba', 'Merhaba!'],
    ['Bugün hava güzel', 'Yarın yağmur yağacak'],
    ['abc', 'abcd'],
    ['abcd', 'abc'],
    ['', 'abc'],
    ['abc', ''],
    ['  Merhaba   dünya  ', 'Merhaba dünya']
  ];
  for (const [older, newer] of pairs) {
    assert.equal(
      isRevision(older, newer),
      MNAEngine.isContinuation(older, newer),
      'isRevision motorla uyuşmuyor: ' + JSON.stringify([older, newer])
    );
  }
});

test('isRevision, cümle sonu noktası atılmış gövde önekini motorla birlikte devam sayar', () => {
  // Meet "Merhaba." yazıp cümleyi "merhaba nasılsın" diye uzatır. Sondaki nokta
  // atılınca gövde "merhaba", yeni metnin birebir önekidir; motor artık devam der.
  // Eski test bu çifti bilerek false tutuyordu; o davranış kopya satır bırakıyordu.
  assert.equal(MNAEngine.isContinuation('Merhaba.', 'merhaba nasılsın'), true);
  assert.equal(isRevision('Merhaba.', 'merhaba nasılsın'), true);
  // Harf düşüren kısaltma devam değildir.
  assert.equal(MNAEngine.isContinuation('biliyorum.', 'biliyom'), false);
  assert.equal(isRevision('biliyorum.', 'biliyom'), false);
  // Ön ek de önektir: motor "biri diğerinin öneki ya da uzantısı" kabul eder.
  assert.equal(isRevision('Merhaba. Nasılsın?', 'Merhaba.'), true);
});

test('normalize motorun normalizeText davranışıyla aynıdır (noktalama silinmez)', () => {
  assert.equal(normalize('  Merhaba   dünya!  '), 'Merhaba dünya!');
  assert.equal(normalize('Merhaba. Nasılsın?'), MNAEngine.normalizeText('Merhaba. Nasılsın?'));
  assert.equal(normalize('Merhaba. Nasılsın?'), 'Merhaba. Nasılsın?');
  assert.equal(normalize(null), '');
});

test('konuşmacı karşılaştırması motorla aynı (birebir, boşluktan arındırılmış)', () => {
  assert.equal(isSameSpeaker('Kerem', 'Kerem'), true);
  assert.equal(isSameSpeaker(' Kerem ', 'Kerem'), true);
  assert.equal(isSameSpeaker('barış', 'Kerem'), false);
});

test('grace sınırları: gap=1 -> 2000 ms, gap=2 -> 3000 ms (kesin birleşme)', () => {
  assert.equal(mergeGuaranteedGraceMs(1), 2000);
  assert.equal(mergeGuaranteedGraceMs(2), 3000);
  assert.equal(mergeGuaranteedGraceMs(0), 1000);
  // KESİN birleşmeme sınırı: gap * 1000
  assert.equal(noMergeGuaranteedGraceMs(1), 1000);
  assert.equal(noMergeGuaranteedGraceMs(2), 2000);
});

test('grace aday taraması motor eşiğini kullanır (gap*1000 < grace)', () => {
  assert.equal(mergesAtGrace(2, DEFAULT_GRACE_MS), true);
  assert.equal(mergesAtGrace(3, DEFAULT_GRACE_MS), false);
  assert.equal(mergesAtGrace(1, 1000), false);
});

test('zaman damgasız dökümde araç uyarır, "temiz" demez', () => {
  const result = analyzeTranscript(TIMELESS);
  assert.equal(result.rows.length, 0);
  assert.equal(result.hasTimestamps, false);
  assert.ok(
    result.warnings.some((w) => w.includes('zaman damgalı satır bulunamadı')),
    'zaman damgası uyarısı üretilmeli'
  );
  assert.ok(result.warnings.includes(NO_TIMESTAMP_WARNING));

  const report = buildReport(result, 'zaman-damgasiz.txt').join('\n');
  assert.ok(!report.includes('döküm temiz'), 'zaman damgasız dökümde "temiz" denmemeli');
  assert.ok(report.includes('zaman damgalı satır bulunamadı'));
});

test('zaman damgalı dökümde zaman damgası uyarısı üretilmez', () => {
  const result = analyzeTranscript(SAMPLE);
  assert.equal(result.hasTimestamps, true);
  assert.ok(!result.warnings.includes(NO_TIMESTAMP_WARNING));
  const report = buildReport(result, 'ornek.txt').join('\n');
  assert.ok(report.includes('döküm temiz') || report.includes('GRACE kaynaklı'));
});

test('rapor grace sınırlarını ve varsayılan grace sonucunu gösterir', () => {
  const result = analyzeTranscript(SAMPLE);
  const report = buildReport(result, 'ornek.txt').join('\n');
  // gap=2 -> kesin birleşme 3000 ms, kesin birleşmeme 2000 ms
  assert.ok(report.includes('KESİN birleşir: grace >= 3000 ms'), report);
  assert.ok(report.includes('KESİN birleşmez: grace <= 2000 ms'), report);
  assert.ok(report.includes('Varsayılan grace 2500 ms ile birleşen çift: 1/1'), report);
});

test('CLI zaman damgasız dökümde "temiz" demez, uyarı verir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mna-analyze-'));
  const file = path.join(dir, 'zaman-damgasiz.txt');
  fs.writeFileSync(file, TIMELESS, 'utf8');
  try {
    const out = execFileSync(process.execPath, [TOOL_PATH, file], { encoding: 'utf8' });
    assert.ok(!out.includes('döküm temiz'), 'CLI "temiz" dememeli:\n' + out);
    assert.ok(out.includes('zaman damgalı satır bulunamadı'), out);
    assert.ok(out.includes('UYARILAR'), out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('boş döküm istisna atmaz', () => {
  const result = analyzeTranscript('');
  assert.equal(result.rows.length, 0);
  assert.equal(result.speakers.length, 0);
  assert.equal(result.graceSplits.length, 0);
});

test('revizyon penceresi motorunkiyle aynı değerdedir', () => {
  assert.equal(REVISION_WINDOW_MS, MNAEngine.REVISION_WINDOW_MS);
});

test('grace yetmezse revizyon penceresi çifti birleştirir', () => {
  // Gerçek test verisindeki "ön ek + uzantı" çifti: 9 sn aralık.
  // Grace 2500 ms bunu birleştiremez, revizyon penceresi birleştirir.
  assert.equal(mergesAtGrace(9, 2500), false, 'grace yolu yetmemeli');
  assert.equal(mergesAtRevisionWindow(9, 2500), true, 'revizyon yolu birleştirmeli');
  assert.equal(mergesInEngine(9, 2500), true);
});

test('çok uzun aralık ne grace ile ne revizyon penceresiyle birleşmez', () => {
  assert.equal(mergesAtGrace(120, 2500), false);
  assert.equal(mergesAtRevisionWindow(120, 2500), false);
  assert.equal(mergesInEngine(120, 2500), false);
});

test('rapor revizyon penceresini ve yol ayrımını gösterir', () => {
  const result = analyzeTranscript(SAMPLE);
  const report = buildReport(result, 'ornek.txt').join('\n');
  assert.ok(report.includes('Revizyon penceresi: ' + REVISION_WINDOW_MS + ' ms'), report);
  assert.ok(/birleşen çift: \d+\/\d+ \(grace yolu \d+, revizyon penceresi \d+\)/.test(report), report);
});
