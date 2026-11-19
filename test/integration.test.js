/**
 * Uçtan uca entegrasyon testi.
 *
 * Gerçek `service-worker.js` ve gerçek `content.js` (gerçek motor) sahte bir
 * Chrome API ortamında çalıştırılır. Amaç: mesaj protokolünün, oturum
 * yaşam döngüsünün ve satır aktarımının tarayıcıda da çalışacağını doğrulamak.
 *
 * Çalıştırma: node --test test/integration.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createHarness, createStubAdapter } = require('./helpers/harness.js');

const TAB_ID = 1;
const OUTBOX_INTERVAL_MS = 1500;

/** İçerik betiğinin outbox zamanlayıcısını bekle. */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function line(id, speaker, text, startedAt) {
  return {
    id,
    speaker,
    text,
    startedAt,
    endedAt: startedAt + 1000,
    seq: Number(String(id).replace(/\D/g, '')) || 1
  };
}

test('Service worker: oturum yaşam döngüsü uçtan uca', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok, 'oturum başlatılmalı: ' + JSON.stringify(start));
  assert.ok(start.sessionId, 'oturum kimliği dönmeli');

  const sessionId = start.sessionId;

  const appended = await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId,
    lines: [line('l1', 'Kerem', 'Merhaba.', 1000)]
  });
  assert.ok(appended && appended.ok);

  // AYNI satırlar ikinci kez gönderilirse çift kayıt oluşmamalı.
  await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId,
    lines: [line('l1', 'Kerem', 'Merhaba.', 1000)]
  });

  await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId,
    lines: [line('l2', 'Elif', 'Nasılsın?', 2000)]
  });

  const stop = await harness.sendToBackground({ type: 'MNA_SESSION_STOP' });
  assert.ok(stop && stop.ok, 'oturum durdurulmalı');
  assert.ok(stop.session, 'durdurma oturumu döndürmeli');
  assert.equal(stop.session.lines.length, 2, 'çift kayıt olmamalı, 2 satır beklenir');
  assert.ok(stop.session.endedAt, 'endedAt damgalanmalı');

  const list = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
  assert.ok(list && list.ok);
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].lineCount, 2);

  const get = await harness.sendToBackground({ type: 'MNA_SESSION_GET', sessionId });
  assert.ok(get && get.ok);
  assert.equal(get.session.lines.length, 2);

  const renamed = await harness.sendToBackground({
    type: 'MNA_SESSION_UPDATE',
    sessionId,
    title: 'Haftalık Sync'
  });
  assert.ok(renamed && renamed.ok);
  assert.equal(renamed.session.title, 'Haftalık Sync');

  const removed = await harness.sendToBackground({ type: 'MNA_SESSION_DELETE', sessionId });
  assert.ok(removed && removed.ok);

  const listAfter = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
  assert.equal(listAfter.sessions.length, 0, 'oturum silinmeli');
});

test('Service worker: oturum yokken satır ekleme hata döndürür', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();

  const result = await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    lines: [line('l1', 'Kerem', 'Merhaba.', 1000)]
  });
  assert.ok(result && result.ok === false, 'aktif oturum yoksa hata dönmeli');
});

test('Service worker: sekme kapanınca oturum yarım olarak kaydedilir', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok);

  await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId: start.sessionId,
    lines: [line('l1', 'Kerem', 'Merhaba.', 1000)]
  });

  harness.removeTab(TAB_ID);
  await wait(50);

  const list = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
  assert.equal(list.sessions.length, 1, 'oturum kaybolmamalı');
  assert.equal(list.sessions[0].lineCount, 1, 'satırlar korunmalı');
});

test('İçerik betiği: durum, yakalama ve satır toplama', async () => {
  const blocks = [
    { speaker: 'Kerem', text: 'Haftalık planlamayı başlayalım.' },
    { speaker: 'Elif', text: 'Ben mobil taraftan ilerleme durumunu paylaşayım.' }
  ];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  const status = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
  assert.ok(status && status.ok);
  assert.equal(status.capture.active, false, 'başlangıçta kayıt kapalı olmalı');
  assert.equal(status.captions.detected, true, 'altyazı bölgesi bulunmalı');
  assert.equal(status.meeting.code, 'abc-defg-hij');

  const setActive = await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
  assert.ok(setActive && setActive.ok);
  assert.equal(setActive.active, true, 'yakalama açılmalı');

  // Altyazı bloklarını gözlemci üzerinden bildir.
  harness.sandbox.MutationObserver.prototype.trigger =
    function trigger() {
      this.callback([]);
    };
  // Gözlemciyi tetiklemek yerine doğrudan tarama yaptır.
  harness.sandbox.window.__mnaGetLines();

  const lines = await harness.sendToTab(TAB_ID, { type: 'MNA_GET_LINES' });
  assert.ok(lines && lines.ok);
  assert.ok(Array.isArray(lines.lines));
});

test('İçerik betiği: altyazı düğmesi bulunamazsa anlaşılır hata döner', async () => {
  const harness = createHarness({ adapter: createStubAdapter({ blocks: [] }) });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  const result = await harness.sendToTab(TAB_ID, { type: 'MNA_TOGGLE_CAPTIONS' });
  assert.ok(result, 'yanıt dönmeli');
  assert.equal(result.ok, false, 'düğme yoksa hata dönmeli');
  assert.match(String(result.error), /altyazı/i);
});

test('İçerik betiği: bilinmeyen mesaj tipi hata döndürür', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  const result = await harness.sendToTab(TAB_ID, { type: 'MNA_YOK_BOYLE_BIR_SEY' });
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /bilinmeyen/i);
});

test('Uçtan uca: içerik betiğinin satırları oturuma yazılır', async () => {
  const blocks = [
    { speaker: 'Kerem', text: 'Bütçe kalemi ne kadar kaldı?' },
    { speaker: 'Murat', text: '120 bin TL kaldı.' }
  ];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok);

  // Arka plan, içerik betiğine MNA_SET_CAPTURE gönderdi; içerik betiği de
  // durum bildirimi yapar. Şimdi altyazılar gözlenir.
  const flush = await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });
  assert.ok(flush && flush.ok);

  // İçerik betiğinin outbox'ı arka plana satırları gönderir (1.5 sn'de bir).
  await wait(OUTBOX_INTERVAL_MS + 400);

  const stop = await harness.sendToBackground({ type: 'MNA_SESSION_STOP' });
  assert.ok(stop && stop.ok, 'oturum durdurulmalı');
  assert.ok(stop.session, 'oturum dönmeli');
  assert.equal(stop.session.lines.length, 2, 'iki satır oturuma yazılmalı');
  assert.equal(stop.session.lines[0].speaker, 'Kerem');
  assert.match(stop.session.lines[0].text, /bütçe/i);
  assert.equal(stop.session.lines[1].speaker, 'Murat');
});

test('Service worker: aynı id\'li revize satır yerinde güncellenir (mükerrer olmaz)', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok);

  await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId: start.sessionId,
    lines: [line('l1', 'Kerem', 'Dünyada hiç keşfedilmemiş', 1000)]
  });

  // Meet altyazıyı sonradan uzattı: AYNI id, FARKLI metin.
  const revised = await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId: start.sessionId,
    lines: [
      line('l1', 'Kerem', 'Dünyada hiç keşfedilmemiş bir fındık bulmamız gerekiyor', 1000)
    ]
  });
  assert.ok(revised && revised.ok);
  assert.equal(revised.appended, 0, 'yeni satır sayılmamalı');
  assert.equal(revised.revised, 1, 'revize edilen satır bildirilmeli');

  const get = await harness.sendToBackground({
    type: 'MNA_SESSION_GET',
    sessionId: start.sessionId
  });
  assert.ok(get && get.ok);
  assert.equal(get.session.lines.length, 1, 'TEK satır olmalı (mükerrer olmamalı)');
  assert.equal(
    get.session.lines[0].text,
    'Dünyada hiç keşfedilmemiş bir fındık bulmamız gerekiyor'
  );
});

test('Uçtan uca: junk filtresi kapalıyken arayüz metni de satır olur', async () => {
  const blocks = [{ speaker: 'Kerem', text: 'frame_person' }];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  await harness.local.set({
    'mna.settings': { graceMs: 1500, junkFilter: false, speakerFallback: 'Bilinmeyen' }
  });

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok);

  await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });
  await wait(OUTBOX_INTERVAL_MS + 400);

  const stop = await harness.sendToBackground({ type: 'MNA_SESSION_STOP' });
  assert.ok(stop && stop.ok);
  assert.equal(stop.session.lines.length, 1, 'junk filtresi kapalıyken arayüz metni satır olmalı');
  assert.equal(stop.session.lines[0].text, 'frame_person');
});

test('Uçtan uca: junk filtresi açıkken arayüz metni elenir', async () => {
  const blocks = [{ speaker: 'Kerem', text: 'more_vert' }];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok);

  await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });
  await wait(OUTBOX_INTERVAL_MS + 400);

  const stop = await harness.sendToBackground({ type: 'MNA_SESSION_STOP' });
  assert.ok(stop && stop.ok);
  assert.equal(stop.session.lines.length, 0, 'arayüz metni satır olmamalı');
});

const MEETING_A = {
  url: 'https://meet.google.com/abc-defg-hij',
  code: 'abc-defg-hij',
  title: 'Haftalık Sync'
};
const MEETING_B = {
  url: 'https://meet.google.com/xyz-uvwx-rst',
  code: 'xyz-uvwx-rst',
  title: 'B Toplantısı'
};

function contentSender(meeting) {
  return { id: 'test-extension', tab: { id: TAB_ID, url: meeting.url } };
}

/** Sekmenin adresini ve MNA_STATUS yanıtını verilen toplantıya çeker. */
function followMeeting(harness, meeting) {
  const state = { meeting: meeting };
  const captureStates = [];
  const original = harness.chrome.tabs.sendMessage;
  harness.chrome.tabs.get(TAB_ID, (tab) => {
    if (tab) {
      tab.url = state.meeting.url;
      tab.title = state.meeting.title;
    }
  });
  harness.chrome.tabs.sendMessage = function (tabId, message, callback) {
    if (message && message.type === 'MNA_STATUS') {
      callback({
        ok: true,
        capture: { active: true, startedAt: 1, lineCount: 0, lastLineAt: null },
        captions: { detected: true },
        meeting: state.meeting
      });
      return;
    }
    if (message && message.type === 'MNA_CAPTURE_STATE') {
      captureStates.push(message);
    }
    return original.call(this, tabId, message, callback);
  };
  return {
    captureStates,
    setMeeting(next) {
      state.meeting = next;
      harness.chrome.tabs.get(TAB_ID, (tab) => {
        if (tab) {
          tab.url = next.url;
          tab.title = next.title;
        }
      });
    }
  };
}

test('Aynı sekmede toplantı kodu değişince yeni satırlar yeni oturuma yazılır', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok, 'A toplantısında kayıt başlamalı');

  await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId: start.sessionId,
    lines: [line('a1', 'Kerem', 'Bu cümle A toplantısına ait.', 1000)]
  });

  const live = followMeeting(harness, MEETING_B);
  const sender = contentSender(MEETING_B);

  const activeResponse = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
  assert.ok(activeResponse && activeResponse.ok);
  assert.ok(activeResponse.active, 'kayıt sürmeli');
  assert.notEqual(activeResponse.active.sessionId, start.sessionId, 'yeni oturum açılmalı');
  assert.equal(activeResponse.active.meetingCode, MEETING_B.code);
  assert.equal(activeResponse.active.meetingUrl, MEETING_B.url);

  const captureRequest = await harness.sendToBackground(
    { type: 'MNA_CAPTURE_STATE_REQUEST' },
    sender
  );
  assert.equal(captureRequest.active.sessionId, activeResponse.active.sessionId);
  assert.equal(captureRequest.active.meetingCode, MEETING_B.code);

  const appended = await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId: start.sessionId,
    lines: [line('b1', 'Ayşe', 'Bu cümle B toplantısına ait.', 5000)]
  }, sender);
  assert.ok(appended && appended.ok);

  const list = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
  assert.equal(list.sessions.length, 2, 'iki toplantı iki oturum olmalı');

  const storedA = await harness.sendToBackground({
    type: 'MNA_SESSION_GET',
    sessionId: start.sessionId
  });
  assert.equal(storedA.session.meetingCode, MEETING_A.code);
  assert.equal(storedA.session.meetingUrl, MEETING_A.url);
  assert.ok(storedA.session.endedAt, 'eski oturum kapanmalı');
  assert.deepEqual(
    storedA.session.lines.map((item) => item.id),
    ['a1'],
    'B cümlesi eski nota yazılmamalı'
  );

  const storedB = await harness.sendToBackground({
    type: 'MNA_SESSION_GET',
    sessionId: activeResponse.active.sessionId
  });
  assert.equal(storedB.session.meetingCode, MEETING_B.code);
  assert.equal(storedB.session.meetingUrl, MEETING_B.url);
  assert.equal(storedB.session.endedAt, null);
  assert.deepEqual(storedB.session.lines.map((item) => item.id), ['b1']);

  const activeNow = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
  assert.equal(activeNow.active.sessionId, activeResponse.active.sessionId);
  assert.equal(activeNow.active.meetingCode, MEETING_B.code);

  assert.ok(live.captureStates.length >= 1, 'içerik betiğine yakalama durumu gitmeli');
  for (const state of live.captureStates) {
    assert.equal(state.sessionId, activeResponse.active.sessionId, 'yakalama durumu yeni oturumu taşımalı');
  }

  harness.cleanup();
});

test('Toplantı kodu aynıysa kayıt aynı oturumda sürer', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok);

  const same = {
    url: 'https://meet.google.com/abc-defg-hij?authuser=1',
    code: 'abc-defg-hij',
    title: 'Haftalık Sync'
  };
  followMeeting(harness, same);
  const sender = contentSender(same);

  await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
  await harness.sendToBackground({ type: 'MNA_CAPTURE_STATE_REQUEST' }, sender);
  await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId: start.sessionId,
    lines: [line('a2', 'Kerem', 'Aynı toplantı devam ediyor.', 2000)]
  }, sender);

  const list = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
  assert.equal(list.sessions.length, 1, 'aynı kod yeni oturum açmamalı');

  const stored = await harness.sendToBackground({
    type: 'MNA_SESSION_GET',
    sessionId: start.sessionId
  });
  assert.equal(stored.session.endedAt, null, 'kayıt kapanmamalı');
  assert.equal(stored.session.meetingCode, MEETING_A.code);
  assert.equal(stored.session.lines.length, 1);

  const activeNow = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
  assert.equal(activeNow.active.sessionId, start.sessionId);

  harness.cleanup();
});

test('Toplantı kodu anlaşılamıyorsa çalışan kayıt kapanmaz', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
  assert.ok(start && start.ok);

  const unknown = {
    url: 'https://meet.google.com/lookup/birisi',
    code: '',
    title: 'Meet'
  };
  followMeeting(harness, unknown);
  const sender = contentSender(unknown);

  const activeResponse = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
  assert.equal(activeResponse.active.sessionId, start.sessionId);
  assert.equal(activeResponse.active.meetingCode, MEETING_A.code);

  await harness.sendToBackground({
    type: 'MNA_LINES_APPENDED',
    sessionId: start.sessionId,
    lines: [line('a3', 'Kerem', 'Kod yok, kayıt sürüyor.', 3000)]
  }, sender);

  const list = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
  assert.equal(list.sessions.length, 1);

  const stored = await harness.sendToBackground({
    type: 'MNA_SESSION_GET',
    sessionId: start.sessionId
  });
  assert.equal(stored.session.endedAt, null);
  assert.equal(stored.session.meetingCode, MEETING_A.code);
  assert.equal(stored.session.meetingUrl, MEETING_A.url);
  assert.equal(stored.session.lines.length, 1);

  harness.cleanup();
});

test('Süren kayıt silinince yakalama kapanır ve silinen satırlar geri gelmez', async () => {
  const blocks = [{ speaker: 'Kerem', text: 'İlk cümle depoya geçsin.' }];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  try {
    const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.ok(start && start.ok, 'kayıt başlamalı');

    harness.sandbox.window.__mnaScan();
    const flush = await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });
    assert.ok(flush && flush.ok);
    assert.equal(flush.lines.length, 1, 'ilk satır içerikte kesinleşmeli');
    await wait(OUTBOX_INTERVAL_MS + 400);

    const stored = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: start.sessionId
    });
    assert.ok(stored && stored.ok);
    assert.equal(stored.session.endedAt, null, 'silmeden önce kayıt sürmeli');
    assert.equal(stored.session.lines.length, 1, 'ilk satır depoya geçmeli');

    const removed = await harness.sendToBackground({
      type: 'MNA_SESSION_DELETE',
      sessionId: start.sessionId
    });
    assert.ok(removed && removed.ok);
    assert.equal(removed.deleted, true, 'not silinmeli');

    const afterDelete = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
    assert.equal(afterDelete.capture.active, false, 'silme sonrası yakalama kapanmalı');

    const gone = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: start.sessionId
    });
    assert.equal(gone.ok, false, 'silinen oturum okunamamalı');

    adapter.setBlocks([{ speaker: 'Elif', text: 'Silindikten sonra gelen cümle.' }]);
    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });
    await wait(OUTBOX_INTERVAL_MS + 400);

    const texts = harness.sandbox.window.__mnaGetLines().map((line) => line.text);
    assert.ok(
      !texts.includes('Silindikten sonra gelen cümle.'),
      'kapalı yakalama yeni satır üretmemeli'
    );

    const list = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
    assert.equal(list.sessions.length, 0, 'silinen oturum ve yeni satır depoya yazılmamalı');

    const stop = await harness.sendToBackground({ type: 'MNA_SESSION_STOP' });
    assert.equal(stop.ok, false);
    assert.match(String(stop.error), /Devam eden bir kayıt bulunamadı/);
    const afterStop = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
    assert.equal(afterStop.capture.active, false, 'durdurma yakalamayı yeniden açmamalı');
  } finally {
    harness.cleanup();
  }
});

test('Oturum yokken durdurma açık yakalamayı kapatır', async () => {
  const blocks = [{ speaker: 'Kerem', text: 'Bu satır kayda geçmemeli.' }];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  harness.loadServiceWorker();
  harness.loadContentScript(TAB_ID);

  try {
    const armed = await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: true });
    assert.equal(armed.active, true, 'yakalama açılmalı');
    await wait(50);

    const active = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.ok(!active.active, 'bu kurulumda aktif oturum olmamalı');

    harness.sandbox.window.__mnaScan();
    await harness.sendToTab(TAB_ID, { type: 'MNA_FLUSH' });
    await wait(OUTBOX_INTERVAL_MS + 400);

    const before = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
    assert.equal(before.sessions.length, 0, 'oturum yokken satır yazılmamalı');

    const stop = await harness.sendToBackground({ type: 'MNA_SESSION_STOP' });
    assert.equal(stop.ok, true, 'açık yakalama kapanmalı');

    const status = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
    assert.equal(status.capture.active, false);

    const again = await harness.sendToBackground({ type: 'MNA_SESSION_STOP' });
    assert.equal(again.ok, false);
    assert.match(String(again.error), /Devam eden bir kayıt bulunamadı/);

    const list = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
    assert.equal(list.sessions.length, 0, 'kapanış eski satırları geri yazmamalı');
  } finally {
    harness.cleanup();
  }
});

/** Sekmeye giden MNA_CAPTURE_STATE mesajlarını kaydeder. */
function watchCaptureStates(harness) {
  const captureStates = [];
  const original = harness.chrome.tabs.sendMessage;
  harness.chrome.tabs.sendMessage = function (tabId, message, callback) {
    if (message && message.type === 'MNA_CAPTURE_STATE') {
      captureStates.push({
        tabId: tabId,
        sessionId: message.sessionId,
        active: message.active
      });
    }
    return original.call(this, tabId, message, callback);
  };
  return captureStates;
}

test('Otomatik açılan oturum sekme kimliğini yazar ve session temizlenince kapanır', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);
  const captureStates = watchCaptureStates(harness);
  const sender = contentSender(MEETING_A);

  try {
    const opened = await harness.sendToBackground(
      { type: 'MNA_CAPTURE_STATE_REQUEST' },
      sender
    );
    assert.ok(opened && opened.ok);
    assert.ok(opened.active && opened.active.sessionId, 'otomatik oturum açılmalı');
    const sessionId = opened.active.sessionId;

    const record = harness.local.store.get('mna.activeSession');
    assert.equal(typeof record.tabId, 'number', 'otomatik oturumun tabId alanı dolu olmalı');
    assert.equal(record.tabId, TAB_ID);

    const still = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
    assert.equal(still.active.sessionId, sessionId, 'canlı oturum kapanmamalı');
    assert.ok(
      captureStates.some((state) => state.tabId === TAB_ID && state.sessionId === sessionId && state.active === true),
      'session kimliği dururken yakalama bağlanmalı'
    );

    const popupLive = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION', restore: true });
    assert.equal(popupLive.active.sessionId, sessionId);

    const beforeClear = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: sessionId
    });
    assert.equal(beforeClear.session.endedAt, null);

    captureStates.length = 0;
    await harness.chrome.storage.session.clear();

    const fromContent = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
    assert.equal(fromContent.active, null, 'eski oturum açık dönmemeli');
    assert.equal(captureStates.length, 0, 'ölü oturuma yakalama durumu gitmemeli');

    const fromPopup = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION', restore: true });
    assert.equal(fromPopup.active, null, 'popup kaydı sürüyor görmemeli');

    const stored = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: sessionId
    });
    assert.ok(stored.session.endedAt, 'otomatik oturum kapanmalı');
    assert.equal(harness.local.store.get('mna.activeSession'), undefined);
  } finally {
    harness.cleanup();
  }
});

test('Elle açılan oturum session temizlenince kapanır', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);
  const sender = contentSender(MEETING_A);

  try {
    const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.ok(start && start.ok);
    assert.equal(harness.local.store.get('mna.activeSession').tabId, TAB_ID);

    const live = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
    assert.equal(live.active.sessionId, start.sessionId);

    await harness.chrome.storage.session.clear();

    const fromPopup = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION', restore: true });
    assert.equal(fromPopup.active, null, 'popup kaydı sürüyor görmemeli');

    const fromContent = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' }, sender);
    assert.equal(fromContent.active, null);

    const stored = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: start.sessionId
    });
    assert.ok(stored.session.endedAt, 'elle açılan oturum kapanmalı');
    assert.equal(harness.local.store.get('mna.activeSession'), undefined);

    const reopened = await harness.sendToBackground(
      { type: 'MNA_CAPTURE_STATE_REQUEST' },
      sender
    );
    assert.ok(reopened.active && reopened.active.sessionId);
    assert.notEqual(reopened.active.sessionId, start.sessionId);
    assert.equal(harness.local.store.get('mna.activeSession').tabId, TAB_ID);
  } finally {
    harness.cleanup();
  }
});

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

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await wait(40);
  }
  return false;
}

function recordMessages(harness) {
  const messages = [];
  harness.swListeners.unshift(function (message) {
    messages.push(message);
    return false;
  });
  return messages;
}

const CC_SETTINGS = {
  graceMs: 2500,
  junkFilter: true,
  speakerFallback: 'Bilinmeyen'
};

test('Otomatik kayıt altyazı bölgesi kalkınca durur ve oturumu kapatır', async () => {
  const blocks = [{ speaker: 'Kerem', text: 'Otomatik kayıt açıkken altyazı kapanacak.' }];
  const adapter = createStubAdapter({ blocks });
  // Chrome içerik mesajına sender.tab ekler. Sekme yoksa otomatik oturum açılmaz.
  const harness = createHarness({ adapter, contentSenderTabId: TAB_ID });
  await harness.local.set({
    'mna.settings': Object.assign({ autoStartOnCc: true }, CC_SETTINGS)
  });
  harness.loadServiceWorker();
  const messages = recordMessages(harness);
  harness.loadContentScript(TAB_ID);

  try {
    const becameActive = await waitUntil(async () => {
      const status = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
      return !!(status && status.capture && status.capture.active);
    });
    assert.ok(becameActive, 'otomatik kayıt başlamalı');

    const sawBlock = await waitUntil(
      () => harness.sandbox.window.__mnaBlockStateSize() >= 1
    );
    assert.ok(sawBlock, 'altyazı bloğu taranmalı');

    const before = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.ok(before.active && before.active.sessionId, 'aktif oturum açılmalı');
    const sessionId = before.active.sessionId;
    const beforeStored = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId
    });
    assert.equal(beforeStored.session.endedAt, null);

    adapter.setBlocks([]);
    assert.ok(triggerBodyObserver(harness), 'gövde gözlemcisi tetiklenmeli');

    const captureOff = await waitUntil(async () => {
      const status = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
      return !!(status && status.capture && status.capture.active === false);
    });
    assert.ok(captureOff, 'altyazı bölgesi kalkınca yakalama kapanmalı');

    const settled = await waitUntil(async () => {
      const stored = await harness.sendToBackground({
        type: 'MNA_SESSION_GET',
        sessionId
      });
      const active = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
      return !!(
        stored &&
        stored.session &&
        stored.session.endedAt &&
        active &&
        active.active == null
      );
    });
    assert.ok(settled, 'aktif oturum kapanmalı');

    const status = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
    assert.equal(status.captions.regionFound, false);
    assert.equal(status.capture.active, false);
    assert.equal(harness.sandbox.window.__mnaBlockStateSize(), 0);

    const popup = await harness.sendToBackground({
      type: 'MNA_ACTIVE_SESSION',
      restore: true
    });
    assert.equal(popup.active, null, 'popup kaydı sürüyor görmemeli');
    const afterRestore = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
    assert.equal(afterRestore.capture.active, false, 'geri yükleme yakalamayı açmamalı');

    const stored = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId
    });
    assert.equal(stored.session.id, sessionId);
    assert.ok(stored.session.endedAt, 'endedAt dolmalı');
    assert.equal(harness.local.store.get('mna.activeSession'), undefined);

    const list = await harness.sendToBackground({ type: 'MNA_SESSION_LIST' });
    assert.equal(list.sessions.length, 1, 'aynı oturum kapanmalı, yenisi açılmamalı');
    assert.equal(list.sessions[0].id, sessionId);

    const stops = messages.filter((message) => message && message.type === 'MNA_SESSION_STOP');
    assert.equal(stops.length, 1, 'arka plana durdurma mesajı gitmeli');
  } finally {
    try {
      await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });
    } catch (err) {
      /* yoksay */
    }
    harness.cleanup();
  }
});

test('Ayar kapalıyken elle kayıt altyazı bölgesi kalkınca sürer', async () => {
  const blocks = [{ speaker: 'Elif', text: 'Elle başlayan kayıt altyazı kalksa da sürer.' }];
  const adapter = createStubAdapter({ blocks });
  const harness = createHarness({ adapter });
  await harness.local.set({
    'mna.settings': Object.assign({ autoStartOnCc: false }, CC_SETTINGS)
  });
  harness.loadServiceWorker();
  const messages = recordMessages(harness);
  harness.loadContentScript(TAB_ID);

  try {
    await wait(50);
    const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.ok(start && start.ok, 'elle kayıt başlamalı');
    const sessionId = start.sessionId;

    const sawBlock = await waitUntil(
      () => harness.sandbox.window.__mnaBlockStateSize() >= 1
    );
    assert.ok(sawBlock, 'altyazı bloğu taranmalı');

    adapter.setBlocks([]);
    assert.ok(triggerBodyObserver(harness), 'gövde gözlemcisi tetiklenmeli');

    const scanned = await waitUntil(
      () => harness.sandbox.window.__mnaBlockStateSize() === 0
    );
    assert.ok(scanned, 'bölge kalkınca tarama çalışmalı');
    // Yanlış bir durdurma olsaydı oturum bu sürede endedAt alırdı.
    await wait(500);

    const status = await harness.sendToTab(TAB_ID, { type: 'MNA_STATUS' });
    assert.equal(status.captions.regionFound, false, 'altyazı bölgesi kalkmış olmalı');
    assert.equal(status.capture.active, true, 'elle kayıt sürmeli');

    const active = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.ok(active.active, 'popup kaydı sürüyor görmeli');
    assert.equal(active.active.sessionId, sessionId);

    const stored = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId
    });
    assert.equal(stored.session.endedAt, null, 'elle oturum kapanmamalı');
    assert.equal(harness.local.store.get('mna.activeSession').sessionId, sessionId);

    const stops = messages.filter((message) => message && message.type === 'MNA_SESSION_STOP');
    assert.equal(stops.length, 0, 'durdurma mesajı gitmemeli');
  } finally {
    try {
      await harness.sendToTab(TAB_ID, { type: 'MNA_SET_CAPTURE', active: false });
    } catch (err) {
      /* yoksay */
    }
    harness.cleanup();
  }
});

/** Popup betiğini hafif sahte DOM ve Chrome API ile VM içinde çalıştırır. */
function loadPopupInVm(opts) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');

  const elements = new Map();
  const exportButtons = ['txt', 'md', 'json', 'srt', 'vtt'].map((fmt) => ({
    tagName: 'BUTTON',
    dataset: { format: fmt },
    disabled: false,
    title: '',
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
  }));

  function getEl(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id: id,
        hidden: false,
        disabled: false,
        textContent: '',
        className: '',
        title: '',
        href: '',
        value: '',
        dataset: {},
        style: {},
        listeners: {},
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        appendChild() {}
      });
    }
    return elements.get(id);
  }

  const runtimeMessages = [];
  const intervals = [];
  const timeouts = [];

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Date: Date,
    Promise: Promise,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Error: Error,
    setTimeout(fn, ms) {
      const t = setTimeout(fn, ms);
      if (t && typeof t.unref === 'function') {
        t.unref();
      }
      timeouts.push(t);
      return t;
    },
    clearTimeout: clearTimeout,
    setInterval(fn, ms) {
      const t = setInterval(fn, ms);
      if (t && typeof t.unref === 'function') {
        t.unref();
      }
      intervals.push(t);
      return t;
    },
    clearInterval: clearInterval,
    document: {
      readyState: 'complete',
      getElementById: getEl,
      querySelectorAll(selector) {
        return selector === '[data-format]' ? exportButtons : [];
      },
      createElement() {
        return {
          className: '',
          textContent: '',
          title: '',
          type: '',
          dataset: {},
          style: {},
          setAttribute() {},
          appendChild() {}
        };
      },
      addEventListener() {}
    },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage(message, callback) {
          runtimeMessages.push(message);
          Promise.resolve().then(() => {
            const reply = opts.onRuntimeMessage(message);
            if (typeof callback === 'function') {
              callback(reply);
            }
          });
        },
        getURL: (p) => 'chrome-extension://test/' + p,
        openOptionsPage() {}
      },
      tabs: {
        query(q, callback) {
          Promise.resolve().then(() => {
            if (typeof callback === 'function') {
              callback(opts.activeTab ? [opts.activeTab] : []);
            }
          });
        },
        sendMessage(tabId, message, callback) {
          Promise.resolve().then(() => {
            const reply = opts.onTabMessage ? opts.onTabMessage(tabId, message) : null;
            if (typeof callback === 'function') {
              callback(reply);
            }
          });
        }
      },
      storage: {
        local: {
          get() {
            return Promise.resolve({});
          }
        }
      }
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const root = path.resolve(__dirname, '..');
  const loadLib = (rel) => {
    const file = path.join(root, rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  };
  loadLib('extension/src/lib/protocol.js');
  loadLib('extension/src/lib/formatters.js');
  loadLib('extension/src/lib/utils.js');
  loadLib('extension/src/lib/schedule.js');
  loadLib('extension/src/popup/popup.js');

  return {
    elements: elements,
    exportButtons: exportButtons,
    runtimeMessages: runtimeMessages,
    cleanup() {
      intervals.forEach(clearInterval);
      timeouts.forEach(clearTimeout);
    }
  };
}

test('M6: farklı sekmeden gelen restore isteği pushCaptureState tetiklemez; aynı sekme ve tabIdsiz istek tetikler', async () => {
  const harness = createHarness();
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);
  const captureStates = watchCaptureStates(harness);

  try {
    const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.ok(start && start.ok, 'oturum sekme 1 içinde başlamalı');

    // Farklı sekmeden (tabId: 2) restore isteği: kayıt sekmesi (1) etkilenmemeli.
    const fromOtherTab = await harness.sendToBackground({
      type: 'MNA_ACTIVE_SESSION',
      restore: true,
      tabId: 2
    });
    assert.ok(fromOtherTab && fromOtherTab.ok && fromOtherTab.active);
    assert.equal(
      captureStates.length,
      0,
      'farklı sekmeden gelen restore isteği MNA_CAPTURE_STATE göndermemeli'
    );

    // tabId açıkça null geldiğinde (aktif sekme okunamadıysa) restore atılmamalı.
    const fromNullTab = await harness.sendToBackground({
      type: 'MNA_ACTIVE_SESSION',
      restore: true,
      tabId: null
    });
    assert.ok(fromNullTab && fromNullTab.ok && fromNullTab.active);
    assert.equal(
      captureStates.length,
      0,
      'tabId: null geldiğinde MNA_CAPTURE_STATE gönderilmemeli'
    );

    // Aynı sekmeden (tabId: 1) restore isteği: kayıt sekmesine gönderilmeli.
    const fromSameTab = await harness.sendToBackground({
      type: 'MNA_ACTIVE_SESSION',
      restore: true,
      tabId: TAB_ID
    });
    assert.ok(fromSameTab && fromSameTab.ok && fromSameTab.active);
    assert.equal(captureStates.length, 1, 'aynı sekmeden gelen restore isteği MNA_CAPTURE_STATE göndermeli');
    assert.equal(captureStates[0].tabId, TAB_ID);

    // tabId verilmeden (geriye dönük uyumluluk): yine gönderilmeli.
    const legacyRestore = await harness.sendToBackground({
      type: 'MNA_ACTIVE_SESSION',
      restore: true
    });
    assert.ok(legacyRestore && legacyRestore.ok && legacyRestore.active);
    assert.equal(captureStates.length, 2, 'tabId verilmezse eski davranış korunmalı');
  } finally {
    harness.cleanup();
  }
});

test('M6: popup restore isteğine aktif sekmenin tabId bilgisini ekler', async () => {
  const popup = loadPopupInVm({
    activeTab: { id: 2, url: 'https://meet.google.com/xyz-uvwx-rst', active: true },
    onTabMessage(tabId, message) {
      if (message && message.type === 'MNA_STATUS') {
        return {
          ok: true,
          capture: { active: false, startedAt: null, lineCount: 0 },
          captions: { regionFound: true, detected: true },
          meeting: { code: 'xyz-uvwx-rst', url: 'https://meet.google.com/xyz-uvwx-rst' }
        };
      }
      return { ok: true };
    },
    onRuntimeMessage(message) {
      if (message && message.type === 'MNA_ACTIVE_SESSION') {
        return {
          ok: true,
          active: {
            sessionId: 'sess_1',
            startedAt: Date.now() - 10000,
            meetingCode: 'abc-defg-hij',
            meetingUrl: 'https://meet.google.com/abc-defg-hij'
          }
        };
      }
      if (message && message.type === 'MNA_SCHEDULE_LIST') {
        return { ok: true, items: [] };
      }
      return { ok: true };
    }
  });

  try {
    await wait(60);
    const restoreReq = popup.runtimeMessages.find(
      (msg) => msg && msg.type === 'MNA_ACTIVE_SESSION' && msg.restore === true
    );
    assert.ok(restoreReq, 'popup restore isteği göndermeli');
    assert.equal(restoreReq.tabId, 2, 'popup restore isteğine aktif sekme tabId eklemeli');
  } finally {
    popup.cleanup();
  }
});

test('M7: Meet dışı sekmede kayıt sürerken Kaydı Durdur düğmesi etkin olur', async () => {
  let stopDeferred = null;
  const popup = loadPopupInVm({
    activeTab: { id: 5, url: 'https://example.com/', active: true },
    onRuntimeMessage(message) {
      if (message && message.type === 'MNA_ACTIVE_SESSION') {
        return {
          ok: true,
          active: {
            sessionId: 'sess_1',
            startedAt: Date.now() - 10000,
            meetingCode: 'abc-defg-hij',
            meetingUrl: 'https://meet.google.com/abc-defg-hij'
          }
        };
      }
      if (message && message.type === 'MNA_SCHEDULE_LIST') {
        return { ok: true, items: [] };
      }
      if (message && message.type === 'MNA_SESSION_STOP') {
        stopDeferred = true;
        return { ok: true };
      }
      return { ok: true };
    }
  });

  try {
    await wait(60);
    const stopBtn = popup.elements.get('stopBtn');
    const startBtn = popup.elements.get('startBtn');
    const copyBtn = popup.elements.get('copyBtn');
    const toggleCcBtn = popup.elements.get('toggleCcBtn');

    assert.equal(stopBtn.hidden, false, 'kayıt sürerken Kaydı Durdur görünür olmalı');
    assert.equal(stopBtn.disabled, false, 'Meet dışı sekmede Kaydı Durdur kilitli olmamalı');
    assert.equal(startBtn.disabled, true, 'Meet dışı sekmede Kaydı Başlat kilitli kalmalı');
    assert.equal(toggleCcBtn.disabled, true, 'Meet dışı sekmede CC düğmesi kilitli kalmalı');
    assert.equal(copyBtn.disabled, true, 'Meet dışı sekmede Kopyala kilitli kalmalı');
    assert.ok(
      popup.exportButtons.every((btn) => btn.disabled === true),
      'Meet dışı sekmede dışa aktarma düğmeleri kilitli kalmalı'
    );

    // Düğme tıklanınca durdurma mesajı gider ve işlem sırasında busy kilidi çalışır.
    stopBtn.listeners.click();
    assert.equal(stopBtn.disabled, true, 'durdurma işlemi sürerken stopBtn kilitlenmeli');
    await wait(40);
    assert.equal(stopDeferred, true, 'MNA_SESSION_STOP arka plana gönderilmeli');
  } finally {
    popup.cleanup();
  }
});

/** Test için chrome.alarms sarmalayıcısı kurar. */
function attachScheduleAlarms(harness) {
  const listeners = [];
  harness.alarmsCleared = [];
  harness.chrome.alarms = {
    create() {},
    clear(name, callback) {
      harness.alarmsCleared.push(name);
      if (typeof callback === 'function') {
        callback(true);
      }
    },
    onAlarm: {
      addListener(fn) {
        listeners.push(fn);
      }
    }
  };
  harness.fireAlarm = (alarm) => Promise.all(
    listeners.map((fn) => Promise.resolve().then(() => fn(alarm)))
  );
}

/** Sekmeyi kapatır ve tüm onRemoved dinleyicilerinin döndürdüğü Promise'leri bekler. */
async function removeTabAndAwait(harness, tabId) {
  await Promise.all(
    harness.removedListeners.slice().map((fn) =>
      Promise.resolve().then(() => fn(tabId, { windowId: 1, isWindowClosing: false }))
    )
  );
}

test('M8: planlı kayıt recording iken sekme kapanınca durum ended olur ve alarmlar temizlenir', async () => {
  const harness = createHarness();
  attachScheduleAlarms(harness);
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  try {
    const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.ok(start && start.ok);

    await harness.local.set({
      'mna.scheduledJoins': [{
        id: 'join_rec',
        url: 'https://meet.google.com/abc-defg-hij',
        meetingCode: 'abc-defg-hij',
        startAt: Date.now() - 60000,
        endAt: Date.now() + 600000,
        status: 'recording',
        statusText: 'Toplantıya katıldı, kayıt başladı.',
        tabId: TAB_ID,
        createdAt: Date.now() - 60000
      }]
    });

    await removeTabAndAwait(harness, TAB_ID);

    const listed = await harness.sendToBackground({ type: 'MNA_SCHEDULE_LIST' });
    assert.equal(listed.items[0].status, 'ended', 'kayıt sürerken sekme kapanınca ended olmalı');
    assert.equal(
      listed.items[0].statusText,
      'Toplantı sekmesi kapatıldı, kayıt durduruldu.'
    );
    assert.ok(harness.alarmsCleared.includes('mna.join.join_rec'));
    assert.ok(harness.alarmsCleared.includes('mna.end.join_rec'));

    // Aktif oturum da kapatılmış olmalı.
    const stored = await harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: start.sessionId
    });
    assert.ok(stored.session.endedAt, 'sekme kapanınca aktif oturum da kapanmalı');
  } finally {
    harness.cleanup();
  }
});

test('M8: planlı katılım waiting iken sekme kapanınca durum failed olur ve başka sekme etkilenmez', async () => {
  const harness = createHarness();
  attachScheduleAlarms(harness);
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  try {
    // Sekme 1'de ayrı bir canlı kayıt var; sekme 2 ise planlı katılım bekliyor.
    const start = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.ok(start && start.ok);

    await harness.local.set({
      'mna.scheduledJoins': [{
        id: 'join_wait',
        url: 'https://meet.google.com/xyz-uvwx-rst',
        meetingCode: 'xyz-uvwx-rst',
        startAt: Date.now() - 60000,
        endAt: Date.now() + 600000,
        status: 'waiting',
        statusText: 'Katılma isteği gönderildi, kabul bekleniyor.',
        tabId: 2,
        createdAt: Date.now() - 60000
      }]
    });

    // İlgisiz başka bir sekmenin (99) kapanması waiting kaydını etkilememeli.
    await removeTabAndAwait(harness, 99);
    let listed = await harness.sendToBackground({ type: 'MNA_SCHEDULE_LIST' });
    assert.equal(listed.items[0].status, 'waiting', 'başka sekme kapanınca durum değişmemeli');

    // Planlı sekme (2) kapatılır: aktif oturum yoksa/farklıysa bile erken dönüş olmadan güncellenmeli.
    await removeTabAndAwait(harness, 2);
    listed = await harness.sendToBackground({ type: 'MNA_SCHEDULE_LIST' });
    assert.equal(listed.items[0].status, 'failed', 'henüz içeri girilmemişken sekme kapanınca failed olmalı');
    assert.equal(
      listed.items[0].statusText,
      'Toplantı sekmesi kapatıldı, katılınmadı.'
    );
    assert.ok(harness.alarmsCleared.includes('mna.join.join_wait'));
    assert.ok(harness.alarmsCleared.includes('mna.end.join_wait'));

    // Sekme 1'deki kayıt etkilenmemeli.
    const active = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.equal(active.active.sessionId, start.sessionId);
  } finally {
    harness.cleanup();
  }
});

test('M8: endAlarm sonradan ateşlenirse ended, failed veya endedByTime durumunu ezmez', async () => {
  const harness = createHarness();
  attachScheduleAlarms(harness);
  harness.loadServiceWorker();
  harness.attachEchoContentScript(TAB_ID);

  const sentToTabs = [];
  const origSendMessage = harness.chrome.tabs.sendMessage;
  harness.chrome.tabs.sendMessage = function (tabId, message, callback) {
    sentToTabs.push({ tabId: tabId, type: message && message.type });
    return origSendMessage.call(this, tabId, message, callback);
  };

  try {
    await harness.local.set({
      'mna.scheduledJoins': [
        {
          id: 'join_ended',
          url: 'https://meet.google.com/abc-defg-hij',
          meetingCode: 'abc-defg-hij',
          startAt: Date.now() - 60000,
          endAt: Date.now() + 60000,
          status: 'ended',
          statusText: 'Toplantı sekmesi kapatıldı, kayıt durduruldu.',
          tabId: TAB_ID,
          createdAt: Date.now() - 60000
        },
        {
          id: 'join_failed',
          url: 'https://meet.google.com/xyz-uvwx-rst',
          meetingCode: 'xyz-uvwx-rst',
          startAt: Date.now() - 60000,
          endAt: Date.now() + 60000,
          status: 'failed',
          statusText: 'Toplantı sekmesi kapatıldı, katılınmadı.',
          tabId: 2,
          createdAt: Date.now() - 60000
        },
        {
          id: 'join_by_time',
          url: 'https://meet.google.com/mno-pqrs-tuv',
          meetingCode: 'mno-pqrs-tuv',
          startAt: Date.now() - 60000,
          endAt: Date.now() + 60000,
          status: 'endedByTime',
          statusText: 'Bitiş saatinde kayıt durduruldu.',
          tabId: 3,
          createdAt: Date.now() - 60000
        }
      ]
    });

    await harness.fireAlarm({ name: 'mna.end.join_ended' });
    await harness.fireAlarm({ name: 'mna.end.join_failed' });
    await harness.fireAlarm({ name: 'mna.end.join_by_time' });

    const listed = await harness.sendToBackground({ type: 'MNA_SCHEDULE_LIST' });
    const endedItem = listed.items.find((item) => item.id === 'join_ended');
    const failedItem = listed.items.find((item) => item.id === 'join_failed');
    const timeItem = listed.items.find((item) => item.id === 'join_by_time');

    assert.equal(endedItem.status, 'ended', 'endAlarm ended durumunu ezmemeli');
    assert.equal(
      endedItem.statusText,
      'Toplantı sekmesi kapatıldı, kayıt durduruldu.'
    );
    assert.equal(failedItem.status, 'failed', 'endAlarm failed durumunu ezmemeli');
    assert.equal(
      failedItem.statusText,
      'Toplantı sekmesi kapatıldı, katılınmadı.'
    );
    assert.equal(timeItem.status, 'endedByTime', 'endAlarm endedByTime durumunu korumalı');
    assert.equal(timeItem.statusText, 'Bitiş saatinde kayıt durduruldu.');
    assert.equal(
      sentToTabs.some((entry) => entry.type === 'MNA_SCHEDULED_LEAVE'),
      false,
      'bitmiş katılımlara ayrılma mesajı gönderilmemeli'
    );
  } finally {
    harness.cleanup();
  }
});
