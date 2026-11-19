/**
 * MNA Background Service Worker (MV3, klasik script).
 *
 * Bu dosya build adımı olmadan çalışır; ortak kütüphaneler importScripts ile yüklenir
 * (MV3 service worker "type": "module" olmadığı için ESM import kullanılmaz).
 *
 * Sorumlulukları:
 *  - Oturum yaşam döngüsü (başlat / durdur / listele / sil / başlık düzenle)
 *  - İçerik betiğinden gelen satırları oturuma eklemek
 *  - Sekme kapanınca oturumu "yarım" olarak kapatmak
 */

importScripts('../lib/protocol.js', '../lib/settings.js', '../lib/storage.js', '../lib/schedule.js');

const MNA = (() => {
  'use strict';

  const T = globalThis.MNAProtocol.MESSAGE_TYPES;
  const Storage = globalThis.MNAStorage;

  const Schedule = globalThis.MNASchedule;
  const MEET_URL_PREFIX = 'https://meet.google.com/';
  /** Bu satır sayısını aşan oturumlar chrome.storage.session'a da yazılır. */
  const MIRROR_LINE_THRESHOLD = 200;

  /**
   * İçerik betiği sekmeye yeniden bağlandığında (sekme yenilendi) arka planla
   * konuşmayı yeniden kurmak için kullanılabilecek toleranslı tip adları.
   */
  const RESUME_ALIASES = Object.keys(globalThis.MNAProtocol.AUX_MESSAGE_TYPES || {}).map(
    (key) => globalThis.MNAProtocol.AUX_MESSAGE_TYPES[key]
  );

  /**
 * Kapanış sırasında eşzamanlı sonlandırmayı önlemek için ortak sonuç.
 * İkinci bir "Durdur" çağrısı yarım oturum değil, aynı kapanışı bekler.
 */
  let finalizePromise = null;

  /**
   * Aynı sekmede toplantı kodu değişince tek bir geçiş yapılır.
   * İkinci çağrı yeni oturum açmaz; birincinin sonucunu bekler.
   */
  let rotatePromise = null;

  /* -------------------- chrome.tabs sarmalayıcıları (callback tabanlı, MV3 uyumlu) -------------------- */

  function queryTabs(query) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query(query, (tabs) => {
          void chrome.runtime.lastError;
          resolve(Array.isArray(tabs) ? tabs : []);
        });
      } catch (err) {
        console.error('[MNA] Sekme sorgusu başarısız:', err);
        resolve([]);
      }
    });
  }

  function getTab(tabId) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.get(tabId, (tab) => {
          void chrome.runtime.lastError;
          resolve(tab || null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function createTab(props) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (tab) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(tab || null);
      };
      try {
        if (!chrome.tabs || typeof chrome.tabs.create !== 'function') {
          finish(null);
          return;
        }
        const maybe = chrome.tabs.create(props, (tab) => {
          void chrome.runtime.lastError;
          finish(tab || null);
        });
        if (maybe && typeof maybe.then === 'function') {
          maybe.then((tab) => finish(tab || null), () => finish(null));
        }
      } catch (err) {
        console.error('[MNA] Sekme açılamadı:', err);
        finish(null);
      }
    });
  }

  /**
   * İçerik betiğine mesaj gönderir. Yanıt yoksa veya hata varsa { ok:false } döner.
   * @returns {Promise<{ok:boolean, response?:Object, error?:string}>}
   */
  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      if (typeof tabId !== 'number' || tabId < 0) {
        resolve({ ok: false, error: 'Geçersiz sekme.' });
        return;
      }
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({
              ok: false,
              error: 'Meet sekmesiyle bağlantı kurulamadı. Sayfayı yenileyin (F5) ve tekrar deneyin.'
            });
            return;
          }
          if (response && response.ok === false) {
            resolve({ ok: false, response: response, error: response.error || 'İşlem tamamlanamadı.' });
            return;
          }
          resolve({ ok: true, response: response });
        });
      } catch (err) {
        console.error('[MNA] İçerik betiğine mesaj gönderilemedi:', err);
        resolve({ ok: false, error: 'Meet sekmesiyle bağlantı kurulamadı.' });
      }
    });
  }

  /* -------------------- yardımcılar -------------------- */

  function isMeetUrl(url) {
    return typeof url === 'string' && url.indexOf(MEET_URL_PREFIX) === 0;
  }

  function meetingCodeFromUrl(url) {
    const match = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(url || '');
    return match ? match[1].toLowerCase() : '';
  }

  /** Anlaşılan toplantı kodu. Boş veya kalıba uymayan değer kod sayılmaz. */
  function canonicalMeetingCode(code) {
    const normalized = String(code || '').trim().toLowerCase();
    return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(normalized) ? normalized : '';
  }

  function meetingCodesDiffer(left, right) {
    const a = canonicalMeetingCode(left);
    const b = canonicalMeetingCode(right);
    return !!(a && b && a !== b);
  }

  function cleanTitle(rawTitle, meetingCode) {
    let title = String(rawTitle || '').trim();
    title = title.replace(/\s*[-–—]\s*Google Meet\s*$/i, '').trim();
    return title || meetingCode || 'Meet Toplantısı';
  }

  function newSessionId() {
    const random = Math.random().toString(36).slice(2, 8).padEnd(4, '0');
    return `sess_${Date.now()}_${random}`;
  }

  /** Belirtilen süre (ms) bekler. */
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Planlı katılım testleri saati buradan kaydırır.
   * Üretimde tanımlı değildir; uyku uyandırma da yapılmaz.
   */
  function currentTime() {
    try {
      if (typeof globalThis.MNA_NOW === 'function') {
        const value = Number(globalThis.MNA_NOW());
        if (Number.isFinite(value)) {
          return value;
        }
      }
    } catch (err) {
      /* yoksay */
    }
    return Date.now();
  }

  /**
   * Yeni oturum oluşturur ve aktif oturum olarak kaydeder.
   * @param {{title?:string, meetingUrl?:string, meetingCode?:string, startedAt?:number}} details
   * @returns {Promise<Object>} oluşturulan oturum
   */
  async function persistNewSession(details) {
    const info = details || {};
    const startedAt = Number(info.startedAt) || Date.now();
    const meetingUrl = info.meetingUrl || '';
    const meetingCode = info.meetingCode || meetingCodeFromUrl(meetingUrl);

    const session = {
      id: newSessionId(),
      title: cleanTitle(info.title, meetingCode),
      meetingUrl: meetingUrl,
      meetingCode: meetingCode,
      startedAt: startedAt,
      endedAt: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      source: 'extension',
      lines: []
    };

    await Storage.saveSession(session);
    await Storage.setActiveSession({
      sessionId: session.id,
      startedAt: startedAt,
      meetingUrl: meetingUrl,
      meetingCode: meetingCode,
      title: session.title,
      // Sekme kimliği local'de tutulur: tarayıcı yeniden başladığında
      // kaydın canlı olup olmadığı anlaşılabilsin.
      tabId: typeof info.tabId === 'number' ? info.tabId : null
    });
    await Storage.setActiveLines([]);
    return session;
  }

  /**
   * Kayıt yapılacak Meet sekmesini bulur.
   * Öncelik: verilen sekme -> aktif sekme -> herhangi bir Meet sekmesi.
   */
  async function findTargetTab(preferredTabId) {
    if (typeof preferredTabId === 'number' && preferredTabId >= 0) {
      const preferred = await getTab(preferredTabId);
      if (preferred && isMeetUrl(preferred.url)) {
        return preferred;
      }
    }

    const activeTabs = await queryTabs({ active: true, currentWindow: true });
    const active = activeTabs[0];
    if (active && isMeetUrl(active.url)) {
      return active;
    }

    const meetTabs = await queryTabs({ url: `${MEET_URL_PREFIX}*` });
    if (meetTabs.length) {
      return meetTabs[0];
    }
    return null;
  }

  function summarize(session) {
    const lines = Array.isArray(session.lines) ? session.lines : null;
    return {
      id: session.id,
      title: session.title || '',
      meetingUrl: session.meetingUrl || '',
      meetingCode: session.meetingCode || '',
      startedAt: session.startedAt || 0,
      endedAt: session.endedAt || null,
      // Oturum dizini satır içermez; o zaman sayaç dizin kaydından gelir.
      lineCount: lines ? lines.length : (Number(session.lineCount) || 0),
      createdAt: session.createdAt || session.startedAt || 0,
      updatedAt: session.updatedAt || session.startedAt || 0
    };
  }

  /* -------------------- oturum yaşam döngüsü -------------------- */

  /**
   * Aktif oturumu kapatır: kalan satırları toplar, endedAt damgalar, durumu temizler.
   * @param {Object} active aktif oturum kaydı
   * @param {number|null} tabId
   * @returns {Promise<Object|null>} kapatılmış oturum
   */
  async function finalizeSession(active, tabId) {
    if (finalizePromise) {
      // Eşzamanlı sonlandırmada aynı sonucu bekle (yarım oturum dönme).
      return finalizePromise;
    }
    finalizePromise = finalizeSessionInner(active, tabId);
    try {
      return await finalizePromise;
    } finally {
      finalizePromise = null;
    }
  }

  /**
   * Aktif oturumu kapatır: kalan satırları toplar, endedAt damgalar, durumu temizler.
   * @param {Object} active aktif oturum kaydı
   * @param {number|null} tabId
   * @returns {Promise<Object|null>} kapatılmış oturum
   */
  async function finalizeSessionInner(active, tabId) {
    const session = await Storage.getSession(active.sessionId);
    if (!session) {
      await Storage.clearActiveSession();
      await Storage.clearActiveLines();
      await Storage.clearActiveTabId();
      await Storage.clearSessionMirror();
      return null;
    }

    if (typeof tabId === 'number' && tabId >= 0) {
      // Önce yakalamayı durdur ki araya yeni satır girmesin, sonra kalanı al.
      await sendToTab(tabId, { type: T.MNA_SET_CAPTURE, active: false });
      const flush = await sendToTab(tabId, { type: T.MNA_FLUSH });
      if (flush.ok && flush.response && Array.isArray(flush.response.lines) && flush.response.lines.length) {
        await Storage.appendLines(session.id, flush.response.lines);
      }
      // İçerik betiği yakalama durdurulurken satırları toplu olarak arka plana
      // gönderir; bu mesajların işlenmesi için kısa bir nefes payı bırakılır.
      await delay(250);
    } else {
      // Sekme kapanmış olabilir: içerik betiğinin pagehide flush'u ile yarışan
      // son satırları yakalamak için kısa bir nefes payı bırakılır.
      await delay(250);
    }

    // Sekme kapandıysa tek kaynak chrome.storage.session yedeğidir.
    const backup = await Storage.getActiveLines();
    if (backup.length) {
      await Storage.appendLines(session.id, backup);
    }

    // local depolama bozulduysa uzun oturum yedeğinden satırları geri al.
    // YEDEK KENDİ OTURUMUNA AİT OLMAK ZORUNDA: aksi halde önceki toplantının
    // satırları bu toplantıya miras kalır.
    const latest = (await Storage.getSession(session.id)) || session;
    if (!latest.lines || !latest.lines.length) {
      const mirror = await Storage.getSessionMirror();
      if (
        mirror &&
        mirror.id === session.id &&
        Array.isArray(mirror.lines) &&
        mirror.lines.length
      ) {
        await Storage.appendLines(session.id, mirror.lines);
      }
    }

    const endedAt = Date.now();
    const updated = await Storage.updateSession(session.id, function (target) {
      target.endedAt = endedAt;
      target.updatedAt = endedAt;
    });

    // Yedek her zaman temizlenmeli: aksi halde sonraki oturuma sızar.
    await Storage.clearSessionMirror();

    // Durum temizliği hata durumunda da yapılmalı; aksi halde kayıt kilitlenir.
    try {
      await Storage.clearActiveSession();
      await Storage.clearActiveLines();
      await Storage.clearActiveTabId();
    } catch (err) {
      console.error('[MNA] Aktif oturum temizlenemedi:', err);
    }

    try {
      const settings = await Storage.getSettings();
      await Storage.pruneSessions(settings.maxStoredSessions);
    } catch (err) {
      console.error('[MNA] Eski oturumlar temizlenemedi:', err);
    }

    return updated || session;
  }

  async function handleSessionStart(payload) {
    const tab = await findTargetTab(payload && payload.tabId);
    if (!tab) {
      return { ok: false, error: 'Açık bir Google Meet sekmesi bulunamadı. Bir Meet toplantısına geçip tekrar deneyin.' };
    }

    // Önceki bir kayıt varsa kapatıp yenisini başlat.
    const previous = await Storage.getActiveSession();
    if (previous) {
      const previousTabId = await Storage.getActiveTabId();
      await finalizeSession(previous, previousTabId);
    }

    const statusResult = await sendToTab(tab.id, { type: T.MNA_STATUS });
    if (!statusResult.ok) {
      return { ok: false, error: statusResult.error };
    }
    const status = statusResult.response || {};
    if (!status.capture) {
      return { ok: false, error: 'Meet içerik betiği beklenen yanıtı vermedi. Sayfayı yenileyin (F5) ve tekrar deneyin.' };
    }

    const meeting = status.meeting || {};
    const meetingUrl = (payload && payload.meetingUrl) || meeting.url || tab.url || '';
    const meetingCode = (payload && payload.meetingCode) || meeting.code || meetingCodeFromUrl(meetingUrl);
    const startedAt = Date.now();

    const session = await persistNewSession({
      title: (payload && payload.title) || meeting.title || tab.title,
      meetingUrl: meetingUrl,
      meetingCode: meetingCode,
      startedAt: startedAt,
      tabId: tab.id
    });
    await Storage.setActiveTabId(tab.id);

    const captureResult = await sendToTab(tab.id, {
      type: T.MNA_SET_CAPTURE,
      active: true,
      startedAt: startedAt,
      sessionId: session.id
    });
    if (!captureResult.ok) {
      // Oturum oluşturuldu ama yakalama başlatılamadı: geri al.
      await Storage.deleteSession(session.id);
      await Storage.clearActiveSession();
      await Storage.clearActiveLines();
      await Storage.clearActiveTabId();
      return { ok: false, error: captureResult.error || 'Kayıt başlatılamadı.' };
    }

    return { ok: true, sessionId: session.id };
  }

  /**
   * Aktif oturum kaydı yokken açık kalan yakalamayı kapatır.
   * Yakalama yoksa hiçbir sekmeye kapatma gönderilmez.
   * @returns {Promise<boolean>} en az bir yakalama kapatıldıysa true
   */
  async function closeOpenCaptures() {
    const ids = [];
    const storedTabId = await Storage.getActiveTabId();
    if (typeof storedTabId === 'number' && storedTabId >= 0) {
      ids.push(storedTabId);
    }
    const meetTabs = await queryTabs({ url: `${MEET_URL_PREFIX}*` });
    for (let i = 0; i < meetTabs.length; i += 1) {
      const tab = meetTabs[i];
      if (!tab || typeof tab.id !== 'number' || !isMeetUrl(tab.url)) {
        continue;
      }
      if (ids.indexOf(tab.id) === -1) {
        ids.push(tab.id);
      }
    }

    let closed = false;
    for (let i = 0; i < ids.length; i += 1) {
      const status = await sendToTab(ids[i], { type: T.MNA_STATUS });
      const capture = status.ok && status.response && status.response.capture;
      if (!capture || capture.active !== true) {
        continue;
      }
      const result = await sendToTab(ids[i], { type: T.MNA_SET_CAPTURE, active: false });
      if (result.ok) {
        closed = true;
      }
    }
    return closed;
  }

  async function handleSessionStop() {
    const active = await Storage.getActiveSession();
    if (!active) {
      const closed = await closeOpenCaptures();
      if (closed) {
        return { ok: true };
      }
      return { ok: false, error: 'Devam eden bir kayıt bulunamadı.' };
    }
    const tabId = await Storage.getActiveTabId();
    const session = await finalizeSession(active, tabId);
    if (!session) {
      return { ok: false, error: 'Kayıt kapatılamadı.' };
    }
    return { ok: true, session: session };
  }

  async function handleLinesAppended(payload, sender) {
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    if (!lines.length) {
      return { ok: true, appended: 0 };
    }

    // Satır, toplantı değiştikten sonra eski kimlikle gelse bile önce sekmenin
    // güncel koduna bak. Geçiş bitmeden eski nota yazılmaz.
    const senderTabId = sender && sender.tab && typeof sender.tab.id === 'number'
      ? sender.tab.id
      : undefined;
    if (rotatePromise) {
      await rotatePromise;
    } else if (!finalizePromise) {
      await rotateSessionForNewMeeting(senderTabId);
    }

    let sessionId = payload.sessionId;
    let session = sessionId ? await Storage.getSession(sessionId) : null;
    const active = await Storage.getActiveSession();

    // Kapanmış önceki toplantının notuna, yeni toplantının cümlesi yazılmaz.
    if (
      session &&
      active &&
      sessionId !== active.sessionId &&
      meetingCodesDiffer(session.meetingCode, active.meetingCode)
    ) {
      sessionId = active.sessionId;
      session = await Storage.getSession(sessionId);
      if (!session) {
        return { ok: false, error: 'Aktif oturum okunamadı.' };
      }
    } else if (!session) {
      // İçerik betiği kendi oturum kimliğini üretebilir; bu durumda aktif
      // oturuma yazılır (satırlar kaybolmaz).
      if (!active) {
        return { ok: false, error: 'Aktif oturum bulunamadı.' };
      }
      if (sessionId) {
        console.warn('[MNA] Oturum kimliği eşleşmedi, aktif oturuma yazılıyor:', sessionId);
      }
      sessionId = active.sessionId;
      session = await Storage.getSession(sessionId);
      if (!session) {
        return { ok: false, error: 'Aktif oturum okunamadı.' };
      }
    }

    let updated = null;
    try {
      updated = await Storage.appendLines(sessionId, lines);
    } catch (err) {
      // Kota vb. hatalarda kullanıcı bilgilendirilir; satırlar içerik
      // betiğinin kuyruğunda tutulmaya devam eder.
      console.error('[MNA] Satırlar kaydedilemedi:', err);
      return {
        ok: false,
        error: (err && err.message) ? err.message : 'Satırlar kaydedilemedi.'
      };
    }

    if (!updated) {
      return { ok: false, error: 'Oturum bulunamadı: ' + sessionId };
    }

    // Geçici yedek (service worker yeniden başlasa da kayıt kaybolmasın).
    // Yedek, aynı id'li satırları güncelleyecek şekilde birleştirilir.
    const backup = await Storage.getActiveLines();
    await Storage.setActiveLines(mergeLinesById(backup, lines));

    // Çok satır biriken oturumları da session alanına yaz.
    if (updated && Array.isArray(updated.lines) && updated.lines.length > MIRROR_LINE_THRESHOLD) {
      await Storage.setSessionMirror(updated);
    }

    return {
      ok: true,
      appended: typeof updated.appended === 'number' ? updated.appended : lines.length,
      // Meet altyazıyı sonradan revize ettiğinde aynı id'li satır güncellendi.
      revised: typeof updated.revised === 'number' ? updated.revised : 0
    };
  }

  /** Aynı id'li satırları yerinde güncelleyerek iki listeyi birleştirir. */
  function mergeLinesById(existing, incoming) {
    const result = Array.isArray(existing) ? existing.slice() : [];
    const index = Object.create(null);
    result.forEach(function (line, i) {
      if (line && line.id) {
        index[line.id] = i;
      }
    });
    (Array.isArray(incoming) ? incoming : []).forEach(function (line) {
      if (!line) { return; }
      if (line.id && index[line.id] !== undefined) {
        result[index[line.id]] = line;
        return;
      }
      if (line.id) {
        index[line.id] = result.length;
      }
      result.push(line);
    });
    return result;
  }

  async function handleSessionList() {
    const sessions = await Storage.listSessions();
    return { ok: true, sessions: sessions.map(summarize) };
  }

  async function handleSessionGet(payload) {
    const sessionId = payload && payload.sessionId;
    if (!sessionId) {
      return { ok: false, error: 'Oturum id eksik.' };
    }
    const session = await Storage.getSession(sessionId);
    if (!session) {
      return { ok: false, error: 'Oturum bulunamadı.' };
    }
    return { ok: true, session: session };
  }

  async function handleSessionDelete(payload) {
    const sessionId = payload && payload.sessionId;
    if (!sessionId) {
      return { ok: false, error: 'Oturum id eksik.' };
    }
    const active = await Storage.getActiveSession();
    let captureTabId = null;
    if (active && active.sessionId === sessionId) {
      const session = await Storage.getSession(sessionId);
      // Yalnızca süren (endedAt boş) kayıtta yakalama kapatılır.
      // Bitmiş bir not silinirken sekmedeki yakalamaya dokunulmaz.
      if (!session || !session.endedAt) {
        const storedTabId = await Storage.getActiveTabId();
        if (typeof storedTabId === 'number' && storedTabId >= 0) {
          captureTabId = storedTabId;
        } else if (typeof active.tabId === 'number' && active.tabId >= 0) {
          captureTabId = active.tabId;
        }
      }
      await Storage.clearActiveSession();
      await Storage.clearActiveLines();
      await Storage.clearActiveTabId();
    }
    // Önce notu sil. Kapatma flush'u bundan sonra gelirse silinen
    // oturumun satırları depoya geri yazılamaz.
    const deleted = await Storage.deleteSession(sessionId);
    if (captureTabId !== null) {
      await sendToTab(captureTabId, { type: T.MNA_SET_CAPTURE, active: false });
    }
    return { ok: true, deleted: deleted };
  }

  async function handleSessionUpdate(payload) {
    const sessionId = payload && payload.sessionId;
    if (!sessionId) {
      return { ok: false, error: 'Oturum id eksik.' };
    }
    const session = await Storage.updateSessionTitle(sessionId, payload.title);
    if (!session) {
      return { ok: false, error: 'Oturum bulunamadı veya başlık boş.' };
    }
    return { ok: true, session: session };
  }

  /**
   * Kayıt sekmesine "durumu geri yükle" sinyali gönderir.
   * Sekme yenilendiğinde kayıp satırların geri gelmesi için kullanılır.
   */
  async function pushCaptureState(tabId, active) {
    if (typeof tabId !== 'number' || tabId < 0 || !active) {
      return false;
    }
    const lines = await Storage.getActiveLines();
    const result = await sendToTab(tabId, {
      type: T.MNA_CAPTURE_STATE,
      active: true,
      startedAt: active.startedAt,
      lines: lines,
      sessionId: active.sessionId
    });
    return result.ok;
  }

  /**
   * Sekmenin şu anki toplantısı, aktif oturumunkinden farklıysa yeni toplantıyı döndürür.
   * Kod yoksa veya aynıysa null: çalışan kayıt kapatılmaz.
   */
  function changedMeeting(active, tab, meeting) {
    const current = canonicalMeetingCode(active && active.meetingCode);
    if (!current) {
      return null;
    }
    const info = meeting || {};
    const urlCode = meetingCodeFromUrl(tab && tab.url);
    const statusCode = canonicalMeetingCode(info.code) || meetingCodeFromUrl(info.url);
    let nextCode = '';
    if (urlCode && urlCode !== current) {
      nextCode = urlCode;
    } else if (statusCode && statusCode !== current) {
      nextCode = statusCode;
    } else {
      return null;
    }

    const statusUrl = typeof info.url === 'string' ? info.url : '';
    const tabUrl = tab && typeof tab.url === 'string' ? tab.url : '';
    let meetingUrl = tabUrl || statusUrl;
    if (statusUrl && meetingCodeFromUrl(statusUrl) === nextCode) {
      meetingUrl = statusUrl;
    } else if (tabUrl && urlCode === nextCode) {
      meetingUrl = tabUrl;
    }
    return {
      meetingCode: nextCode,
      meetingUrl: meetingUrl,
      title: info.title || (tab && tab.title) || ''
    };
  }

  /**
   * Kayıt yapılan sekmede toplantı kodu değiştiyse eski oturumu kapatıp yenisini açar.
   * Sekmeye giden yakalama durumu yeni sessionId taşır.
   * @returns {Promise<Object|null>} yeni aktif oturum kaydı; geçiş yoksa null
   */
  function rotateSessionForNewMeeting(tabId) {
    if (rotatePromise) {
      return rotatePromise;
    }
    rotatePromise = rotateSessionForNewMeetingInner(tabId).finally(() => {
      rotatePromise = null;
    });
    return rotatePromise;
  }

  async function rotateSessionForNewMeetingInner(tabId) {
    const active = await Storage.getActiveSession();
    if (!active || !active.sessionId) {
      return null;
    }
    const activeTabId = await Storage.getActiveTabId();
    const id = typeof tabId === 'number' ? tabId : activeTabId;
    if (typeof id !== 'number' || id < 0) {
      return null;
    }
    // Başka bir sekme, kayıt yapılan toplantıyı değiştirmez.
    if (activeTabId !== null && activeTabId !== undefined && id !== activeTabId) {
      return null;
    }
    const tab = await getTab(id);
    if (!tab) {
      return null;
    }

    const statusResult = await sendToTab(id, { type: T.MNA_STATUS });
    const meeting = statusResult.ok && statusResult.response
      ? (statusResult.response.meeting || {})
      : {};
    const next = changedMeeting(active, tab, meeting);
    if (!next) {
      return null;
    }

    // Sekmeye flush gönderilmez: o flush yeni toplantının cümlelerini eski
    // nota yazardı. Kapanış yine endedAt damgalar ve kaydı aktif olmaktan çıkarır.
    await finalizeSession(active, null);

    const session = await persistNewSession({
      title: next.title,
      meetingUrl: next.meetingUrl,
      meetingCode: next.meetingCode,
      startedAt: Date.now(),
      tabId: id
    });
    await Storage.setActiveTabId(id);

    const record = {
      sessionId: session.id,
      startedAt: session.startedAt,
      meetingUrl: session.meetingUrl,
      meetingCode: session.meetingCode,
      title: session.title,
      tabId: id
    };
    await pushCaptureState(id, record);
    console.info('[MNA] Toplantı değişti, yeni oturum açıldı:', session.id);
    return record;
  }

  async function handleActiveSession(payload, sender) {
    let active = await Storage.getActiveSession();
    const isContentRequest = !!(sender && sender.tab && typeof sender.tab.id === 'number');
    let activeTabId = await Storage.getActiveTabId();

    // Tarayıcı yeniden başladıysa kayıt ölmüş olabilir: sekme yedeği
    // chrome.storage.session'da durur ve tarayıcı kapanınca silinir. Bu
    // durumda "kayıt sürüyor" görünür ama kayıt gerçekte durmuştur.
    if (active && active.tabId && (activeTabId === null || activeTabId === undefined)) {
      console.warn('[MNA] Aktif oturum canlı değil; tarayıcı yeniden başlamış olabilir.');
      try {
        await finalizeSession(active, null);
      } catch (err) {
        console.error('[MNA] Ölü oturum kapatılamadı:', err);
      }
      active = null;
    }

    // Toplantı geçişi sürüyorsa ikinci bir oturum açılmaz; yeni kayıt beklenir.
    if (!active && rotatePromise) {
      const rotated = await rotatePromise;
      if (rotated) {
        active = rotated;
        if (typeof rotated.tabId === 'number') {
          activeTabId = rotated.tabId;
        }
      }
    }

    // "Yakalama başladı" sinyali (MNA_CAPTURE_STATE_REQUEST) ve arka planda
    // oturum yoksa: içerik betiği kendi kendine başlamıştır (autoStartOnCc).
    // Arka plan oturumu oluşturur ve kimliği geri bildirir; aksi halde
    // satırların hangi oturuma yazılacağı bilinmez.
    const captureStarted = !!payload && payload.type === 'MNA_CAPTURE_STATE_REQUEST';
    if (!active && isContentRequest && captureStarted) {
      const tab = await getTab(sender.tab.id);
      if (tab) {
        const statusResult = await sendToTab(tab.id, { type: T.MNA_STATUS });
        const status = statusResult.ok ? (statusResult.response || {}) : {};
        const meeting = status.meeting || {};
        const created = await persistNewSession({
          title: meeting.title || tab.title,
          meetingUrl: meeting.url || tab.url || '',
          meetingCode: meeting.code || '',
          tabId: tab.id
        });
        await Storage.setActiveTabId(tab.id);
        activeTabId = tab.id;
        // Oturum nesnesi (id) -> aktif oturum kaydı (sessionId) biçimine çevrilir.
        active = {
          sessionId: created.id,
          startedAt: created.startedAt,
          meetingUrl: created.meetingUrl,
          meetingCode: created.meetingCode,
          title: created.title
        };
        console.info('[MNA] İçerik betiğinin isteği üzerine oturum oluşturuldu:', created.id);
      }
    }

    // Yalnızca kayıt yapılan sekmeye durum geri yüklenir; başka bir Meet
    // sekmesi kaydı kendiliğinden başlatmaz.
    if (active && typeof activeTabId === 'number' && activeTabId >= 0) {
      const rotated = await rotateSessionForNewMeeting(activeTabId);
      if (rotated) {
        active = rotated;
        activeTabId = typeof rotated.tabId === 'number' ? rotated.tabId : activeTabId;
      }
    }

    const isRecordingTab = isContentRequest
      && activeTabId !== null
      && activeTabId !== undefined
      && activeTabId === sender.tab.id;
    const restoreTabMatches = !payload
      || payload.tabId === undefined
      || payload.tabId === activeTabId;

    if (isRecordingTab && active) {
      await pushCaptureState(sender.tab.id, active);
    } else if (
      payload
      && payload.restore === true
      && active
      && activeTabId !== null
      && activeTabId !== undefined
      && restoreTabMatches
    ) {
      // Uzantı sayfası (popup) "sekme yenilenmiş, durumu geri yükle" derse
      // yalnızca kayıt sekmesinden (veya tabId verilmemişse) geldiğinde gönder.
      await pushCaptureState(activeTabId, active);
    }

    if (!active) {
      return { ok: true, active: null };
    }
    return {
      ok: true,
      active: {
        sessionId: active.sessionId,
        startedAt: active.startedAt,
        meetingUrl: active.meetingUrl || '',
        meetingCode: active.meetingCode || '',
        title: active.title || ''
      }
    };
  }

  /**
   * İçerik betiği yakalama durumunu arka plana bildirir.
   * (active:false -> içerik betiği kendiliğinden durdu, oturumu kapat.)
   */
  async function handleCaptureState(message) {
    if (message.active === false) {
      if (!finalizePromise) {
        const active = await Storage.getActiveSession();
        if (active) {
          const activeTabId = await Storage.getActiveTabId();
          await finalizeSession(active, activeTabId);
        }
      }
    }
    // active:true durumunda geriye bir şey gönderilmez; aksi halde
    // içerik betiği ile arka plan birbirine sürekli durum gönderir.
    return { ok: true };
  }

  /* -------------------- planlı katılım -------------------- */

  const JOIN_KEY = (Schedule && Schedule.STORAGE_KEY) || 'mna.scheduledJoins';
  const UNFINISHED_SCHEDULE_STATUSES = {
    opening: true,
    joining: true,
    waiting: true,
    admitted: true,
    blocked: true,
    recording: true
  };
  const TERMINAL_SCHEDULE_STATUSES = {
    cancelled: true,
    skipped: true,
    expired: true,
    ended: true,
    failed: true,
    endedByTime: true
  };
  let scheduleQueue = Promise.resolve();

  function withScheduleLock(task) {
    const run = scheduleQueue.then(task, task);
    scheduleQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Planlı katılım tanılama günlüğü: sonradan "neden katılamadı?" sorusunu
   * yanıtlamak için. Yalnız yerelde (chrome.storage.local) tutulur, ağa gitmez.
   * Son TRACE_MAX kayıt saklanır; altyazı/konuşma metni yazılmaz.
   */
  const TRACE_KEY = 'mna.joinTrace';
  const TRACE_MAX = 600;
  const TRACE_DATA_MAX = 1800;
  let traceQueue = Promise.resolve();

  function trace(joinId, src, type, data) {
    let safe = data === undefined ? null : data;
    try {
      const text = JSON.stringify(safe);
      if (text && text.length > TRACE_DATA_MAX) {
        safe = { truncated: text.slice(0, TRACE_DATA_MAX) };
      }
    } catch (err) {
      safe = null;
    }
    const entry = {
      t: currentTime(),
      id: joinId || null,
      src: src,
      type: String(type || '').slice(0, 40),
      data: safe
    };
    traceQueue = traceQueue.then(async () => {
      const result = await chrome.storage.local.get(TRACE_KEY);
      const list = result && Array.isArray(result[TRACE_KEY]) ? result[TRACE_KEY] : [];
      list.push(entry);
      while (list.length > TRACE_MAX) {
        list.shift();
      }
      const payload = {};
      payload[TRACE_KEY] = list;
      await chrome.storage.local.set(payload);
    }).catch(() => undefined);
    return traceQueue;
  }

  function readJoins() {
    return chrome.storage.local.get(JOIN_KEY).then((result) => {
      const value = result && result[JOIN_KEY];
      return Array.isArray(value) ? value : [];
    }).catch((err) => {
      console.error('[MNA] Planlı katılımlar okunamadı:', err);
      return [];
    });
  }

  function writeJoins(list) {
    const payload = {};
    payload[JOIN_KEY] = list;
    return chrome.storage.local.set(payload);
  }

  async function updateJoin(id, patch) {
    const list = await readJoins();
    let updated = null;
    const next = list.map((item) => {
      if (!item || item.id !== id) {
        return item;
      }
      updated = Object.assign({}, item, patch, { updatedAt: currentTime() });
      return updated;
    });
    await writeJoins(next);
    return updated;
  }

  async function readJoin(id) {
    const list = await readJoins();
    for (let i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].id === id) {
        return list[i];
      }
    }
    return null;
  }

  function createAlarm(name, when) {
    try {
      if (!Schedule || !chrome.alarms || typeof chrome.alarms.create !== 'function') {
        return false;
      }
      if (!Number.isFinite(when)) {
        return false;
      }
      chrome.alarms.create(name, { when: when });
      return true;
    } catch (err) {
      console.error('[MNA] Alarm kurulamadı:', name, err);
      return false;
    }
  }

  function clearAlarm(name) {
    try {
      if (!chrome.alarms || typeof chrome.alarms.clear !== 'function') {
        return;
      }
      chrome.alarms.clear(name, () => {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      console.error('[MNA] Alarm silinemedi:', name, err);
    }
  }

  function newJoinId() {
    const random = Math.random().toString(36).slice(2, 8);
    return `join_${Date.now()}_${random}`;
  }

  /**
   * Tarayıcı yeniden açıldığında session yedeği silinir; local'de kalan
   * oturum kaydı canlı kayıt değildir.
   */
  async function isLiveRecording() {
    const active = await Storage.getActiveSession();
    if (!active || !active.sessionId) {
      return false;
    }
    const tabId = await Storage.getActiveTabId();
    return typeof tabId === 'number' && tabId >= 0;
  }

  async function resyncAlarms() {
    if (!Schedule || !chrome.alarms || typeof chrome.alarms.create !== 'function') {
      return;
    }
    const now = currentTime();
    const list = await readJoins();
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      if (!item) {
        continue;
      }
      const staleOpening = item.status === 'opening' && (item.tabId === null || item.tabId === undefined);
      if (item.status !== 'scheduled' && !staleOpening) {
        continue;
      }
      if (now > Number(item.startAt) + Schedule.JOIN_WINDOW_MS) {
        await updateJoin(item.id, {
          status: 'expired',
          statusText: Schedule.statusText('expired')
        });
        continue;
      }
      if (staleOpening) {
        await updateJoin(item.id, {
          status: 'scheduled',
          statusText: Schedule.statusText('scheduled')
        });
      }
      createAlarm(Schedule.joinAlarmName(item.id), item.startAt);
      if (item.endAt) {
        createAlarm(Schedule.endAlarmName(item.id), item.endAt);
      }
    }
  }

  async function handleScheduleSave(message) {
    if (!Schedule) {
      return { ok: false, error: 'Planlama modülü yüklenemedi.' };
    }
    const checked = Schedule.validateSchedule({
      url: message && message.url,
      startAt: message && message.startAt,
      endAt: message ? message.endAt : null,
      now: currentTime()
    });
    if (!checked.ok) {
      return checked;
    }
    const now = currentTime();
    const item = {
      id: newJoinId(),
      url: checked.url,
      meetingCode: checked.meetingCode,
      startAt: checked.startAt,
      endAt: checked.endAt,
      status: 'scheduled',
      statusText: Schedule.statusText('scheduled'),
      tabId: null,
      createdAt: now,
      updatedAt: now
    };
    const list = await readJoins();
    list.push(item);
    await writeJoins(list);
    const armed = createAlarm(Schedule.joinAlarmName(item.id), item.startAt);
    if (!armed) {
      await writeJoins(list.filter((entry) => !entry || entry.id !== item.id));
      return { ok: false, error: 'Zamanlayıcı kurulamadı.' };
    }
    if (item.endAt) {
      createAlarm(Schedule.endAlarmName(item.id), item.endAt);
    }
    trace(item.id, 'sw', 'saved', {
      code: item.meetingCode,
      startAt: item.startAt,
      endAt: item.endAt || null
    });
    return { ok: true, item: item };
  }

  async function handleScheduleList() {
    const list = await readJoins();
    return { ok: true, items: Schedule ? Schedule.sortJoins(list) : list };
  }

  async function handleScheduleCancel(message) {
    if (!Schedule) {
      return { ok: false, error: 'Planlama modülü yüklenemedi.' };
    }
    const id = message && message.id;
    if (!id) {
      return { ok: false, error: 'Katılım kimliği eksik.' };
    }
    const list = await readJoins();
    const item = list.find((entry) => entry && entry.id === id) || null;
    if (!item) {
      return { ok: true, removed: false };
    }
    clearAlarm(Schedule.joinAlarmName(id));
    clearAlarm(Schedule.endAlarmName(id));
    await writeJoins(list.filter((entry) => !entry || entry.id !== id));
    if (Schedule.cancelsRunningJoin(item.status) && typeof item.tabId === 'number') {
      await sendToTab(item.tabId, { type: 'MNA_SCHEDULED_CANCEL', joinId: id });
    }
    return { ok: true, removed: true };
  }

  async function handleScheduleStatus(message) {
    if (!Schedule) {
      return { ok: false, error: 'Planlama modülü yüklenemedi.' };
    }
    const id = message && message.joinId;
    const update = Schedule.phaseUpdate(message && message.phase, message && message.reason);
    if (!id || !update) {
      return { ok: true, ignored: true };
    }
    const current = await readJoin(id);
    if (!current) {
      return { ok: true, ignored: true };
    }
    if (Schedule.statusRank(update.status) < Schedule.statusRank(current.status)) {
      trace(id, 'sw', 'status-ignored', {
        phase: message && message.phase,
        proposed: update.status,
        current: current.status
      });
      return { ok: true, ignored: true, item: current };
    }
    const saved = await updateJoin(id, {
      status: update.status,
      statusText: update.text
    });
    trace(id, 'sw', 'status', {
      phase: message && message.phase,
      reason: (message && message.reason) || null,
      status: update.status,
      text: update.text
    });
    return { ok: true, item: saved };
  }

  function beginPayload(item) {
    return {
      type: 'MNA_BEGIN_SCHEDULED_JOIN',
      joinId: item.id,
      startAt: item.startAt,
      deadlineAt: Number(item.startAt) + Schedule.JOIN_WINDOW_MS,
      endAt: item.endAt || null,
      url: item.url,
      meetingCode: item.meetingCode
    };
  }

  async function handleJoinAlarm(item) {
    if (!Schedule || !item) {
      return;
    }
    const claim = await withScheduleLock(async () => {
      const fresh = await readJoin(item.id);
      if (!fresh) {
        return { action: 'ignore' };
      }
      if (fresh.status === 'opening') {
        return { action: 'ignore' };
      }
      const live = await isLiveRecording();
      const decision = Schedule.decideJoinAlarm(fresh, currentTime(), live);
      trace(fresh.id, 'sw', 'join-alarm', {
        decision: decision,
        liveRecording: !!live,
        lateMs: currentTime() - Number(fresh.startAt),
        status: fresh.status
      });
      if (decision === 'expired') {
        await updateJoin(fresh.id, {
          status: 'expired',
          statusText: Schedule.statusText('expired')
        });
        return { action: 'expired' };
      }
      if (decision === 'skipped') {
        await updateJoin(fresh.id, {
          status: 'skipped',
          statusText: Schedule.statusText('skipped')
        });
        return { action: 'skipped' };
      }
      if (decision !== 'join') {
        return { action: 'ignore' };
      }
      await updateJoin(fresh.id, {
        status: 'opening',
        statusText: Schedule.statusText('opening')
      });
      return { action: 'join', item: fresh };
    });
    if (!claim || claim.action !== 'join') {
      return;
    }
    const fresh = claim.item;
    let tab = null;
    try {
      tab = await createTab({ url: fresh.url, active: true });
    } catch (err) {
      tab = null;
      trace(fresh.id, 'sw', 'tab-create-error', { message: String(err && err.message || err) });
    }
    if (!tab || typeof tab.id !== 'number') {
      trace(fresh.id, 'sw', 'tab-create-failed', null);
      await withScheduleLock(() => updateJoin(fresh.id, {
        status: 'failed',
        statusText: Schedule.statusText('failed')
      }));
      return;
    }
    const deadlineAt = Number(fresh.startAt) + Schedule.JOIN_WINDOW_MS;
    await withScheduleLock(() => updateJoin(fresh.id, {
      status: 'joining',
      statusText: Schedule.statusText('joining'),
      tabId: tab.id,
      deadlineAt: deadlineAt
    }));
    console.info('[MNA] Planlı katılım sekmesi açıldı:', fresh.meetingCode);
    trace(fresh.id, 'sw', 'tab-opened', { tabId: tab.id });
    const begun = await sendToTab(tab.id, beginPayload(Object.assign({}, fresh, { tabId: tab.id })));
    trace(fresh.id, 'sw', 'begin-sent', {
      tabId: tab.id,
      reply: begun && typeof begun === 'object' ? { ok: begun.ok !== false } : null
    });
  }

  /**
   * Planlı sekmedeki bitiş ekranı yalnız o sekmenin kaydını kapatır.
   * Başka bir Meet sekmesindeki kayıt sürer.
   */
  async function handleScheduledMeetingEnded(message, sender) {
    if (!Schedule) {
      return { ok: false, error: 'Planlama modülü yüklenemedi.' };
    }
    const joinId = message && message.joinId;
    const reason = (message && (message.reason || message.phase)) || 'ended';
    if (!joinId) {
      return { ok: true, ignored: true };
    }
    const senderTab = scheduledTabId(message, sender);
    const item = await readJoin(joinId);
    if (!item) {
      return { ok: true, ignored: true };
    }
    if (senderTab !== null && item.tabId !== senderTab) {
      return { ok: true, ignored: true };
    }
    const active = await Storage.getActiveSession();
    const activeTab = await Storage.getActiveTabId();
    if (active && typeof item.tabId === 'number' && activeTab === item.tabId) {
      await handleSessionStop();
    }
    return withScheduleLock(() => handleScheduleStatus({
      joinId: joinId,
      phase: reason,
      reason: reason
    }));
  }

  async function handleEndAlarm(item) {
    if (!item || TERMINAL_SCHEDULE_STATUSES[item.status]) {
      return;
    }
    const tabId = typeof item.tabId === 'number' ? item.tabId : null;
    const active = await Storage.getActiveSession();
    const activeTab = await Storage.getActiveTabId();
    trace(item.id, 'sw', 'end-alarm', {
      status: item.status,
      tabId: tabId,
      recordingHere: !!(active && tabId !== null && activeTab === tabId)
    });
    if (active && tabId !== null && activeTab === tabId) {
      await handleSessionStop();
    }
    if (tabId !== null) {
      await sendToTab(tabId, { type: 'MNA_SCHEDULED_LEAVE', joinId: item.id });
    }
    await withScheduleLock(async () => {
      const fresh = await readJoin(item.id);
      if (!fresh || TERMINAL_SCHEDULE_STATUSES[fresh.status]) {
        return;
      }
      await updateJoin(item.id, {
        status: 'endedByTime',
        statusText: Schedule.statusText('endedByTime')
      });
    });
  }

  async function handleAlarm(alarm) {
    if (!Schedule) {
      return;
    }
    const parsed = Schedule.parseAlarmName(alarm && alarm.name);
    if (!parsed) {
      return;
    }
    const item = await readJoin(parsed.id);
    trace(parsed.id, 'sw', 'alarm-fired', { kind: parsed.kind, itemFound: !!item });
    if (!item) {
      return;
    }
    if (parsed.kind === 'end') {
      await handleEndAlarm(item);
      return;
    }
    await handleJoinAlarm(item);
  }

  function scheduledTabId(message, sender) {
    if (sender && sender.tab && typeof sender.tab.id === 'number') {
      return sender.tab.id;
    }
    if (message && typeof message.tabId === 'number') {
      return message.tabId;
    }
    return null;
  }

  async function handleScheduledHello(sender) {
    if (!Schedule) {
      return { ok: true, scheduled: false };
    }
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    if (tabId === null) {
      return { ok: true, scheduled: false };
    }
    const list = await readJoins();
    const now = currentTime();
    const item = list.find((entry) => entry && entry.tabId === tabId) || null;
    trace(item ? item.id : null, 'sw', 'page-hello', {
      tabId: tabId,
      knownJoin: !!item,
      status: item ? item.status : null
    });
    if (
      item &&
      (item.status === 'opening' || item.status === 'joining' || item.status === 'waiting' || item.status === 'blocked') &&
      now > Number(item.startAt) + Schedule.JOIN_WINDOW_MS
    ) {
      await withScheduleLock(() => updateJoin(item.id, {
        status: 'expired',
        statusText: Schedule.statusText('expired')
      }));
      return { ok: true, scheduled: false };
    }
    if (!Schedule.shouldResume(item, tabId, now)) {
      return { ok: true, scheduled: false };
    }
    return Object.assign({ ok: true, scheduled: true }, beginPayload(item));
  }

  async function handleScheduledCaptureStart(message, sender) {
    if (!Schedule) {
      return { ok: false, error: 'Planlama modülü yüklenemedi.' };
    }
    const tabId = scheduledTabId(message, sender);
    const joinId = message && message.joinId;
    if (tabId === null || !joinId) {
      return { ok: false, error: 'Planlı katılım sekmesi değil.' };
    }
    const gate = await withScheduleLock(async () => {
      const item = await readJoin(joinId);
      if (!item || item.tabId !== tabId) {
        return { ok: false, error: 'Planlı katılım sekmesi değil.' };
      }
      const live = await isLiveRecording();
      const activeTab = await Storage.getActiveTabId();
      if (live && activeTab !== tabId) {
        return { ok: false, error: 'Başka bir kayıt sürüyor.' };
      }
      if (live && activeTab === tabId) {
        const active = await Storage.getActiveSession();
        return {
          ok: true,
          already: true,
          sessionId: active && active.sessionId,
          item: item
        };
      }
      return { ok: true, start: true, item: item };
    });
    if (!gate || gate.ok === false) {
      return gate || { ok: false, error: 'Kayıt başlatılamadı.' };
    }
    if (gate.already) {
      await withScheduleLock(() => updateJoin(joinId, {
        status: 'recording',
        statusText: Schedule.statusText('recording'),
        tabId: tabId
      }));
      return { ok: true, already: true, sessionId: gate.sessionId };
    }
    const started = await handleSessionStart({
      tabId: tabId,
      meetingUrl: gate.item.url,
      meetingCode: gate.item.meetingCode
    });
    if (started && started.ok) {
      await withScheduleLock(() => updateJoin(joinId, {
        status: 'recording',
        statusText: Schedule.statusText('recording'),
        tabId: tabId
      }));
    }
    return started;
  }

  /* -------------------- mesaj yönlendirici -------------------- */

  async function handleMessage(message, sender) {
    if (!message || typeof message.type !== 'string') {
      return { ok: false, error: 'Geçersiz mesaj.' };
    }

    switch (message.type) {
      case T.MNA_SESSION_START:
        return handleSessionStart(message);
      case T.MNA_SESSION_STOP:
        return handleSessionStop(message);
      case T.MNA_SESSION_LIST:
        return handleSessionList();
      case T.MNA_SESSION_GET:
        return handleSessionGet(message);
      case T.MNA_SESSION_DELETE:
        return handleSessionDelete(message);
      case T.MNA_SESSION_UPDATE:
        return handleSessionUpdate(message);
      case T.MNA_ACTIVE_SESSION:
        return handleActiveSession(message, sender);
      case T.MNA_LINES_APPENDED:
        return handleLinesAppended(message, sender);
      case T.MNA_CAPTURE_STATE:
        return handleCaptureState(message);
      case 'MNA_SCHEDULE_SAVE':
        return withScheduleLock(() => handleScheduleSave(message));
      case 'MNA_SCHEDULE_LIST':
        return handleScheduleList();
      case 'MNA_SCHEDULE_CANCEL':
        return withScheduleLock(() => handleScheduleCancel(message));
      case 'MNA_SCHEDULE_STATUS':
        return withScheduleLock(() => handleScheduleStatus(message));
      case 'MNA_SCHEDULED_HELLO':
        return handleScheduledHello(sender);
      case 'MNA_SCHEDULED_CAPTURE_START':
        return handleScheduledCaptureStart(message, sender).then((result) => {
          trace(message && message.joinId, 'sw', 'capture-start', {
            ok: !!(result && result.ok),
            error: (result && result.error) || null
          });
          return result;
        });
      case 'MNA_SCHEDULED_MEETING_ENDED':
        trace(message && message.joinId, 'sw', 'meeting-ended', {
          reason: (message && message.reason) || null
        });
        return handleScheduledMeetingEnded(message, sender);
      case 'MNA_JOIN_TRACE':
        // Sayfa tarafı olayları (yalnız planlı katılım sekmesinden).
        if (sender && sender.tab && message && message.joinId) {
          trace(message.joinId, 'page', message.kind, message.data);
        }
        return { ok: true };
      default:
        if (RESUME_ALIASES.indexOf(message.type) !== -1) {
          return handleActiveSession(message, sender);
        }
        return { ok: false, error: `Bilinmeyen mesaj tipi: ${message.type}` };
    }
  }

  /* -------------------- olay dinleyicileri -------------------- */

  /**
   * Kapatılan sekmeye bağlı, henüz bitmemiş planlı katılımları sonlandırır.
   */
  async function closeScheduledJoinsForTab(tabId) {
    if (!Schedule || typeof tabId !== 'number' || tabId < 0) {
      return;
    }
    await withScheduleLock(async () => {
      const list = await readJoins();
      const matches = list.filter(
        (entry) => entry && entry.tabId === tabId && UNFINISHED_SCHEDULE_STATUSES[entry.status]
      );
      for (let i = 0; i < matches.length; i += 1) {
        const entry = matches[i];
        const joined = entry.status === 'recording' || entry.status === 'admitted';
        trace(entry.id, 'sw', 'tab-closed', { tabId: tabId, statusWas: entry.status });
        await updateJoin(entry.id, {
          status: joined ? 'ended' : 'failed',
          statusText: Schedule.statusText(joined ? 'tabClosedRecording' : 'tabClosedNotJoined')
        });
        clearAlarm(Schedule.joinAlarmName(entry.id));
        clearAlarm(Schedule.endAlarmName(entry.id));
      }
    });
  }

  /**
   * Kayıt yapılan sekme kapanırsa oturumu "yarım" olarak kapat.
   */
  async function handleTabRemoved(tabId) {
    try {
      await closeScheduledJoinsForTab(tabId);
    } catch (err) {
      console.error('[MNA] Planlı katılım sekme kapanışı işlenemedi:', err);
    }
    const active = await Storage.getActiveSession();
    if (!active) {
      return;
    }
    const activeTabId = await Storage.getActiveTabId();
    if (activeTabId === null || activeTabId === undefined || activeTabId !== tabId) {
      return;
    }
    try {
      // Sekme kapanırken içerik betiğinin son satırları gönderilmiş olabilir;
      // kapanmadan önce bir kez daha flush iste.
      await sendToTab(tabId, { type: T.MNA_FLUSH });
      await finalizeSession(active, null);
      console.info('[MNA] Kayıt sekmesi kapandı, oturum yarım olarak kapatıldı.');
    } catch (err) {
      console.error('[MNA] Oturum kapatılamadı:', err);
    }
  }

  /**
   * Planlı katılım sekmesi yüklenince/yönlenince günlüğe yazar. Meet dışı bir
   * adrese (ör. Google giriş sayfası) yönlenirse url görünmez: "url yok" bunun işaretidir.
   */
  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (!Schedule || !changeInfo || (changeInfo.status !== 'complete' && !changeInfo.url)) {
      return;
    }
    const list = await readJoins();
    const item = list.find(
      (entry) => entry && entry.tabId === tabId && UNFINISHED_SCHEDULE_STATUSES[entry.status]
    );
    if (!item) {
      return;
    }
    const rawUrl = (changeInfo.url || (tab && tab.url) || '');
    trace(item.id, 'sw', 'tab-updated', {
      tabId: tabId,
      loading: changeInfo.status || null,
      url: rawUrl ? String(rawUrl).split(/[?#]/)[0] : null,
      meetUrlVisible: !!rawUrl
    });
  }

  /**
   * Eklenti kurulduğunda/güncellendiğinde varsayılan ayarları yaz.
   */
  async function handleInstalled() {
    try {
      await Storage.saveSettings({});
      console.info('[MNA] Varsayılan ayarlar hazırlandı.');
    } catch (err) {
      console.error('[MNA] Varsayılan ayarlar yazılamadı:', err);
    }
    try {
      await withScheduleLock(() => resyncAlarms());
    } catch (err) {
      console.error('[MNA] Katılım alarmları yenilenemedi:', err);
    }
  }

  async function handleStartup() {
    try {
      const joins = await readJoins();
      trace(null, 'sw', 'browser-startup', {
        scheduled: joins
          .filter((entry) => entry && entry.status === 'scheduled')
          .map((entry) => ({ id: entry.id, startAt: entry.startAt, endAt: entry.endAt || null }))
      });
    } catch (err) {
      /* günlük isteğe bağlıdır */
    }
    try {
      await withScheduleLock(() => resyncAlarms());
    } catch (err) {
      console.error('[MNA] Katılım alarmları yenilenemedi:', err);
    }
  }

  return {
    handleMessage: handleMessage,
    handleTabRemoved: handleTabRemoved,
    handleTabUpdated: handleTabUpdated,
    handleInstalled: handleInstalled,
    handleStartup: handleStartup,
    handleAlarm: handleAlarm
  };
})();

/* -------------------- dinleyici kayıtları -------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  MNA.handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((err) => {
      console.error('[MNA] Mesaj işlenemedi:', err);
      // Kullanıcıya ham hata metni gösterilmez (teknik jargon sızar);
      // ayrıntı konsola yazılır.
      const message = (err && err.message) ? err.message : '';
      const userFacing = /Depolama alanı doldu|Veri kaydedilemedi/.test(message)
        ? message
        : 'İşlem tamamlanamadı. Ayrıntı için eklenti konsoluna bakın.';
      sendResponse({ ok: false, error: userFacing });
    });
  return true; // yanıt asenkron dönecek
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Promise döndürülür: işlem tamamlanana kadar beklenebilsin.
  return MNA.handleTabRemoved(tabId);
});

if (chrome.tabs && chrome.tabs.onUpdated && typeof chrome.tabs.onUpdated.addListener === 'function') {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    MNA.handleTabUpdated(tabId, changeInfo, tab).catch(() => undefined);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  return MNA.handleInstalled();
});

if (chrome.alarms && chrome.alarms.onAlarm && typeof chrome.alarms.onAlarm.addListener === 'function') {
  chrome.alarms.onAlarm.addListener((alarm) => {
    try {
      return MNA.handleAlarm(alarm);
    } catch (err) {
      console.error('[MNA] Alarm işlenemedi:', err);
      return undefined;
    }
  });
}

if (chrome.runtime.onStartup && typeof chrome.runtime.onStartup.addListener === 'function') {
  chrome.runtime.onStartup.addListener(() => {
    return MNA.handleStartup();
  });
}
