/**
 * Ayar uygulama testleri.
 *
 * Ayarlar sayfasında değiştirilen değerler (graceMs, junkFilter,
 * speakerFallback) çalışma anında motora uygulanmalıdır. Bu testler,
 * motorun `configure` yeteneğini ve bunun beklenen davranış değişikliklerini
 * doğrular.
 *
 * Çalıştırma: node --test test/settings.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  createTranscriptEngine,
} = require('../extension/src/content/transcript-engine.js');

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

test('configure() grace süresini değiştirir ve bekleyen satır ona göre kesinleşir', () => {
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now, graceMs: 1500 });

  engine.configure({ graceMs: 400 });
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Kısa bir cümle.' });

  // 400 ms sonra hâlâ değişiklik yok -> kesinleşmeli.
  clock.advance(500);
  const committed = engine.tick().committed;
  assert.strictEqual(committed.length, 1, 'yeni grace süresi uygulanmalı');
  assert.strictEqual(committed[0].text, 'Kısa bir cümle.');
});

test('configure() uzun grace süresi satırı erken kesinleştirmez', () => {
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now, graceMs: 1500 });

  engine.configure({ graceMs: 4000 });
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'Uzun cümle.' });

  clock.advance(2000);
  assert.strictEqual(engine.tick().committed.length, 0, 'grace dolmadan kesinleşmemeli');

  clock.advance(2500);
  assert.strictEqual(engine.tick().committed.length, 1, 'grace sonunda kesinleşmeli');
});

test('configure() junk filtresini kapatınca arayüz metni de satır olur', () => {
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now, junkFilter: true });

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'frame_person' });
  assert.strictEqual(engine.flush().committed.length, 0, 'filtre açıkken satır olmamalı');

  engine.configure({ junkFilter: false });
  engine.observe({ key: 'b2', speaker: 'Kerem', text: 'frame_person' });
  const committed = engine.flush().committed;
  assert.strictEqual(committed.length, 1, 'filtre kapalıyken metin geçmeli');
  assert.strictEqual(committed[0].text, 'frame_person');
});

test('configure() junk filtresini yeniden açınca arayüz metni yine elenir', () => {
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now, junkFilter: false });

  engine.configure({ junkFilter: true });
  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'more_vert' });
  assert.strictEqual(engine.flush().committed.length, 0);
});

test('configure() konuşmacı yedeğini değiştirir', () => {
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now, speakerFallback: 'Bilinmeyen' });

  engine.configure({ speakerFallback: 'Katılımcı' });
  engine.observe({ key: 'b1', speaker: '', text: 'Konuşmacı adı okunamadı.' });

  const committed = engine.flush().committed;
  assert.strictEqual(committed.length, 1);
  assert.strictEqual(committed[0].speaker, 'Katılımcı');
});

test('configure() geçersiz değerleri yok sayar ve mevcut ayarı korur', () => {
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now, graceMs: 1500 });

  const applied = engine.configure({
    graceMs: 'abc',
    junkFilter: 'evet',
    speakerFallback: '   ',
    minLineChars: -5,
  });

  assert.strictEqual(applied.graceMs, 1500, 'geçersiz graceMs uygulanmamalı');
  assert.strictEqual(applied.junkFilter, true, 'geçersiz junkFilter uygulanmamalı');
  assert.strictEqual(applied.speakerFallback, 'Bilinmeyen', 'boş yedek ad uygulanmamalı');
  assert.ok(applied.minLineChars >= 0, 'minLineChars negatif olamaz');
});

test('configure() grace süresini güvenli aralığa sıkıştırır', () => {
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now });

  assert.strictEqual(engine.configure({ graceMs: 10 }).graceMs, 500);
  assert.strictEqual(engine.configure({ graceMs: 999999 }).graceMs, 5000);
});

test('Varsayılan grace süresi, 2 sn sonra gelen revizyonu tek satırda birleştirir', () => {
  // Gerçek Meet testinde altyazının revizyonu konuşmadan ~2 sn sonra geliyordu;
  // 1500 ms'lik varsayılan bu satırı ikiye bölüyordu. Varsayılan 2500 ms.
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now });

  engine.observe({ key: 'b1', speaker: 'Siz', text: 'Merhaba' });
  clock.advance(2000);
  engine.observe({ key: 'b2', speaker: 'Siz', text: 'Merhaba nasılsın' });

  engine.flush();
  const lines = engine.getLines();
  assert.equal(lines.length, 1, 'revizyon ayrı satır olmamalı');
  assert.equal(lines[0].text, 'Merhaba nasılsın', 'son hâl saklanmalı');
});

test('Araya giren konuşmacı, grace süresinden bağımsız olarak satırı böler', () => {
  // Bilinen davranış: kesişme (interruption) cümleyi ikiye böler.
  // Grace ayarı bunu düzeltmez; döküm sadakatini korur.
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now, graceMs: 5000 });

  engine.observe({ key: 'b1', speaker: 'Siz', text: 'teşekkür' });
  engine.observe({ key: 'b2', speaker: 'Çağla', text: 'İyiyim.' });
  engine.observe({ key: 'b3', speaker: 'Siz', text: 'Teşekkür ederim.' });

  engine.flush();
  const lines = engine.getLines();
  assert.equal(lines.length, 3, 'kesişmede üç ayrı konuşma turu korunmalı');
  assert.deepEqual(
    lines.map((l) => l.speaker),
    ['Siz', 'Çağla', 'Siz']
  );
});

test('configure() mevcut satırlara dokunmaz', () => {
  const clock = createClock();
  const engine = createTranscriptEngine({ now: clock.now });

  engine.observe({ key: 'b1', speaker: 'Kerem', text: 'İlk cümle.' });
  const before = engine.flush().committed;
  assert.strictEqual(before.length, 1);

  engine.configure({ graceMs: 3000, speakerFallback: 'X' });

  const after = engine.getLines();
  assert.strictEqual(after.length, 1, 'satır sayısı değişmemeli');
  assert.strictEqual(after[0].text, 'İlk cümle.');
  assert.strictEqual(after[0].speaker, 'Kerem', 'kesinleşmiş satır değişmemeli');
});

test('Ayarlar: yalnız kalma varsayılan açık, sessizlik varsayılan kapalı ve değer sınırlanır', async () => {
  const store = {};
  global.chrome = {
    storage: {
      local: {
        get: (key) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (payload) => { Object.assign(store, payload); return Promise.resolve(); },
      },
    },
  };
  delete require.cache[require.resolve('../extension/src/lib/settings.js')];
  const Settings = require('../extension/src/lib/settings.js');

  assert.strictEqual(Settings.DEFAULT_SETTINGS.autoStopWhenAlone, true);
  assert.strictEqual(Settings.DEFAULT_SETTINGS.autoStopSilenceMin, 0);

  const fresh = await Settings.getSettings();
  assert.strictEqual(fresh.autoStopWhenAlone, true);
  assert.strictEqual(fresh.autoStopSilenceMin, 0);

  const cases = [[0, 0], [-5, 0], ['abc', 0], [3, 10], [45, 45], [999, 240]];
  for (const [input, expected] of cases) {
    const saved = await Settings.saveSettings({ autoStopSilenceMin: input });
    assert.strictEqual(saved.autoStopSilenceMin, expected, `${input} -> ${expected}`);
  }
  const off = await Settings.saveSettings({ autoStopWhenAlone: false });
  assert.strictEqual(off.autoStopWhenAlone, false);
  delete global.chrome;
});
