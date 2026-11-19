/**
 * Planlı katılım: bağlantı/saat, alarm, sahte Meet sayfası ve mevcut kayıt yolu.
 * Çalıştırma: node --test test/scheduled-join.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createHarness } = require('./helpers/harness.js');
const { el, doc } = require('./helpers/fake-dom.js');
const Schedule = require('../extension/src/lib/schedule.js');

const ROOT = path.resolve(__dirname, '..');
const JOIN_SRC = path.join(ROOT, 'extension', 'src', 'content', 'meet-join.js');
const WINDOW_MS = Schedule.JOIN_WINDOW_MS;
const T0 = Date.parse('2026-11-08T09:00:00Z');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) {
      return true;
    }
    await wait(15);
  }
  return false;
}

function attachAlarms(harness) {
  const listeners = [];
  harness.alarmsCreated = [];
  harness.alarmsCleared = [];
  harness.chrome.alarms = {
    create(name, info) {
      harness.alarmsCreated.push({ name: name, when: info && info.when });
    },
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

function watchTabs(harness) {
  const opened = [];
  const original = harness.chrome.tabs.create;
  harness.chrome.tabs.create = function (props, callback) {
    opened.push(props || {});
    return original.call(harness.chrome.tabs, props, function (tab) {
      harness.attachEchoContentScript(tab.id);
      if (typeof callback === 'function') {
        callback(tab);
      }
    });
  };
  return opened;
}

function boot(clock) {
  let now = clock === undefined ? T0 : clock;
  const harness = createHarness();
  attachAlarms(harness);
  const opened = watchTabs(harness);
  harness.loadServiceWorker();
  harness.sandbox.MNA_NOW = function () { return now; };
  return {
    harness: harness,
    opened: opened,
    setClock(value) { now = value; },
    clock() { return now; },
    fire(alarm) { return harness.fireAlarm(alarm); }
  };
}

async function saveJoin(env, url, startAt, endAt) {
  return env.harness.sendToBackground({
    type: 'MNA_SCHEDULE_SAVE',
    url: url,
    startAt: startAt,
    endAt: endAt === undefined ? null : endAt
  });
}

async function listJoins(env) {
  const result = await env.harness.sendToBackground({ type: 'MNA_SCHEDULE_LIST' });
  assert.equal(result.ok, true);
  return result.items;
}

function setLabel(button, label) {
  button.setAttribute('aria-label', label);
  if (button.childNodes[0]) {
    button.childNodes[0].data = label;
  }
}

function button(label) {
  const node = el({
    tag: 'button',
    attrs: { type: 'button', 'aria-label': label },
    text: label
  });
  // Gerçek düğmenin click() metodu vardır. Testler kendi tıklamasını bunun üstüne yazar.
  node.click = function () {};
  return node;
}

function replaceBody(document, children) {
  while (document.body.childNodes.length) {
    document.body.removeChild(document.body.childNodes[0]);
  }
  children.forEach((child) => document.body.appendChild(child));
}

/**
 * Katılma modülünü, getUserMedia sayacı olan bir ortamda yükler.
 * Modül serbest `navigator` ararsa bu sayaç artar.
 */
function loadJoin(mediaCalls) {
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Date: Date,
    Promise: Promise,
    WeakSet: WeakSet,
    Array: Array,
    String: String,
    Number: Number,
    RegExp: RegExp,
    Object: Object,
    Error: Error,
    navigator: {
      mediaDevices: {
        getUserMedia() {
          mediaCalls.count += 1;
          return Promise.reject(new Error('izin istenmemeli'));
        }
      }
    }
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(JOIN_SRC, 'utf8'), context, { filename: JOIN_SRC });
  return context.module.exports;
}

function kinds(controller) {
  // Tıklama listesi vm içinde doğar; yerli diziye kopyalanmadan katı eşitlik prototipte kalır.
  return Array.prototype.map.call(controller.getClicks(), (item) => item.kind);
}

test('Bağlantı ve saat kuralları', () => {
  const parsed = Schedule.parseMeetLink('https://meet.google.com/ABC-DEFG-HIJ?authuser=1');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.meetingCode, 'abc-defg-hij');
  assert.equal(parsed.url, 'https://meet.google.com/abc-defg-hij?authuser=1');

  assert.equal(Schedule.parseMeetLink('meet.google.com/abc-defg-hij').ok, true);
  assert.equal(Schedule.parseMeetLink('https://example.com/abc-defg-hij').ok, false);
  assert.equal(Schedule.parseMeetLink('https://meet.google.com/lookup/abc').ok, false);
  assert.equal(Schedule.parseMeetLink('javascript:alert(1)').ok, false);

  const now = T0;
  const future = Schedule.validateSchedule({
    url: 'https://meet.google.com/abc-defg-hij',
    startAt: now + 120000,
    endAt: null,
    now: now
  });
  assert.equal(future.ok, true);

  const past = Schedule.validateSchedule({
    url: 'https://meet.google.com/abc-defg-hij',
    startAt: now - 120000,
    now: now
  });
  assert.equal(past.ok, false);
  assert.match(past.error, /geçmişte/);

  const recentMinute = Schedule.validateSchedule({
    url: 'https://meet.google.com/abc-defg-hij',
    startAt: now - 30000,
    now: now
  });
  assert.equal(recentMinute.ok, true);

  const badEnd = Schedule.validateSchedule({
    url: 'https://meet.google.com/abc-defg-hij',
    startAt: now + 60000,
    endAt: now + 60000,
    now: now
  });
  assert.equal(badEnd.ok, false);
  assert.match(badEnd.error, /Bitiş saati/);

  const local = new Date(2026, 10, 8, 21, 30, 0, 0);
  assert.equal(Schedule.parseDateTimeLocal('2026-11-08T21:30'), local.getTime());

  assert.equal(Schedule.decideJoinAlarm(
    { status: 'scheduled', startAt: now },
    now + WINDOW_MS,
    false
  ), 'join');
  assert.equal(Schedule.decideJoinAlarm(
    { status: 'scheduled', startAt: now },
    now + WINDOW_MS + 1,
    false
  ), 'expired');
  assert.equal(Schedule.decideJoinAlarm(
    { status: 'scheduled', startAt: now },
    now + 60000,
    true
  ), 'skipped');
  assert.equal(Schedule.decideJoinAlarm(
    { status: 'joining', startAt: now },
    now,
    false
  ), 'ignore');
});

test('Sekme kapanma durum metinleri tanımlıdır', () => {
  assert.equal(
    Schedule.statusText('tabClosedRecording'),
    'Toplantı sekmesi kapatıldı, kayıt durduruldu.'
  );
  assert.equal(
    Schedule.statusText('tabClosedNotJoined'),
    'Toplantı sekmesi kapatıldı, katılınmadı.'
  );
});

test('Durum önceliği: izin uyarısı sonrası joining/waiting kabul edilir, admitted ve recording sonrası blocked yok sayılır', async () => {
  // blocked, joining ile aynı sırada: kullanıcı izni verince katılım ilerleyebilir.
  assert.ok(Schedule.statusRank('blocked') <= Schedule.statusRank('joining'));
  assert.ok(Schedule.statusRank('blocked') < Schedule.statusRank('admitted'));
  assert.ok(Schedule.statusRank('recording') < Schedule.statusRank('ended'));

  const env = boot(T0);
  try {
    const first = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
    assert.equal(first.ok, true);
    const second = await saveJoin(env, 'https://meet.google.com/xyz-wxyz-xyz', T0 + 120000);
    assert.equal(second.ok, true);

    const list = env.harness.local.store.get(Schedule.STORAGE_KEY);
    const itemA = list.find((entry) => entry.id === first.item.id);
    const itemB = list.find((entry) => entry.id === second.item.id);
    itemA.status = 'blocked';
    itemA.statusText = Schedule.statusText('permission');
    itemB.status = 'recording';
    itemB.statusText = Schedule.statusText('recording');

    const afterPermission = await env.harness.sendToBackground({
      type: 'MNA_SCHEDULE_STATUS',
      joinId: itemA.id,
      phase: 'waiting'
    });
    assert.equal(afterPermission.ok, true);
    assert.notEqual(afterPermission.ignored, true);
    assert.equal(afterPermission.item.status, 'waiting');

    const fresh = env.harness.local.store.get(Schedule.STORAGE_KEY)
      .find((entry) => entry.id === first.item.id);
    fresh.status = 'admitted';
    fresh.statusText = Schedule.statusText('admitted');
    const admittedBlocked = await env.harness.sendToBackground({
      type: 'MNA_SCHEDULE_STATUS',
      joinId: itemA.id,
      phase: 'blocked'
    });
    assert.equal(admittedBlocked.ok, true);
    assert.equal(admittedBlocked.ignored, true);
    assert.equal(admittedBlocked.item.status, 'admitted');

    const recordingBlocked = await env.harness.sendToBackground({
      type: 'MNA_SCHEDULE_STATUS',
      joinId: itemB.id,
      phase: 'blocked'
    });
    assert.equal(recordingBlocked.ok, true);
    assert.equal(recordingBlocked.ignored, true);
    assert.equal(recordingBlocked.item.status, 'recording');
    assert.equal(recordingBlocked.item.statusText, Schedule.statusText('recording'));
  } finally {
    env.harness.cleanup();
  }
});

test('Kullanıcı bağlantı ve saati kaydeder, iptal alarmı siler', async () => {
  const env = boot(T0);
  try {
    const bad = await saveJoin(env, 'https://example.com/toplanti', T0 + 60000);
    assert.equal(bad.ok, false);
    assert.equal(env.harness.alarmsCreated.length, 0);

    const past = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 - 120000);
    assert.equal(past.ok, false);
    assert.match(past.error, /geçmişte/);

    const endAt = T0 + 30 * 60000;
    const saved = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000, endAt);
    assert.equal(saved.ok, true);
    assert.equal(saved.item.meetingCode, 'abc-defg-hij');
    assert.equal(saved.item.statusText, 'Planlandı');

    const names = env.harness.alarmsCreated.map((alarm) => alarm.name);
    assert.deepEqual(names.sort(), [
      Schedule.endAlarmName(saved.item.id),
      Schedule.joinAlarmName(saved.item.id)
    ].sort());
    const joinAlarm = env.harness.alarmsCreated.find((alarm) => alarm.name.indexOf('mna.join.') === 0);
    const endAlarm = env.harness.alarmsCreated.find((alarm) => alarm.name.indexOf('mna.end.') === 0);
    assert.equal(joinAlarm.when, T0 + 60000);
    assert.equal(endAlarm.when, endAt);

    const listed = await listJoins(env);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].url, 'https://meet.google.com/abc-defg-hij');

    const cancelled = await env.harness.sendToBackground({
      type: 'MNA_SCHEDULE_CANCEL',
      id: saved.item.id
    });
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.removed, true);
    assert.equal((await listJoins(env)).length, 0);
    assert.ok(env.harness.alarmsCleared.includes(Schedule.joinAlarmName(saved.item.id)));
    assert.ok(env.harness.alarmsCleared.includes(Schedule.endAlarmName(saved.item.id)));
  } finally {
    env.harness.cleanup();
  }
});

test('Alarm doğru sekmeyi açar; geç kalırsa pencereye göre katılır veya vazgeçer', async () => {
  const env = boot(T0);
  try {
    const early = await saveJoin(env, 'https://meet.google.com/xyz-wxyz-xyz', T0 + 60000);
    const late = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 120000);
    assert.equal(early.ok, true);
    assert.equal(late.ok, true);

    env.setClock(early.item.startAt + 10 * 60000);
    await env.fire({ name: Schedule.joinAlarmName(early.item.id) });
    assert.equal(env.opened.length, 1);
    assert.equal(env.opened[0].url, 'https://meet.google.com/xyz-wxyz-xyz');
    assert.equal(env.opened[0].active, true);
    let items = await listJoins(env);
    const openedItem = items.find((item) => item.id === early.item.id);
    assert.equal(openedItem.status, 'joining');
    assert.equal(typeof openedItem.tabId, 'number');

    env.setClock(late.item.startAt + WINDOW_MS + 1);
    await env.fire({ name: Schedule.joinAlarmName(late.item.id) });
    assert.equal(env.opened.length, 1, 'pencere kapandıysa sekme açılmamalı');
    items = await listJoins(env);
    const expired = items.find((item) => item.id === late.item.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.statusText, 'Başlangıçtan 30 dakika geçti, katılınmadı.');
  } finally {
    env.harness.cleanup();
  }
});

test('Tam 30. dakikada katılır, bir milisaniye sonra katılmaz', async () => {
  const env = boot(T0);
  try {
    const edge = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
    const closed = await saveJoin(env, 'https://meet.google.com/xyz-wxyz-xyz', T0 + 120000);
    env.setClock(edge.item.startAt + WINDOW_MS);
    await env.fire({ name: Schedule.joinAlarmName(edge.item.id) });
    assert.equal(env.opened.length, 1);

    env.setClock(closed.item.startAt + WINDOW_MS + 1);
    await env.fire({ name: Schedule.joinAlarmName(closed.item.id) });
    assert.equal(env.opened.length, 1);
    const items = await listJoins(env);
    assert.equal(items.find((item) => item.id === closed.item.id).statusText, 'Başlangıçtan 30 dakika geçti, katılınmadı.');
  } finally {
    env.harness.cleanup();
  }
});

test('Başka kayıt sürüyorsa yeni sekme açılmaz ve atlandı yazılır', async () => {
  const env = boot(T0);
  env.harness.attachEchoContentScript(1);
  try {
    const started = await env.harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.equal(started.ok, true);
    const saved = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
    env.setClock(saved.item.startAt);
    await env.fire({ name: Schedule.joinAlarmName(saved.item.id) });
    assert.equal(env.opened.length, 0);
    const items = await listJoins(env);
    assert.equal(items[0].status, 'skipped');
    assert.equal(items[0].statusText, 'Mevcut kayıt yüzünden bu toplantı atlandı.');
    const active = await env.harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.equal(active.active.sessionId, started.sessionId);
  } finally {
    env.harness.cleanup();
  }
});

test('Tarayıcı yeniden açılmış ölü kayıt yeni katılımı engellemez', async () => {
  const env = boot(T0);
  env.harness.attachEchoContentScript(1);
  try {
    const started = await env.harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.equal(started.ok, true);
    await env.harness.chrome.storage.session.clear();
    const saved = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
    env.setClock(saved.item.startAt);
    await env.fire({ name: Schedule.joinAlarmName(saved.item.id) });
    assert.equal(env.opened.length, 1);
    const items = await listJoins(env);
    assert.notEqual(items[0].status, 'skipped');
  } finally {
    env.harness.cleanup();
  }
});

test('Sahte sayfa: kapalı mikrofon ve kamerayla Katıl, altyazı mevcut kaydı başlatır, bitiş durdurur', async () => {
  const env = boot(T0);
  const mediaCalls = { count: 0 };
  const api = loadJoin(mediaCalls);
  try {
    const saved = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
    env.setClock(saved.item.startAt);
    await env.fire({ name: Schedule.joinAlarmName(saved.item.id) });
    const item = (await listJoins(env))[0];
    assert.equal(item.status, 'joining');

    const nameInput = el({
      tag: 'input',
      attrs: { type: 'text', 'aria-label': 'Adınız', value: 'Kerem Yılmaz' }
    });
    const allow = button('İzin ver');
    let allowClicks = 0;
    allow.click = function () { allowClicks += 1; };
    const mic = button('Mikrofonu kapat');
    const cam = button('Kamerayı kapat');
    const join = button('Katıl');
    mic.click = function () { setLabel(mic, 'Mikrofonu aç'); };
    cam.click = function () { setLabel(cam, 'Kamerayı aç'); };

    const captions = button('Altyazıları aç');
    const leaveInCall = button('Aramadan ayrıl');
    const region = el({
      tag: 'div',
      attrs: { role: 'region', 'aria-label': 'Altyazılar' }
    });
    captions.click = function () {
      setLabel(captions, 'Altyazıları kapat');
      document.body.appendChild(region);
    };
    const document = doc({
      children: [nameInput, mic, cam, allow, join]
    });
    join.click = function () {
      replaceBody(document, [leaveInCall, captions]);
    };

    let clock = saved.item.startAt;
    const controller = api.createMeetJoin({
      document: document,
      now: function () { return clock; },
      deadlineAt: saved.item.startAt + WINDOW_MS,
      onCaptionsReady: function () {
        return env.harness.sendToBackground({
          type: 'MNA_SCHEDULED_CAPTURE_START',
          joinId: item.id,
          tabId: item.tabId
        }, { tab: { id: item.tabId } });
      },
      onMeetingEnded: function (info) {
        return env.harness.sendToBackground({
          type: 'MNA_SCHEDULED_MEETING_ENDED',
          joinId: item.id,
          reason: info.reason
        });
      },
      onStatus: function (info) {
        return env.harness.sendToBackground({
          type: 'MNA_SCHEDULE_STATUS',
          joinId: item.id,
          phase: info.phase,
          reason: info.reason
        });
      }
    });

    const phase = await controller.tick();
    assert.equal(phase, 'recording');
    assert.deepEqual(kinds(controller), ['mic', 'cam', 'join', 'captions']);
    assert.equal(allowClicks, 0);
    assert.equal(mediaCalls.count, 0);
    assert.equal(nameInput.getAttribute('value'), 'Kerem Yılmaz');
    assert.equal(mic.getAttribute('aria-label'), 'Mikrofonu aç');
    assert.equal(cam.getAttribute('aria-label'), 'Kamerayı aç');

    const active = await env.harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.ok(active.active && active.active.sessionId);
    const sessionId = active.active.sessionId;
    const stored = await env.harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: sessionId
    });
    assert.equal(stored.session.source, 'extension');
    assert.equal(stored.session.meetingCode, 'abc-defg-hij');
    assert.equal(stored.session.endedAt, null);
    const listed = await listJoins(env);
    assert.equal(listed[0].statusText, 'Toplantıya katıldı, kayıt başladı.');

    const leave = button('Aramadan ayrıl');
    let left = 0;
    leave.click = function () { left += 1; };
    replaceBody(document, [
      el({ tag: 'h1', text: 'Toplantı bitti' }),
      leave
    ]);
    clock += 60000;
    const ended = await controller.tick();
    assert.equal(ended, 'ended');
    assert.equal(left, 1);
    assert.equal(kinds(controller).filter((kind) => kind === 'leave').length, 1);
    const after = await env.harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: sessionId
    });
    assert.ok(after.session.endedAt);
    const quiet = await env.harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.equal(quiet.active, null);
    const status = (await listJoins(env))[0];
    assert.equal(status.statusText, 'Toplantı bitti, kayıt durduruldu.');
  } finally {
    env.harness.cleanup();
  }
});

test('Sahte sayfa: Katılma isteği yenilenir, 30 dakika sonra vazgeçilir', async () => {
  const env = boot(T0);
  const mediaCalls = { count: 0 };
  const api = loadJoin(mediaCalls);
  try {
    const saved = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
    const item = saved.item;
    const document = doc({ children: [] });
    const mic = button('Mikrofonu kapat');
    const cam = button('Kamerayı kapat');
    const nameInput = el({
      tag: 'input',
      attrs: { 'aria-label': 'Adınız', value: 'Kerem Yılmaz' }
    });
    const allow = button('İzin ver');
    let allowClicks = 0;
    allow.click = function () { allowClicks += 1; };
    mic.click = function () { setLabel(mic, 'Mikrofonu aç'); };
    cam.click = function () { setLabel(cam, 'Kamerayı aç'); };
    let note = null;
    function showAsk() {
      const ask = button('Katılma isteği gönder');
      ask.click = function () {
        ask.remove();
        note = el({
          tag: 'div',
          text: 'Katılma isteği gönderildi. Birisi sizi içeri aldığında katılacaksınız.'
        });
        document.body.appendChild(note);
      };
      document.body.appendChild(ask);
      return ask;
    }
    replaceBody(document, [nameInput, mic, cam, allow]);
    showAsk();

    let clock = item.startAt;
    const controller = api.createMeetJoin({
      document: document,
      now: function () { return clock; },
      deadlineAt: item.startAt + WINDOW_MS,
      onStatus: function (info) {
        return env.harness.sendToBackground({
          type: 'MNA_SCHEDULE_STATUS',
          joinId: item.id,
          phase: info.phase,
          reason: info.reason
        });
      }
    });

    assert.equal(await controller.tick(), 'waiting');
    assert.deepEqual(kinds(controller), ['mic', 'cam', 'ask']);
    assert.equal(await controller.tick(), 'waiting');
    assert.equal(kinds(controller).length, 3, 'istek dururken yeniden basılmamalı');

    note.remove();
    showAsk();
    assert.equal(await controller.tick(), 'waiting');
    assert.deepEqual(kinds(controller), ['mic', 'cam', 'ask', 'ask']);

    clock = item.startAt + WINDOW_MS + 1;
    note.remove();
    showAsk();
    assert.equal(await controller.tick(), 'expired');
    assert.equal(kinds(controller).filter((kind) => kind === 'ask').length, 2);
    assert.equal(allowClicks, 0);
    assert.equal(mediaCalls.count, 0);
    assert.equal(nameInput.getAttribute('value'), 'Kerem Yılmaz');
    const listed = await listJoins(env);
    assert.equal(listed[0].statusText, 'Başlangıçtan 30 dakika geçti, katılınmadı.');
  } finally {
    env.harness.cleanup();
  }
});

test('İngilizce Katıl ve Ask to join kapalı aygıtla basılır; açıkken izin istenmez', async () => {
  const mediaCalls = { count: 0 };
  const api = loadJoin(mediaCalls);
  const mic = button('Turn off microphone');
  const cam = button('Turn off camera');
  const join = button('Join now');
  mic.click = function () { setLabel(mic, 'Turn on microphone'); };
  cam.click = function () { setLabel(cam, 'Turn on camera'); };
  const document = doc({ children: [mic, cam, join] });
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    deadlineAt: T0 + WINDOW_MS
  });
  await controller.tick();
  assert.deepEqual(kinds(controller), ['mic', 'cam', 'join']);
  assert.equal(mediaCalls.count, 0);
  await controller.tick();
  assert.deepEqual(kinds(controller), ['mic', 'cam', 'join'], 'Katıl ikinci kez basılmamalı');

  const askMic = button('Turn on microphone');
  const askCam = button('Turn on camera');
  const ask = button('Ask to join');
  const askDoc = doc({ children: [askMic, askCam, ask] });
  const askController = api.createMeetJoin({
    document: askDoc,
    now: function () { return T0; },
    deadlineAt: T0 + WINDOW_MS
  });
  await askController.tick();
  assert.deepEqual(kinds(askController), ['ask']);
  assert.equal(mediaCalls.count, 0);
});

test('Açık aygıt kapanmazsa yeniden denenir, kapalı aygıta basılmaz', async () => {
  const mediaCalls = { count: 0 };
  const api = loadJoin(mediaCalls);
  const mic = button('Mikrofonu kapat');
  const cam = button('Kamerayı kapat');
  const join = button('Katıl');
  const allow = button('İzin ver');
  let allowClicks = 0;
  allow.click = function () { allowClicks += 1; };
  mic.click = function () {};
  cam.click = function () { setLabel(cam, 'Kamerayı aç'); };
  const document = doc({ children: [mic, cam, allow, join] });
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    deadlineAt: T0 + WINDOW_MS
  });
  await controller.tick();
  await controller.tick();
  assert.deepEqual(kinds(controller), ['mic', 'cam', 'mic']);
  assert.equal(allowClicks, 0);
  assert.equal(kinds(controller).indexOf('join'), -1);
  assert.equal(mediaCalls.count, 0);
  setLabel(mic, 'Mikrofonu aç');
  await controller.tick();
  assert.deepEqual(kinds(controller), ['mic', 'cam', 'mic', 'join']);
  assert.equal(cam.getAttribute('aria-label'), 'Kamerayı aç');
  assert.equal(mic.getAttribute('aria-label'), 'Mikrofonu aç');
});

/**
 * Ekran görüntüsündeki «sizi duysunlar mı?» diyaloğu.
 * X diyaloğu kaldırır. «Kullan» düğmeleri sayacı ayrıca tutulur.
 */
function hearYouPage(spec) {
  const useCounts = { mic: 0, both: 0 };
  const allowClicks = { n: 0 };
  const useMic = button(spec.useMic);
  const useBoth = button(spec.useBoth);
  useMic.click = function () { useCounts.mic += 1; };
  useBoth.click = function () { useCounts.both += 1; };
  const heading = el({ tag: 'h2', text: spec.title });
  const note = el({
    tag: 'p',
    text: spec.note || 'Toplantıda mikrofonunuzu istediğiniz zaman kapatabilirsiniz.'
  });
  const dialog = el({
    tag: 'div',
    attrs: { role: 'dialog' },
    children: [heading, note, useMic, useBoth]
  });
  if (spec.closeLabel) {
    const closeBtn = button(spec.closeLabel);
    closeBtn.click = function () { dialog.remove(); };
    dialog.appendChild(closeBtn);
  }
  const nameInput = el({
    tag: 'input',
    attrs: { type: 'text', 'aria-label': 'Adınız', value: spec.name || 'Kerem Ölçay' }
  });
  const allow = button(spec.allowLabel || 'İzin ver');
  allow.click = function () { allowClicks.n += 1; };
  const mic = button(spec.micLabel);
  const cam = button(spec.camLabel);
  mic.click = function () { setLabel(mic, spec.micOff); };
  cam.click = function () { setLabel(cam, spec.camOff); };
  const join = button(spec.joinLabel);
  const permissionNote = el({ tag: 'div', text: 'İzin gerekiyor' });
  const document = doc({
    children: [nameInput, mic, cam, allow, join, permissionNote, dialog]
  });
  return {
    document: document,
    dialog: dialog,
    nameInput: nameInput,
    mic: mic,
    cam: cam,
    useCounts: useCounts,
    allowClicks: allowClicks
  };
}

test('Duyulma diyaloğu yalnız X ile kapanır, sonra kapalı aygıtla katılınır', async () => {
  const mediaCalls = { count: 0 };
  const api = loadJoin(mediaCalls);
  const cases = [
    {
      title: 'Kullanıcıların toplantıda sizi duymasını istiyor musunuz?',
      useMic: 'Mikrofonu kullan',
      useBoth: 'Mikrofon ve kamerayı kullan',
      closeLabel: 'Kapat',
      micLabel: 'Mikrofonu kapat',
      camLabel: 'Kamerayı kapat',
      micOff: 'Mikrofonu aç',
      camOff: 'Kamerayı aç',
      joinLabel: 'Katılma isteği gönder',
      expected: 'ask'
    },
    {
      title: 'Kullanıcıların toplantıda sizi duymasını istiyor musunuz?',
      useMic: 'Mikrofonu kullan',
      useBoth: 'Mikrofon ve kamerayı kullan',
      closeLabel: 'Diyaloğu kapat',
      micLabel: 'Mikrofonu kapat',
      camLabel: 'Kamerayı kapat',
      micOff: 'Mikrofonu aç',
      camOff: 'Kamerayı aç',
      joinLabel: 'Katıl',
      expected: 'join'
    },
    {
      title: 'Do you want people to hear you in the meeting?',
      note: 'You can turn off your microphone anytime during the meeting.',
      useMic: 'Use microphone',
      useBoth: 'Use microphone and camera',
      closeLabel: 'Close',
      micLabel: 'Turn off microphone',
      camLabel: 'Turn off camera',
      micOff: 'Turn on microphone',
      camOff: 'Turn on camera',
      joinLabel: 'Join now',
      expected: 'join',
      allowLabel: 'Allow'
    },
    {
      title: 'Do you want others to hear you in the meeting?',
      note: 'You can turn off your microphone anytime during the meeting.',
      useMic: 'Use mic',
      useBoth: 'Use mic and camera',
      closeLabel: 'Close dialog',
      micLabel: 'Turn off microphone',
      camLabel: 'Turn off camera',
      micOff: 'Turn on microphone',
      camOff: 'Turn on camera',
      joinLabel: 'Ask to join',
      expected: 'ask',
      allowLabel: 'Allow'
    }
  ];
  for (const spec of cases) {
    const page = hearYouPage(spec);
    const controller = api.createMeetJoin({
      document: page.document,
      now: function () { return T0; },
      deadlineAt: T0 + WINDOW_MS
    });
    await controller.tick();
    assert.deepEqual(kinds(controller), ['dismiss', 'mic', 'cam', spec.expected], spec.joinLabel);
    assert.equal(page.useCounts.mic, 0, spec.useMic);
    assert.equal(page.useCounts.both, 0, spec.useBoth);
    assert.equal(page.allowClicks.n, 0);
    assert.equal(page.nameInput.getAttribute('value'), 'Kerem Ölçay');
    assert.equal(page.mic.getAttribute('aria-label'), spec.micOff);
    assert.equal(page.cam.getAttribute('aria-label'), spec.camOff);
    assert.equal(page.document.body.contains(page.dialog), false, 'diyalog kapanmalı');

    page.document.body.appendChild(page.dialog);
    await controller.tick();
    assert.deepEqual(
      kinds(controller),
      ['dismiss', 'mic', 'cam', spec.expected, 'dismiss'],
      spec.joinLabel + ' yeniden'
    );
    assert.equal(page.useCounts.mic, 0);
    assert.equal(page.useCounts.both, 0);
    assert.equal(page.allowClicks.n, 0);
    assert.equal(page.nameInput.getAttribute('value'), 'Kerem Ölçay');
  }
  assert.equal(mediaCalls.count, 0);
});

test('Gerçek Meet: X olmayan diyalogda «Mikrofon ve kamera olmadan devam et» ile geçilir', async () => {
  const cases = [
    {
      title: 'Do you want people to see and hear you in the meeting?',
      use: 'Use microphone and camera',
      skip: 'Continue without microphone and camera',
      join: 'Ask to join',
      expected: 'ask'
    },
    {
      title: 'Kullanıcıların toplantıda sizi görmesini ve duymasını istiyor musunuz?',
      use: 'Mikrofon ve kamerayı kullan',
      skip: 'Mikrofon ve kamera olmadan devam et',
      join: 'Katılma isteği',
      expected: 'ask'
    },
    {
      title: 'Bilinmeyen yeni bir başlık',
      use: 'Mikrofon ve kamerayı kullan',
      skip: 'Mikrofon ve kamera olmadan devam et',
      join: 'Şimdi katıl',
      expected: 'join'
    }
  ];
  for (const spec of cases) {
    const mediaCalls = { count: 0 };
    const api = loadJoin(mediaCalls);
    let useClicks = 0;
    let allowClicks = 0;
    const use = button(spec.use);
    use.click = function () { useClicks += 1; };
    const skip = button(spec.skip);
    const more = button('More options');
    const dialog = el({
      tag: 'div',
      attrs: { role: 'dialog' },
      children: [el({ tag: 'h2', text: spec.title }), use, more, skip]
    });
    skip.click = function () { dialog.remove(); };
    const allow = button('İzin ver');
    allow.click = function () { allowClicks += 1; };
    const join = button(spec.join);
    const document = doc({ children: [allow, join, dialog] });
    const controller = api.createMeetJoin({
      document: document,
      now: function () { return T0; },
      deadlineAt: T0 + WINDOW_MS
    });
    await controller.tick();
    assert.deepEqual(kinds(controller), ['continue-without-media', spec.expected], spec.title);
    assert.equal(useClicks, 0, 'aygıtı kullan düğmesine basılmamalı');
    assert.equal(allowClicks, 0, 'izin ver düğmesine basılmamalı');
    assert.equal(mediaCalls.count, 0);
  }
});
test('X yokken kullan düğmeleri katılmayı açmaz', async () => {
  const mediaCalls = { count: 0 };
  const api = loadJoin(mediaCalls);
  const page = hearYouPage({
    title: 'Kullanıcıların toplantıda sizi duymasını istiyor musunuz?',
    useMic: 'Mikrofonu kullan',
    useBoth: 'Mikrofon ve kamerayı kullan',
    micLabel: 'Mikrofonu kapat',
    camLabel: 'Kamerayı kapat',
    micOff: 'Mikrofonu aç',
    camOff: 'Kamerayı aç',
    joinLabel: 'Katılma isteği gönder'
  });
  const controller = api.createMeetJoin({
    document: page.document,
    now: function () { return T0; },
    deadlineAt: T0 + WINDOW_MS
  });
  await controller.tick();
  await controller.tick();
  assert.deepEqual(kinds(controller), []);
  assert.equal(controller.getPhase(), 'looking');
  assert.equal(page.useCounts.mic, 0);
  assert.equal(page.useCounts.both, 0);
  assert.equal(page.allowClicks.n, 0);
  assert.equal(mediaCalls.count, 0);
  assert.equal(page.nameInput.getAttribute('value'), 'Kerem Ölçay');
  assert.equal(page.mic.getAttribute('aria-label'), 'Mikrofonu kapat');
  assert.equal(page.document.body.contains(page.dialog), true);
});

test('Diyalog kapanmazsa 45 sn sonra durum «izin gerekiyor» olur; kapanınca katılım sürer', async () => {
  const api = loadJoin({ count: 0 });
  const page = hearYouPage({
    title: 'Kullanıcıların toplantıda sizi duymasını istiyor musunuz?',
    useMic: 'Mikrofonu kullan',
    useBoth: 'Mikrofon ve kamerayı kullan',
    micLabel: 'Mikrofonu kapat',
    camLabel: 'Kamerayı kapat',
    micOff: 'Mikrofonu aç',
    camOff: 'Kamerayı aç',
    joinLabel: 'Katılma isteği gönder'
  });
  let clock = T0;
  const statuses = [];
  const controller = api.createMeetJoin({
    document: page.document,
    now: function () { return clock; },
    deadlineAt: T0 + WINDOW_MS,
    onStatus: function (info) { statuses.push(info.phase + ':' + info.reason); }
  });
  await controller.tick();
  assert.equal(controller.getPhase(), 'looking');
  clock = T0 + 20000;
  await controller.tick();
  assert.equal(controller.getPhase(), 'looking', '45 sn dolmadan değişmez');
  clock = T0 + 50000;
  await controller.tick();
  assert.equal(controller.getPhase(), 'blocked');
  assert.deepEqual(statuses, ['blocked:permission']);
  assert.equal(Schedule.phaseUpdate('blocked', 'permission').status, 'blocked');
  assert.match(Schedule.phaseUpdate('blocked', 'permission').text, /izin/);
  assert.equal(page.useCounts.mic + page.useCounts.both + page.allowClicks.n, 0);

  // Kullanıcı izni elle verip diyaloğu kapatınca bot katılmaya devam eder.
  page.dialog.remove();
  clock = T0 + 55000;
  await controller.tick();
  assert.ok(kinds(controller).indexOf('ask') !== -1 || kinds(controller).indexOf('join') !== -1);
});
test('Kullan düğmeleri aygıt sanılıp katılmayı kilitlemez', async () => {
  const mediaCalls = { count: 0 };
  const api = loadJoin(mediaCalls);
  const prompts = [
    'Mikrofonu kullan',
    'Mikrofon ve kamerayı kullan',
    'Use microphone',
    'Use microphone and camera',
    'Use mic',
    'Use mic and camera'
  ];
  const counts = {};
  const promptButtons = prompts.map((label) => {
    const node = button(label);
    counts[label] = 0;
    node.click = function () { counts[label] += 1; };
    return node;
  });
  const mic = button('Mikrofonu aç');
  const cam = button('Kamerayı aç');
  const join = button('Katıl');
  const document = doc({ children: [mic, cam, join].concat(promptButtons) });
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    deadlineAt: T0 + WINDOW_MS
  });
  await controller.tick();
  assert.deepEqual(kinds(controller), ['join']);
  prompts.forEach((label) => {
    assert.equal(counts[label], 0, label);
  });
  assert.equal(mediaCalls.count, 0);
});

test('İzin gerekiyor katılmayı kilitlemez; diyalog, yenileme ve süre tek akışta', async () => {
  const mediaCalls = { count: 0 };
  const api = loadJoin(mediaCalls);
  const useMic = button('Mikrofonu kullan');
  const useBoth = button('Mikrofon ve kamerayı kullan');
  let useClicks = 0;
  useMic.click = function () { useClicks += 1; };
  useBoth.click = function () { useClicks += 1; };
  const allow = button('İzin ver');
  let allowClicks = 0;
  allow.click = function () { allowClicks += 1; };
  const outsideClose = button('Kapat');
  let outsideClicks = 0;
  outsideClose.click = function () { outsideClicks += 1; };
  const upgrade = button('Yükselt');
  let upgradeClicks = 0;
  upgrade.click = function () { upgradeClicks += 1; };
  const permMic = button('Mikrofon, izin gerekiyor');
  let permClicks = 0;
  permMic.click = function () { permClicks += 1; };
  const cam = button('Kamerayı kapat');
  cam.click = function () { setLabel(cam, 'Kamerayı aç'); };
  const nameInput = el({
    tag: 'input',
    attrs: { type: 'text', 'aria-label': 'Adınız', value: 'Kerem Ölçay' }
  });
  const heading = el({
    tag: 'h2',
    text: 'Kullanıcıların toplantıda sizi duymasını istiyor musunuz?'
  });
  const sub = el({
    tag: 'p',
    text: 'Toplantıda mikrofonunuzu istediğiniz zaman kapatabilirsiniz.'
  });
  const dialog = el({
    tag: 'div',
    attrs: { role: 'dialog' },
    children: [heading, sub, useMic, useBoth]
  });
  const x = button('close');
  x.click = function () { dialog.remove(); };
  dialog.appendChild(x);
  const document = doc({
    children: [
      nameInput,
      permMic,
      cam,
      allow,
      upgrade,
      outsideClose,
      el({ tag: 'div', text: 'İzin gerekiyor' }),
      dialog
    ]
  });
  let note = null;
  function showAsk() {
    const ask = button('Katılma isteği gönder');
    ask.click = function () {
      ask.remove();
      note = el({
        tag: 'div',
        text: 'Katılma isteği gönderildi. Birisi sizi içeri aldığında katılacaksınız.'
      });
      document.body.appendChild(note);
    };
    document.body.appendChild(ask);
    return ask;
  }
  showAsk();
  let clock = T0;
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return clock; },
    deadlineAt: T0 + WINDOW_MS
  });
  assert.equal(await controller.tick(), 'waiting');
  assert.deepEqual(kinds(controller), ['dismiss', 'cam', 'ask']);
  assert.equal(useClicks, 0);
  assert.equal(allowClicks, 0);
  assert.equal(permClicks, 0);
  assert.equal(outsideClicks, 0);
  assert.equal(upgradeClicks, 0);
  assert.equal(nameInput.getAttribute('value'), 'Kerem Ölçay');
  assert.equal(cam.getAttribute('aria-label'), 'Kamerayı aç');
  assert.equal(await controller.tick(), 'waiting');
  assert.equal(kinds(controller).length, 3, 'istek dururken yeniden basılmamalı');

  note.remove();
  showAsk();
  assert.equal(await controller.tick(), 'waiting');
  assert.equal(kinds(controller).filter((kind) => kind === 'ask').length, 2);

  clock = T0 + WINDOW_MS + 1;
  note.remove();
  showAsk();
  assert.equal(await controller.tick(), 'expired');
  assert.equal(kinds(controller).filter((kind) => kind === 'ask').length, 2);
  assert.equal(useClicks, 0);
  assert.equal(mediaCalls.count, 0);
  assert.equal(api.joinKind('Toplantıya katıl'), 'join');
  assert.equal(api.joinKind('Katılma isteği gönder'), 'ask');
  assert.equal(api.deviceIsLive(button('Microphone permission needed')), false);
  assert.equal(api.deviceIsLive(button('Mikrofonu kapat')), true);
});

test('X kısa adla kapanır', async () => {
  const api = loadJoin({ count: 0 });
  const useMic = button('Mikrofonu kullan');
  let useClicks = 0;
  useMic.click = function () { useClicks += 1; };
  const outside = button('Kapat');
  let outsideClicks = 0;
  outside.click = function () { outsideClicks += 1; };
  const heading = el({
    tag: 'h2',
    text: 'Kullanıcıların toplantıda sizi duymasını istiyor musunuz?'
  });
  const dialog = el({
    tag: 'div',
    attrs: { role: 'dialog' },
    children: [heading, useMic]
  });
  const x = button('Kapat pencere');
  x.click = function () { dialog.remove(); };
  dialog.appendChild(x);
  const join = button('Toplantıya katıl');
  const document = doc({
    children: [button('Mikrofonu aç'), button('Kamerayı aç'), outside, join, dialog]
  });
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    deadlineAt: T0 + WINDOW_MS
  });
  await controller.tick();
  assert.deepEqual(kinds(controller), ['dismiss', 'join']);
  assert.equal(useClicks, 0);
  assert.equal(outsideClicks, 0);
  assert.equal(document.body.contains(dialog), false);
});

function inCallHarness(api, children) {
  let records = 0;
  let stops = 0;
  const document = doc({ children: children });
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    deadlineAt: T0 + WINDOW_MS,
    onCaptionsReady: function () {
      records += 1;
      return { ok: true };
    },
    onMeetingEnded: function () {
      stops += 1;
    }
  });
  return {
    document: document,
    controller: controller,
    records: function () { return records; },
    stops: function () { return stops; }
  };
}

test('Altyazı ilk tıklamada açılmazsa yeniden denenir, açıkken kapatılmaz', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Aramadan ayrıl');
  const captions = button('Altyazıları aç');
  let captionClicks = 0;
  captions.click = function () {
    captionClicks += 1;
    if (captionClicks >= 2) {
      setLabel(captions, 'Altyazıları kapat');
    }
  };
  const harness = inCallHarness(api, [leave, captions]);
  assert.equal(await harness.controller.tick(), 'admitted');
  assert.equal(captionClicks, 1);
  assert.equal(harness.records(), 0);
  assert.equal(await harness.controller.tick(), 'recording');
  assert.equal(captionClicks, 2);
  assert.equal(harness.records(), 1);
  assert.equal(await harness.controller.tick(), 'recording');
  assert.equal(captionClicks, 2, 'açık altyazı ikinci kez kapatılmamalı');
  assert.equal(harness.stops(), 0);
});

test('Altyazı Diğer seçenekler altındaysa yalnız o öğe açılır', async () => {
  const api = loadJoin({ count: 0 });
  const cases = [
    ['Diğer seçenekler', 'Altyazıları aç'],
    ['More options', 'Turn on captions']
  ];
  for (const [moreLabel, captionLabel] of cases) {
    const leave = button('Aramadan ayrıl');
    const settings = button('Ayarlar');
    const useMic = button('Mikrofonu kullan');
    let settingsClicks = 0;
    let useClicks = 0;
    settings.click = function () { settingsClicks += 1; };
    useMic.click = function () { useClicks += 1; };
    const captions = button(captionLabel);
    captions.click = function () { setLabel(captions, 'Altyazıları kapat'); };
    const more = button(moreLabel);
    const harness = inCallHarness(api, [leave, more]);
    more.click = function () {
      harness.document.body.appendChild(settings);
      harness.document.body.appendChild(useMic);
      harness.document.body.appendChild(captions);
    };
    assert.equal(await harness.controller.tick(), 'recording', moreLabel);
    assert.deepEqual(kinds(harness.controller), ['more', 'captions'], moreLabel);
    assert.equal(settingsClicks, 0);
    assert.equal(useClicks, 0);
    assert.equal(harness.records(), 1);
    await harness.controller.tick();
    assert.equal(kinds(harness.controller).filter((kind) => kind === 'captions').length, 1);
  }
});

test('Gerçek Meet etiketleri: «Görüşmeden çık» ve «Altyazılar ve çeviri» menüsüyle altyazı açılır', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Görüşmeden çık');
  const menu = button('Altyazılar ve çeviri');
  menu.setAttribute('aria-pressed', 'false');
  const settings = button('Altyazı ayarlarını aç');
  let settingsClicks = 0;
  settings.click = function () { settingsClicks += 1; };
  const enable = button('Altyazıları etkinleştir');
  const harness = inCallHarness(api, [leave, menu, settings]);
  menu.click = function () {
    harness.document.body.appendChild(enable);
  };
  enable.click = function () {
    setLabel(enable, 'Canlı altyazıları devre dışı bırak');
  };
  assert.equal(await harness.controller.tick(), 'recording');
  assert.deepEqual(kinds(harness.controller), ['captions-menu', 'captions']);
  assert.equal(settingsClicks, 0, 'altyazı ayarlarına basılmamalı');
  assert.equal(harness.records(), 1);
  assert.equal(harness.stops(), 0);
});

test('Altyazı menü öğesi gecikmeli gelirse diğer seçeneklere basılmaz, 2 sn dolmadan menü tekrar basılmaz', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Görüşmeden çık');
  const menu = button('Altyazılar ve çeviri');
  menu.setAttribute('aria-pressed', 'false');
  const more = button('Diğer seçenekler');
  let moreClicks = 0;
  more.click = function () { moreClicks += 1; };
  const enable = button('Altyazıları etkinleştir');
  enable.click = function () {
    setLabel(enable, 'Canlı altyazıları devre dışı bırak');
  };
  const document = doc({ children: [leave, menu, more] });
  let clock = T0;
  let records = 0;
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return clock; },
    deadlineAt: T0 + WINDOW_MS,
    onCaptionsReady: function () {
      records += 1;
      return { ok: true };
    }
  });

  assert.equal(await controller.tick(), 'admitted');
  assert.equal(moreClicks, 0, 'menü basılınca aynı tickte Diğer seçeneklere basılmamalı');
  assert.deepEqual(kinds(controller), ['captions-menu']);

  clock = T0 + 1000;
  assert.equal(await controller.tick(), 'admitted');
  assert.equal(moreClicks, 0, '2 sn dolmadan Diğer seçeneklere düşülmemeli');
  assert.deepEqual(kinds(controller), ['captions-menu'], '2 sn dolmadan aynı menü düğmesine tekrar basılmamalı');

  document.body.appendChild(enable);
  clock = T0 + 2500;
  assert.equal(await controller.tick(), 'recording');
  assert.equal(moreClicks, 0);
  assert.deepEqual(kinds(controller), ['captions-menu', 'captions']);
  assert.equal(records, 1);
});

test('Altyazı menü düğmesi açılmadıysa 2 sn dolmadan tekrar basılmaz, 2 sn sonra tekrar denenir', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Görüşmeden çık');
  const more = button('Diğer seçenekler');
  const captions = button('Altyazıları aç');
  captions.click = function () { setLabel(captions, 'Altyazıları kapat'); };
  const document = doc({ children: [leave, more] });
  let moreClicks = 0;
  more.click = function () {
    moreClicks += 1;
    if (moreClicks >= 2) {
      document.body.appendChild(captions);
    }
  };
  let clock = T0;
  let records = 0;
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return clock; },
    deadlineAt: T0 + WINDOW_MS,
    onCaptionsReady: function () {
      records += 1;
      return { ok: true };
    }
  });

  assert.equal(await controller.tick(), 'admitted');
  assert.equal(moreClicks, 1);
  assert.deepEqual(kinds(controller), ['more']);

  clock = T0 + 1999;
  assert.equal(await controller.tick(), 'admitted');
  assert.equal(moreClicks, 1, '2 sn dolmadan aynı menü düğmesine tekrar basılmamalı');
  assert.deepEqual(kinds(controller), ['more']);

  clock = T0 + 2000;
  assert.equal(await controller.tick(), 'recording');
  assert.equal(moreClicks, 2);
  assert.deepEqual(kinds(controller), ['more', 'more', 'captions']);
  assert.equal(records, 1);
});

test('Altyazılar ve çeviri öğe açmazsa 2 sn sonra Diğer seçeneklere geçer', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Görüşmeden çık');
  const menu = button('Altyazılar ve çeviri');
  menu.setAttribute('aria-pressed', 'false');
  let menuClicks = 0;
  menu.click = function () { menuClicks += 1; };
  const more = button('Diğer seçenekler');
  const enable = button('Altyazıları etkinleştir');
  enable.click = function () {
    setLabel(enable, 'Canlı altyazıları devre dışı bırak');
  };
  const document = doc({ children: [leave, menu, more] });
  let moreClicks = 0;
  more.click = function () {
    moreClicks += 1;
    document.body.appendChild(enable);
  };
  let clock = T0;
  let records = 0;
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return clock; },
    deadlineAt: T0 + WINDOW_MS,
    onCaptionsReady: function () {
      records += 1;
      return { ok: true };
    }
  });

  assert.equal(await controller.tick(), 'admitted');
  assert.equal(menuClicks, 1);
  assert.equal(moreClicks, 0);
  assert.deepEqual(kinds(controller), ['captions-menu']);

  clock = T0 + 1000;
  assert.equal(await controller.tick(), 'admitted');
  assert.equal(menuClicks, 1);
  assert.equal(moreClicks, 0, '2 sn dolmadan Diğer seçeneklere geçilmemeli');

  clock = T0 + 3000;
  assert.equal(await controller.tick(), 'recording');
  assert.equal(menuClicks, 1);
  assert.equal(moreClicks, 1);
  assert.deepEqual(kinds(controller), ['captions-menu', 'more', 'captions']);
  assert.equal(records, 1);

  // Gecikmeli Diğer seçenekler menüsü ve tur sıfırlanması
  const delayedLeave = button('Görüşmeden çık');
  const delayedMenu = button('Altyazılar ve çeviri');
  delayedMenu.setAttribute('aria-pressed', 'false');
  const delayedMore = button('Diğer seçenekler');
  const delayedEnable = button('Altyazıları etkinleştir');
  delayedEnable.click = function () {
    setLabel(delayedEnable, 'Canlı altyazıları devre dışı bırak');
  };
  const delayedDoc = doc({ children: [delayedLeave, delayedMenu, delayedMore] });
  let delayedClock = T0;
  let delayedRecords = 0;
  const delayedController = api.createMeetJoin({
    document: delayedDoc,
    now: function () { return delayedClock; },
    deadlineAt: T0 + WINDOW_MS,
    onCaptionsReady: function () {
      delayedRecords += 1;
      return { ok: true };
    }
  });

  assert.equal(await delayedController.tick(), 'admitted');
  assert.deepEqual(kinds(delayedController), ['captions-menu']);

  delayedClock = T0 + 3000;
  assert.equal(await delayedController.tick(), 'admitted');
  assert.deepEqual(kinds(delayedController), ['captions-menu', 'more']);

  // Tüm adaylar denendiği için bir sonraki tur yeniden ilk düğmeden başlar
  delayedClock = T0 + 6000;
  assert.equal(await delayedController.tick(), 'admitted');
  assert.deepEqual(kinds(delayedController), ['captions-menu', 'more', 'captions-menu']);

  delayedDoc.body.appendChild(delayedEnable);
  delayedClock = T0 + 7000;
  assert.equal(await delayedController.tick(), 'recording');
  assert.deepEqual(kinds(delayedController), ['captions-menu', 'more', 'captions-menu', 'captions']);
  assert.equal(delayedRecords, 1);
});

test('Altyazı ve dil menü öğesiyse de Türkçe seçilir', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Aramadan ayrıl');
  const captions = el({
    tag: 'div',
    attrs: { role: 'menuitem', 'aria-label': 'Altyazıları aç' },
    text: 'Altyazıları aç'
  });
  captions.click = function () { setLabel(captions, 'Altyazıları kapat'); };
  const settings = el({
    tag: 'div',
    attrs: { role: 'menuitem', 'aria-label': 'Ayarlar' },
    text: 'Ayarlar'
  });
  let settingsClicks = 0;
  settings.click = function () { settingsClicks += 1; };
  const more = button('Diğer seçenekler');
  const lang = button('English');
  const turkish = el({
    tag: 'div',
    attrs: { role: 'option', 'aria-label': 'Türkçe' },
    text: 'Türkçe'
  });
  const deutsch = el({
    tag: 'div',
    attrs: { role: 'option', 'aria-label': 'Deutsch' },
    text: 'Deutsch'
  });
  let deutschClicks = 0;
  deutsch.click = function () { deutschClicks += 1; };
  const list = el({ tag: 'div', attrs: { role: 'listbox' } });
  const harness = inCallHarness(api, [leave, more, lang]);
  more.click = function () {
    harness.document.body.appendChild(settings);
    harness.document.body.appendChild(captions);
  };
  lang.click = function () {
    list.appendChild(deutsch);
    list.appendChild(turkish);
    harness.document.body.appendChild(list);
  };
  turkish.click = function () {
    setLabel(lang, 'Türkçe');
    list.remove();
  };
  assert.equal(await harness.controller.tick(), 'recording');
  assert.deepEqual(kinds(harness.controller), ['more', 'captions', 'lang', 'lang']);
  assert.equal(settingsClicks, 0);
  assert.equal(deutschClicks, 0);
  assert.equal(lang.getAttribute('aria-label'), 'Türkçe');
  assert.equal(captions.getAttribute('aria-label'), 'Altyazıları kapat');
  assert.equal(harness.records(), 1);
  await harness.controller.tick();
  assert.equal(kinds(harness.controller).length, 4);
  assert.equal(harness.records(), 1);
});

test('Altyazı açılınca İngilizce dil Türkçeye çevrilir, kayıt o zaman başlar', async () => {
  const api = loadJoin({ count: 0 });
  const cases = [
    ['English', 'Türkçe'],
    ['English (United States)', 'Turkish'],
    ['İngilizce (ABD)', 'Türkçe']
  ];
  for (const [current, choice] of cases) {
    const leave = button('Aramadan ayrıl');
    const captions = button('Altyazıları aç');
    const lang = button(current);
    const turkish = button(choice);
    const deutsch = button('Deutsch');
    const englishItem = button('English');
    let deutschClicks = 0;
    let englishItemClicks = 0;
    deutsch.click = function () { deutschClicks += 1; };
    englishItem.click = function () { englishItemClicks += 1; };
    const menu = el({ tag: 'div', attrs: { role: 'menu' } });
    const harness = inCallHarness(api, [leave, captions, lang]);
    captions.click = function () { setLabel(captions, 'Altyazıları kapat'); };
    lang.click = function () {
      harness.document.body.appendChild(menu);
      menu.appendChild(englishItem);
      menu.appendChild(turkish);
      menu.appendChild(deutsch);
    };
    turkish.click = function () {
      setLabel(lang, 'Türkçe');
      menu.remove();
    };
    assert.equal(await harness.controller.tick(), 'recording', current);
    assert.deepEqual(kinds(harness.controller), ['captions', 'lang', 'lang'], current);
    const labels = Array.prototype.map.call(harness.controller.getClicks(), (item) => item.label);
    assert.deepEqual(labels, ['Altyazıları aç', current, choice], current);
    assert.equal(deutschClicks, 0);
    assert.equal(englishItemClicks, 0);
    assert.equal(lang.getAttribute('aria-label'), 'Türkçe');
    assert.equal(harness.records(), 1);
    assert.equal(captions.getAttribute('aria-label'), 'Altyazıları kapat');
    await harness.controller.tick();
    assert.equal(kinds(harness.controller).length, 3, 'açık altyazı ve Türkçe yeniden basılmamalı');
    assert.equal(harness.records(), 1);
  }
});

test('Altyazı dili zaten Türkçeyse başka dil seçilmez', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Aramadan ayrıl');
  const english = button('English');
  const deutsch = button('Deutsch');
  let englishClicks = 0;
  let deutschClicks = 0;
  english.click = function () { englishClicks += 1; };
  deutsch.click = function () { deutschClicks += 1; };
  const menu = el({
    tag: 'div',
    attrs: { role: 'menu' },
    children: [english, deutsch]
  });
  const lang = button('Türkçe');
  const region = el({ tag: 'div', attrs: { role: 'region', 'aria-label': 'Altyazılar' } });
  const harness = inCallHarness(api, [
    leave,
    button('Altyazıları kapat'),
    lang,
    menu,
    region
  ]);
  assert.equal(await harness.controller.tick(), 'recording');
  assert.deepEqual(kinds(harness.controller), []);
  assert.equal(englishClicks, 0);
  assert.equal(deutschClicks, 0);
  assert.equal(harness.records(), 1);
  assert.equal(lang.getAttribute('aria-label'), 'Türkçe');
});

test('Dil düğmesi yoksa kayıt başlar; sonra İngilizce olursa kayıt kesilmeden Türkçe seçilir', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Aramadan ayrıl');
  const region = el({ tag: 'div', attrs: { role: 'region', 'aria-label': 'Altyazılar' } });
  const harness = inCallHarness(api, [leave, button('Altyazıları kapat'), region]);
  assert.equal(await harness.controller.tick(), 'recording');
  assert.equal(harness.records(), 1);
  assert.deepEqual(kinds(harness.controller), []);

  const lang = button('English');
  const turkish = button('Türkçe');
  const deutsch = button('Deutsch');
  let deutschClicks = 0;
  deutsch.click = function () { deutschClicks += 1; };
  const menu = el({ tag: 'div', attrs: { role: 'menu' } });
  lang.click = function () {
    harness.document.body.appendChild(menu);
    menu.appendChild(turkish);
    menu.appendChild(deutsch);
  };
  turkish.click = function () {
    setLabel(lang, 'Türkçe');
    menu.remove();
  };
  harness.document.body.appendChild(lang);
  assert.equal(await harness.controller.tick(), 'recording');
  assert.deepEqual(kinds(harness.controller), ['lang', 'lang']);
  const labels = Array.prototype.map.call(harness.controller.getClicks(), (item) => item.label);
  assert.deepEqual(labels, ['English', 'Türkçe']);
  assert.equal(deutschClicks, 0);
  assert.equal(harness.records(), 1);
  assert.equal(harness.stops(), 0);
  assert.equal(lang.getAttribute('aria-label'), 'Türkçe');
});

test('Çıkarıldı ve arama sona erdi ekranları kaydı durdurur ve ayrılır', async () => {
  const cases = [
    ['Toplantıdan çıkarıldınız', 'removed', 'Toplantıdan çıkarıldınız, kayıt durduruldu.'],
    ['Arama sona erdi', 'call-ended', 'Arama sona erdi, kayıt durduruldu.']
  ];
  for (const [text, reason, statusText] of cases) {
    const env = boot(T0);
    const api = loadJoin({ count: 0 });
    try {
      const saved = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
      env.setClock(saved.item.startAt);
      await env.fire({ name: Schedule.joinAlarmName(saved.item.id) });
      const item = (await listJoins(env))[0];
      const started = await env.harness.sendToBackground({
        type: 'MNA_SCHEDULED_CAPTURE_START',
        joinId: item.id,
        tabId: item.tabId
      }, { tab: { id: item.tabId } });
      assert.equal(started.ok, true, text);
      const leave = button('Aramadan ayrıl');
      let left = 0;
      leave.click = function () { left += 1; };
      const document = doc({
        children: [el({ tag: 'h1', text: text }), leave]
      });
      const controller = api.createMeetJoin({
        document: document,
        now: function () { return saved.item.startAt; },
        deadlineAt: saved.item.startAt + WINDOW_MS,
        onMeetingEnded: function (info) {
          assert.equal(info.reason, reason);
          return env.harness.sendToBackground({
            type: 'MNA_SCHEDULED_MEETING_ENDED',
            joinId: item.id,
            reason: info.reason
          });
        }
      });
      assert.equal(await controller.tick(), reason);
      assert.equal(left, 1);
      const active = await env.harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
      assert.equal(active.active, null);
      const listed = await listJoins(env);
      assert.equal(listed[0].statusText, statusText);
    } finally {
      env.harness.cleanup();
    }
  }
});

test('Altyazıda konuşulan «toplantı bitti / çıkarıldı» sözü toplantıyı bitirmez', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Aramadan ayrıl');
  let left = 0;
  leave.click = function () { left += 1; };
  const captions = el({
    tag: 'div',
    attrs: { role: 'region', 'aria-label': 'Altyazılar' },
    text: 'Toplantı bitti arkadaşlar, o kişi dün çıkarıldı. Arama sona erdi.'
  });
  const document = doc({ children: [captions, leave] });
  let ended = 0;
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    onMeetingEnded: function () { ended += 1; }
  });
  await controller.tick();
  assert.equal(ended, 0, 'altyazı metni bitiş sayılmamalı');
  assert.equal(left, 0, 'toplantıdan ayrılınmamalı');
});

test('«Toplantıdan ayrıldınız» ekranı bitiş sayılır ve altyazı/yan panelde yazılırsa sayılmaz', () => {
  const api = loadJoin({ count: 0 });
  assert.equal(api.endReason('Toplantıdan ayrıldınız Yeniden katıl'), 'left');
  assert.equal(api.endReason('You left the meeting'), 'left');
  assert.equal(Schedule.phaseUpdate('left', 'left').status, 'ended');
  assert.equal(
    Schedule.phaseUpdate('left', 'left').text,
    'Toplantıdan ayrıldınız, kayıt durduruldu.'
  );
  const panel = el({ tag: 'aside', attrs: { 'aria-label': 'Yan panel' }, text: 'Toplantıdan ayrıldınız' });
  const captions = el({
    tag: 'div',
    attrs: { role: 'region', 'aria-label': 'Altyazılar' },
    text: 'Toplantıdan ayrıldınız'
  });
  assert.equal(api.meetingEndReason(doc({ children: [panel, captions] })), null);
  assert.equal(
    api.meetingEndReason(doc({ children: [el({ tag: 'h1', text: 'Toplantıdan ayrıldınız' })] })),
    'left'
  );
  // Görüşme düğmesi varken ekrandaki bildirim bitiş sayılmaz.
  assert.equal(
    api.meetingEndReason(
      doc({ children: [el({ tag: 'div', text: 'Ali toplantıdan çıkarıldı' }), button('Görüşmeden çık')] })
    ),
    null
  );
});

test('Sohbet panelinde yazılan «toplantı bitti / çıkarıldınız» toplantıyı bitirmez', async () => {
  const api = loadJoin({ count: 0 });
  const leave = button('Aramadan ayrıl');
  let left = 0;
  leave.click = function () { left += 1; };
  // Gerçek Meet'te sohbet mesajı <aside aria-label="Yan panel"> içindedir.
  const panel = el({
    tag: 'aside',
    attrs: { 'aria-label': 'Yan panel' },
    text: 'Toplantı bitti, arama sona erdi, çıkarıldınız'
  });
  const document = doc({ children: [panel, leave] });
  let ended = 0;
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    onMeetingEnded: function () { ended += 1; }
  });
  await controller.tick();
  assert.equal(ended, 0, 'sohbet metni bitiş sayılmamalı');
  assert.equal(left, 0, 'toplantıdan ayrılınmamalı');
});

test('participantCount ve yalnız kalma izleyicisi: önce başkaları görülmeli, sonra süre dolmalı, sayı okunamazsa sıfırlanır', () => {
  const api = loadJoin({ count: 0 });
  assert.equal(api.participantCount(doc({ children: [button('Kullanıcılar12')] })), 12);
  assert.equal(api.participantCount(doc({ children: [button('People 3')] })), 3);
  assert.equal(api.participantCount(doc({ children: [button('Sohbet')] })), null);

  let clock = 0;
  const watcher = api.createAloneWatcher({ aloneMs: 5 * 60 * 1000, now: function () { return clock; } });
  const alone = doc({ children: [button('Kullanıcılar1')] });
  const group = doc({ children: [button('Kullanıcılar5')] });
  const unknown = doc({ children: [button('Sohbet')] });

  // Daha önce başkası görülmeden yalnız olmak (toplantı henüz boş) bitiş sayılmaz.
  assert.equal(watcher.update(alone), false);
  clock += 10 * 60 * 1000;
  assert.equal(watcher.update(alone), false, 'başkası hiç görülmediyse durdurulmaz');

  assert.equal(watcher.update(group), false);
  assert.equal(watcher.update(alone), false, 'sayaç yeni başladı');
  clock += 4 * 60 * 1000;
  assert.equal(watcher.update(alone), false, '4 dk yetmez');
  assert.equal(watcher.update(unknown), false, 'sayı okunamazsa sıfırlanır');
  clock += 4 * 60 * 1000;
  assert.equal(watcher.update(alone), false, 'sıfırlandıktan sonra yeniden sayılır');
  clock += 5 * 60 * 1000;
  assert.equal(watcher.update(alone), true, '5 dk yalnız kalınca true');
  clock += 1000;
  assert.equal(watcher.update(group), false, 'biri dönerse sıfırlanır');
});

test('Aygıt güvenliği: mikrofon/kamera durumu okunamıyorsa katılınmaz, kapalı okunuyorsa katılınır', async () => {
  const api = loadJoin({ count: 0 });
  async function tryJoin(deviceLabels) {
    const join = button('Şimdi katıl');
    let pressed = 0;
    join.click = function () { pressed += 1; };
    const controller = api.createMeetJoin({
      document: doc({ children: deviceLabels.map((label) => button(label)).concat([join]) }),
      now: function () { return T0; },
      onStatus: function () {}
    });
    await controller.tick();
    return pressed;
  }
  // Yalnız «Mikrofon: …» seçici düğmeleri var, açık/kapalı okunamıyor: emin değiliz, katılma.
  assert.equal(await tryJoin(['Mikrofon: Mikrofon (Realtek(R) Audio)', 'Kamera: HD Webcam']), 0);
  // Mikrofon kapalı okunuyor ama kamera okunamıyor: katılma.
  assert.equal(await tryJoin(['Mikrofonu aç', 'Kamera: HD Webcam']), 0);
  // İkisi de kapalı okunuyor: katıl.
  assert.equal(await tryJoin(['Mikrofonu aç', 'Kamerayı açın']), 1);
  // Aygıt düğmesi hiç yok (ör. kamerası olmayan bilgisayar): katılmaya engel değil.
  assert.equal(await tryJoin([]), 1);
});

test('Aygıt güvenliği: toplantıdayken açık görünen mikrofon ve kamera kapatılır', async () => {
  const api = loadJoin({ count: 0 });
  const mic = button('Mikrofonu kapat');
  const cam = button('Kamerayı kapat');
  let micClicks = 0;
  let camClicks = 0;
  mic.click = function () { micClicks += 1; };
  cam.click = function () { camClicks += 1; };
  const controller = api.createMeetJoin({
    document: doc({ children: [mic, cam, button('Görüşmeden çık')] }),
    now: function () { return T0; },
    onStatus: function () {}
  });
  await controller.tick();
  assert.equal(micClicks, 1, 'açık mikrofon kapatılmalı');
  assert.equal(camClicks, 1, 'açık kamera kapatılmalı');
});

test('Bekleme odası: «sizi görüşmeye alana kadar bekleyin» ekranı katıldı sayılmaz, kişi karesi menüsüne basılmaz', async () => {
  const api = loadJoin({ count: 0 });
  let tileClicks = 0;
  let moreClicks = 0;
  const tile = button('Ayşe Yılmaz için diğer seçenekler');
  tile.click = function () { tileClicks += 1; };
  const more = button('Diğer seçenekler');
  more.click = function () { moreClicks += 1; };
  const statuses = [];
  const document = doc({
    children: [
      el({ tag: 'p', text: 'Lütfen toplantıyı düzenleyen kişi sizi görüşmeye alana kadar bekleyin.' }),
      tile,
      more,
      button('Görüşmeden çık')
    ]
  });
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    onStatus: function (info) { statuses.push(info.phase); }
  });
  await controller.tick();
  await controller.tick();
  assert.deepEqual(statuses, ['waiting'], 'bekleme odasında yalnız waiting bildirilmeli');
  assert.equal(tileClicks, 0);
  assert.equal(moreClicks, 0);

  // Toplantıya girildikten sonra (bekleme metni yok) asıl menüye basılır, kişi karesine değil.
  const inCall = doc({ children: [tile, more, button('Görüşmeden çık')] });
  const second = api.createMeetJoin({
    document: inCall,
    now: function () { return T0; },
    onStatus: function () {}
  });
  await second.tick();
  assert.equal(tileClicks, 0, 'kişi karesinin menüsüne basılmamalı');
  assert.equal(moreClicks, 1, 'asıl «Diğer seçenekler» düğmesine basılmalı');
});

test('Tanılama günlüğü: alarm, sekme ve sayfa olayları sırayla yazılır, sayı sınırlıdır', async () => {
  const env = boot(T0);
  try {
    const saved = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
    env.setClock(saved.item.startAt);
    await env.fire({ name: Schedule.joinAlarmName(saved.item.id) });
    const item = (await listJoins(env))[0];
    const fromTab = { tab: { id: item.tabId } };
    await env.harness.sendToBackground(
      { type: 'MNA_JOIN_TRACE', joinId: item.id, kind: 'page', data: { buttons: ['Katıl'] } },
      fromTab
    );
    // Sekme dışından (ör. başka bir uzantı sayfası) gelen kayıt yazılmaz.
    await env.harness.sendToBackground(
      { type: 'MNA_JOIN_TRACE', joinId: item.id, kind: 'sahte', data: null }
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const log = env.harness.local.store.get('mna.joinTrace');
    const types = log.map((entry) => entry.src + ':' + entry.type);
    ['sw:saved', 'sw:alarm-fired', 'sw:join-alarm', 'sw:tab-opened', 'page:page'].forEach((want) => {
      assert.ok(types.indexOf(want) !== -1, want + ' günlükte olmalı: ' + types.join(','));
    });
    assert.equal(types.indexOf('page:sahte'), -1);
    assert.ok(types.indexOf('sw:saved') < types.indexOf('sw:tab-opened'));

    for (let i = 0; i < 650; i += 1) {
      await env.harness.sendToBackground(
        { type: 'MNA_JOIN_TRACE', joinId: item.id, kind: 'n' + i, data: null },
        fromTab
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const capped = env.harness.local.store.get('mna.joinTrace');
    assert.equal(capped.length, 600);
    assert.equal(capped[capped.length - 1].type, 'n649');
  } finally {
    env.harness.cleanup();
  }
});

test('Tanılama günlüğü (sayfa): görünen düğmeler, basılanlar ve durum olayları; e-posta gizlenir', async () => {
  const api = loadJoin({ count: 0 });
  const join = button('Şimdi katıl');
  join.click = function () {};
  const account = button('Google Hesabı: Ali (ali@example.com)');
  const events = [];
  const document = doc({ children: [el({ tag: 'p', text: 'Hazır mısınız?' }), account, join] });
  const controller = api.createMeetJoin({
    document: document,
    now: function () { return T0; },
    onTrace: function (event) { events.push(event); },
    onStatus: function () {}
  });
  await controller.tick();
  await controller.tick();
  const settled = events.filter((event) => event.kind === 'page').length;
  await controller.tick();
  await controller.tick();
  const pages = events.filter((event) => event.kind === 'page');
  assert.equal(pages.length, settled, 'aşama oturunca aynı görünüm tekrar yazılmamalı');
  assert.ok(pages[0].data.buttons.indexOf('Şimdi katıl') !== -1);
  assert.ok(pages[0].data.text.indexOf('Hazır mısınız') !== -1);
  assert.equal(JSON.stringify(pages[0].data).indexOf('ali@example.com'), -1, 'e-posta yazılmamalı');
  assert.equal(JSON.stringify(pages[0].data).indexOf('Ali ('), -1, 'hesap adı yazılmamalı');
  assert.ok(events.some((event) => event.kind === 'click' && event.data.kind === 'join'));
  assert.ok(events.some((event) => event.kind === 'phase'));
});

test('captionsEntry: menü düğmesi, menüdeki öğe ve ⋮ sırayla seçilir', () => {
  const api = loadJoin({ count: 0 });
  const menu = button('Altyazılar ve çeviri');
  menu.setAttribute('aria-pressed', 'false');
  const more = button('Diğer seçenekler');
  assert.equal(api.captionsEntry(doc({ children: [menu, more] })).kind, 'menu');
  assert.equal(api.captionsEntry(doc({ children: [more] })).kind, 'more');
  assert.equal(api.captionsEntry(doc({ children: [] })), null);
  const item = button('Altyazıları aç');
  const found = api.captionsEntry(doc({ children: [menu, more, item] }));
  assert.equal(found.kind, 'toggle');
  assert.equal(found.el, item);
});

test('outOfCall: Ayrıl düğmesi yok ve Yeniden katıl var ise görüşme dışıdır', () => {
  const api = loadJoin({ count: 0 });
  assert.equal(api.outOfCall(doc({ children: [button('Yeniden katıl')] })), true);
  assert.equal(api.outOfCall(doc({ children: [button('Ana ekrana dön')] })), true);
  assert.equal(api.outOfCall(doc({ children: [button('Aramadan ayrıl'), button('Yeniden katıl')] })), false);
  assert.equal(api.outOfCall(doc({ children: [button('Mikrofonu kapat')] })), false);
  assert.equal(api.outOfCall(doc({ children: [] })), false);
});

test('M2: toplantı sürerken başka katılımcı için «X çıkarıldı» bildirimi kaydı bitirmez', async () => {
  const api = loadJoin({ count: 0 });
  assert.equal(api.endReason('Ali çıkarıldı'), 'removed');
  const cases = [
    ['Ali toplantıdan çıkarıldı', null],
    ['Ali çıkarıldı. Toplantı bitti', 'ended'],
    ['Ali was removed from the meeting', null],
    ['Toplantıdan çıkarıldınız', 'removed'],
    ['You were removed from the meeting', 'removed']
  ];
  for (const [text, expected] of cases) {
    const leave = button('Aramadan ayrıl');
    let left = 0;
    leave.click = function () { left += 1; };
    let ended = 0;
    const controller = api.createMeetJoin({
      document: doc({ children: [el({ tag: 'div', text: text }), leave] }),
      now: function () { return T0; },
      onMeetingEnded: function () { ended += 1; }
    });
    await controller.tick();
    if (expected === null) {
      assert.equal(ended, 0, text + ' bitiş sayılmamalı');
      assert.equal(left, 0, text + ': ayrılınmamalı');
    } else {
      assert.equal(ended, 1, text + ' bitiş sayılmalı');
    }
  }
});

test('İsteğe bağlı bitiş saati kaydı durdurur ve ayrılma ister; başka sekmenin kaydına dokunmaz', async () => {
  const env = boot(T0);
  env.harness.attachEchoContentScript(1);
  try {
    const saved = await saveJoin(
      env,
      'https://meet.google.com/abc-defg-hij',
      T0 + 60000,
      T0 + 20 * 60000
    );
    env.setClock(saved.item.startAt);
    await env.fire({ name: Schedule.joinAlarmName(saved.item.id) });
    const item = (await listJoins(env))[0];
    const started = await env.harness.sendToBackground({
      type: 'MNA_SCHEDULED_CAPTURE_START',
      joinId: item.id,
      tabId: item.tabId
    }, { tab: { id: item.tabId } });
    assert.equal(started.ok, true);

    const sent = [];
    const original = env.harness.chrome.tabs.sendMessage;
    env.harness.chrome.tabs.sendMessage = function (tabId, message, callback) {
      sent.push({ tabId: tabId, type: message && message.type });
      return original.call(env.harness.chrome.tabs, tabId, message, callback);
    };
    await env.fire({ name: Schedule.endAlarmName(item.id) });
    const after = await env.harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: started.sessionId
    });
    assert.ok(after.session.endedAt);
    assert.equal((await listJoins(env))[0].statusText, 'Bitiş saatinde kayıt durduruldu.');
    assert.ok(sent.some((message) => message.type === 'MNA_SCHEDULED_LEAVE' && message.tabId === item.tabId));
  } finally {
    env.harness.cleanup();
  }

  const other = boot(T0);
  other.harness.attachEchoContentScript(1);
  try {
    const started = await other.harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.equal(started.ok, true);
    const saved = await saveJoin(other, 'https://meet.google.com/xyz-wxyz-xyz', T0 + 60000, T0 + 20 * 60000);
    const stored = other.harness.local.store.get(Schedule.STORAGE_KEY);
    stored[0].tabId = 99;
    stored[0].status = 'recording';
    await other.fire({ name: Schedule.endAlarmName(saved.item.id) });
    const still = await other.harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: started.sessionId
    });
    assert.equal(still.session.endedAt, null);
    const active = await other.harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.equal(active.active.sessionId, started.sessionId);
  } finally {
    other.harness.cleanup();
  }
});

test('Planlı sekmenin bitiş ekranı başka sekmedeki kaydı durdurmaz', async () => {
  const env = boot(T0);
  env.harness.attachEchoContentScript(1);
  try {
    const started = await env.harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.equal(started.ok, true);
    const saved = await saveJoin(env, 'https://meet.google.com/abc-defg-hij', T0 + 60000);
    const stored = env.harness.local.store.get(Schedule.STORAGE_KEY);
    stored[0].tabId = 2;
    stored[0].status = 'recording';
    stored[0].statusText = 'Toplantıya katıldı, kayıt başladı.';
    const ended = await env.harness.sendToBackground({
      type: 'MNA_SCHEDULED_MEETING_ENDED',
      joinId: saved.item.id,
      reason: 'ended'
    }, { tab: { id: 2 } });
    assert.equal(ended.ok, true);
    const still = await env.harness.sendToBackground({
      type: 'MNA_SESSION_GET',
      sessionId: started.sessionId
    });
    assert.equal(still.session.endedAt, null);
    const active = await env.harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.equal(active.active.sessionId, started.sessionId);
    assert.equal((await listJoins(env))[0].statusText, 'Toplantı bitti, kayıt durduruldu.');
  } finally {
    env.harness.cleanup();
  }
});

test('Elle açılan Meet sekmesi bitişte kaydı durdurmaz ve katılım denetçisi kurmaz', async () => {
  const harness = createHarness({ contentSenderTabId: 1 });
  attachAlarms(harness);
  harness.loadServiceWorker();
  const calls = [];
  harness.sandbox.MNAJoin = {
    createMeetJoin() {
      calls.push('create');
      return {
        run() { calls.push('run'); },
        leave() { calls.push('leave'); },
        stop() { calls.push('stop'); }
      };
    },
    clickLeave() { calls.push('clickLeave'); }
  };
  harness.loadContentScript(1);
  try {
    const armed = await waitFor(() => calls.length > 0);
    assert.equal(armed, false);
    assert.deepEqual(calls, []);
    const started = await harness.sendToBackground({ type: 'MNA_SESSION_START' });
    assert.equal(started.ok, true);
    const leave = await harness.sendToTab(1, { type: 'MNA_SCHEDULED_LEAVE' });
    assert.equal(leave.ignored, true);
    assert.deepEqual(calls, []);
    const active = await harness.sendToBackground({ type: 'MNA_ACTIVE_SESSION' });
    assert.equal(active.active.sessionId, started.sessionId);
  } finally {
    harness.cleanup();
  }
});

test('Planlı sekme denetçiyi kurar; pencere kapanmışsa kurmaz', async () => {
  const harness = createHarness({ contentSenderTabId: 1 });
  attachAlarms(harness);
  harness.loadServiceWorker();
  const calls = [];
  harness.sandbox.MNAJoin = {
    createMeetJoin(options) {
      calls.push(options.deadlineAt);
      return {
        run() { calls.push('run'); },
        leave() { calls.push('leave'); },
        stop() { calls.push('stop'); }
      };
    }
  };
  const startAt = Date.now() + 60000;
  await harness.local.set({
    [Schedule.STORAGE_KEY]: [{
      id: 'join_content',
      url: 'https://meet.google.com/abc-defg-hij',
      meetingCode: 'abc-defg-hij',
      startAt: startAt,
      endAt: null,
      status: 'joining',
      statusText: 'Toplantı sekmesi açıldı.',
      tabId: 1,
      createdAt: startAt
    }]
  });
  harness.loadContentScript(1);
  try {
    const seen = await waitFor(() => calls.includes('run'));
    assert.equal(seen, true);
    assert.equal(calls[0], startAt + WINDOW_MS);
    const leave = await harness.sendToTab(1, { type: 'MNA_SCHEDULED_LEAVE' });
    assert.equal(leave.ok, true);
    assert.ok(calls.includes('leave'));
    const cancel = await harness.sendToTab(1, { type: 'MNA_SCHEDULED_CANCEL' });
    assert.equal(cancel.ok, true);
    assert.ok(calls.includes('stop'));
    const again = await harness.sendToTab(1, { type: 'MNA_BEGIN_SCHEDULED_JOIN', joinId: 'join_content', deadlineAt: startAt + WINDOW_MS });
    assert.equal(again.ok, false);
    assert.equal(calls.filter((item) => item === 'run').length, 1);
  } finally {
    harness.cleanup();
  }

  const closed = createHarness({ contentSenderTabId: 1 });
  attachAlarms(closed);
  closed.loadServiceWorker();
  const closedCalls = [];
  closed.sandbox.MNAJoin = {
    createMeetJoin() {
      closedCalls.push('create');
      return { run() {}, leave() {}, stop() {} };
    }
  };
  await closed.local.set({
    [Schedule.STORAGE_KEY]: [{
      id: 'join_late',
      url: 'https://meet.google.com/abc-defg-hij',
      meetingCode: 'abc-defg-hij',
      startAt: Date.now() - WINDOW_MS - 1000,
      endAt: null,
      status: 'joining',
      statusText: 'Toplantı sekmesi açıldı.',
      tabId: 1,
      createdAt: Date.now()
    }]
  });
  closed.loadContentScript(1);
  try {
    const expired = await waitFor(() => {
      const list = closed.local.store.get(Schedule.STORAGE_KEY);
      return list && list[0] && list[0].status === 'expired';
    });
    assert.equal(expired, true);
    assert.deepEqual(closedCalls, []);
    assert.equal(closed.local.store.get(Schedule.STORAGE_KEY)[0].statusText, 'Başlangıçtan 30 dakika geçti, katılınmadı.');
  } finally {
    closed.cleanup();
  }
});

test('Kayıt süren planlı sekme pencere geçse de bitişi izlemeye devam eder', async () => {
  const harness = createHarness({ contentSenderTabId: 1 });
  attachAlarms(harness);
  harness.loadServiceWorker();
  const calls = [];
  harness.sandbox.MNAJoin = {
    createMeetJoin() {
      calls.push('create');
      return { run() { calls.push('run'); }, leave() {}, stop() {} };
    }
  };
  await harness.local.set({
    [Schedule.STORAGE_KEY]: [{
      id: 'join_live',
      url: 'https://meet.google.com/abc-defg-hij',
      meetingCode: 'abc-defg-hij',
      startAt: Date.now() - WINDOW_MS - 5000,
      endAt: null,
      status: 'recording',
      statusText: 'Toplantıya katıldı, kayıt başladı.',
      tabId: 1,
      createdAt: Date.now()
    }]
  });
  harness.loadContentScript(1);
  try {
    const seen = await waitFor(() => calls.includes('run'));
    assert.equal(seen, true);
  } finally {
    harness.cleanup();
  }
});

test('Arayüz alanları ve yasak API’ler', () => {
  const html = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'popup', 'popup.html'), 'utf8');
  assert.match(html, /id="scheduleUrl"/);
  assert.match(html, /id="scheduleStart"/);
  assert.match(html, /id="scheduleEnd"/);
  assert.match(html, /id="scheduleList"/);
  assert.match(html, /Planlı katılım/);
  assert.match(html, /Katılımı kaydet/);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  assert.ok(manifest.permissions.includes('alarms'));
  assert.equal(manifest.permissions.includes('tabs'), false);
  assert.deepEqual(manifest.host_permissions, ['https://meet.google.com/*']);
  assert.deepEqual(manifest.content_scripts[0].js, [
    'src/content/transcript-engine.js',
    'src/content/meet-adapter.js',
    'src/content/meet-join.js',
    'src/content/content.js'
  ]);

  const files = [
    'extension/src/content/meet-join.js',
    'extension/src/content/content.js',
    'extension/src/background/service-worker.js',
    'extension/src/lib/schedule.js',
    'extension/src/popup/popup.js'
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.equal(/getUserMedia|getDisplayMedia|MediaRecorder|chrome\.power|requestKeepAwake/.test(src), false, rel);
  }
  const sw = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'background', 'service-worker.js'), 'utf8');
  assert.match(sw, /chrome\.alarms/);
  assert.match(sw, /handleSessionStart/);
  assert.match(sw, /handleSessionStop/);

  const content = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'content', 'content.js'), 'utf8');
  const scheduled = content.slice(
    content.indexOf('function startScheduledJoin'),
    content.indexOf('function handleMessage')
  );
  assert.match(scheduled, /MNA_SCHEDULED_MEETING_ENDED/);
  assert.equal(scheduled.includes('MNA_SESSION_STOP'), false);
});
