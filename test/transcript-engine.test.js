/**
 * Saf transkript motoru testleri.
 * Çalıştırma: node --test test/transcript-engine.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createTranscriptEngine,
} = require('../extension/src/content/transcript-engine.js');

/** Kontrollü (sahte) saat. */
function createClock(start) {
  let current = typeof start === 'number' ? start : 1700000000000;
  return {
    now: function () {
      return current;
    },
    advance: function (ms) {
      current += ms;
      return current;
    },
  };
}

function createEngine(clock, options) {
  const opts = options || {};
  return createTranscriptEngine(
    Object.assign(
      {
        now: clock.now,
        graceMs: 1500,
        junkFilter: true,
        speakerFallback: 'Bilinmeyen',
      },
      opts
    )
  );
}

test('1) Aynı blok metni 3 kez büyürse tek satır üretilir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba nasılsın' });
  const result = engine.observe({
    key: 'b1',
    speaker: 'Kerem',
    text: 'Merhaba nasılsın, iyiyim',
  });

  assert.deepStrictEqual(result.committed, [], 'revizyon sırasında commit olmamalı');

  const flushed = engine.flush().committed;
  assert.strictEqual(flushed.length, 1, 'toplam 1 satır olmalı');
  assert.strictEqual(flushed[0].text, 'Merhaba nasılsın, iyiyim');
  assert.strictEqual(flushed[0].speaker, 'Kerem');
  assert.strictEqual(engine.getLines().length, 1);
});

test('1b) Aynı blok, aynı metin -> hiçbir şey değişmez', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  const first = engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  const second = engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });

  assert.strictEqual(first.committed.length, 0);
  assert.strictEqual(second.committed.length, 0);
  assert.strictEqual(engine.getPending().length, 1, 'tek bekleyen satır olmalı');
  assert.strictEqual(engine.flush().committed.length, 1);
});

test('2) Aynı blok metni kısalırsa (düzeltme) yine 1 satır ve son metin', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba nasılsınız' });
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });

  const lines = engine.flush().committed;
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, 'Merhaba');
});

test('2b) Metin revizyonunda startedAt korunur', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Mer' });
  clock.advance(400);
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });

  const line = engine.getPending()[0];
  assert.strictEqual(line.startedAt, 1700000000000);
  assert.strictEqual(line.text, 'Merhaba');
});

test('3) Konuşmacı değişirse önceki satır eski konuşmacıda kesinleşir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  const result = engine.observe({ key: 'b2', speaker: 'Ayşe', text: 'Selam' });

  assert.strictEqual(result.committed.length, 1);
  assert.strictEqual(result.committed[0].speaker, 'Kerem');

  const flushed = engine.flush().committed;
  assert.strictEqual(flushed.length, 1, 'flush yalnızca bekleyeni kesinleştirir');
  assert.strictEqual(flushed[0].speaker, 'Ayşe');

  const lines = engine.getLines();
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].speaker, 'Kerem');
  assert.strictEqual(lines[0].text, 'Merhaba');
  assert.strictEqual(lines[1].speaker, 'Ayşe');
  assert.strictEqual(lines[1].text, 'Selam');
});

test('3b) Aynı anahtarda konuşmacı değişirse de 2 satır oluşur', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  const result = engine.observe({ key: 'b1', speaker: 'Ayşe', text: 'Selam' });

  assert.strictEqual(result.committed.length, 1);
  assert.strictEqual(result.committed[0].speaker, 'Kerem');
  assert.strictEqual(engine.flush().committed.length, 1);
  assert.strictEqual(engine.getLines().length, 2);
});

test('4) Aynı konuşmacı + yeni blok + devam metni -> 1 satırda birleşir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  const result = engine.observe({
    key: 'b2',
    speaker: 'Kerem',
    text: 'Merhaba nasılsınız',
  });

  assert.deepStrictEqual(result.committed, [], 'devam metni commit tetiklememeli');

  const lines = engine.flush().committed;
  assert.strictEqual(lines.length, 1, 'çift kayıt oluşmamalı');
  assert.strictEqual(lines[0].text, 'Merhaba nasılsınız');
});

test('4b) Aynı konuşmacı, aynı metinle yeniden kurulan blok birleşir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  engine.observe({ key: 'b2', speaker: 'Kerem', text: 'Merhaba' });

  const lines = engine.flush().committed;
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].text, 'Merhaba');
});

test('4c) Farklı konuşmacı + benzer metin birleşmez', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  engine.observe({ key: 'b2', speaker: 'Ayşe', text: 'Merhaba' });

  assert.strictEqual(engine.flush().committed.length, 1);
  assert.strictEqual(engine.getLines().length, 2);
});

test('5) Grace süresi dolunca tick() satırı kesinleştirir', () => {
  const clock = createClock();
  const engine = createEngine(clock, { graceMs: 1500 });

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });

  clock.advance(1499);
  let result = engine.tick();
  assert.strictEqual(result.committed.length, 0, 'grace dolmadan commit olmamalı');

  clock.advance(2);
  result = engine.tick();
  assert.strictEqual(result.committed.length, 1, 'grace dolunca commit olmalı');
  assert.strictEqual(result.committed[0].text, 'Merhaba');
  assert.strictEqual(engine.getLines().length, 1);
});

test('5b) Metin değişirse grace süresi yeniden başlar', () => {
  const clock = createClock();
  const engine = createEngine(clock, { graceMs: 1500 });

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  clock.advance(1400);
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba nasılsın' });
  clock.advance(1400);

  assert.strictEqual(engine.tick().committed.length, 0, 'süre yeniden başlamalı');

  clock.advance(200);
  assert.strictEqual(engine.tick().committed.length, 1);
});

test('6) flush() bekleyen satırları kesinleştirir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  engine.observe({ key: 'b2', speaker: 'Ayşe', text: 'Selam' });

  const flushed = engine.flush().committed;
  assert.strictEqual(flushed.length, 1, 'flush bekleyen satırı kesinleştirir');
  assert.strictEqual(engine.getPending().length, 0, 'bekleyen kalmamalı');
  const lines = engine.getLines();
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].endedAt >= lines[0].startedAt);
});

test('7) Junk filtre arayüz metinlerini satır olarak eklemez', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'frame_person' });
  engine.observe({ key: 'b2', speaker: 'Kerem', text: 'more_vert' });
  engine.observe({ key: 'b3', speaker: 'Kerem', text: 'Turn on captions' });
  engine.observe({ key: 'b4', speaker: 'Kerem', text: 'caption_settings' });
  engine.observe({ key: 'b5', speaker: 'Kerem', text: 'moreVert' });

  assert.strictEqual(engine.getPending().length, 0);
  assert.strictEqual(engine.flush().committed.length, 0);
  assert.strictEqual(engine.getLines().length, 0);
});

test('7b) Boş metin atlanır, konuşmacı boşsa fallback kullanılır', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: '   ' });
  assert.strictEqual(engine.getPending().length, 0);

  engine.observe({ key: 'b2', speaker: '', text: 'Merhaba' });
  const pending = engine.getPending();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].speaker, 'Bilinmeyen');
});

test('7c) Junk filtre kapatılınca arayüz metni geçer', () => {
  const clock = createClock();
  const engine = createEngine(clock, { junkFilter: false });

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'frame_person' });
  assert.strictEqual(engine.getPending().length, 1);
});

test('8) getLines() kopyası dışarıdan değiştirilince iç durum bozulmaz', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  engine.flush();

  const lines = engine.getLines();
  assert.strictEqual(lines.length, 1);

  lines.length = 0;
  lines.push({ id: 'x', speaker: 'X', text: 'sabotaj' });

  const fresh = engine.getLines();
  assert.strictEqual(fresh.length, 1, 'dizi kopyası dönmeli');
  assert.strictEqual(fresh[0].text, 'Merhaba');
});

test('8b) getPending() kopyası döndürür', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  const pending = engine.getPending();
  pending.length = 0;

  assert.strictEqual(engine.getPending().length, 1);
});

test('9) seq monotonik artar ve id benzersizdir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Bir' });
  engine.observe({ key: 'b2', speaker: 'Ayşe', text: 'İki' });
  engine.observe({ key: 'b3', speaker: 'Kerem', text: 'Üç' });
  engine.flush();
  const lines = engine.getLines();

  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0].seq, 1);
  assert.strictEqual(lines[1].seq, 2);
  assert.strictEqual(lines[2].seq, 3);

  const ids = new Set(lines.map((line) => line.id));
  assert.strictEqual(ids.size, 3, 'id benzersiz olmalı');
  assert.strictEqual(lines[0].id, 'l1');
  assert.strictEqual(lines[2].id, 'l3');
});

test('9b) reset() motoru sıfırlar ama satır sayacını GERİ ALMAZ', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  engine.flush();
  engine.reset();

  assert.strictEqual(engine.getLines().length, 0);
  assert.strictEqual(engine.getPending().length, 0);

  // Sayac sıfırlanmaz: arka planda saklanan eski satırların id'leri
  // ("l1", "l2", ...) yeniden kullanılırsa aynı id'li satır güncellenirken
  // eski metin ezilir -> sessiz veri kaybı.
  engine.observe({ key: 'b9', speaker: 'Kerem', text: 'Tekrar' });
  assert.strictEqual(engine.getPending()[0].seq, 2, 'sayaç sıfırlanmamalı');
  assert.strictEqual(engine.getPending()[0].id, 'l2', 'id tekrar kullanılmamalı');
});

test('12) Meet revizyonu: kesinleşmiş satır yeni blokla uzatılır (mükerrer satır yok)', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  // İlk blok: kısa metin.
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Dünyada hiç keşfedilmemiş' });
  clock.advance(3000);
  const committed = engine.tick().committed;
  assert.strictEqual(committed.length, 1, 'ilk satır kesinleşmeli');

  // Meet bloğu YENİ bir elemente taşıdı ve metni uzattı.
  clock.advance(1000);
  const result = engine.observe({
    key: 'b2',
    speaker: 'Kerem',
    text: 'Dünyada hiç keşfedilmemiş bir fındık bulmamız gerekiyor',
  });

  assert.strictEqual(result.committed.length, 0, 'yeni satır açılmamalı');
  assert.strictEqual(result.updated.length, 1, 'revizyon bildirilmeli');
  assert.strictEqual(result.updated[0].id, committed[0].id, 'id aynı kalmalı');
  assert.strictEqual(
    result.updated[0].text,
    'Dünyada hiç keşfedilmemiş bir fındık bulmamız gerekiyor'
  );

  const lines = engine.getLines();
  assert.strictEqual(lines.length, 1, 'TEK satır olmalı (mükerrer olmamalı)');
  assert.strictEqual(
    lines[0].text,
    'Dünyada hiç keşfedilmemiş bir fındık bulmamız gerekiyor'
  );
});

test('12b) Revizyon penceresi dışındaki benzer metin YENİ satır açar', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Evet' });
  clock.advance(3000);
  engine.tick();

  // Revizyon penceresi (30 sn) aşıldı: yeni bir konuşma turudur.
  clock.advance(40000);
  const result = engine.observe({ key: 'b2', speaker: 'Kerem', text: 'Evet, kesinlikle' });

  assert.strictEqual(result.updated.length, 0, 'eski satır güncellenmemeli');
  assert.strictEqual(result.committed.length, 0, 'yeni satır henüz kesinleşmedi');
  assert.strictEqual(engine.getLines().length, 1, 'kesinleşmiş satır değişmemeli');
  assert.strictEqual(engine.getLines()[0].text, 'Evet', 'eski metin korunmalı');
  assert.strictEqual(engine.getPending().length, 1, 'yeni tur ayrı satır olmalı');
  assert.strictEqual(engine.getPending()[0].text, 'Evet, kesinlikle');
});

test('12c) Araya başka konuşmacı girince revizyon birleşmez (konuşma turu korunur)', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  clock.advance(3000);
  engine.tick();

  // Ayşe araya giriyor (bekleyen satır oluşur).
  engine.observe({ key: 'b2', speaker: 'Ayşe', text: 'Selam' });

  // Kerem yeni metinle dönüyor: A,B,A deseni korunmalı.
  clock.advance(500);
  const result = engine.observe({ key: 'b3', speaker: 'Kerem', text: 'Merhaba dünya' });

  assert.strictEqual(result.updated.length, 0, 'farklı turlar birleşmemeli');
  // Ayşe'nin turu kesinleşir, Kerem'ın yeni turu AYRI bir satır olarak bekler.
  const lines = engine.getLines();
  assert.strictEqual(lines.length, 2, 'ilk iki tur kesinleşmiş olmalı');
  assert.strictEqual(lines[0].text, 'Merhaba', 'ilk tur metni değişmemeli');
  assert.strictEqual(lines[1].text, 'Selam');
  assert.strictEqual(engine.getPending().length, 1, 'yeni tur ayrı satır olmalı');
  assert.strictEqual(engine.getPending()[0].text, 'Merhaba dünya');
});

test('12d) Aynı metinle yeni blok gelirse mükerrer satır açılmaz', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  clock.advance(3000);
  engine.tick();

  clock.advance(500);
  const result = engine.observe({ key: 'b2', speaker: 'Kerem', text: 'Merhaba' });

  assert.strictEqual(result.committed.length, 0);
  assert.strictEqual(result.updated.length, 0);
  assert.strictEqual(engine.getLines().length, 1, 'mükerrer satır olmamalı');
});

test('12e) observe() her zaman {committed, updated} döndürür', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  const bos = engine.observe(null);
  assert.deepStrictEqual(Object.keys(bos).sort(), ['committed', 'updated']);

  const bosMetin = engine.observe({ key: 'b1', speaker: 'Kerem', text: '  ' });
  assert.deepStrictEqual(Object.keys(bosMetin).sort(), ['committed', 'updated']);

  const normal = engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  assert.deepStrictEqual(Object.keys(normal).sort(), ['committed', 'updated']);

  assert.deepStrictEqual(Object.keys(engine.tick()).sort(), ['committed', 'updated']);
  assert.deepStrictEqual(Object.keys(engine.flush()).sort(), ['committed', 'updated']);
});

test('10) Satır biçimi beklenen alanları içerir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Merhaba' });
  clock.advance(1200);
  const line = engine.flush().committed[0];

  assert.deepStrictEqual(Object.keys(line).sort(), [
    'endedAt',
    'id',
    'seq',
    'speaker',
    'startedAt',
    'text',
  ]);
  assert.strictEqual(line.startedAt, 1700000000000);
  assert.strictEqual(line.endedAt, 1700000001200);
});

test('11) restore() kayıtlı satırları geri yükler ve çift kaydı önler', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  const restored = engine.restore([
    { id: 'l1', speaker: 'Kerem', text: 'Merhaba', startedAt: 1000, endedAt: 2000, seq: 1 },
    { id: 'l2', speaker: 'Ayşe', text: 'Selam', startedAt: 3000, endedAt: 4000, seq: 2 },
  ]);

  assert.strictEqual(restored.ok, true);
  assert.strictEqual(engine.getLines().length, 2);
  assert.strictEqual(engine.getLines()[0].text, 'Merhaba');

  // Aynı satırlar ikinci kez gönderilirse çift kayıt oluşmamalı.
  engine.restore([
    { id: 'l1', speaker: 'Kerem', text: 'Merhaba', startedAt: 1000, endedAt: 2000, seq: 1 },
    { id: 'l2', speaker: 'Ayşe', text: 'Selam', startedAt: 3000, endedAt: 4000, seq: 2 },
  ]);
  assert.strictEqual(engine.getLines().length, 2, 'çift kayıt olmamalı');

  // Yeni satırlar seq'i devam ettirmeli.
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Devam' });
  const flushed = engine.flush().committed;
  assert.strictEqual(flushed.length, 1);
  assert.strictEqual(flushed[0].seq, 3);
  assert.strictEqual(flushed[0].id, 'l3');
});

test('13) Açık satır: «bilin.» yeni blokta «bilinen» olunca aynı satır büyür', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({
    key: 'b1',
    speaker: 'Kerem',
    text: 'Karşılaştığımız zorlukta bilin.',
  });
  const open = engine.getPending()[0];
  // Satır henüz açık. Yeni DOM bloğu aynı çağrı zincirinde gelir;
  // kapanış + ikinci satır olmamalı.
  const result = engine.observe({
    key: 'b2',
    speaker: 'Kerem',
    text: 'Karşılaştığımız zorlukta bilinen kişilerin listesi',
  });

  assert.deepStrictEqual(result.committed, [], 'kısa satır kapanıp kopya açılmamalı');
  assert.deepStrictEqual(result.updated, []);
  assert.strictEqual(engine.getLines().length, 0);
  assert.strictEqual(engine.getPending().length, 1);
  assert.strictEqual(engine.getPending()[0].id, open.id);
  assert.strictEqual(engine.getPending()[0].startedAt, open.startedAt);
  assert.strictEqual(
    engine.getPending()[0].text,
    'Karşılaştığımız zorlukta bilinen kişilerin listesi'
  );
});

test('13b) Kesinleşmiş satır: «bakalım.» 22 sn sonra yerinde güncellenir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Yani bakalım.' });
  const startedAt = engine.getPending()[0].startedAt;
  const id = engine.getPending()[0].id;
  clock.advance(1500);
  engine.tick();

  clock.advance(22000);
  const result = engine.observe({
    key: 'b2',
    speaker: 'Kerem',
    text: 'Yani bakalım nelerle satabiliriz?',
  });

  assert.strictEqual(result.committed.length, 0, 'ikinci satır açılmamalı');
  assert.strictEqual(result.updated.length, 1);
  assert.strictEqual(result.updated[0].id, id);
  assert.strictEqual(result.updated[0].startedAt, startedAt);
  assert.strictEqual(result.updated[0].text, 'Yani bakalım nelerle satabiliriz?');
  assert.strictEqual(engine.getLines().length, 1);
  assert.strictEqual(engine.getPending().length, 0);
  assert.strictEqual(engine.getLines()[0].id, id);
  assert.strictEqual(engine.getLines()[0].startedAt, startedAt);
  assert.strictEqual(engine.getLines()[0].text, 'Yani bakalım nelerle satabiliriz?');
});

test('13z) Kuyruk revizyonu: son kelime değişince satır mükerrer olmaz', () => {
  const head =
    'Merhabalar Evet ses deneme yapıyorum. Şu anda bakalım kayıtlar düzgün bir hikayeler ' +
    'olmadan bir şekilde. Gözükecek mi? Evet bugün girişimcilik nedir? Onu konuşacağız ' +
    'profesyoneldir kendisi Yaklaşık 5 tane girişim batırdığı için bu konularda epey bilgileri';
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Ben', text: head + ' konusunda' });
  const id = engine.getPending()[0].id;
  clock.advance(1500);
  engine.tick();

  clock.advance(3000);
  const result = engine.observe({
    key: 'b2',
    speaker: 'Ben',
    text: head + ' Evet durumlar bunlar.',
  });

  assert.strictEqual(result.committed.length, 0, 'ikinci satır açılmamalı');
  assert.strictEqual(result.updated.length, 1);
  assert.strictEqual(engine.getLines().length, 1);
  assert.strictEqual(engine.getLines()[0].id, id);
  assert.strictEqual(engine.getLines()[0].text, head + ' Evet durumlar bunlar.');
});

test('13z2) Farklı iki cümle ortak kısa başlangıçla birleşmez', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  engine.observe({ key: 'b1', speaker: 'Ben', text: 'Evet bence bu iş çok güzel olacak yarın' });
  clock.advance(1500);
  engine.tick();
  clock.advance(2000);
  engine.observe({ key: 'b2', speaker: 'Ben', text: 'Evet bence bambaşka bir konuya geçelim' });
  engine.flush();
  assert.strictEqual(engine.getLines().length, 2);
});

test('13c) Üç adımlı büyüme tek satır ve aynı kimlikte kalır', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Ayşe', text: 'Yani bakalım.' });
  clock.advance(200);
  engine.observe({ key: 'b2', speaker: 'Ayşe', text: 'Yani bakalım nelerle' });
  clock.advance(200);
  engine.observe({
    key: 'b3',
    speaker: 'Ayşe',
    text: 'Yani bakalım nelerle satabiliriz?',
  });

  assert.strictEqual(engine.getLines().length, 0, 'açık zincir erken kapanmamalı');
  assert.strictEqual(engine.getPending().length, 1);
  const open = engine.getPending()[0];
  assert.strictEqual(open.startedAt, 1700000000000);
  assert.strictEqual(open.text, 'Yani bakalım nelerle satabiliriz?');

  const clock2 = createClock();
  const closed = createEngine(clock2);
  closed.observe({ key: 'b1', speaker: 'Ayşe', text: 'zorlukta bilin.' });
  const id = closed.getPending()[0].id;
  const startedAt = closed.getPending()[0].startedAt;
  clock2.advance(1500);
  closed.tick();

  clock2.advance(10000);
  const mid = closed.observe({ key: 'b2', speaker: 'Ayşe', text: 'zorlukta bilinen' });
  assert.strictEqual(mid.committed.length, 0);
  assert.strictEqual(mid.updated.length, 1);
  assert.strictEqual(mid.updated[0].id, id);
  assert.strictEqual(mid.updated[0].startedAt, startedAt);

  clock2.advance(10000);
  const last = closed.observe({
    key: 'b3',
    speaker: 'Ayşe',
    text: 'zorlukta bilinen kişilerin listesi',
  });
  assert.strictEqual(last.committed.length, 0);
  assert.strictEqual(last.updated.length, 1);
  assert.strictEqual(last.updated[0].id, id);
  assert.strictEqual(last.updated[0].startedAt, startedAt);
  assert.strictEqual(closed.getLines().length, 1);
  assert.strictEqual(closed.getPending().length, 0);
  assert.strictEqual(closed.getLines()[0].text, 'zorlukta bilinen kişilerin listesi');
  assert.strictEqual(closed.getLines()[0].startedAt, startedAt);
});

test('13d) «Tamam.» ardından «Tamam, başka konuya geçelim.» birleşir', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Tamam.' });
  const id = engine.getPending()[0].id;
  const startedAt = engine.getPending()[0].startedAt;
  clock.advance(1500);
  engine.tick();
  clock.advance(4000);

  const result = engine.observe({
    key: 'b2',
    speaker: 'Kerem',
    text: 'Tamam, başka konuya geçelim.',
  });

  assert.strictEqual(result.committed.length, 0);
  assert.strictEqual(result.updated.length, 1);
  assert.strictEqual(result.updated[0].id, id);
  assert.strictEqual(result.updated[0].startedAt, startedAt);
  assert.strictEqual(result.updated[0].text, 'Tamam, başka konuya geçelim.');
  assert.strictEqual(engine.getLines().length, 1);
});

test('13e) «Toplantı bitti.» ile «Toplantı yarın.» birleşmez', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Toplantı bitti.' });
  const result = engine.observe({ key: 'b2', speaker: 'Kerem', text: 'Toplantı yarın.' });

  assert.strictEqual(result.committed.length, 1);
  assert.strictEqual(result.committed[0].text, 'Toplantı bitti.');
  assert.strictEqual(result.updated.length, 0);
  assert.strictEqual(engine.getPending().length, 1);
  assert.strictEqual(engine.getPending()[0].text, 'Toplantı yarın.');
  assert.notStrictEqual(engine.getPending()[0].id, result.committed[0].id);
});

test('13f) «biliyorum.» ardından «biliyom» birleşmez', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'biliyorum.' });
  const result = engine.observe({ key: 'b2', speaker: 'Kerem', text: 'biliyom' });

  assert.strictEqual(result.committed.length, 1);
  assert.strictEqual(result.committed[0].text, 'biliyorum.');
  assert.strictEqual(engine.getPending().length, 1);
  assert.strictEqual(engine.getPending()[0].text, 'biliyom');
  assert.notStrictEqual(engine.getPending()[0].id, result.committed[0].id);
});

test('13g) «Ali gitti.» ardından «Ali geldi.» birleşmez', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Ali gitti.' });
  clock.advance(1500);
  engine.tick();
  clock.advance(5000);

  const result = engine.observe({ key: 'b2', speaker: 'Kerem', text: 'Ali geldi.' });

  assert.strictEqual(result.updated.length, 0);
  assert.strictEqual(engine.getLines().length, 1);
  assert.strictEqual(engine.getLines()[0].text, 'Ali gitti.');
  assert.strictEqual(engine.getPending().length, 1);
  assert.strictEqual(engine.getPending()[0].text, 'Ali geldi.');
});

test('13h) Farklı konuşmacı noktalı büyümeyi birleştirmez', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({
    key: 'b1',
    speaker: 'Kerem',
    text: 'Karşılaştığımız zorlukta bilin.',
  });
  const result = engine.observe({
    key: 'b2',
    speaker: 'Ayşe',
    text: 'Karşılaştığımız zorlukta bilinen kişilerin',
  });

  assert.strictEqual(result.committed.length, 1);
  assert.strictEqual(result.committed[0].speaker, 'Kerem');
  assert.strictEqual(result.committed[0].text, 'Karşılaştığımız zorlukta bilin.');
  assert.strictEqual(engine.getPending().length, 1);
  assert.strictEqual(engine.getPending()[0].speaker, 'Ayşe');
  assert.strictEqual(engine.getPending()[0].text, 'Karşılaştığımız zorlukta bilinen kişilerin');
});

test('13i) 30 saniyelik revizyon sınırında noktalı büyüme', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'zorlukta bilin.' });
  clock.advance(1500);
  engine.tick();
  clock.advance(30000);
  const onEdge = engine.observe({
    key: 'b2',
    speaker: 'Kerem',
    text: 'zorlukta bilinen kişilerin',
  });
  assert.strictEqual(onEdge.updated.length, 1, 'tam 30 sn hâlâ pencerede');
  assert.strictEqual(engine.getLines().length, 1);
  assert.strictEqual(engine.getLines()[0].text, 'zorlukta bilinen kişilerin');

  const late = createClock();
  const engine2 = createEngine(late);
  engine2.observe({ key: 'b1', speaker: 'Kerem', text: 'zorlukta bilin.' });
  late.advance(1500);
  engine2.tick();
  late.advance(30001);
  const result = engine2.observe({
    key: 'b2',
    speaker: 'Kerem',
    text: 'zorlukta bilinen kişilerin',
  });
  assert.strictEqual(result.updated.length, 0, '30 sn’den eski satır güncellenmemeli');
  assert.strictEqual(engine2.getLines().length, 1);
  assert.strictEqual(engine2.getLines()[0].text, 'zorlukta bilin.');
  assert.strictEqual(engine2.getPending().length, 1);
  assert.strictEqual(engine2.getPending()[0].text, 'zorlukta bilinen kişilerin');
  assert.notStrictEqual(engine2.getPending()[0].id, engine2.getLines()[0].id);
});

test('13j) Araya başka konuşmacı girince noktalı büyüme birleşmez', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Yani bakalım.' });
  clock.advance(1500);
  engine.tick();
  engine.observe({ key: 'b2', speaker: 'Ayşe', text: 'Selam' });
  clock.advance(500);
  const result = engine.observe({
    key: 'b3',
    speaker: 'Kerem',
    text: 'Yani bakalım nelerle satabiliriz?',
  });

  assert.strictEqual(result.updated.length, 0);
  assert.strictEqual(engine.getLines().length, 2);
  assert.strictEqual(engine.getLines()[0].text, 'Yani bakalım.');
  assert.strictEqual(engine.getLines()[1].text, 'Selam');
  assert.strictEqual(engine.getPending().length, 1);
  assert.strictEqual(engine.getPending()[0].text, 'Yani bakalım nelerle satabiliriz?');
});

test('13k) Noktasız tam önek birleştirmesi bozulmaz', () => {
  const clock = createClock();
  const engine = createEngine(clock);

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Dünyada hiç keşfedilmemiş' });
  const open = engine.observe({
    key: 'b2',
    speaker: 'Kerem',
    text: 'Dünyada hiç keşfedilmemiş bir fındık',
  });
  assert.strictEqual(open.committed.length, 0);
  assert.strictEqual(engine.getPending().length, 1);

  clock.advance(1500);
  const committed = engine.tick().committed;
  clock.advance(1000);
  const revised = engine.observe({
    key: 'b3',
    speaker: 'Kerem',
    text: 'Dünyada hiç keşfedilmemiş bir fındık bulmamız gerekiyor',
  });
  assert.strictEqual(revised.updated.length, 1);
  assert.strictEqual(revised.updated[0].id, committed[0].id);
  assert.strictEqual(engine.getLines().length, 1);
  assert.strictEqual(
    engine.getLines()[0].text,
    'Dünyada hiç keşfedilmemiş bir fındık bulmamız gerekiyor'
  );
});

test('13l) Cümle sonu işaretleri atılınca gövde önekse birleşir, harf veya rakam düşerse birleşmez', () => {
  const marks = [
    '.',
    ',',
    '?',
    '!',
    ':',
    ';',
    '\u2026',
    '...',
    '"',
    "'",
    '\u201C',
    '\u201D',
    '\u2018',
    '\u2019',
    '\u00AB',
    '\u00BB',
    '\u201E',
    '."',
  ];
  marks.forEach((mark, index) => {
    const clock = createClock();
    const engine = createEngine(clock);
    engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Bilgi' + mark });
    const result = engine.observe({
      key: 'b2',
      speaker: 'Kerem',
      text: 'Bilgiler geldi',
    });
    assert.strictEqual(result.committed.length, 0, 'işaret birleşmeli: ' + index + ' ' + mark);
    assert.strictEqual(engine.getPending().length, 1);
    assert.strictEqual(engine.getPending()[0].text, 'Bilgiler geldi');
  });

  const clock = createClock();
  const engine = createEngine(clock);
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Madde 20.' });
  const dropped = engine.observe({ key: 'b2', speaker: 'Kerem', text: 'Madde 2 kişi' });
  assert.strictEqual(dropped.committed.length, 1, 'rakam atıldıysa birleşmemeli');
  assert.strictEqual(dropped.committed[0].text, 'Madde 20.');
  assert.strictEqual(engine.getPending()[0].text, 'Madde 2 kişi');

  const grown = createClock();
  const engine2 = createEngine(grown);
  engine2.observe({ key: 'b1', speaker: 'Kerem', text: 'Madde 2.' });
  const kept = engine2.observe({ key: 'b2', speaker: 'Kerem', text: 'Madde 20 kişi' });
  assert.strictEqual(kept.committed.length, 0, 'rakam büyüyorsa birleşmeli');
  assert.strictEqual(engine2.getPending()[0].text, 'Madde 20 kişi');
});

// ---- Kayan pencere: Meet uzun konuşmada metnin başını kırpar ----------------

const SLIDE_TEXT =
  'Birinci cümle burada başlıyor ve devam ediyor. İkinci cümle ürünün testleriyle ilgili. ' +
  'Üçüncü cümle prototip aşamasında yapılması gerekenleri anlatıyor. ' +
  'Dördüncü cümle seri üretime geçerken karşılaşılan sorunları anlatıyor.';

test('14) Kesinleşmiş blok başından kırpılırsa kopya satır açılmaz, metin kaybolmaz', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  engine.observe({ key: 'b1', speaker: 'Zeynep', text: SLIDE_TEXT });
  clock.advance(1500);
  engine.tick();
  assert.strictEqual(engine.getLines().length, 1);

  clock.advance(60000);
  const trimmed = SLIDE_TEXT.slice(SLIDE_TEXT.indexOf('Üçüncü'));
  const result = engine.observe({ key: 'b1', speaker: 'Zeynep', text: trimmed });

  assert.strictEqual(result.committed.length, 0);
  assert.strictEqual(result.updated.length, 0);
  assert.strictEqual(engine.getLines().length, 1);
  assert.strictEqual(engine.getLines()[0].text, SLIDE_TEXT, 'eski metin korunmalı');
});

test('14b) Kayan pencere: kırpılıp sonuna yeni konuşma eklenirse tek satırda birleşir', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  engine.observe({ key: 'b1', speaker: 'Zeynep', text: SLIDE_TEXT });
  const id = engine.getPending()[0].id;
  clock.advance(1500);
  engine.tick();

  clock.advance(60000);
  const next =
    SLIDE_TEXT.slice(SLIDE_TEXT.indexOf('Üçüncü')) + ' Beşinci cümle yeni söylenen kısım.';
  const result = engine.observe({ key: 'b1', speaker: 'Zeynep', text: next });

  assert.strictEqual(result.committed.length, 0);
  assert.strictEqual(result.updated.length, 1);
  assert.strictEqual(result.updated[0].id, id);
  assert.strictEqual(engine.getLines().length, 1);
  assert.strictEqual(
    engine.getLines()[0].text,
    SLIDE_TEXT + ' Beşinci cümle yeni söylenen kısım.'
  );
});

test('14c) Bekleyen blok kırpılırsa eski metin kaybolmaz', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  engine.observe({ key: 'b1', speaker: 'Zeynep', text: SLIDE_TEXT });
  clock.advance(500);
  engine.observe({
    key: 'b1',
    speaker: 'Zeynep',
    text: SLIDE_TEXT.slice(SLIDE_TEXT.indexOf('İkinci')) + ' Yeni kısım geldi.',
  });
  assert.strictEqual(engine.getPending().length, 1);
  assert.strictEqual(engine.getPending()[0].text, SLIDE_TEXT + ' Yeni kısım geldi.');
});

test('14d) Yeni anahtar ve kayan pencere örtüşmesi de tek satırda kalır', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  engine.observe({ key: 'b1', speaker: 'Zeynep', text: SLIDE_TEXT });
  clock.advance(1500);
  engine.tick();

  clock.advance(5000);
  const next = SLIDE_TEXT.slice(SLIDE_TEXT.indexOf('İkinci')) + ' Altıncı cümle sonradan geldi.';
  engine.observe({ key: 'b2', speaker: 'Zeynep', text: next });
  assert.strictEqual(engine.getLines().length + engine.getPending().length, 1);
});

test('14e) Kısa metinler ve farklı konuşmacı kayan pencere sayılmaz', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  engine.observe({ key: 'b1', speaker: 'Zeynep', text: SLIDE_TEXT });
  clock.advance(1500);
  engine.tick();
  clock.advance(1000);
  engine.observe({ key: 'b9', speaker: 'Kemal', text: SLIDE_TEXT.slice(40) });
  engine.observe({ key: 'b1', speaker: 'Zeynep', text: 'Evet.' });
  engine.flush();
  const lines = engine.getLines();
  assert.ok(lines.some((line) => line.speaker === 'Kemal'), 'farklı konuşmacı ayrı satır');
  assert.ok(lines.some((line) => line.text === 'Evet.'), 'kısa metin ayrı satır');
});

test('14f) Çakışan bölgede noktalama/büyük harf düzeltmesi olsa da kayan pencere birleşir', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  const older =
    've bütün o süreci yaşamışsınız testlerini yapmışsınız doğrulamışsınız evet ürün çalışıyor ' +
    'vaat ettiğini yapıyor ama müşteri ile buluşması için üretilmesi lazım ve orada bir partner doğr.';
  const newer =
    'Testlerini yapmışsınız, doğrulamışsınız. Evet ürün çalışıyor, vaat ettiğini yapıyor ' +
    'ama müşteri ile buluşması için üretilmesi lazım ve orada bir partner doğrulanamıyorsa B planı gerekir.';
  engine.observe({ key: 'b1', speaker: 'Zeynep', text: older });
  clock.advance(1500);
  engine.tick();
  clock.advance(30000);
  const result = engine.observe({ key: 'b1', speaker: 'Zeynep', text: newer });
  assert.strictEqual(result.committed.length, 0);
  assert.strictEqual(engine.getLines().length, 1);
  const text = engine.getLines()[0].text;
  assert.ok(text.startsWith('ve bütün o süreci yaşamışsınız '), 'eski başlangıç korunmalı');
  assert.ok(text.endsWith('B planı gerekir.'), 'yeni son eklenmeli');
  assert.strictEqual(text.split('doğrulamışsınız').length - 1, 1, 'çakışan kısım iki kez yazılmamalı');
});
test('14g) Uzun konuşmada tarama aralığı dakikalarca açılsa da Meet düzeltmesi yeni satır açmaz', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  const head = 'Şimdi biz bu projeyi evde kendi imkanlarımızla başlattık ve parça parça büyüttük. '.repeat(8);
  const older = head + 'Aldık parasını aldığımız bir ürün sattık yani geri götürdük ve ofiste bedava basmaya başladık.';
  const newer = head + 'Derken yeni siparişler geldi. 8 tane daha üretim yaptık ve yavaş yavaş geliştirmeye başladık.';
  engine.observe({ key: 'k1', speaker: 'Serhat', text: older });
  clock.advance(1500);
  engine.tick();
  assert.strictEqual(engine.getLines().length, 1);
  clock.advance(20 * 60 * 1000);
  engine.observe({ key: 'k2', speaker: 'Serhat', text: newer });
  clock.advance(1500);
  engine.tick();
  const lines = engine.getLines();
  assert.strictEqual(lines.length, 1, 'aynı konuşma turu tek satır kalmalı');
  assert.ok(lines[0].text.endsWith('geliştirmeye başladık.'));
});

test('14h) Kısa metinlerde zaman sınırı korunur: 20 dk sonra aynı söz yeni satır olur', () => {
  const clock = createClock();
  const engine = createEngine(clock);
  engine.observe({ key: 'k1', speaker: 'Ali', text: 'Evet.' });
  clock.advance(1500);
  engine.tick();
  clock.advance(20 * 60 * 1000);
  engine.observe({ key: 'k2', speaker: 'Ali', text: 'Evet. Tamam anladım.' });
  clock.advance(1500);
  engine.tick();
  assert.strictEqual(engine.getLines().length, 2);
});
