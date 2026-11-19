/**
 * İçerik betiği orkestrasyon testleri.
 *
 * Bu testler, `extension/src/content/content.js` içindeki orkestratörün
 * yaşam döngüsü kurallarını doğrular:
 *   - K3: yalnızca "sayfadan ayrılma" olaylarında flush yapılır,
 *   - K1: sekme yenilendikten sonra geri yüklenen satırlar tekrar kaydedilmez,
 *   - K6: otomatik başlatma ayarı yüklendikten sonra değerlendirilir ve
 *         kullanıcı kaydı durdurduktan sonra eklenti kendi kendine başlamaz,
 *   - K10: blockState sınırsız büyümez,
 *   - K2: motorun güncellediği satırlar arka plana gider.
 *
 * Çalıştırma: node --test test/content-orchestration.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, createStubAdapter } = require('./helpers/harness.js');

const TAB_ID = 1;

/** Belirtilen süre (ms) bekler. */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Arka plana gönderilen mesajları yakalar.
 * Dinleyici yanıt vermez; böylece diğer dinleyiciler de çalışmaya devam eder.
 */
function captureBackgroundMessages(harness) {
  const messages = [];
  harness.swListeners.unshift(function (message) {
    messages.push(message);
    return false;
  });
  return messages;
}

/** Belirtilen tipte kaç mesaj gönderildiğini sayar. */
function countType(messages, type) {
  return messages.filter((message) => message && message.type === type).length;
}

/** Gövde gözlemcisini tetikler (sayfada bir değişiklik oldu). */
function triggerBodyObserver(harness) {
  const observers = harness.sandbox.MutationObserver.instances || [];
  for (const observer of observers) {
    if (observer.target === harness.sandbox.document.body) {
      observer.trigger();
      return true;
    }
  }
  return false;
}

/** Kaydedilmiş ayarlar (otomatik başlatma açık). */
const AUTO_START_SETTINGS = {
  graceMs: 2500,
  junkFilter: true,
  speakerFallback: 'Bilinmeyen',
  autoStartOnCc: true,
};

/**
 * Test sonunda kaydı durdurur ve zamanlayıcıları temizler.
 * (Kayıt açık kalırsa outbox yeniden denemeye devam eder ve test dosyası
 * kapanmaz.)
 */
async function teardown(harness) {
  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });
    await harness.sendToTab(TAB_ID, { type: 'MNA_RESET' });
  } catch (err) {
    /* yoksay */
  }
  await wait(10);
  harness.cleanup();
}

test('K3: içerik betiği sayfadan ayrılma olaylarını dinler, görünürlük olayını dinlemez', () => {
  const harness = createHarness({ adapter: createStubAdapter({ blocks: [] }) });
  harness.loadContentScript(TAB_ID);

  const types = harness.registeredEvents.map((event) => event.type);
  assert.ok(types.includes('pagehide'), 'pagehide dinlenmeli');
  assert.ok(types.includes('beforeunload'), 'beforeunload dinlenmeli');
  assert.ok(
    !types.includes('visibilitychange'),
    'visibilitychange dinlenmemeli (erken kesinleştirme mükerrer satır yaratır)'
  );

  const documentTypes = harness.registeredEvents
    .filter((event) => event.target === 'document')
    .map((event) => event.type);
  assert.ok(
    !documentTypes.includes('visibilitychange'),
    'document üzerinde visibilitychange dinleyicisi olmamalı'
  );

  harness.cleanup();
});

test('K1: geri yüklenen satırlar yeniden gözlenirse mükerrer satır üretilmez', async () => {
  const blocks = [
    { speaker: 'Kerem', text: 'Haftalık planlamayı başlayalım.' },
    { speaker: 'Elif', text: 'Ben mobil taraftan ilerleyeceğim.' },
  ];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  try {
    // Arka plan, sekme yenilendikten sonra kaydedilmiş satırları geri yükler.
    const restored = await harness.sendToTab(TAB_ID, {
      type: 'MNA_CAPTURE_STATE',
      active: true,
      startedAt: 1000,
      sessionId: 'sess_test',
      lines: [
        {
          id: 'l1',
          speaker: 'Kerem',
          text: 'Haftalık planlamayı başlayalım.',
          startedAt: 1000,
          endedAt: 2000,
          seq: 1,
        },
        {
          id: 'l2',
          speaker: 'Elif',
          text: 'Ben mobil taraftan ilerleyeceğim.',
          startedAt: 2000,
          endedAt: 3000,
          seq: 2,
        },
      ],
    });
    assert.ok(restored && restored.ok, 'geri yükleme kabul edilmeli');

    // Geri yüklenen bloklar yeniden gözlenir: YENİ satır üretilmemeli.
    harness.sandbox.window.__mnaScan();
    const afterRestore = await harness.sendToTab(TAB_ID, { type: 'MNA_GET_LINES' });
    assert.ok(afterRestore && afterRestore.ok);
    assert.equal(
      afterRestore.lines.length,
      2,
      'geri yüklenen satırlar korunmalı, mükerrer satır olmamalı'
    );
    assert.equal(afterRestore.lines[0].id, 'l1');

    // Aynı bloklar ikinci kez gözlenir: hâlâ yeni satır olmamalı.
    harness.sandbox.window.__mnaScan();
    const afterSecondScan = await harness.sendToTab(TAB_ID, { type: 'MNA_GET_LINES' });
    assert.equal(
      afterSecondScan.lines.length,
      2,
      'koruma tekrar gözlemde geçerli olmalı, satır sayısı artmamalı'
    );

    // Yeni içerikli bir blok: yeni satır üretilmeli.
    blocks[1].text = 'Bütçe kalemi ne kadar kaldı?';
    harness.sandbox.window.__mnaScan();
    const afterNew = await harness.sendToTab(TAB_ID, { type: 'MNA_GET_LINES' });
    assert.equal(afterNew.lines.length, 3, 'yeni içerikli blok yeni satır üretmeli');
    assert.equal(afterNew.lines[2].speaker, 'Elif');
    assert.match(afterNew.lines[2].text, /bütçe/i);
  } finally {
    await teardown(harness);
  }
});

test('K6: otomatik başlatma isteği ayarlar yüklenene kadar gönderilmez', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Merhaba.' }],
  });
  const harness = createHarness({ adapter, deferLocalGet: true });
  await harness.local.set({ 'mna.settings': AUTO_START_SETTINGS });

  const messages = captureBackgroundMessages(harness);
  harness.loadContentScript(TAB_ID);

  try {
    await wait(50);
    assert.equal(
      countType(messages, 'MNA_CAPTURE_STATE_REQUEST'),
      0,
      'ayarlar çözülmeden otomatik başlatma istenmemeli'
    );

    harness.resolveLocalGet();
    await wait(50);
    assert.equal(
      countType(messages, 'MNA_CAPTURE_STATE_REQUEST'),
      1,
      'ayarlar çözüldükten sonra otomatik başlatma istenmeli'
    );
  } finally {
    await teardown(harness);
  }
});

test('K6: kullanıcı kaydı durdurduktan sonra eklenti kendi kendine yeniden başlamaz', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Merhaba.' }],
  });
  const harness = createHarness({ adapter });
  await harness.local.set({ 'mna.settings': AUTO_START_SETTINGS });

  const messages = captureBackgroundMessages(harness);
  harness.loadContentScript(TAB_ID);

  try {
    await wait(50);
    assert.equal(
      countType(messages, 'MNA_CAPTURE_STATE_REQUEST'),
      1,
      'ilk otomatik başlatma isteği gönderilmeli'
    );

    // Kullanıcı kaydı elle durdurur; Meet altyazıları AÇIK kalır.
    const stopped = await harness.sendToTab(TAB_ID, {
      type: 'MNA_SET_CAPTURE',
      active: false,
    });
    assert.ok(stopped && stopped.ok, 'kayıt durdurulmalı');

    // Sayfada yeni bir değişiklik olur (gövde gözlemcisi tetiklenir).
    assert.ok(triggerBodyObserver(harness), 'gövde gözlemcisi bulunmalı');
    await wait(50);
    assert.equal(
      countType(messages, 'MNA_CAPTURE_STATE_REQUEST'),
      1,
      'CC açıkken ikinci bir otomatik başlatma isteği gönderilmemeli'
    );
  } finally {
    await teardown(harness);
  }
});

test('Toplantıdan ayrılınca (bitiş ekranı) elle başlatılan kayıt bir kez durdurulur', async () => {
  const adapter = createStubAdapter({ blocks: [{ speaker: 'Kerem', text: 'Merhaba.' }] });
  const harness = createHarness({ adapter });
  const messages = captureBackgroundMessages(harness);
  const clock = makeFakeClock(Date.now());
  harness.sandbox.Date = clock.Date;
  let reason = null;
  harness.sandbox.MNAJoin = {
    meetingEndReason: function () {
      return reason;
    },
  };
  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    clock.now += 2100;
    await wait(700);
    assert.equal(
      countType(messages, 'MNA_SESSION_STOP'),
      0,
      'bitiş ekranı yokken kayıt durdurulmamalı'
    );

    reason = 'left';
    clock.now += 2100;
    await wait(700);
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 1, 'ayrılınca kayıt durdurulmalı');

    clock.now += 2100;
    await wait(700);
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 1, 'durdurma isteği tekrarlanmamalı');
  } finally {
    await teardown(harness);
  }
});

test('Bitiş metni tanınmasa da görüşme arayüzü gidince (Yeniden katıl) kayıt durdurulur', async () => {
  const adapter = createStubAdapter({ blocks: [{ speaker: 'Kerem', text: 'Merhaba.' }] });
  const harness = createHarness({ adapter });
  const messages = captureBackgroundMessages(harness);
  // Her adımda sahte saat 2,1 sn ilerler: tam bir kontrol aralığı = tam bir kontrol.
  const clock = makeFakeClock(Date.now());
  harness.sandbox.Date = clock.Date;
  const step = async () => {
    clock.now += 2100;
    await wait(700);
  };
  let gone = false;
  harness.sandbox.MNAJoin = {
    meetingEndReason: function () { return null; },
    outOfCall: function () { return gone; },
  };
  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    await step();
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 0, 'arayüz varken durdurulmamalı');

    gone = true;
    await step();
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 0, 'tek kontrolde durdurulmamalı');
    gone = false;
    await step();
    gone = true;
    await step();
    await step();
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 0, 'ardışık olmayan kontroller sayılmaz');

    await step();
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 1, 'üç ardışık kontrolde durdurulmalı');
  } finally {
    await teardown(harness);
  }
});

/** Dakikalarca beklemeden zaman ilerletmek için sahte Date. */
function makeFakeClock(startMs) {
  const clock = { now: startMs };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) {
        super(...args);
      } else {
        super(clock.now);
      }
    }
    static now() {
      return clock.now;
    }
  }
  clock.Date = FakeDate;
  return clock;
}

test('Sessizlik kuralı: ayar açıksa süre dolunca durur; altyazı değişimi (uzun konuşma) süreyi sıfırlar', async () => {
  const adapter = createStubAdapter({ blocks: [{ speaker: 'Hoca', text: 'Başlıyoruz.' }] });
  const harness = createHarness({ adapter });
  const clock = makeFakeClock(Date.now());
  harness.sandbox.Date = clock.Date;
  await harness.local.set({ 'mna.settings': { autoStopSilenceMin: 10 } });
  const messages = captureBackgroundMessages(harness);
  harness.sandbox.MNAJoin = { meetingEndReason: function () { return null; } };
  harness.loadContentScript(TAB_ID);

  try {
    await wait(50);
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    clock.now += 8 * 60 * 1000;
    // 8. dakikada konuşma sürüyor: metin uzuyor.
    adapter.setBlocks([{ speaker: 'Hoca', text: 'Başlıyoruz. Şimdi uzun bir konuya geçiyorum.' }]);
    assert.ok(triggerBodyObserver(harness));
    await wait(120);
    clock.now += 8 * 60 * 1000; // toplam 16 dk, son etkinlikten 8 dk
    await wait(800);
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 0, 'etkinlik varken (8 dk) durdurulmamalı');

    clock.now += 3 * 60 * 1000; // son etkinlikten 11 dk
    await wait(800);
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 1, '10 dk sessizlikten sonra durdurulmalı');
  } finally {
    await teardown(harness);
  }
});

test('Sessizlik kuralı kapalıyken (varsayılan) uzun sessizlikte kayıt durmaz', async () => {
  const adapter = createStubAdapter({ blocks: [{ speaker: 'Hoca', text: 'Başlıyoruz.' }] });
  const harness = createHarness({ adapter });
  const clock = makeFakeClock(Date.now());
  harness.sandbox.Date = clock.Date;
  const messages = captureBackgroundMessages(harness);
  harness.sandbox.MNAJoin = { meetingEndReason: function () { return null; } };
  harness.loadContentScript(TAB_ID);
  try {
    await wait(50);
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    clock.now += 5 * 60 * 60 * 1000;
    await wait(800);
    assert.equal(countType(messages, 'MNA_SESSION_STOP'), 0);
  } finally {
    await teardown(harness);
  }
});

test('Yalnız kalma kuralı (elle kayıt): sayaç «yalnız» derse bir kez durdurur; ayar kapalıysa durdurmaz', async () => {
  for (const enabled of [true, false]) {
    const adapter = createStubAdapter({ blocks: [{ speaker: 'Hoca', text: 'Merhaba.' }] });
    const harness = createHarness({ adapter });
    await harness.local.set({ 'mna.settings': { autoStopWhenAlone: enabled } });
    const messages = captureBackgroundMessages(harness);
    harness.sandbox.MNAJoin = {
      meetingEndReason: function () { return null; },
      createAloneWatcher: function () {
        return { update: function () { return true; } };
      },
    };
    harness.loadContentScript(TAB_ID);
    try {
      await wait(50);
      await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
      await wait(800);
      assert.equal(
        countType(messages, 'MNA_SESSION_STOP'),
        enabled ? 1 : 0,
        enabled ? 'yalnız kalınca durmalı' : 'ayar kapalıyken durmamalı'
      );
    } finally {
      await teardown(harness);
    }
  }
});

test('Kaydı başlat: altyazı kapalıysa Meet menüsünden açmayı dener, açıksa dokunmaz', async () => {
  for (const captionsOn of [false, true]) {
    const adapter = createStubAdapter({
      blocks: captionsOn ? [{ speaker: 'Kerem', text: 'Merhaba.' }] : [],
    });
    const harness = createHarness({ adapter });
    let clicks = 0;
    harness.sandbox.MNAJoin = {
      captionsEntry: function () {
        return captionsOn
          ? { kind: 'on', el: null }
          : { kind: 'toggle', el: { click: function () { clicks += 1; } } };
      },
    };
    harness.loadContentScript(TAB_ID);
    try {
      const result = await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
      assert.equal(result.ok, true);
      assert.equal(clicks, captionsOn ? 0 : 1, captionsOn ? 'açıkken basılmamalı' : 'kapalıyken açılmalı');
    } finally {
      await teardown(harness);
    }
  }
});

test('Altyazı düğmesine tek basış: menü açılır, çıkan «Altyazıları aç» öğesine kendisi basar', async () => {
  const harness = createHarness({ adapter: createStubAdapter({ blocks: [] }) });
  let menuClicks = 0;
  let itemClicks = 0;
  let menuOpen = false;
  const menu = { click: function () { menuClicks += 1; menuOpen = true; } };
  const item = { click: function () { itemClicks += 1; } };
  harness.sandbox.MNAJoin = {
    captionsEntry: function () {
      return menuOpen ? { kind: 'toggle', el: item } : { kind: 'menu', el: menu };
    },
  };
  harness.loadContentScript(TAB_ID);

  try {
    const result = await harness.sendToTab(TAB_ID, { type: 'MNA_TOGGLE_CAPTIONS' });
    assert.equal(result.ok, true);
    assert.equal(menuClicks, 1, 'menü düğmesine bir kez basılmalı');
    assert.equal(itemClicks, 0, 'öğe henüz görünmedi');
    await wait(900);
    assert.equal(itemClicks, 1, 'menü açılınca öğeye otomatik basılmalı');
    await wait(1800);
    assert.equal(itemClicks, 1, 'öğeye bir kez basılmalı');
    assert.equal(menuClicks, 1, 'menü yeniden basılıp kapatılmamalı');
  } finally {
    await teardown(harness);
  }
});

test('K6: altyazı bölgesi kaybolursa otomatik başlatma kilidi bırakılır', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Merhaba.' }],
  });
  const harness = createHarness({ adapter });
  await harness.local.set({ 'mna.settings': AUTO_START_SETTINGS });

  const messages = captureBackgroundMessages(harness);
  harness.loadContentScript(TAB_ID);

  try {
    await wait(50);
    assert.equal(countType(messages, 'MNA_CAPTURE_STATE_REQUEST'), 1);

    // Kullanıcı kaydı durdurur ve Meet altyazılarını kapatır.
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });
    adapter.setBlocks([]);

    // Sayfada değişiklik olur: bölge yok -> kilit bırakılır.
    assert.ok(triggerBodyObserver(harness), 'gövde gözlemcisi bulunmalı');
    await wait(50);
    assert.equal(
      countType(messages, 'MNA_CAPTURE_STATE_REQUEST'),
      1,
      'bölge yokken yeni istek gönderilmemeli'
    );

    // Kullanıcı CC'yi yeniden açar: yeni oturum otomatik başlamalı.
    adapter.setBlocks([{ speaker: 'Kerem', text: 'Tekrar bağlandım.' }]);
    assert.ok(triggerBodyObserver(harness), 'gövde gözlemcisi bulunmalı');
    await wait(50);
    assert.equal(
      countType(messages, 'MNA_CAPTURE_STATE_REQUEST'),
      2,
      'CC yeniden açıldığında otomatik başlatma yeniden çalışmalı'
    );
  } finally {
    await teardown(harness);
  }
});

test('K10: blockState sınırlı kalır ve değişmeyen bloklar tekrar gönderilmez', async () => {
  const blocks = [];
  for (let i = 0; i < 900; i += 1) {
    blocks.push({
      speaker: 'Katılımcı ' + (i % 4),
      text: 'Cümle ' + i + '. Bu bir test cümlesidir.',
    });
  }
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    harness.sandbox.window.__mnaScan();

    const size = harness.sandbox.window.__mnaBlockStateSize();
    assert.ok(size <= 800, 'blockState üst sınırı aşmamalı, görülen: ' + size);

    const tracked = harness.sandbox.window.__mnaTrackedBlockSize();
    assert.ok(tracked <= 1600, 'izlenen toplam blok sayısı sınırlı olmalı: ' + tracked);

    // İkinci tarama: hiçbir blok değişmedi, yeni satır üretilmemeli.
    const before = harness.sandbox.window.__mnaGetLines().length;
    harness.sandbox.window.__mnaScan();
    const after = harness.sandbox.window.__mnaGetLines().length;
    assert.equal(after, before, 'değişmeyen bloklar tekrar gönderilmemeli');
  } finally {
    await teardown(harness);
  }
});

test('K10: DOM\'dan kalan blokların kayıtları budanır', async () => {
  const blocks = [
    { speaker: 'Kerem', text: 'İlk cümle.' },
    { speaker: 'Elif', text: 'İkinci cümle.' },
  ];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    harness.sandbox.window.__mnaScan();
    assert.equal(harness.sandbox.window.__mnaBlockStateSize(), 2);

    // Meet altyazı bloğunu DOM\'dan kaldırır.
    adapter.setBlocks([]);
    harness.sandbox.window.__mnaScan();
    assert.equal(
      harness.sandbox.window.__mnaBlockStateSize(),
      0,
      'DOM\'da olmayan blokların kayıtları silinmeli'
    );
    assert.equal(harness.sandbox.window.__mnaTrackedBlockSize(), 0);
  } finally {
    await teardown(harness);
  }
});

test('K2: motorun güncellediği satırlar arka plana gönderilir', async () => {
  const updatedLine = {
    id: 'l7',
    speaker: 'Kerem',
    text: 'Merhaba nasılsın',
    startedAt: 1000,
    endedAt: 2500,
    seq: 7,
  };
  // Motor, kesinleşmiş satırın revize hâlini `updated` içinde döndürür.
  const fakeEngine = {
    observe() {
      return { committed: [], updated: [updatedLine] };
    },
    tick() {
      return { committed: [] };
    },
    flush() {
      return { committed: [] };
    },
    reset() {},
    getLines() {
      return [];
    },
    getPending() {
      return [];
    },
    restore() {
      return { ok: true, lineCount: 0, total: 0 };
    },
    configure() {
      return {};
    },
  };

  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Merhaba' }],
  });
  const harness = createHarness({ adapter, engine: fakeEngine });
  const messages = captureBackgroundMessages(harness);
  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    harness.sandbox.window.__mnaScan();

    // Kaydı durdurmak, bekleyen satırları hemen arka plana gönderir.
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });
    await wait(30);

    const appended = messages.filter(
      (message) => message && message.type === 'MNA_LINES_APPENDED'
    );
    assert.ok(appended.length >= 1, 'güncellenen satır arka plana gönderilmeli');

    const ids = [];
    for (const message of appended) {
      for (const line of message.lines || []) {
        ids.push(line.id);
      }
    }
    assert.ok(
      ids.includes('l7'),
      'güncellenen satırın id\'si MNA_LINES_APPENDED yükünde bulunmalı: ' + ids.join(', ')
    );
  } finally {
    await teardown(harness);
  }
});

test('Sekme arka plandayken tarama zamanlayıcı beklemeden mutasyonda yapılır', async () => {
  for (const hidden of [true, false]) {
    const adapter = createStubAdapter({ blocks: [{ speaker: 'Kerem', text: 'Merhaba herkese.' }] });
    let scans = 0;
    const originalCollect = adapter.collectBlocks;
    adapter.collectBlocks = function () {
      scans += 1;
      return originalCollect.apply(adapter, arguments);
    };
    const harness = createHarness({ adapter });
    harness.loadContentScript(TAB_ID);
    harness.sandbox.document.hidden = hidden;
    try {
      await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
      await wait(150);
      const before = scans;
      assert.ok(triggerBodyObserver(harness), 'gövde gözlemcisi bulunmalı');
      if (hidden) {
        assert.ok(scans > before, 'sayfa gizliyken tarama hemen yapılmalı');
      } else {
        assert.strictEqual(scans, before, 'sayfa görünürken tarama zamanlayıcıya bırakılır');
      }
    } finally {
      await teardown(harness);
    }
  }
});

/** Test hızlandırması: outbox yeniden deneme beklemesini (1500 ms) kısaltır. */
function speedUpOutboxTimer(harness, shortMs) {
  const originalSetTimeout = harness.sandbox.setTimeout;
  harness.sandbox.setTimeout = function (fn, ms, ...rest) {
    const adjusted = ms === 1500 ? shortMs : ms;
    return originalSetTimeout(fn, adjusted, ...rest);
  };
}

test('M5: durdurma anında gönderim sürerken kuyruğa giren son satır da arka plana hemen ulaşır', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Birinci cümle gönderiliyor.' }],
  });
  const harness = createHarness({ adapter });
  const receivedLines = [];
  let releaseFirstSend = null;
  let sendCount = 0;

  harness.swListeners.push(function (message, sender, sendResponse) {
    if (!message || message.type !== 'MNA_LINES_APPENDED') {
      return false;
    }
    sendCount += 1;
    const batch = (message.lines || []).map((l) => l.text);
    if (sendCount === 1) {
      // İlk gönderimi uçuşta beklet (outboxBusy = true kalsın).
      releaseFirstSend = function () {
        receivedLines.push(...batch);
        sendResponse({ ok: true, appended: batch.length, revised: 0 });
      };
      return true;
    }
    receivedLines.push(...batch);
    sendResponse({ ok: true, appended: batch.length, revised: 0 });
    return false;
  });

  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });

    // İlk outbox zamanlayıcısının (1500 ms) ateşlenip ilk gönderimi başlatmasını bekle.
    const deadline = Date.now() + 2500;
    while (!releaseFirstSend && Date.now() < deadline) {
      await wait(20);
    }
    assert.ok(releaseFirstSend, 'ilk paket uçuşa geçmiş olmalı');

    // İlk paket hâlâ yoldayken yeni konuşmacı satırı eklenir ve kayıt durdurulur.
    adapter.setBlocks([
      { speaker: 'Kerem', text: 'Birinci cümle gönderiliyor.' },
      { speaker: 'Elif', text: 'Durdurma anındaki son cümle.' },
    ]);
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });

    // İlk paketin yanıtını serbest bırak.
    releaseFirstSend();
    // Service worker durdurmada yalnızca 250 ms bekliyor; ikinci paket 1.5 sn beklemeden ulaşmalı.
    await wait(150);

    assert.equal(sendCount, 2, 'ikinci paket ilk paketin ardından hemen gönderilmeli');
    assert.ok(
      receivedLines.some((text) => /Birinci cümle/.test(text)),
      'ilk paket arka plana ulaşmalı'
    );
    assert.ok(
      receivedLines.some((text) => /Durdurma anındaki son cümle/.test(text)),
      'durdurma anında eklenen son satır da arka plana ulaşmalı'
    );
  } finally {
    await teardown(harness);
  }
});

test('M5: durdurma sonrası geçici hatada satırlar silinmez ve tekrar denenir', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Durdurma sonrası geçici hata satırı.' }],
  });
  const harness = createHarness({ adapter });
  speedUpOutboxTimer(harness, 10);

  let attempts = 0;
  const savedTexts = [];
  harness.swListeners.push(function (message, sender, sendResponse) {
    if (!message || message.type !== 'MNA_LINES_APPENDED') {
      return false;
    }
    attempts += 1;
    if (attempts === 1) {
      sendResponse({ ok: false, error: 'Geçici depolama hatası' });
      return false;
    }
    for (const l of message.lines || []) {
      savedTexts.push(l.text);
    }
    sendResponse({ ok: true, appended: (message.lines || []).length, revised: 0 });
    return false;
  });

  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });

    await wait(100);
    assert.equal(attempts, 2, 'geçici hata sonrası satırlar tekrar denenmeli');
    assert.ok(
      savedTexts.some((text) => /Durdurma sonrası geçici hata satırı/.test(text)),
      'satırlar silinmemeli ve ikinci denemede arka plana ulaşmalı'
    );
  } finally {
    await teardown(harness);
  }
});

test('M5: aktif oturum bulunamadı hatasında satırlar bırakılır ve tekrar denenmez', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Oturum kapalıyken gelen satır.' }],
  });
  const harness = createHarness({ adapter });
  speedUpOutboxTimer(harness, 10);

  let attempts = 0;
  harness.swListeners.push(function (message, sender, sendResponse) {
    if (!message || message.type !== 'MNA_LINES_APPENDED') {
      return false;
    }
    attempts += 1;
    sendResponse({ ok: false, error: 'Aktif oturum bulunamadı.' });
    return false;
  });

  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });

    await wait(100);
    assert.equal(attempts, 1, 'kalıcı hatada yeniden deneme yapılmamalı');
  } finally {
    await teardown(harness);
  }
});

test('M5: ardışık 20 geçici hatadan sonra satırlar bırakılır ve uyarı yazılır', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Sürekli başarısız olan satır.' }],
  });
  const harness = createHarness({ adapter });
  speedUpOutboxTimer(harness, 1);

  const warnings = [];
  harness.sandbox.console.warn = function (...args) {
    warnings.push(args.join(' '));
  };

  let attempts = 0;
  harness.swListeners.push(function (message, sender, sendResponse) {
    if (!message || message.type !== 'MNA_LINES_APPENDED') {
      return false;
    }
    attempts += 1;
    sendResponse({ ok: false, error: 'Geçici hata' });
    return false;
  });

  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });

    const deadline = Date.now() + 2000;
    while (attempts < 20 && Date.now() < deadline) {
      await wait(15);
    }
    // Bırakıldıktan sonra ek deneme yapılmadığını görmek için kısa bir süre daha bekle.
    await wait(50);
    assert.equal(attempts, 20, '20 ardışık denemeden sonra bırakılmalı');
    assert.ok(
      warnings.some((msg) => /20.*bırak|sınır|ardışık/i.test(msg)),
      'üst sınır aşıldığında console.warn yazılmalı'
    );
  } finally {
    await teardown(harness);
  }
});

test('M5: eski oturumdan kuyrukta kalan satır yeni oturumun sessionId\'si ile gönderilmez', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Birinci oturum cümlesi.' }],
  });
  const harness = createHarness({ adapter });
  speedUpOutboxTimer(harness, 15);

  const sentBatches = [];
  let failFirst = true;
  harness.swListeners.push(function (message, sender, sendResponse) {
    if (!message || message.type !== 'MNA_LINES_APPENDED') {
      return false;
    }
    if (failFirst) {
      failFirst = false;
      sendResponse({ ok: false, error: 'Geçici hata' });
      return false;
    }
    sentBatches.push({
      sessionId: message.sessionId,
      texts: (message.lines || []).map((l) => l.text),
    });
    sendResponse({ ok: true, appended: (message.lines || []).length, revised: 0 });
    return false;
  });

  harness.loadContentScript(TAB_ID);

  try {
    // Oturum 1 başlar, bir satır kesinleşir ve durdurma sırasında ilk gönderim geçici hata alır.
    await harness.sendToTab(TAB_ID, {
      type: 'MNA_SET_CAPTURE',
      active: true,
      sessionId: 'sess_1',
      startedAt: 1000,
    });
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });
    await wait(5);

    // Kuyrukta sess_1 satırı varken Oturum 2 başlar.
    adapter.setBlocks([{ speaker: 'Elif', text: 'İkinci oturum cümlesi.' }]);
    await harness.sendToTab(TAB_ID, {
      type: 'MNA_SET_CAPTURE',
      active: true,
      sessionId: 'sess_2',
      startedAt: 2000,
    });
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });

    const deadline = Date.now() + 1000;
    while (sentBatches.length < 2 && Date.now() < deadline) {
      await wait(15);
    }

    const sess1Texts = sentBatches
      .filter((b) => b.sessionId === 'sess_1')
      .flatMap((b) => b.texts);
    const sess2Texts = sentBatches
      .filter((b) => b.sessionId === 'sess_2')
      .flatMap((b) => b.texts);

    assert.ok(
      sess1Texts.some((t) => /Birinci oturum cümlesi/.test(t)),
      'eski satır kendi oturum kimliği (sess_1) ile gönderilmeli'
    );
    assert.ok(
      !sess2Texts.some((t) => /Birinci oturum cümlesi/.test(t)),
      'eski oturum satırı yeni oturuma (sess_2) sızmamalı'
    );
    assert.ok(
      sess2Texts.some((t) => /İkinci oturum cümlesi/.test(t)),
      'yeni satır kendi oturum kimliği (sess_2) ile gönderilmeli'
    );
  } finally {
    await teardown(harness);
  }
});

test('M5: eski satır 19 kez başarısız olmuşken eklenen yeni satır 20. hatada düşmez ve kaydedilir', async () => {
  const adapter = createStubAdapter({
    blocks: [{ speaker: 'Kerem', text: 'Eski inatçı satır.' }],
  });
  const harness = createHarness({ adapter });
  speedUpOutboxTimer(harness, 15);
  harness.sandbox.console.warn = function () {};

  let attempts = 0;
  let batch20Texts = [];
  const savedTexts = [];
  let onAttempt19 = null;

  harness.swListeners.push(function (message, sender, sendResponse) {
    if (!message || message.type !== 'MNA_LINES_APPENDED') {
      return false;
    }
    attempts += 1;
    const texts = (message.lines || []).map((l) => l.text);
    if (attempts <= 20) {
      if (attempts === 20) {
        batch20Texts = texts;
      }
      sendResponse({ ok: false, error: 'Geçici hata' });
      if (attempts === 19 && onAttempt19) {
        setTimeout(onAttempt19, 2);
      }
      return false;
    }
    savedTexts.push(...texts);
    sendResponse({ ok: true, appended: texts.length, revised: 0 });
    return false;
  });

  harness.loadContentScript(TAB_ID);

  try {
    await harness.sendToTab(TAB_ID, {
      type: 'MNA_SET_CAPTURE',
      active: true,
      sessionId: 'sess_mix',
      startedAt: 1000,
    });
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });

    await new Promise((resolve) => {
      onAttempt19 = async function () {
        // 19. hata sonrası, 20. denemeden hemen önce yeni satır kuyruğa eklenir.
        adapter.setBlocks([
          { speaker: 'Kerem', text: 'Eski inatçı satır.' },
          { speaker: 'Elif', text: 'Yeni eklenen satır.' },
        ]);
        harness.sandbox.window.__mnaScan();
        await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });
        resolve();
      };
    });

    const deadline = Date.now() + 2000;
    while (attempts < 21 && Date.now() < deadline) {
      await wait(15);
    }

    assert.ok(
      batch20Texts.some((t) => /Eski inatçı satır/.test(t)) &&
        batch20Texts.some((t) => /Yeni eklenen satır/.test(t)),
      '20. deneme eski ve yeni satırı birlikte göndermeli'
    );
    assert.ok(
      !savedTexts.some((t) => /Eski inatçı satır/.test(t)),
      '20. hatada yalnızca eski satır bırakılmalı'
    );
    assert.ok(
      savedTexts.some((t) => /Yeni eklenen satır/.test(t)),
      'yeni satır eski satırın hata sayacından etkilenmeyip 21. denemede kaydedilmeli'
    );
  } finally {
    await teardown(harness);
  }
});

test('M5: aktif oturum okunamadı ve context invalidated hataları kalıcı sayılır', async () => {
  for (const errorMessage of ['Aktif oturum okunamadı.', 'Extension context invalidated.']) {
    const adapter = createStubAdapter({
      blocks: [{ speaker: 'Kerem', text: 'Kalıcı hata denemesi.' }],
    });
    const harness = createHarness({ adapter });
    speedUpOutboxTimer(harness, 5);

    let attempts = 0;
    harness.swListeners.push(function (message, sender, sendResponse) {
      if (!message || message.type !== 'MNA_LINES_APPENDED') {
        return false;
      }
      attempts += 1;
      sendResponse({ ok: false, error: errorMessage });
      return false;
    });

    harness.loadContentScript(TAB_ID);
    try {
      await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
      harness.sandbox.window.__mnaScan();
      await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });
      await wait(60);
      assert.equal(attempts, 1, errorMessage + ' kalıcı sayılmalı, yeniden denenmemeli');
    } finally {
      await teardown(harness);
    }
  }
});