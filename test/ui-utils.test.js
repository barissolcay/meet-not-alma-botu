/**
 * Arayüz yardımcı fonksiyon testleri (utils.js).
 * Çalıştırma: node --test test/ui-utils.test.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFilename,
  matchesQuery,
  filterSessionsByQuery,
  formatDuration,
  formatDateTime,
  buildLiveExportSession,
  resolveCaptionsNotice,
} = require('../extension/src/lib/utils.js');
const { formatSessionText, buildPlainTranscript } = require('../extension/src/lib/formatters.js');

// Yerel saatle kurulur; dosya adındaki zaman damgası saat dilimine bağlı olmamalı.
const START = new Date(2026, 10, 6, 14, 0, 0).getTime();

function createSession() {
  return {
    id: 's-test',
    title: 'Haftalık Planlama',
    meetingCode: 'abc-defg-hij',
    startedAt: START,
    endedAt: START + 5 * 60 * 1000 + 30 * 1000,
    lines: [
      { id: 'l1', speaker: 'Kerem', text: 'Haftalık planlamayı başlayalım.' },
      { id: 'l2', speaker: 'Elif', text: 'Onboarding akışında iki ekran kaldı.' },
    ],
  };
}

test('buildFilename toplantı kodu ve zaman damgasıyla dosya adı üretir', () => {
  const name = buildFilename(createSession(), 'txt');

  assert.equal(name, 'meet-transkript-abc-defg-hij-20261106-140000.txt');
});

test('buildFilename toplantı kodu yoksa oturum adını kullanır', () => {
  const session = createSession();
  delete session.meetingCode;

  assert.match(buildFilename(session, 'md'), /^meet-transkript-oturum-\d{8}-\d{6}\.md$/);
});

test('buildFilename geçersiz karakterleri temizler', () => {
  const session = createSession();
  session.meetingCode = 'abc defg/hij';

  assert.match(buildFilename(session, 'json'), /^meet-transkript-abcdefghij-\d{8}-\d{6}\.json$/);
});

test('matchesQuery boş sorguda tüm oturumları eşleştirir', () => {
  const session = createSession();

  assert.equal(matchesQuery(session, '', session), true);
  assert.equal(matchesQuery(session, '   ', session), true);
});

test('matchesQuery başlık ve toplantı kodunda arar', () => {
  const session = createSession();

  assert.equal(matchesQuery(session, 'planlama', session), true);
  assert.equal(matchesQuery(session, 'ABC-DEF', session), true);
  assert.equal(matchesQuery(session, 'bulunmayan', session), false);
});

test('matchesQuery satır metninde arar', () => {
  const session = createSession();

  assert.equal(matchesQuery(session, 'onboarding', session), true);
  assert.equal(matchesQuery(session, 'ekran', session), true);
});

test('matchesQuery konuşmacı adında arar', () => {
  const session = createSession();

  assert.equal(matchesQuery(session, 'elif', session), true);
});

test('matchesQuery tam oturum yoksa yalnızca başlık ve kodu arar', () => {
  const session = createSession();

  assert.equal(matchesQuery(session, 'onboarding', null), false);
  assert.equal(matchesQuery(session, 'planlama', null), true);
});

test('geçmiş araması satır cümlesini ve Türkçe harfi bulur', async () => {
  const sentence = 'Yalnızca bu satırda geçen mor menekşe cümlesi.';
  const lineOnly = {
    id: 'line',
    title: 'Toplantı',
    meetingCode: 'aaa-bbbb-ccc',
    lineCount: 1,
  };
  // İ + Ş + I + K. Türkçe katlama: i + ş + ı + k ("işık"), "ışık" değil.
  const isik = {
    id: 'isik',
    title: 'İŞIK',
    meetingCode: 'ddd-eeee-fff',
    lineCount: 0,
  };
  const kapi = {
    id: 'kapi',
    title: 'KAPI',
    meetingCode: 'ggg-hhhh-iii',
    lineCount: 0,
  };
  const other = {
    id: 'other',
    title: 'Bütçe',
    meetingCode: 'jjj-kkkk-lll',
    lineCount: 1,
  };
  const sessions = [lineOnly, isik, kapi, other];
  const full = {
    line: { lines: [{ speaker: 'Ayşe', text: sentence }] },
    other: { lines: [{ speaker: 'Ali', text: 'Bambaşka bir bütçe konusu.' }] },
  };

  assert.deepEqual([...isik.title].map((ch) => ch.codePointAt(0)), [0x130, 0x15e, 0x49, 0x4b]);
  const queryIsik = 'işık';
  const queryDotless = 'ışık';
  const queryKapi = 'kapı';
  assert.equal(isik.title.toLocaleLowerCase('tr'), queryIsik);
  assert.deepEqual([...queryIsik].map((ch) => ch.codePointAt(0)), [0x69, 0x15f, 0x131, 0x6b]);
  assert.deepEqual([...queryDotless].map((ch) => ch.codePointAt(0)), [0x131, 0x15f, 0x131, 0x6b]);
  assert.deepEqual([...queryKapi].map((ch) => ch.codePointAt(0)), [0x6b, 0x61, 0x70, 0x131]);
  assert.equal(matchesQuery(lineOnly, sentence, null), false);
  assert.equal(matchesQuery(lineOnly, sentence, full.line), true);

  let reads = 0;
  const loadFull = (session) => {
    reads += 1;
    return full[session.id] || null;
  };

  const untouched = await filterSessionsByQuery(sessions, '   ', loadFull);
  assert.equal(untouched, sessions);
  assert.equal(reads, 0);

  const byLine = await filterSessionsByQuery(sessions, sentence, loadFull);
  assert.deepEqual(byLine.map((item) => item.id), ['line']);

  const byIsik = await filterSessionsByQuery(sessions, queryIsik, loadFull);
  assert.deepEqual(byIsik.map((item) => item.id), ['isik']);

  const byKapi = await filterSessionsByQuery(sessions, queryKapi, loadFull);
  assert.deepEqual(byKapi.map((item) => item.id), ['kapi']);

  assert.deepEqual(await filterSessionsByQuery(sessions, queryDotless, loadFull), []);
  assert.deepEqual(await filterSessionsByQuery(sessions, 'işik', loadFull), []);
  assert.deepEqual(await filterSessionsByQuery(sessions, 'isik', loadFull), []);
  assert.deepEqual(await filterSessionsByQuery(sessions, 'kapi', loadFull), []);
  assert.deepEqual(await filterSessionsByQuery(sessions, 'hiçbir oturumda yok qzx', loadFull), []);

  const history = fs.readFileSync(
    path.join(__dirname, '../extension/src/history/history.js'),
    'utf8'
  );
  assert.match(history, /filterSessionsByQuery/);
  assert.match(history, /getSession/);
  assert.equal(history.includes('toLowerCase('), false);
});

test('formatDuration dakika ve saniye biçimini üretir', () => {
  const session = createSession();

  assert.equal(formatDuration(session), '5 dk 30 sn');
});

test('formatDuration saat biçimini üretir', () => {
  const session = createSession();
  session.endedAt = session.startedAt + (90 * 60 + 5 * 60) * 1000;

  assert.equal(formatDuration(session), '1 sa 35 dk');
});

test('formatDuration bitmemiş oturumda geçen süreyi hesaplar', () => {
  const session = createSession();
  session.startedAt = Date.now() - 90 * 1000;
  delete session.endedAt;

  assert.match(formatDuration(session), /^1 dk \d+ sn$/);
});

test('formatDuration son satırı 10 dakikadan eski yarım kalmış oturumda son satıra kadar hesaplar', () => {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const staleWithEndedAt = {
    startedAt: thirtyDaysAgo,
    endedAt: null,
    lines: [
      { speaker: 'Kerem', text: 'Başladık', startedAt: thirtyDaysAgo, endedAt: thirtyDaysAgo + 5000 },
      {
        speaker: 'Elif',
        text: 'Son söz',
        startedAt: thirtyDaysAgo + 12 * 60 * 1000,
        endedAt: thirtyDaysAgo + 12 * 60 * 1000 + 15 * 1000,
      },
    ],
  };
  assert.equal(formatDuration(staleWithEndedAt), '12 dk 15 sn');

  const staleWithStartedAtOnly = {
    startedAt: thirtyDaysAgo,
    lines: [
      {
        speaker: 'Kerem',
        text: 'Yarım kalan satır',
        startedAt: thirtyDaysAgo + 8 * 60 * 1000 + 5 * 1000,
      },
    ],
  };
  assert.equal(formatDuration(staleWithStartedAtOnly), '8 dk 5 sn');
});

test('formatDuration son satırı 10 dakikadan yeni canlı oturumda şimdiki zamanı kullanır', () => {
  const now = Date.now();
  const liveSession = {
    startedAt: now - 5 * 60 * 1000,
    endedAt: null,
    lines: [
      {
        speaker: 'Kerem',
        text: 'Az önce konuşuldu',
        startedAt: now - 2 * 60 * 1000 - 10 * 1000,
        endedAt: now - 2 * 60 * 1000,
      },
    ],
  };
  assert.match(formatDuration(liveSession), /^5 dk \d+ sn$/);
});

test('formatDateTime başlangıç zamanını biçimlendirir', () => {
  const text = formatDateTime(new Date(2026, 10, 6, 14, 5).getTime());

  assert.equal(text, 'Başlangıç: 06.11.2026 14:05');
});

test('resolveCaptionsNotice altyazı bölgesi yoksa "missing" döner', () => {
  assert.equal(resolveCaptionsNotice({ regionFound: false, detected: false }, true), 'missing');
});

test('resolveCaptionsNotice CC açık ama blok yoksa "unreadable" döner', () => {
  // Kritik ayrım: CC zaten açık, bu yüzden "CC'yi aç" uyarısı gösterilmemeli.
  assert.equal(
    resolveCaptionsNotice({ regionFound: true, detected: false }, true),
    'unreadable'
  );
});

test('resolveCaptionsNotice her şey yolundaysa uyarı üretmez', () => {
  assert.equal(resolveCaptionsNotice({ regionFound: true, detected: true }, true), null);
});

test('resolveCaptionsNotice içerik betiğine ulaşılamadıysa uyarı üretmez', () => {
  assert.equal(resolveCaptionsNotice(null, false), null);
  assert.equal(resolveCaptionsNotice({ regionFound: false, detected: false }, false), null);
});

test('canlı dışa aktarım, kayıt durduktan sonra toplantı saatini korur', () => {
  const start = new Date(2026, 10, 7, 14, 0, 0).getTime();
  const lines = [
    {
      id: 'l1',
      speaker: 'Siz',
      text: 'Altın kırmızı çiçek ışığı.',
      startedAt: start,
      endedAt: start + 4000,
      seq: 1,
    },
    {
      id: 'l2',
      speaker: 'Elif Demir',
      text: 'Üç yüz yirmi dört adet elma.',
      startedAt: start + 8000,
      endedAt: start + 12000,
      seq: 2,
    },
    {
      id: 'l3',
      speaker: 'Siz',
      text: 'Yarın İstanbul\'dan Ankara\'ya gideceğim.',
      startedAt: start + 20000,
      endedAt: start + 25000,
      seq: 3,
    },
  ];
  const session = buildLiveExportSession({
    meeting: {
      title: 'Haftalık Plan',
      url: 'https://meet.google.com/abc-defg-hij',
      code: 'abc-defg-hij',
    },
    lines: lines,
    captureStartedAt: start,
  });

  assert.equal(session.startedAt, start);
  assert.equal(session.lines, lines, 'satır dizisi aynı kalmalı');
  const txt = formatSessionText(session, { includeTimestamps: true, localSpeakerName: 'Ben' });
  assert.match(txt, /Tarih: 07\.11\.2026 14:00/);
  assert.match(txt, /Süre: 00:00:25/);
  assert.match(txt, /\[00:00:00\] Ben: Altın kırmızı çiçek ışığı\./);
  assert.match(txt, /\[00:00:08\] Elif Demir: Üç yüz yirmi dört adet elma\./);
  assert.match(txt, /\[00:00:20\] Ben: Yarın İstanbul'dan Ankara'ya gideceğim\./);
  assert.equal((txt.match(/\[00:00:00\]/g) || []).length, 1);

  const plain = buildPlainTranscript(session, { localSpeakerName: 'Ben' });
  assert.match(plain, /Tarih: 07\.11\.2026 14:00/);
  assert.match(plain, /Süre: 00:00:25/);
  assert.match(plain, /Ben: Altın kırmızı çiçek ışığı\./);
});

test('canlı dışa aktarım kayıt başlangıcı yoksa ilk satırın saatini kullanır', () => {
  const start = new Date(2026, 10, 7, 14, 0, 0).getTime();
  const session = buildLiveExportSession({
    meeting: { title: 'Haftalık Plan', code: 'abc-defg-hij' },
    lines: [
      { speaker: 'Siz', text: 'Bir', startedAt: start, endedAt: start + 1000 },
      { speaker: 'Siz', text: 'İki', startedAt: start + 9000, endedAt: start + 10000 },
    ],
    captureStartedAt: null,
  });

  assert.equal(session.startedAt, start);
  const txt = formatSessionText(session, { includeTimestamps: true, localSpeakerName: 'Ben' });
  assert.match(txt, /\[00:00:00\] Ben: Bir/);
  assert.match(txt, /\[00:00:09\] Ben: İki/);
});

test('canlı dışa aktarım geçersiz başlangıcı toplantı saati saymaz', () => {
  const start = new Date(2026, 10, 7, 14, 0, 0).getTime();
  for (const invalid of [0, -1, Number.NaN, 'şimdi', '', null, undefined]) {
    const session = buildLiveExportSession({
      lines: [{ speaker: 'Siz', text: 'Bir', startedAt: start, endedAt: start + 1000 }],
      captureStartedAt: invalid,
    });
    assert.equal(session.startedAt, start, String(invalid));
  }
});

test('canlı dışa aktarımda saat hiç yoksa başlangıç boş kalır', () => {
  const session = buildLiveExportSession({
    lines: [{ speaker: 'Siz', text: 'Bir' }],
  });

  assert.equal(session.startedAt, null);
  assert.equal(session.lines.length, 1);
  assert.equal(session.lines[0].text, 'Bir');
});

test('popup indirme anını toplantı başlangıcı yapmaz', () => {
  const popup = fs.readFileSync(
    path.join(__dirname, '../extension/src/popup/popup.js'),
    'utf8'
  );
  assert.equal(popup.includes('startedAt: Date.now()'), false);
  assert.match(popup, /buildLiveExportSession/);
  assert.match(popup, /captureStartedAt: capture\.startedAt/);
});

test('resolveCaptionsNotice eski içerik betiğinde geriye dönük çalışır', () => {
  // regionFound bildirilmemişse eski davranış: okunabilir blok yoksa "missing".
  assert.equal(resolveCaptionsNotice({ detected: false }, true), 'missing');
  assert.equal(resolveCaptionsNotice({ detected: true }, true), null);
});
