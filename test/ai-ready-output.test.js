/**
 * "Yapay zekâya hazır çıktı" kabul testleri.
 *
 * Projenin asıl işlevi: toplantı konuşmasını, yapay zekânın bir yönetici
 * özeti ("patron haberi") üretebileceği biçimde dışa aktarmak. Bu testler,
 * dışa aktarılan metnin bu işe yarayacak yapıda olduğunu doğrular.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const F = require('../extension/src/lib/formatters.js');
const { session } = require('./fixtures/sample-session.js');

test('TXT çıktısı başlık bloğu içerir (toplantı, tarih, süre, katılımcılar)', () => {
  const txt = F.formatSessionText(session, {});
  assert.match(txt, /Haftalık Ürün Planlama Toplantısı/);
  assert.match(txt, /2026/);
  assert.match(txt, /Katılımcılar/);
  assert.match(txt, /Kerem Yılmaz/);
  assert.match(txt, /Elif Demir/);
  assert.match(txt, /Murat Öztürk/);
});

test('TXT çıktısında her konuşma satırı zaman damgası ve konuşmacı taşır', () => {
  const txt = F.formatSessionText(session, {});
  const body = txt.split(/\n\s*\n/).pop();
  const rows = body.split('\n').filter((line) => line.trim().length);
  assert.equal(rows.length, session.lines.length);
  for (const row of rows) {
    assert.match(row, /^\[\d{2}:\d{2}:\d{2}\]\s+.+?:\s+\S/, `satır biçimi bozuk: ${row}`);
  }
});

test('TXT çıktısında zaman damgaları oturum başlangıcına göre artar', () => {
  const txt = F.formatSessionText(session, {});
  const stamps = Array.from(txt.matchAll(/\[(\d{2}):(\d{2}):(\d{2})\]/g)).map((m) => {
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  });
  assert.ok(stamps.length >= session.lines.length);
  for (let i = 1; i < stamps.length; i += 1) {
    assert.ok(stamps[i] >= stamps[i - 1], `zaman damgası geri gidiyor: ${stamps[i - 1]} -> ${stamps[i]}`);
  }
});

test('Zaman damgasız düz metin, konuşmacı ve metni korur ama zaman içermez', () => {
  const plain = F.buildPlainTranscript(session, {});
  assert.match(plain, /Kerem Yılmaz: Haftalık planlamayı başlayalım\./);
  assert.doesNotMatch(plain, /\[\d{2}:\d{2}:\d{2}\]/);
});

test('Düz metin başlığı toplantı bağlamını taşır (yapay zekâya yapıştırma yolu)', () => {
  const plain = F.buildPlainTranscript(session, {});
  assert.match(plain, /Toplantı: Haftalık Ürün Planlama Toplantısı/);
  assert.match(plain, /Katılımcılar:/);
  assert.match(plain, /Süre:/);
});

test('Başlık kapatılınca düz metin yalnızca konuşma satırlarından oluşur', () => {
  const plain = F.buildPlainTranscript(session, { includeHeader: false });
  assert.doesNotMatch(plain, /Toplantı:/);
  const rows = plain.split('\n').filter((line) => line.trim().length);
  assert.equal(rows.length, session.lines.length);
});

test('Markdown çıktısı rapor okunabilirliği için başlık ve konuşma bölümü içerir', () => {
  const md = F.formatSessionMarkdown(session, {});
  assert.match(md, /^#\s+/m);
  assert.match(md, /##\s+Konuşma/);
  assert.match(md, /\*\*Kerem Yılmaz:\*\*/);
  assert.match(md, /Katılımcılar/);
});

test('JSON çıktısı makine tarafından okunabilir ve satırları içerir', () => {
  const parsed = JSON.parse(F.formatSessionJson(session, {}));
  assert.equal(parsed.lines.length, session.lines.length);
  assert.ok(Array.isArray(parsed.participants));
  assert.equal(parsed.participants.length, 3);
  assert.equal(typeof parsed.durationMs, 'number');
  assert.ok(parsed.durationMs > 0);
});

test('SRT ve VTT çıktıları oynatıcıların beklediği biçimdedir', () => {
  const srt = F.formatSessionSrt(session, {});
  assert.match(srt, /^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/);
  assert.equal(srt.split(/\n\s*\n/).filter((b) => b.trim()).length, session.lines.length);

  const vtt = F.formatSessionVtt(session, {});
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.match(vtt, /\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/);
});

test('Boş oturumda çıktı üretilebilir ve istisna atmaz', () => {
  const empty = Object.assign({}, session, { lines: [], endedAt: null });
  for (const format of ['txt', 'md', 'json', 'srt', 'vtt']) {
    const out = F.formatSession(empty, format, {});
    assert.equal(typeof out, 'string');
  }
});

test('Konuşmacı bilinmiyorsa yedek ad kullanılır', () => {
  const nameless = Object.assign({}, session, {
    lines: [{ id: 'l1', speaker: '', text: 'Merhaba', startedAt: session.startedAt, endedAt: session.startedAt + 1000, seq: 1 }]
  });
  const txt = F.formatSessionText(nameless, { speakerFallback: 'Katılımcı' });
  assert.match(txt, /Katılımcı: Merhaba/);
});

test('Yapay zekâ paketi: hazır istem + başlıklı, zaman damgalı transkript; doldurulacak boşluk yok', () => {
  const pack = F.buildAiPackage(session, {});
  assert.ok(pack.startsWith(F.AI_SUMMARY_PROMPT), 'paket istemle başlamalı');
  // İki tür için kısa biçim
  for (const heading of ['Ne öğretildi', 'Akılda kalması gereken', 'Uygulama adımları', 'Alınan kararlar', 'Aksiyonlar', 'Açık kalan konular']) {
    assert.ok(pack.indexOf(heading) !== -1, heading + ' bölümü istemde olmalı');
  }
  // Kısa tutma ve gereksizi dışarıda bırakma kuralları
  assert.match(pack, /500 kelime/);
  assert.match(pack, /Tablo kullanma/);
  assert.match(pack, /kişisel projelerini/);
  assert.doesNotMatch(F.AI_SUMMARY_PROMPT, /Katılımcı katkıları|Şüpheli yerler:/);
  // Uydurmama ve otomatik altyazı uyarısı
  assert.match(pack, /uydurma/i);
  assert.match(pack, /otomatik/i);
  // Transkript: başlık bloğu + zaman damgalı satırlar, ayraçlar arasında
  const start = pack.indexOf('===== TRANSKRİPT BAŞLANGICI =====');
  const end = pack.indexOf('===== TRANSKRİPT SONU =====');
  assert.ok(start > 0 && end > start);
  const body = pack.slice(start, end);
  assert.match(body, /Haftalık Ürün Planlama Toplantısı/);
  assert.match(body, /\[\d{2}:\d{2}:\d{2}\]\s+.+?:\s+\S/);
  for (const line of session.lines) {
    assert.ok(body.indexOf(line.text.trim()) !== -1, 'her satır pakette olmalı');
  }
  // Doldurulacak yer tutucu kalmamalı
  assert.doesNotMatch(F.AI_SUMMARY_PROMPT, /\{\{|\}\}|\[BURAYA|<[A-ZÇĞİÖŞÜ ]+>|XXX|\.\.\.\.\./);
});

test('Yapay zekâ paketi: zaman damgası ayarı kapalı olsa da damga korunur', () => {
  const pack = F.buildAiPackage(session, { includeTimestamps: false });
  assert.match(pack, /\[\d{2}:\d{2}:\d{2}\]/);
});
