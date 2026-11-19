/**
 * Dışa aktarma formatlayıcı testleri.
 * Çalıştırma: node --test test/formatters.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  formatTimestamp,
  formatSessionText,
  formatSessionMarkdown,
  formatSessionJson,
  formatSessionSrt,
  formatSessionVtt,
  formatSession,
  buildPlainTranscript,
} = require('../extension/src/lib/formatters.js');

const START = 1700000000000;

function createSession() {
  return {
    id: 's-test',
    title: 'Ürün Toplantısı',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    startedAt: START,
    endedAt: START + 12000,
    lines: [
      {
        id: 'l1',
        speaker: 'Kerem',
        text: 'Merhaba herkese',
        startedAt: START,
        endedAt: START + 2000,
        seq: 1,
      },
      {
        id: 'l2',
        speaker: 'Ayşe',
        text: 'İyiyim, teşekkürler',
        startedAt: START + 5000,
        endedAt: START + 9000,
        seq: 2,
      },
      {
        id: 'l3',
        speaker: 'Kerem',
        text: 'Toplantıya başlayalım',
        startedAt: START + 11000,
        endedAt: START + 12000,
        seq: 3,
      },
    ],
  };
}

test('10) TXT çıktısı konuşmacı adı ve zaman damgası içerir', () => {
  const text = formatSessionText(createSession());

  assert.ok(text.includes('Kerem'), 'konuşmacı adı olmalı');
  assert.ok(text.includes('[00:00:00]'), 'zaman damgası olmalı');
  assert.ok(text.includes('[00:00:05] Ayşe: İyiyim, teşekkürler'));
  assert.ok(text.includes('Merhaba herkese'));
});
test('10b) TXT satırları arasında boş satır yoktur', () => {
  const session = createSession();
  const text = formatSessionText(session, { includeHeader: false });
  const rows = text.split('\n');

  assert.strictEqual(rows.length, 3);
  rows.forEach((row) => {
    assert.notStrictEqual(row.trim(), '', 'satırlar arasında boş satır olmamalı');
  });
});

test('11) Markdown çıktısı "## Konuşma" başlığını içerir', () => {
  const md = formatSessionMarkdown(createSession());

  assert.ok(md.includes('## Konuşma'));
  assert.ok(md.includes('# Ürün Toplantısı'));
  assert.ok(md.includes('- Katılımcılar:'), 'katılımcı listesi olmalı');
  assert.ok(md.includes('**Kerem:**'));
  assert.ok(md.includes('[00:00:11] **Kerem:** Toplantıya başlayalım'));
});

test('12) JSON çıktısı parse edilebilir ve lines doğru uzunlukta', () => {
  const raw = formatSessionJson(createSession());
  const parsed = JSON.parse(raw);

  assert.strictEqual(parsed.lines.length, 3);
  assert.strictEqual(parsed.title, 'Ürün Toplantısı');
  assert.strictEqual(parsed.meetingUrl, 'https://meet.google.com/abc-defg-hij');
  assert.strictEqual(parsed.startedAt, START);
  assert.strictEqual(parsed.durationMs, 12000);
  assert.deepStrictEqual(parsed.participants, ['Kerem', 'Ayşe']);
});

test('13) SRT "-->" ve virgüllü milisaniye içerir', () => {
  const srt = formatSessionSrt(createSession());

  assert.ok(srt.includes('-->'));
  assert.ok(srt.includes('00:00:00,000 --> 00:00:02,000'));
  assert.ok(srt.includes('00:00:05,000 --> 00:00:09,000'));
  assert.ok(srt.startsWith('1\n'), 'sıra numarası 1 den başlamalı');
  assert.ok(srt.includes('Ayşe: İyiyim, teşekkürler'));
});

test('13b) VTT "WEBVTT" ile başlar', () => {
  const vtt = formatSessionVtt(createSession());

  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('00:00:00.000 --> 00:00:02.000'));
  assert.ok(vtt.includes('Kerem: Merhaba herkese'));
});

test('14) buildPlainTranscript başlık üretir ama zaman damgası içermez', () => {
  const plain = buildPlainTranscript(createSession());

  assert.ok(!plain.includes('['), 'zaman damgası olmamalı');
  assert.ok(!plain.includes('00:00:00'));
  assert.ok(plain.includes('Kerem: Merhaba herkese'));
  assert.ok(plain.includes('Ayşe: İyiyim, teşekkürler'));
});

test('14b) buildPlainTranscript başlığı toplantı kimliğini içerir', () => {
  const plain = buildPlainTranscript(createSession());

  assert.ok(plain.startsWith('Toplantı: Ürün Toplantısı\n'), 'toplantı başlığı olmalı');
  assert.ok(plain.includes('Toplantı Kodu: abc-defg-hij'), 'toplantı kodu olmalı');
  assert.ok(plain.includes('Tarih: '), 'tarih olmalı');
  assert.ok(plain.includes('Süre: 00:00:12'), 'süre olmalı');
  assert.ok(plain.includes('Katılımcılar: Kerem, Ayşe'), 'katılımcılar olmalı');
  assert.ok(plain.includes('Bağlantı: https://meet.google.com/abc-defg-hij'), 'bağlantı olmalı');
  assert.ok(
    plain.includes('\n\nKerem: Merhaba herkese'),
    'başlık ile diyalog arasında boş satır olmalı'
  );
});

test('14c) buildPlainTranscript includeHeader=false ile eski (başlıksız) davranışı verir', () => {
  const plain = buildPlainTranscript(createSession(), { includeHeader: false });

  assert.strictEqual(plain.split('\n').length, 3);
  assert.ok(!plain.includes('Toplantı:'), 'başlık olmamalı');
  assert.ok(plain.includes('Kerem: Merhaba herkese'));
});

test('15) formatTimestamp saat ve dakika biçimini doğru üretir', () => {
  assert.strictEqual(formatTimestamp(0), '00:00:00');
  assert.strictEqual(formatTimestamp(83000), '00:01:23');
  assert.strictEqual(formatTimestamp(83000, { withHours: false }), '01:23');
  assert.strictEqual(formatTimestamp(3600000), '01:00:00');
});

test('16) formatSession ayırıcı doğru biçimi seçer', () => {
  const session = createSession();

  assert.strictEqual(formatSession(session, 'md'), formatSessionMarkdown(session));
  assert.strictEqual(formatSession(session, 'txt'), formatSessionText(session));
  assert.strictEqual(formatSession(session, 'json'), formatSessionJson(session));
  assert.strictEqual(formatSession(session, 'srt'), formatSessionSrt(session));
  assert.strictEqual(formatSession(session, 'vtt'), formatSessionVtt(session));
  assert.ok(formatSession(session, 'bilinmeyen').includes('Kerem'), 'bilinmeyen biçimde txt dönmeli');
});

test('17) Boş metinli satırlar atlanır', () => {
  const session = createSession();
  session.lines.push({ id: 'l4', speaker: 'Kerem', text: '   ', startedAt: START, endedAt: START });

  assert.strictEqual(formatSessionJson(session).includes('"l4"'), false);
  assert.strictEqual(buildPlainTranscript(session, { includeHeader: false }).split('\n').length, 3);
});

test('18) Konuşmacı adı boşsa fallback kullanılır', () => {
  const session = createSession();
  session.lines[0].speaker = '';

  assert.ok(formatSessionText(session).includes('Bilinmeyen: Merhaba herkese'));
  assert.ok(formatSessionText(session, { speakerFallback: 'Katılımcı' }).includes('Katılımcı:'));
});

test('19) includeTimestamps=false zaman damgalarını kaldırır', () => {
  const text = formatSessionText(createSession(), { includeTimestamps: false });

  assert.ok(!text.includes('[00:00:00]'));
  assert.ok(text.includes('Kerem: Merhaba herkese'));
});

test('20) TXT başlığı toplantı kodunu ve bağlantıyı içerir', () => {
  const session = createSession();
  session.meetingCode = 'xyz-uvw-rst';
  const text = formatSessionText(session);

  assert.ok(text.includes('Toplantı Kodu: xyz-uvw-rst'), 'toplantı kodu olmalı');
  assert.ok(text.includes('Bağlantı: https://meet.google.com/abc-defg-hij'), 'bağlantı olmalı');
});

test('20b) TXT başlığında toplantı kodu bağlantıdan türetilir', () => {
  const session = createSession();
  delete session.meetingCode;
  const text = formatSessionText(session);

  assert.ok(text.includes('Toplantı Kodu: abc-defg-hij'), 'kod bağlantıdan türetilmeli');
});

test('20c) Toplantı kodu ve bağlantı yoksa başlıkta o satırlar yazılmaz', () => {
  const session = createSession();
  delete session.meetingCode;
  delete session.meetingUrl;
  const text = formatSessionText(session);

  assert.ok(!text.includes('Toplantı Kodu:'), 'toplantı kodu satırı olmamalı');
  assert.ok(!text.includes('Bağlantı:'), 'bağlantı satırı olmamalı');
});

test('21) Markdown başlığı toplantı kodu ve bağlantıyı liste öğesi olarak içerir', () => {
  const session = createSession();
  session.meetingCode = 'xyz-uvw-rst';
  const md = formatSessionMarkdown(session);

  assert.ok(md.includes('- Toplantı Kodu: xyz-uvw-rst'), 'toplantı kodu olmalı');
  assert.ok(md.includes('- Bağlantı: https://meet.google.com/abc-defg-hij'), 'bağlantı olmalı');
});

test('22) JSON çıktısı meetingCode alanını içerir', () => {
  const session = createSession();
  session.meetingCode = 'xyz-uvw-rst';
  const parsed = JSON.parse(formatSessionJson(session));

  assert.strictEqual(parsed.meetingCode, 'xyz-uvw-rst');
});

test('22b) JSON çıktısında meetingCode bağlantıdan türetilir', () => {
  const session = createSession();
  delete session.meetingCode;
  const parsed = JSON.parse(formatSessionJson(session));

  assert.strictEqual(parsed.meetingCode, 'abc-defg-hij');
});

test('23) Meet yerel kullanıcı etiketi ("Siz") kullanıcı adına çevrilir', () => {
  const session = createSession();
  session.lines[0].speaker = 'Siz';
  session.lines[2].speaker = 'Siz';

  const text = formatSessionText(session);
  assert.ok(text.includes('Ben: Merhaba herkese'), 'diyalogda "Siz" yerine "Ben" olmalı');
  assert.ok(text.includes('Katılımcılar: Ben, Ayşe'), 'katılımcı listesinde "Ben" olmalı');
  assert.ok(!text.includes('Siz'), '"Siz" etiketi çıktıda kalmamalı');
});

test('23b) Yerel kullanıcı adı ayardan gelir ve büyük/küçük harf duyarsızdır', () => {
  const session = createSession();
  session.lines[0].speaker = 'you';

  const text = formatSessionText(session, { localSpeakerName: 'Kerem' });
  assert.ok(text.includes('Kerem: Merhaba herkese'), 'özel ad kullanılmalı');
  assert.ok(text.includes('Katılımcılar: Kerem, Ayşe'), 'katılımcı listesinde özel ad olmalı');
});

test('23c) Yerel kullanıcı adı boşsa varsayılana döner', () => {
  const session = createSession();
  session.lines[0].speaker = 'Siz';

  const text = formatSessionText(session, { localSpeakerName: '   ' });
  assert.ok(text.includes('Ben: Merhaba herkese'), 'varsayılan ad kullanılmalı');
});

test('23d) Sen, Tu, Du ve Sie gerçek ad olarak kalır; Siz ve You yerel ada döner', () => {
  const speakers = ['Sen', 'Sena', 'Senem', 'Siz', 'Tu', 'Du', 'Sie', 'You', 'Ali'];
  const session = createSession();
  session.lines = speakers.map((speaker, index) => ({
    id: 'n' + index,
    speaker,
    text: 'satır',
    startedAt: START + index * 1000,
    endedAt: START + index * 1000 + 500,
    seq: index + 1,
  }));

  const text = formatSession(session, 'txt', {
    localSpeakerName: 'Deniz',
    includeHeader: false,
    includeTimestamps: false,
  });

  assert.deepStrictEqual(
    text.split('\n').map((line) => line.split(': ')[0]),
    ['Sen', 'Sena', 'Senem', 'Deniz', 'Tu', 'Du', 'Sie', 'Deniz', 'Ali']
  );
});
