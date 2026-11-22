/**
 * Meet Not Alma Botu — content script orkestratörü.
 *
 * Sorumluluklar:
 *  - Meet altyazı bölgesini izlemek (MutationObserver),
 *  - Blokları okuyup saf motoru beslemek,
 *  - Kesinleşen satırları arka plana (background) toplu göndermek,
 *  - Popup/background ile mesajlaşmak.
 *
 * Bağımlılıklar (manifest'te bu dosyalardan ÖNCE yüklenmelidir):
 *  ../content/transcript-engine.js  -> globalThis.MNAEngine
 *  ../content/meet-adapter.js       -> globalThis.MNAAdapter
 *  ../content/meet-join.js          -> globalThis.MNAJoin
 *
 * ⚠️ manifest.json içindeki content_scripts.js şu sırayı içermelidir:
 *   ["src/content/transcript-engine.js", "src/content/meet-adapter.js", "src/content/meet-join.js", "src/content/content.js"]
 *
 * Background ile konuşma (lib/protocol.js ile ortak):
 *  içe  : { type: 'MNA_CAPTURE_STATE', active, startedAt, lines, sessionId }
 *  dışa  : { type: 'MNA_LINES_APPENDED', sessionId, lines }
 *          { type: 'MNA_CAPTURE_STATE_REQUEST' }   (yakalama durumu bildirimi)
 *          { type: 'MNA_ACTIVE_SESSION' }           (sekme yenilendiğinde devam)
 */
(function () {
  'use strict';

  const engineApi = typeof globalThis !== 'undefined' ? globalThis.MNAEngine : null;
  const adapterApi = typeof globalThis !== 'undefined' ? globalThis.MNAAdapter : null;
  const joinApi = typeof globalThis !== 'undefined' ? globalThis.MNAJoin : null;

  if (!engineApi || !adapterApi) {
    console.warn(
      '[MNA] transcript-engine.js / meet-adapter.js yüklenemedi; content script pasif.'
    );
    return;
  }

  // Varsayılan grace süresi 2500 ms: gerçek Meet testinde altyazının revizyonu
  // konuşmadan ~2 sn sonra geldiği için 1500 ms cümleleri ikiye bölüyordu.
  const GRACE_MS = 2500;
  const TICK_INTERVAL_MS = 500;
  const FLUSH_INTERVAL_MS = 1500;
  const OUTBOX_MAX_RETRIES = 20;
  const SCAN_DEBOUNCE_MS = 60;
  const SETTINGS_KEY = 'mna.settings';
  /**
   * blockState için sert üst sınır. Uzun toplantılarda görülen her altyazı
   * bloğu bir kayıt bıraktığı için bellek sınırsız büyüyebilir; bu sınır
   * aşıldığında en eski kayıtlar silinir.
   */
  const BLOCK_STATE_MAX = 800;

  const DEFAULT_SETTINGS = {
    graceMs: GRACE_MS,
    junkFilter: true,
    speakerFallback: 'Bilinmeyen',
    autoStartOnCc: false,
    autoStopWhenAlone: true,
    autoStopSilenceMin: 0,
  };

  const adapter = adapterApi.createMeetAdapter({ document, window });
  const engine = engineApi.createTranscriptEngine({
    graceMs: DEFAULT_SETTINGS.graceMs,
    junkFilter: DEFAULT_SETTINGS.junkFilter,
    speakerFallback: DEFAULT_SETTINGS.speakerFallback,
  });

  /** Kullanıcı ayarları (ayarlar sayfasından gelir; çalışma anında güncellenir). */
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  /**
   * Ayar değişiklik sayacı. Başlangıçtaki okuma (loadSettings) sonradan
   * çözülürse bayat veriyi yazmasın diye: okuma başlarkenki sayaç ile
   * karşılaştırılır.
   */
  let settingsRevision = 0;

  let captureActive = false;
  /** Yalnızca planlı katılım sekmesinde kurulan denetleyici. Elle açılan sekmelerde null kalır. */
  let scheduledJoin = null;
  let scheduledJoinDisabled = false;
  let startedAt = null;
  let sessionId = null;
  /** Otomatik başlatma için bu sayfada istek gönderildi mi? */
  let autoStartRequested = false;

  /** Kesinleşen ama background'a gönderilmemiş öğeler: { line, sessionId, failures }. */
  const pendingOutbox = [];
  /** Arka plana gönderim sürüyor mu? (aynı anda tek parti gönderilir.) */
  let outboxBusy = false;
  /** Sıfırlama (MNA_RESET) sırasında uçuşdaki yanıtı ayırt etmek için sayaç. */
  let outboxEpoch = 0;
  /** Blok anahtarı -> son görülen { speaker, text } (değişim tespiti için). */
  const blockState = new Map();
  /**
   * Üst sınır nedeniyle ana haritadan düşen blokların son değerleri.
   * Meet altyazı bölgesi binlerce bloğu birden tutabiliyor; ana harita
   * sınırına dayanınca düşen bloğun değeri burada tutulmazsa "değişmeyen blok
   * tekrar gönderilmez" davranışı bozulur ve mükerrer satır doğar. Bu
   * harita de sınırlıdır (en eski kayıt düşer).
   */
  const blockStateArchive = new Map();
  /**
   * Sekme yenilendikten sonra geri yüklenen satırların kümesi.
   * Anahtar: konuşmacı + '\u0000' + metin (ayırıcı belirsizliği önler).
   * Küme, eşleşen kayıt TÜKETİLENE kadar korunur; taramalar arasında yaşar
   * (bir tarama blokların hepsini göremeyebilir).
   */
  const resumeGuard = new Set();

  let currentRegion = null;
  let regionObserver = null;
  let bodyObserver = null;
  let tickTimer = null;
  let scanTimer = null;
  let outboxTimer = null;

  // ---------------------------------------------------------------- yardımcılar

  function nowMs() {
    return Date.now();
  }

  function createSessionId() {
    return 's' + nowMs().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** Metni karşılaştırma için normalize eder (fazla boşluklar tekilleşir). */
  function normalizeGuardText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Konuşmacıyı karşılaştırma için normalize eder.
   * Konuşmacı boşsa motorun kullandığı yedek ad kullanılır; böylece
   * "Bilinmeyen" ile saklanan geri yüklenen satır, adı olmayan bloğu eşler.
   */
  function normalizeGuardSpeaker(value) {
    const speaker = normalizeGuardText(value);
    return speaker || settings.speakerFallback || DEFAULT_SETTINGS.speakerFallback;
  }

  /** Koruma kümesinin anahtarı: konuşmacı + ayırıcı + metin. */
  function resumeGuardKey(speaker, text) {
    return normalizeGuardSpeaker(speaker) + '\u0000' + normalizeGuardText(text);
  }

  /**
   * Bir bloğun son görülen değerini döndürür (ana harita ya da arşiv).
   * @returns {{speaker: string, text: string}|undefined}
   */
  function getBlockState(key) {
    const hot = blockState.get(key);
    if (hot) {
      return hot;
    }
    return blockStateArchive.get(key);
  }

  /**
   * Bir bloğun son görülen değerini kaydeder.
   * Ana harita BLOCK_STATE_MAX kaydı aşarsa en eski kayıt arşive taşınır
   * (Map ekleme sırası korunur, yani baştan silinir).
   */
  function setBlockState(key, value) {
    blockState.set(key, value);
    blockStateArchive.delete(key);
    while (blockState.size > BLOCK_STATE_MAX) {
      const oldest = blockState.keys().next();
      if (oldest.done) {
        break;
      }
      const evicted = blockState.get(oldest.value);
      blockState.delete(oldest.value);
      if (!evicted) {
        continue;
      }
      blockStateArchive.set(oldest.value, evicted);
      while (blockStateArchive.size > BLOCK_STATE_MAX) {
        const archiveOldest = blockStateArchive.keys().next();
        if (archiveOldest.done) {
          break;
        }
        blockStateArchive.delete(archiveOldest.value);
      }
    }
  }

  /**
   * DOM'da artık bulunmayan blokların kayıtlarını siler.
   * Böylece blockState uzun toplantılarda sınırsız büyümez.
   */
  function pruneBlockState(seenKeys) {
    for (const key of Array.from(blockState.keys())) {
      if (!seenKeys.has(key)) {
        blockState.delete(key);
      }
    }
    for (const key of Array.from(blockStateArchive.keys())) {
      if (!seenKeys.has(key)) {
        blockStateArchive.delete(key);
      }
    }
  }

  /**
   * Arka plana mesaj gönderir.
   * @returns {Promise<{ok: boolean, error?: string}>} arka planın yanıtı
   */
  function sendToBackground(message) {
    return new Promise(function (resolve) {
      try {
        if (
          typeof chrome === 'undefined' ||
          !chrome ||
          !chrome.runtime ||
          typeof chrome.runtime.sendMessage !== 'function'
        ) {
          resolve({ ok: false, error: 'Arka plana bağlanılamadı.' });
          return;
        }
        const maybePromise = chrome.runtime.sendMessage(message, function (response) {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ ok: false, error: lastError.message || 'Mesaj gönderilemedi.' });
            return;
          }
          if (!response) {
            resolve({ ok: false, error: 'Arka plan yanıt vermedi.' });
            return;
          }
          resolve(response);
        });
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then(
            function (response) {
              if (response) {
                resolve(response);
              }
            },
            function () {
              resolve({ ok: false, error: 'Mesaj gönderilemedi.' });
            }
          );
        }
      } catch (err) {
        console.warn('[MNA] background mesajı gönderilemedi —', err);
        resolve({ ok: false, error: 'Mesaj gönderilemedi.' });
      }
    });
  }

  function enqueueLines(lines) {
    if (!lines || !lines.length) {
      return;
    }
    const batchSessionId = sessionId || null;
    for (const line of lines) {
      pendingOutbox.push({
        line: line,
        sessionId: batchSessionId,
        failures: 0,
      });
    }
    scheduleOutbox();
  }

  function scheduleOutbox() {
    if (outboxTimer) {
      return;
    }
    outboxTimer = setTimeout(function () {
      outboxTimer = null;
      flushOutbox();
    }, FLUSH_INTERVAL_MS);
  }

  function resetOutbox() {
    outboxEpoch += 1;
    pendingOutbox.length = 0;
    if (outboxTimer) {
      clearTimeout(outboxTimer);
      outboxTimer = null;
    }
  }

  /** Verilen öğe referanslarını pendingOutbox kuyruğundan çıkarır. */
  function removeOutboxItems(itemsToRemove) {
    if (!itemsToRemove || !itemsToRemove.length) {
      return;
    }
    const dropSet = new Set(itemsToRemove);
    for (let i = pendingOutbox.length - 1; i >= 0; i -= 1) {
      if (dropSet.has(pendingOutbox[i])) {
        pendingOutbox.splice(i, 1);
      }
    }
  }

  /**
   * Biriken satırları arka plana gönderir.
   * Aynı oturuma ait ardışık öğeler birlikte gönderilir; her öğe kendi hata
   * sayacını ve oturum kimliğini taşır.
   */
  function flushOutbox() {
    if (!pendingOutbox.length || outboxBusy) {
      return;
    }
    if (outboxTimer) {
      clearTimeout(outboxTimer);
      outboxTimer = null;
    }
    const epoch = outboxEpoch;
    const targetSessionId = pendingOutbox[0].sessionId;
    const batch = [];
    for (let i = 0; i < pendingOutbox.length; i += 1) {
      if (pendingOutbox[i].sessionId !== targetSessionId) {
        break;
      }
      batch.push(pendingOutbox[i]);
    }
    const lines = batch.map(function (item) {
      return item.line;
    });
    const payload = { type: 'MNA_LINES_APPENDED', lines: lines };
    // Oturum id background tarafından üretilir; bilinmiyorsa boş bırakılır
    // (background aktif oturuma düşer).
    if (targetSessionId) {
      payload.sessionId = targetSessionId;
    }
    outboxBusy = true;
    sendToBackground(payload).then(function (response) {
      outboxBusy = false;
      if (epoch !== outboxEpoch) {
        if (pendingOutbox.length) {
          flushOutbox();
        }
        return;
      }
      if (!response || response.ok === false) {
        const reason = (response && response.error) || 'bilinmeyen hata';
        // "Aktif oturum yok/okunamadı" ve geçersiz eklenti bağlamı kalıcıdır.
        const contextDead = /context invalidated/i.test(reason);
        const permanent =
          contextDead ||
          /aktif oturum bulunamadı|aktif oturum okunamadı|oturum bulunamadı/i.test(reason);
        if (permanent) {
          removeOutboxItems(batch);
          if (!contextDead && pendingOutbox.length) {
            scheduleOutbox();
          }
          return;
        }
        const expired = [];
        for (const item of batch) {
          item.failures += 1;
          if (item.failures >= OUTBOX_MAX_RETRIES) {
            expired.push(item);
          }
        }
        if (expired.length) {
          console.warn(
            '[MNA] Satırlar arka plana kaydedilemedi, ' +
              OUTBOX_MAX_RETRIES +
              ' ardışık deneme sonrası bırakılıyor:',
            reason
          );
          removeOutboxItems(expired);
        }
        if (pendingOutbox.length) {
          if (!expired.length) {
            console.warn('[MNA] Satırlar arka plana kaydedilemedi, tekrar denenecek:', reason);
          }
          // Kalan satırlar kuyrukta kalır; bir sonraki turda tekrar gönderilir.
          scheduleOutbox();
        }
        return;
      }
      // Başarılı: gönderilen öğeleri kuyruktan düş.
      removeOutboxItems(batch);
      // Uçuş sırasında kuyruğa yeni satır veya başka oturum paketi eklendiyse hemen gönder.
      if (pendingOutbox.length) {
        flushOutbox();
      }
    });
  }

  // ------------------------------------------------------------------ DOM izleme

  /**
   * Ayarları motora uygular. Satırlara dokunmaz; yalnızca ileride gelen
   * metinlerin işlenme biçimini değiştirir.
   */
  function applySettings() {
    try {
      engine.configure({
        graceMs: settings.graceMs,
        junkFilter: settings.junkFilter,
        speakerFallback: settings.speakerFallback,
      });
    } catch (err) {
      console.warn('[MNA] ayarlar uygulanamadı —', err);
    }
  }

  /** Ayarlar sayfasındaki değerleri okur ve motora uygular. */
  function loadSettings() {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        return Promise.resolve(settings);
      }
      const revision = settingsRevision;
      return chrome.storage.local
        .get(SETTINGS_KEY)
        .then(function (result) {
          if (revision !== settingsRevision) {
            // Okuma sürerken ayarlar değişti: bayat veri uygulanmamalı.
            return settings;
          }
          const stored = (result && result[SETTINGS_KEY]) || {};
          settings = Object.assign({}, DEFAULT_SETTINGS, stored);
          applySettings();
          return settings;
        })
        .catch(function (err) {
          console.warn('[MNA] ayarlar okunamadı —', err);
          return settings;
        });
    } catch (err) {
      console.warn('[MNA] ayarlar okunamadı —', err);
      return Promise.resolve(settings);
    }
  }

  /** Ayar sayfası değiştiğinde motoru güncelle. */
  function watchSettings() {
    try {
      if (!chrome || !chrome.storage || !chrome.storage.onChanged) {
        return;
      }
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local' || !changes || !changes[SETTINGS_KEY]) {
          return;
        }
        settingsRevision += 1;
        const stored = changes[SETTINGS_KEY].newValue || {};
        settings = Object.assign({}, DEFAULT_SETTINGS, stored);
        applySettings();
      });
    } catch (err) {
      console.warn('[MNA] ayar dinleyicisi kurulamadı —', err);
    }
  }

  /**
   * "Meet'te altyazılar açıldığında kaydı otomatik başlat" ayarı.
   * Altyazı bölgesi göründüğünde arka plana bildirilir; oturumu arka plan
   * açar (kimlik ve başlangıç zamanı orada üretilir).
   *
   * Kilit (autoStartRequested) yalnızca altyazı bölgesi KAYBOLDUĞUNDA
   * bırakılır: kullanıcı CC'yi kapatıp yeniden açtığında yeni bir oturum
   * otomatik başlayabilsin. Kullanıcı kaydı elle durdurduysa kilit yerinde
   * kalır; eklenti kendi kendine yeniden başlamaz.
   */
  function maybeAutoStart() {
    if (captureActive || !settings.autoStartOnCc) {
      return;
    }
    let region = null;
    try {
      region = adapter.findCaptionsRegion();
    } catch (err) {
      return;
    }
    if (!region) {
      // Altyazı bölgesi yok (kullanıcı CC'yi kapattı): kilidi bırak ki
      // CC yeniden açıldığında otomatik başlatma çalışabilsin.
      autoStartRequested = false;
      return;
    }
    if (autoStartRequested) {
      return;
    }
    autoStartRequested = true;
    console.info('[MNA] Meet altyazıları algılandı; kayıt otomatik başlatılıyor.');
    sendToBackground({ type: 'MNA_CAPTURE_STATE_REQUEST' });
  }

  /** Toplantı bitiş/ayrılma ekranı görününce kayıt bir kez durdurulur. */
  let meetingEndStopSent = false;
  let lastEndCheckAt = 0;
  /** Altyazı metninde son değişiklik (uzun tek konuşmalar da etkinlik sayılır). */
  let lastActivityAt = 0;
  let aloneWatcher = null;

  function markActivity() {
    lastActivityAt = nowMs();
  }

  /** «N dakikadır hiç konuşma gelmedi» ayarı açık ve süre doldu mu? */
  function silenceExceeded() {
    const minutes = Number(settings.autoStopSilenceMin) || 0;
    if (minutes <= 0 || !captureActive || !lastActivityAt) {
      return false;
    }
    return nowMs() - lastActivityAt >= minutes * 60 * 1000;
  }

  function resetAutoStopWatchers() {
    markActivity();
    aloneWatcher = null;
  }
  const END_CHECK_INTERVAL_MS = 2000;
  /** Görüşme arayüzü bu kadar ardışık kontrolde yoksa (≈6 sn) kayıt durur. */
  const OUT_OF_CALL_CHECKS = 3;
  let outOfCallChecks = 0;

  /**
   * Elle başlatılan kayıtta da, toplantıdan ayrılınca ("Toplantıdan ayrıldınız"),
   * çıkarılınca ya da arama bitince kayıt durur. Planlı katılım sekmesinde bu işi
   * kendi denetleyicisi yapar. Altyazı ve yan panel metni bitiş sayılmaz.
   */
  function checkMeetingEnded() {
    if (!captureActive || meetingEndStopSent || scheduledJoin) {
      return;
    }
    const at = nowMs();
    if (at - lastEndCheckAt < END_CHECK_INTERVAL_MS) {
      return;
    }
    lastEndCheckAt = at;
    if (!joinApi || typeof joinApi.meetingEndReason !== 'function') {
      return;
    }
    let reason = null;
    try {
      reason = joinApi.meetingEndReason(document);
    } catch (err) {
      return;
    }
    if (!reason && settings.autoStopWhenAlone !== false && typeof joinApi.createAloneWatcher === 'function') {
      try {
        if (!aloneWatcher) {
          aloneWatcher = joinApi.createAloneWatcher({ now: nowMs });
        }
        if (aloneWatcher.update(document)) {
          reason = 'alone';
        }
      } catch (err) {
        /* sayaç hatası kaydı etkilemez */
      }
    }
    if (!reason && silenceExceeded()) {
      reason = 'silence';
    }
    if (!reason && typeof joinApi.outOfCall === 'function') {
      // Bitiş metni tanınmasa da görüşme arayüzü gittiyse (Ayrıl düğmesi yok,
      // «Yeniden katıl» var) birkaç ardışık kontrolde ayrılmış sayılır.
      let gone = false;
      try {
        gone = joinApi.outOfCall(document) === true;
      } catch (err) {
        gone = false;
      }
      outOfCallChecks = gone ? outOfCallChecks + 1 : 0;
      if (outOfCallChecks >= OUT_OF_CALL_CHECKS) {
        reason = 'out-of-call';
      }
    }
    if (!reason) {
      return;
    }
    meetingEndStopSent = true;
    console.info('[MNA] Toplantı bitti (' + reason + '); kayıt durduruluyor.');
    sendToBackground({ type: 'MNA_SESSION_STOP' });
  }

  function scanRegion() {
    if (!captureActive) {
      return;
    }
    const region = adapter.findCaptionsRegion();
    if (!region) {
      detachRegion();
      blockState.clear();
      blockStateArchive.clear();
      // Otomatik başlayan kayıt, altyazı bölgesi kapanınca durur.
      // Arka plan oturumu kapatır (endedAt); elle kayıtta kilit yoktur.
      if (settings.autoStartOnCc && autoStartRequested) {
        autoStartRequested = false;
        sendToBackground({ type: 'MNA_SESSION_STOP' });
      }
      return;
    }
    if (region !== currentRegion) {
      attachRegion(region);
    }

    const blocks = adapter.collectBlocks(region);
    /** Bu taramada görülen blok anahtarları (budama için). */
    const seenKeys = new Set();
    for (const block of blocks) {
      const key = adapter.getBlockKey(block);
      let data = null;
      try {
        data = adapter.readBlock(block);
      } catch (err) {
        console.warn('[MNA] blok okunamadı —', err);
        continue;
      }
      if (!data) {
        continue;
      }
      seenKeys.add(key);
      const previous = getBlockState(key);
      const guardKey = resumeGuardKey(data.speaker, data.text);
      if (
        previous &&
        previous.speaker === data.speaker &&
        previous.text === data.text
      ) {
        // Değişiklik yok: motora tekrar gönderilmez (junk/zaman damgası kazancı yok).
        // Kullanılmayan koruma kaydı da temizlenir (set şişmesin).
        resumeGuard.delete(guardKey);
        continue;
      }
      if (resumeGuard.has(guardKey)) {
        // Sekme yenilenmişti; bu blok geri yüklenen satırlardan biri.
        // Kayıt TÜKETİLİR: koruma yalnızca bir gözlemde geçerli olur,
        // sonraki taramada aynı blok yeniden kaydedilmez.
        resumeGuard.delete(guardKey);
        setBlockState(key, { speaker: data.speaker, text: data.text });
        continue;
      }
      setBlockState(key, { speaker: data.speaker, text: data.text });
      markActivity();
      try {
        const result = engine.observe({
          key: key,
          speaker: data.speaker,
          text: data.text,
        });
        enqueueLines(result.committed);
        // Meet, kesinleşmiş bir satırın metnini sonradan revize edebilir.
        // Motor bu revizyonu `updated` içinde, AYNI id ile döndürür; satır
        // burada TEKRAR gönderilir ki arka plan aynı id'yi güncellesin
        // (yeni satır açılmaz).
        enqueueLines(result.updated);
      } catch (err) {
        console.warn('[MNA] motor observe hatası —', err);
      }
    }
    // blockState sınırsız büyümesin: DOM'da artık bulunmayan blokların
    // kayıtları silinir. (Görülen blokların kayıtları korunur; böylece
    // "değişmeyen blok tekrar gönderilmez" davranışı bozulmaz.)
    pruneBlockState(seenKeys);
  }

  /**
   * Sekme arka plandayken (başka sekme önde, pencere küçük ya da örtülü) Chrome
   * sayfanın zamanlayıcılarını dakikada bire düşürür; setTimeout ile planlanan
   * tarama dakikada bir çalışır, satırların zaman damgaları bozulur ve metin
   * toplu gelir. MutationObserver geri çağrıları ise zamanlayıcıya bağlı
   * değildir: sayfa gizliyken taramayı doğrudan burada yapıp motoru da ilerletiriz.
   */
  let lastHiddenScanAt = 0;
  const HIDDEN_SCAN_MIN_GAP_MS = 300;

  function onPageMutation() {
    let hidden = false;
    try {
      hidden = document.hidden === true;
    } catch (err) {
      hidden = false;
    }
    if (hidden) {
      const at = nowMs();
      if (at - lastHiddenScanAt >= HIDDEN_SCAN_MIN_GAP_MS) {
        lastHiddenScanAt = at;
        try {
          scanRegion();
          if (captureActive) {
            enqueueLines(engine.tick().committed);
            checkMeetingEnded();
          }
        } catch (err) {
          console.warn('[MNA] arka plan taraması hatası —', err);
        }
      }
    }
    // Sondaki değişikliği kaçırmamak için normal planlı tarama da kalır.
    scheduleScan();
  }

  function scheduleScan(delay) {
    if (scanTimer) {
      return;
    }
    scanTimer = setTimeout(function () {
      scanTimer = null;
      try {
        scanRegion();
      } catch (err) {
        console.warn('[MNA] tarama hatası —', err);
      }
    }, delay === undefined ? SCAN_DEBOUNCE_MS : delay);
  }

  function attachRegion(region) {
    detachRegion();
    currentRegion = region;
    try {
      regionObserver = new MutationObserver(function () {
        onPageMutation();
      });
      regionObserver.observe(region, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (err) {
      console.warn('[MNA] bölge gözlemcisi kurulamadı —', err);
      regionObserver = null;
    }
  }

  function detachRegion() {
    if (regionObserver) {
      try {
        regionObserver.disconnect();
      } catch (err) {
        /* yoksay */
      }
      regionObserver = null;
    }
    currentRegion = null;
  }

  function startBodyObserver() {
    if (bodyObserver || !document.body) {
      return;
    }
    try {
      bodyObserver = new MutationObserver(function () {
        if (!captureActive) {
          // Kayıt kapalıyken de altyazı bölgesini izle: açılır açılmaz
          // otomatik başlatma ayarı devreye girsin.
          maybeAutoStart();
          return;
        }
        onPageMutation();
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    } catch (err) {
      console.warn('[MNA] gövde gözlemcisi kurulamadı —', err);
      bodyObserver = null;
    }
  }

  // ------------------------------------------------------------------- yakalama

  /**
   * Meet'in kendi altyazı (CC) düğmesini bulur.
   * Önce tam etiketli düğmeler, sonra jsname, sonra genel "caption" araması.
   * @returns {Element|null}
   */
  function findCaptionsToggleButton() {
    if (!document || !document.querySelector) {
      return null;
    }
    const exactSelectors = [
      'button[aria-label="Turn on captions"]',
      'button[aria-label="Turn off captions"]',
    ];
    const genericSelectors = [
      'button[jsname="r4nke"]',
      'button[aria-label*="caption" i]',
      'button[aria-label*="altyaz" i]',
      'button[aria-label*="sous-titre" i]',
      'button[aria-label*="untertitel" i]',
      '[role="button"][aria-label*="caption" i]',
    ];

    const candidates = [];
    for (const selector of exactSelectors.concat(genericSelectors)) {
      let found = [];
      try {
        found = Array.prototype.slice.call(document.querySelectorAll(selector));
      } catch (err) {
        console.warn('[MNA] CC düğmesi araması başarısız —', selector, err);
        continue;
      }
      for (const element of found) {
        // Altyazı bölgesinin İÇİNDEKİ düğmeler (ayarlar, kapat) CC düğmesi değildir.
        const region = adapter.findCaptionsRegion();
        if (region && region.contains && region.contains(element)) {
          continue;
        }
        candidates.push(element);
      }
      if (candidates.length) {
        break;
      }
    }
    return candidates.length ? candidates[0] : null;
  }

  const CAPTION_FOLLOWUP_MS = [700, 1500, 2600];

  /**
   * Altyazı kapalıyken Meet'in menüsünü açıp çıkan «Altyazıları aç» öğesine kendisi
   * basar (popup'taki düğmeye ikinci kez basmak gerekmez).
   * @returns {boolean} true: bu akış işi üstlendi; false: eski yola düşülür
   */
  function openCaptionsFlow() {
    if (!joinApi || typeof joinApi.captionsEntry !== 'function') {
      return false;
    }
    const entry = joinApi.captionsEntry(document);
    if (!entry || entry.kind === 'on' || !entry.el || typeof entry.el.click !== 'function') {
      return false;
    }
    const flow = { finished: false, morePressed: entry.kind === 'more' };
    entry.el.click();
    if (entry.kind === 'toggle') {
      return true;
    }
    CAPTION_FOLLOWUP_MS.forEach(function (delay) {
      setTimeout(function () {
        if (flow.finished) {
          return;
        }
        try {
          const next = joinApi.captionsEntry(document);
          if (!next || next.kind === 'on') {
            flow.finished = !!next;
            return;
          }
          if (next.kind === 'toggle') {
            flow.finished = true;
            next.el.click();
          } else if (next.kind === 'more' && !flow.morePressed) {
            flow.morePressed = true;
            next.el.click();
          }
        } catch (err) {
          console.warn('[MNA] altyazı menüsü işlenemedi —', err);
        }
      }, delay);
    });
    return true;
  }

  /**
   * Yakalama durumunu açar/kapatır.
   * @param {boolean} active
   * @param {{startedAt?: number, sessionId?: string, notify?: boolean, isRestore?: boolean}} [opts]
   *   startedAt/sessionId: background tarafından (yetkili) gönderilirse alınır.
   *   notify: true ise background'a durum bildirimi gönderilir.
   *   isRestore: true ise bu açılış bir GERİ YÜKLEMEDİR; yeniden başlatma
   *     koruma kümesi temizlenmez (geri yüklenen satırlar korunur).
   */
  function setCaptureActive(active, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const next = !!active;
    const notify = options.notify !== false;
    const isRestore = options.isRestore === true;

    if (next) {
      if (Number.isFinite(options.startedAt)) {
        startedAt = options.startedAt;
      }
      if (!startedAt) {
        startedAt = nowMs();
      }
      if (typeof options.sessionId === 'string' && options.sessionId) {
        sessionId = options.sessionId;
      }
      if (!sessionId) {
        sessionId = createSessionId();
      }
      if (!isRestore) {
        // Gerçekten YENİ bir kayıt başlıyor: geri yükleme koruması geçersiz.
        resumeGuard.clear();
      }
      captureActive = true;
      startBodyObserver();
      meetingEndStopSent = false;
      outOfCallChecks = 0;
      resetAutoStopWatchers();
      if (!tickTimer) {
        tickTimer = setInterval(function () {
          try {
            enqueueLines(engine.tick().committed);
          } catch (err) {
            console.warn('[MNA] tick hatası —', err);
          }
          checkMeetingEnded();
        }, TICK_INTERVAL_MS);
      }
      scheduleScan(0);
      if (notify) {
        // Background'a "durum nedir?" sorusu: oturum id ve başlangıç zamanı
        // background tarafında da doğrulanır (MNA_CAPTURE_STATE geri gelir).
        sendToBackground({ type: 'MNA_CAPTURE_STATE_REQUEST' });
      }
    } else {
      captureActive = false;
      // NOT: autoStartRequested BURADA sıfırlanmaz. Kullanıcı kaydı elle
      // durdurduysa kilit yerinde kalmalı; aksi halde sayfadaki sonraki
      // değişimde eklenti kullanıcı istemeden İKİNCİ bir oturum açar.
      // Kilit, altyazı bölgesi kaybolduğunda bırakılır.
      // Durdurma sonrası artık geçerli olmayan geri yükleme koruması temizlenir.
      resumeGuard.clear();
      // Kapanmadan önce bekleyen satırları kesinleştirip gönder.
      try {
        enqueueLines(engine.flush().committed);
      } catch (err) {
        console.warn('[MNA] flush hatası —', err);
      }
      flushOutbox();
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      // Durdurma bildirimi yapılmaz: background zaten durdurmanın sahibidir ve
      // bildirim, aktif oturum hâlâ kayıtlıysa "active:true" geri yankılanıp
      // kaydı yeniden başlatabilirdi.
    }
  }

  function getStatus() {
    const committed = engine.getLines();
    const pending = engine.getPending();
    const last = committed.length ? committed[committed.length - 1] : null;
    const region = adapter.findCaptionsRegion();
    return {
      ok: true,
      capture: {
        active: captureActive,
        startedAt: startedAt,
        lineCount: committed.length + pending.length,
        lastLineAt: last ? last.endedAt : null,
      },
      captions: {
        // "Bölge var mı?" -> Meet'te CC açık mı sorusu.
        regionFound: !!region,
        // "Okunabilir blok var mı?" -> döküm alınabiliyor mu sorusu.
        detected: adapter.isCaptionsLikelyOn(region),
      },
      meeting: adapter.getMeetingInfo(),
    };
  }

  // --------------------------------------------------------- planlı katılım

  /**
   * Katılma tıklamaları meet-join.js içindedir. Burada yalnızca mevcut
   * kayıt mesajlarına (MNA_SCHEDULED_CAPTURE_START / MNA_SESSION_STOP) bağlanır.
   * Elle açılan sekmelerde çağrılmaz.
   */
  /** Planlı katılım tanılama günlüğüne olay gönderir (sonucu beklenmez). */
  function sendJoinTrace(joinId, kind, data) {
    if (!joinId) {
      return;
    }
    try {
      const sent = sendToBackground({
        type: 'MNA_JOIN_TRACE',
        joinId: joinId,
        kind: String(kind || 'event'),
        data: data === undefined ? null : data,
      });
      if (sent && typeof sent.catch === 'function') {
        sent.catch(function () {});
      }
    } catch (err) {
      /* günlük isteğe bağlıdır */
    }
  }

  function startScheduledJoin(payload) {
    if (scheduledJoinDisabled || scheduledJoin) {
      return !!scheduledJoin;
    }
    if (!joinApi || typeof joinApi.createMeetJoin !== 'function') {
      sendJoinTrace(payload && payload.joinId, 'start-failed', { reason: 'katılım modülü yok' });
      return false;
    }
    if (!payload || !payload.joinId) {
      return false;
    }
    sendJoinTrace(payload.joinId, 'start', {
      path: typeof location !== 'undefined' && location ? String(location.pathname || '') : '',
      readyState: String(document.readyState || ''),
      hidden: document.hidden === true,
    });
    var deadline = Number(payload.deadlineAt);
    if (!Number.isFinite(deadline)) {
      var startAt = Number(payload.startAt);
      deadline = Number.isFinite(startAt) ? startAt + (30 * 60 * 1000) : NaN;
    }
    var joinId = payload.joinId;
    var controller;
    try {
      controller = joinApi.createMeetJoin({
        document: document,
        deadlineAt: deadline,
        pollMs: 3000,
        autoStopWhenAlone: settings.autoStopWhenAlone !== false,
        reopen: function () {
          // Bekleme odası zaman aşımı ya da ana sayfaya düşüş: toplantıya geri dön.
          if (payload.url && typeof location !== 'undefined' && location && typeof location.assign === 'function') {
            location.assign(payload.url);
          }
        },
        shouldEnd: function () {
          return silenceExceeded() ? 'silence' : null;
        },
        onCaptionsReady: function () {
          return sendToBackground({
            type: 'MNA_SCHEDULED_CAPTURE_START',
            joinId: joinId
          });
        },
        onMeetingEnded: function (info) {
          var reason = info && info.reason ? info.reason : 'ended';
          return sendToBackground({
            type: 'MNA_SCHEDULED_MEETING_ENDED',
            joinId: joinId,
            reason: reason
          });
        },
        onTrace: function (event) {
          sendJoinTrace(joinId, event && event.kind, event && event.data);
        },
        onStatus: function (info) {
          return sendToBackground({
            type: 'MNA_SCHEDULE_STATUS',
            joinId: joinId,
            phase: info && info.phase,
            reason: info && info.reason
          });
        }
      });
    } catch (err) {
      console.warn('[MNA] Planlı katılım başlatılamadı —', err);
      return false;
    }
    scheduledJoin = controller;
    try {
      if (controller && typeof controller.run === 'function') {
        controller.run();
      }
    } catch (err) {
      console.warn('[MNA] Planlı katılım döngüsü başlamadı —', err);
    }
    return true;
  }

  // ----------------------------------------------------------------- mesajlaşma

  function handleMessage(message, sendResponse) {
    if (!message || typeof message !== 'object' || !message.type) {
      sendResponse({ ok: false, error: 'geçersiz mesaj' });
      return false;
    }

    switch (message.type) {
      case 'MNA_STATUS': {
        try {
          sendResponse(getStatus());
        } catch (err) {
          console.warn('[MNA] status hatası —', err);
          sendResponse({ ok: false, error: 'durum alınamadı' });
        }
        return false;
      }

      case 'MNA_GET_LINES': {
        try {
          enqueueLines(engine.flush().committed);
          sendResponse({ ok: true, lines: engine.getLines() });
        } catch (err) {
          console.warn('[MNA] get lines hatası —', err);
          sendResponse({ ok: false, error: 'satırlar alınamadı' });
        }
        return false;
      }

      case 'MNA_SET_CAPTURE': {
        try {
          setCaptureActive(!!message.active, {
            startedAt: message.startedAt,
            sessionId: message.sessionId,
            notify: true,
          });
          // "Kaydı başlat" altyazıyı da açsın: altyazı bölgesi yoksa Meet'in
          // menüsünden açmayı dene (başarısızsa kullanıcı düğmeyle açar).
          if (message.active && !scheduledJoin && !adapter.findCaptionsRegion()) {
            try {
              openCaptionsFlow();
            } catch (err) {
              console.warn('[MNA] altyazı kendiliğinden açılamadı —', err);
            }
          }
          sendResponse({
            ok: true,
            active: captureActive,
            startedAt: startedAt,
          });
        } catch (err) {
          console.warn('[MNA] capture ayarlanamadı —', err);
          sendResponse({ ok: false, error: 'kayıt durumu değiştirilemedi' });
        }
        return false;
      }

      case 'MNA_RESET': {
        try {
          engine.reset();
          blockState.clear();
          blockStateArchive.clear();
          resumeGuard.clear();
          resetOutbox();
          sendResponse({ ok: true });
        } catch (err) {
          console.warn('[MNA] sıfırlama hatası —', err);
          sendResponse({ ok: false, error: 'sıfırlanamadı' });
        }
        return false;
      }

      case 'MNA_FLUSH': {
        try {
          const flushed = engine.flush().committed;
          enqueueLines(flushed);
          sendResponse({ ok: true, lines: flushed });
        } catch (err) {
          console.warn('[MNA] flush hatası —', err);
          sendResponse({ ok: false, error: 'kesinleştirilemedi' });
        }
        return false;
      }

      case 'MNA_CAPTURE_STATE': {
        // Background kayıt durumunu bildirir (sekme yenilendiğinde hatırlatma).
        // Geri bildirim GÖNDERİLMEZ; aksi halde döngü oluşur.
        try {
          if (message.active) {
            if (Array.isArray(message.lines) && message.lines.length) {
              const restored = engine.restore(message.lines);
              if (!restored.ok) {
                console.warn('[MNA] satırlar geri yüklenemedi —', restored.error);
              }
              // blockState SİLİNMEZ: silinirse aynı bloklar yeniden gözlenir ve
              // mükerrer satır oluşur. Sekme yenilenmişse DOM elemanları zaten
              // yenidir ve yeni anahtarlarla gözlenirler.
              // Geri yüklenen HER satır koruma kümesine eklenir: yalnızca son
              // satırı korumak, yenilemeden sonra daha önceki satırların tekrar
              // kaydedilmesine (mükerrer satır) yol açardı.
              resumeGuard.clear();
              message.lines.forEach(function (line) {
                if (!line || typeof line !== 'object') {
                  return;
                }
                const text = normalizeGuardText(line.text);
                if (!text) {
                  return;
                }
                resumeGuard.add(resumeGuardKey(line.speaker, text));
              });
            }
            setCaptureActive(true, {
              startedAt: message.startedAt,
              sessionId: message.sessionId,
              notify: false,
              isRestore: true,
            });
          } else {
            setCaptureActive(false, { notify: false });
          }
          // Yanıt verilmezse gönderen taraf "port closed" hatası alır.
          sendResponse({ ok: true, active: captureActive, startedAt: startedAt });
        } catch (err) {
          console.warn('[MNA] capture state işlenemedi —', err);
          sendResponse({ ok: false, error: 'capture state işlenemedi' });
        }
        return false;
      }

      case 'MNA_BEGIN_SCHEDULED_JOIN': {
        try {
          const started = startScheduledJoin(message);
          sendResponse({ ok: started });
        } catch (err) {
          console.warn('[MNA] planlı katılım başlatılamadı —', err);
          sendResponse({ ok: false, error: 'Planlı katılım başlatılamadı.' });
        }
        return false;
      }

      case 'MNA_SCHEDULED_LEAVE': {
        if (!scheduledJoin) {
          sendResponse({ ok: true, ignored: true });
          return false;
        }
        try {
          scheduledJoin.leave();
          sendResponse({ ok: true });
        } catch (err) {
          console.warn('[MNA] toplantıdan ayrılınamadı —', err);
          sendResponse({ ok: false, error: 'Toplantıdan ayrılınamadı.' });
        }
        return false;
      }

      case 'MNA_SCHEDULED_CANCEL': {
        scheduledJoinDisabled = true;
        if (scheduledJoin && typeof scheduledJoin.stop === 'function') {
          try {
            scheduledJoin.stop();
          } catch (err) {
            /* yoksay */
          }
        }
        scheduledJoin = null;
        sendResponse({ ok: true });
        return false;
      }

      case 'MNA_TOGGLE_CAPTIONS': {
        // Meet'in kendi altyazı düğmesine bas (eklenti CC'yi yönetmez).
        try {
          // Meet'te CC çoğu kez iki adımlıdır (menü → öğe): tek basışta bitir.
          if (openCaptionsFlow()) {
            sendResponse({ ok: true });
            return false;
          }
          const button = findCaptionsToggleButton();
          if (!button) {
            sendResponse({
              ok: false,
              error: 'Meet altyazı düğmesi bulunamadı.',
            });
            return false;
          }
          button.click();
          sendResponse({ ok: true });
        } catch (err) {
          console.warn('[MNA] altyazı düğmesi çalıştırılamadı —', err);
          sendResponse({ ok: false, error: 'Altyazı düğmesi çalıştırılamadı.' });
        }
        return false;
      }

      default:
        sendResponse({ ok: false, error: 'bilinmeyen mesaj tipi' });
        return false;
    }
  }

  if (
    typeof chrome !== 'undefined' &&
    chrome &&
    chrome.runtime &&
    chrome.runtime.onMessage &&
    typeof chrome.runtime.onMessage.addListener === 'function'
  ) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      try {
        return handleMessage(message, sendResponse);
      } catch (err) {
        console.warn('[MNA] mesaj işlenemedi —', err);
        try {
          sendResponse({ ok: false, error: 'mesaj işlenemedi' });
        } catch (ignored) {
          /* yoksay */
        }
        return false;
      }
    });
  }

  // --------------------------------------------------------- geliştirici kolaylığı

  window.__mnaGetLines = function () {
    try {
      return engine.getLines();
    } catch (err) {
      console.warn('[MNA] satırlar okunamadı —', err);
      return [];
    }
  };

  window.__mnaReset = function () {
    try {
      engine.reset();
      blockState.clear();
      blockStateArchive.clear();
      resumeGuard.clear();
      resetOutbox();
      return true;
    } catch (err) {
      console.warn('[MNA] sıfırlanamadı —', err);
      return false;
    }
  };

  /** Test/debug kancası: anlık tarama yapar (mutasyon beklenmez). */
  window.__mnaScan = function () {
    try {
      scanRegion();
      return true;
    } catch (err) {
      console.warn('[MNA] tarama hatası —', err);
      return false;
    }
  };

  /** Test/debug kancası: blockState kayıt sayısı (bellek sınırı denetimi). */
  window.__mnaBlockStateSize = function () {
    return blockState.size;
  };

  /** Test/debug kancası: izlenen toplam blok sayısı (ana harita + arşiv). */
  window.__mnaTrackedBlockSize = function () {
    return blockState.size + blockStateArchive.size;
  };

  // -------------------------------------------------------------------- unload

  function finalizeOnUnload() {
    try {
      enqueueLines(engine.flush().committed);
      flushOutbox();
    } catch (err) {
      console.warn('[MNA] unload flush hatası —', err);
    }
  }

  // Yalnızca gerçek "sayfadan ayrılma" sinyalleri dinlenir.
  //
  // ⚠️ `visibilitychange` BİLEREK KULLANILMAZ: başka sekmeye geçmek veya
  // pencereyi küçültmek de bu olayı tetikler. O an bekleyen satırlar
  // kesinleştirilirse Meet altyazıyı henüz revize etmemiş olur; Meet sonra
  // revizyonu gönderdiğinde artık birleştirilemez ve MÜKERRER SATIR oluşur.
  // Bu, gerçek kullanımda görülen mükerrer altyazı sorununun kök nedenidir.
  window.addEventListener('pagehide', finalizeOnUnload);
  window.addEventListener('beforeunload', finalizeOnUnload);

  // Başlangıç: ayarları yükle, bölgeyi bir kez kontrol et.
  watchSettings();
  // Otomatik başlatma AYARIN OKUNMASINI bekler: autoStartOnCc kayıtlıysa
  // ayar henüz yüklenmemişken başlatma isteği gönderilmez. Aksi halde
  // otomatik başlatma hiç çalışmaz (ayar her zaman "kapalı" görünür).
  loadSettings()
    .then(function () {
      maybeAutoStart();
    })
    .catch(function () {
      maybeAutoStart();
    });
  startBodyObserver();
  scheduleScan(0);

  // Sekme yenilenmiş olabilir: background'a sor, kayıt durumunda ise
  // MNA_CAPTURE_STATE ile satırlar geri yüklenir.
  sendToBackground({ type: 'MNA_ACTIVE_SESSION' });

  // Planlı katılım yalnız arka planın işaretlediği sekmede başlar.
  sendToBackground({ type: 'MNA_SCHEDULED_HELLO' }).then(function (res) {
    if (!res || !res.scheduled) {
      return;
    }
    try {
      startScheduledJoin(res);
    } catch (err) {
      console.warn('[MNA] Planlı katılım başlatılamadı —', err);
    }
  });
})();
