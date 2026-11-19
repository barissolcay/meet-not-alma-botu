/**
 * MNA Storage - Tüm chrome.storage erişimi bu dosyada toplanır.
 *
 *   chrome.storage.local
 *     mna.settings       -> ayarlar
 *     mna.sessionIndex   -> oturum dizini (özet bilgiler, hafif)
 *     mna.session.<id>   -> tek tek oturum verisi (satırlar dahil)
 *     mna.activeSession  -> { sessionId, startedAt, meetingUrl, meetingCode, title, tabId } | null
 *
 *   chrome.storage.session (geçici yedek, service worker yeniden başlasa da kayıt kaybolmaz)
 *     mna.activeLines    -> commit edilmiş satırlar
 *     mna.activeTabId    -> kayıt yapılan sekmenin id'si
 *     mna.sessionMirror  -> uzun oturumların tam yedeği
 *
 * Neden oturum başına ayrı anahtar?
 *   Oturumlar tek bir "mna.sessions" haritasında tutulurken, bir satır
 *   ekleme işlemi tüm haritayı okuyup yeniden yazıyordu. Eşzamanlı iki
 *   yazma aynı haritanın kopyasını okuyup "son yazan kazanır" diye
 *   bitiyordu: satırlar sessizce kayboluyordu. Oturum başına ayrı anahtar
 *   yazma alanını oturumla sınırlar, ayrıca her satır için tüm geçmişi
 *   yeniden yazma maliyetini (yazma amplifikasyonu) ortadan kaldırır.
 *
 * Neden ayrı "mna.sessionMirror" anahtarı?
 *   Daha önce yedek de "mna.activeSession" anahtarına, ama chrome.storage.session
 *   alanına yazılıyordu. Yedek hiçbir zaman temizlenmediği için bir sonraki
 *   toplantının sonucu, önceki toplantının satırlarını miras alabiliyordu.
 */
(function (root) {
  'use strict';

  var PROTOCOL = root.MNAProtocol || null;
  var KEYS = (PROTOCOL && PROTOCOL.STORAGE_KEYS) || {
    settings: 'mna.settings',
    sessions: 'mna.sessions',
    activeSession: 'mna.activeSession',
    activeLines: 'mna.activeLines'
  };
  var DEFAULTS = (PROTOCOL && PROTOCOL.DEFAULTS) || {
    graceMs: 2500,
    speakerFallback: 'Bilinmeyen',
    includeTimestamps: true,
    junkFilter: true,
    autoStartOnCc: false,
    maxStoredSessions: 100
  };

  var SESSION_PREFIX = 'mna.session.';
  var INDEX_KEY = 'mna.sessionIndex';
  var MIRROR_KEY = 'mna.sessionMirror';

  /* chrome.storage.session kullanılabilir mi? (Chrome 102+) */
  function hasSessionStorage() {
    try {
      return !!(chrome && chrome.storage && chrome.storage.session);
    } catch (err) {
      return false;
    }
  }

  /* -------------------- düşük seviye yardımcılar -------------------- */

  function readLocal(key) {
    return chrome.storage.local.get(key).then(function (result) {
      return result ? result[key] : undefined;
    });
  }

  /**
   * Kota hatalarını anlaşılır bir mesaja çevirir. Ham hata mesajı
   * ("QUOTA_BYTES: storage quota exceeded") kullanıcıya gösterilirse
   * eklentinin bozuk göründüğü anlaşılmaz.
   */
  function describeStorageError(err) {
    var message = (err && err.message) ? err.message : String(err);
    if (/QUOTA_BYTES|quota/i.test(message)) {
      return new Error(
        'Depolama alanı doldu. Eski oturumları silin veya "Azami oturum sayısı" ayarını düşürün.'
      );
    }
    return new Error('Veri kaydedilemedi: ' + message);
  }

  function writeLocal(key, value) {
    var payload = {};
    payload[key] = value;
    return chrome.storage.local.set(payload).catch(function (err) {
      console.error('[MNA] Depolamaya yazılamadı (' + key + '):', err);
      throw describeStorageError(err);
    });
  }

  function removeLocal(key) {
    return chrome.storage.local.remove(key).catch(function (err) {
      console.error('[MNA] Depolamadan silinemedi (' + key + '):', err);
      throw describeStorageError(err);
    });
  }

  function readSessionArea(key) {
    if (!hasSessionStorage()) {
      return readLocal(key);
    }
    return chrome.storage.session.get(key).then(function (result) {
      return result ? result[key] : undefined;
    });
  }

  function writeSessionArea(key, value) {
    if (!hasSessionStorage()) {
      return writeLocal(key, value);
    }
    var payload = {};
    payload[key] = value;
    return chrome.storage.session.set(payload).catch(function (err) {
      console.error('[MNA] Geçici yedeğe yazılamadı (' + key + '):', err);
      throw describeStorageError(err);
    });
  }

  function removeSessionArea(key) {
    if (!hasSessionStorage()) {
      return removeLocal(key);
    }
    return chrome.storage.session.remove(key).catch(function (err) {
      console.error('[MNA] Geçici yedek silinemedi (' + key + '):', err);
      throw describeStorageError(err);
    });
  }

  /* -------------------- yazma sıralaması -------------------- */

  /**
   * chrome.storage üzerinde okuma-değiştirme-yazma atomik DEĞİLDİR.
   * Aynı oturuma eşzamanlı yazan iki işlem birbirinin yazdığı veriyi
   * ezebilirdi. Tüm yerel yazma işlemleri tek bir kuyrukta sıralanır:
   * her işlem en güncel veriyi okur, sonra yazar.
   */
  var writeQueue = Promise.resolve();

  function withWriteLock(task) {
    var result = writeQueue.then(task, task);
    // Kuyruk zinciri kopmasın: hata bir sonraki işi engellememeli.
    writeQueue = result.then(noop, noop);
    return result;
  }

  function noop() {}

  /* -------------------- ayarlar (storage.js üzerinden de erişilebilir) -------------------- */

  function getSettings() {
    var settings = root.MNASettings;
    if (settings && typeof settings.getSettings === 'function') {
      return Promise.resolve(settings.getSettings());
    }
    // MNASettings yüklenmemişse dahili yedek uygulama.
    return readLocal(KEYS.settings).then(function (stored) {
      return Object.assign({}, DEFAULTS, stored || {});
    }).catch(function (err) {
      console.error('[MNA] Ayarlar okunamadı:', err);
      return Object.assign({}, DEFAULTS);
    });
  }

  function saveSettings(patch) {
    var settings = root.MNASettings;
    if (settings && typeof settings.saveSettings === 'function') {
      return Promise.resolve(settings.saveSettings(patch));
    }
    return getSettings().then(function (current) {
      var next = Object.assign({}, current, patch || {});
      return writeLocal(KEYS.settings, next).then(function () { return next; });
    });
  }

  /* -------------------- oturumlar -------------------- */

  function sessionKey(id) {
    return SESSION_PREFIX + id;
  }

  function isSessionKey(key) {
    return typeof key === 'string' && key.indexOf(SESSION_PREFIX) === 0;
  }

  function readIndex() {
    return readLocal(INDEX_KEY).then(function (value) {
      return (value && Array.isArray(value)) ? value : [];
    }).catch(function (err) {
      console.error('[MNA] Oturum dizini okunamadı:', err);
      return [];
    });
  }

  function writeIndex(index) {
    return writeLocal(INDEX_KEY, index);
  }

  /** Oturumun dizin kaydı (özet bilgiler). */
  function indexEntry(session) {
    return {
      id: session.id,
      title: session.title || '',
      meetingUrl: session.meetingUrl || '',
      meetingCode: session.meetingCode || '',
      startedAt: Number(session.startedAt) || 0,
      endedAt: Number(session.endedAt) || null,
      createdAt: Number(session.createdAt) || Number(session.startedAt) || 0,
      updatedAt: Number(session.updatedAt) || Date.now(),
      lineCount: Array.isArray(session.lines) ? session.lines.length : 0
    };
  }

  /** Dizine ekler/günceller (kuyruk içinde çağrılmalı). */
  function upsertIndex(entry) {
    return readIndex().then(function (index) {
      var replaced = false;
      for (var i = 0; i < index.length; i += 1) {
        if (index[i] && index[i].id === entry.id) {
          index[i] = entry;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        index.push(entry);
      }
      index.sort(function (a, b) {
        return (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0);
      });
      return writeIndex(index).then(function () { return index; });
    });
  }

  function removeFromIndex(id) {
    return readIndex().then(function (index) {
      var next = index.filter(function (item) { return !item || item.id !== id; });
      return writeIndex(next).then(function () { return next; });
    });
  }

  /**
   * Tüm oturumları en yeniden eskiye doğru sıralı döndürür.
   * Satırlar yüklenmez; yalnızca dizin bilgisi okunur (hafif).
   * @returns {Promise<Array>}
   */
  function listSessions() {
    return readIndex().then(function (index) {
      var list = index.filter(Boolean);
      list.sort(function (a, b) {
        return (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0);
      });
      return list;
    }).catch(function (err) {
      console.error('[MNA] Oturumlar okunamadı:', err);
      return [];
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  function getSession(id) {
    if (!id) { return Promise.resolve(null); }
    return readLocal(sessionKey(id)).then(function (value) {
      return (value && typeof value === 'object') ? value : null;
    }).catch(function (err) {
      console.error('[MNA] Oturum okunamadı:', err);
      return null;
    });
  }

  /**
   * Oturumu kaydeder (yoksa ekler).
   * @param {Object} session
   * @returns {Promise<Object>} kaydedilen oturum
   */
  function saveSession(session) {
    if (!session || !session.id) {
      return Promise.reject(new Error('Oturum id eksik.'));
    }
    var id = session.id;
    return withWriteLock(function () {
      var next = Object.assign({}, session);
      if (!Array.isArray(next.lines)) { next.lines = []; }
      next.lineCount = next.lines.length;
      next.updatedAt = Number(next.updatedAt) || Date.now();
      return writeLocal(sessionKey(id), next)
        .then(function () { return upsertIndex(indexEntry(next)); })
        .then(function () { return next; });
    });
  }

  /**
   * Oturumu okur, değiştirir ve yazar — tek bir atomik adımda.
   * @param {string} id
   * @param {Function} mutator oturum nesnesini değiştiren fonksiyon
   * @returns {Promise<Object|null>} güncellenmiş oturum
   */
  function updateSession(id, mutator) {
    if (!id) { return Promise.resolve(null); }
    return withWriteLock(function () {
      return readLocal(sessionKey(id)).then(function (session) {
        if (!session || typeof session !== 'object') { return null; }
        if (!Array.isArray(session.lines)) { session.lines = []; }
        if (typeof mutator === 'function') {
          mutator(session);
        }
        session.lineCount = session.lines.length;
        session.updatedAt = Date.now();
        return writeLocal(sessionKey(id), session)
          .then(function () { return upsertIndex(indexEntry(session)); })
          .then(function () { return session; });
      });
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>} silindiyse true
   */
  function deleteSession(id) {
    if (!id) { return Promise.resolve(false); }
    return withWriteLock(function () {
      return readLocal(sessionKey(id)).then(function (session) {
        if (!session) { return false; }
        return removeLocal(sessionKey(id))
          .then(function () { return removeFromIndex(id); })
          .then(function () { return true; });
      });
    });
  }

  /**
   * Oturum başlığını günceller.
   * @returns {Promise<Object|null>} güncellenmiş oturum
   */
  function updateSessionTitle(id, title) {
    if (!id) { return Promise.resolve(null); }
    var clean = String(title == null ? '' : title).trim();
    if (!clean) { return Promise.resolve(null); }
    return updateSession(id, function (session) {
      session.title = clean;
    });
  }

  /**
   * Oturuma satır ekler.
   *
   * Aynı id'li satır gelirse ESKİ SATIRIN YERİNE GEÇER (güncellenir), atlanmaz:
   * Meet canlı altyazıda konuşma sırasında metni revize eder ve revizyon
   * grace süresi dolduktan sonra gelirse aynı konuşma turu ikinci bir satır
   * olarak eklenirse dökümde mükerrer görünür.
   *
   * @param {string} sessionId
   * @param {Array} lines
   * @returns {Promise<Object|null>} güncellenmiş oturum
   */
  function appendLines(sessionId, lines) {
    if (!sessionId || !Array.isArray(lines) || !lines.length) {
      return getSession(sessionId);
    }
    var added = 0;
    var revised = 0;
    return updateSession(sessionId, function (session) {
      // id -> dizin indeksi (revize satırları yerinde güncellenir).
      var index = Object.create(null);
      // İçerikten türetilen anahtarlar (id'siz satırlar) için tekilleştirme.
      var seen = Object.create(null);
      session.lines.forEach(function (line, i) {
        seen[lineKey(line)] = true;
        if (line && line.id) {
          index['id:' + line.id] = i;
        }
      });
      lines.forEach(function (line) {
        if (!line) { return; }
        if (line.id) {
          var pos = index['id:' + line.id];
          if (pos !== undefined) {
            // Aynı satır, revize edilmiş metin -> yerinde güncelle.
            session.lines[pos] = Object.assign({}, session.lines[pos], line);
            revised += 1;
            return;
          }
        }
        var key = lineKey(line);
        if (seen[key]) { return; }
        seen[key] = true;
        if (line.id) {
          index['id:' + line.id] = session.lines.length;
        }
        session.lines.push(line);
        added += 1;
      });
    }).then(function (session) {
      if (!session) { return null; }
      return Object.assign({}, session, { appended: added, revised: revised });
    });
  }

  /** Satır için benzersiz anahtar (id yoksa içerikten türetilir). */
  function lineKey(line) {
    if (line.id) { return 'id:' + line.id; }
    return 'c:' + (line.seq || '') + '|' + (line.startedAt || '') + '|' + (line.text || '');
  }

  /**
   * Azami oturum sayısını aşan en eski oturumları siler.
   * Aktif oturum ASLA silinmez (aksi halde kayıt kapatılamaz hale gelir).
   * @param {number} limit
   * @returns {Promise<number>} silinen oturum sayısı
   */
  function pruneSessions(limit) {
    var max = Number(limit) > 0 ? Math.floor(Number(limit)) : DEFAULTS.maxStoredSessions;
    return getActiveSession().then(function (active) {
      var activeId = active && active.sessionId ? active.sessionId : null;
      return listSessions().then(function (list) {
        if (list.length <= max) { return 0; }
        var excess = list.slice(max);
        var removable = excess.filter(function (session) {
          return !activeId || session.id !== activeId;
        });
        if (!removable.length) { return 0; }
        return removable.reduce(function (chain, session) {
          return chain.then(function (count) {
            return deleteSession(session.id).then(function () {
              return count + 1;
            });
          });
        }, Promise.resolve(0));
      });
    }).catch(function (err) {
      console.error('[MNA] Oturum temizleme hatası:', err);
      return 0;
    });
  }

  /* -------------------- aktif oturum -------------------- */

  /** @returns {Promise<Object|null>} */
  function getActiveSession() {
    return readLocal(KEYS.activeSession).then(function (value) {
      return (value && typeof value === 'object') ? value : null;
    }).catch(function (err) {
      console.error('[MNA] Aktif oturum okunamadı:', err);
      return null;
    });
  }

  /** @param {Object|null} value */
  function setActiveSession(value) {
    if (!value) { return clearActiveSession(); }
    return writeLocal(KEYS.activeSession, value);
  }

  function clearActiveSession() {
    return removeLocal(KEYS.activeSession);
  }

  /* -------------------- aktif satır yedeği (chrome.storage.session) -------------------- */

  /** @returns {Promise<Array>} */
  function getActiveLines() {
    return readSessionArea(KEYS.activeLines).then(function (value) {
      return Array.isArray(value) ? value : [];
    }).catch(function (err) {
      console.error('[MNA] Aktif satırlar okunamadı:', err);
      return [];
    });
  }

  /** @param {Array} lines */
  function setActiveLines(lines) {
    var safe = Array.isArray(lines) ? lines.slice(-5000) : [];
    return writeSessionArea(KEYS.activeLines, safe);
  }

  function clearActiveLines() {
    return removeSessionArea(KEYS.activeLines);
  }

  /* -------------------- yardımcılar: kayıt sekmesi ve tam oturum yedeği -------------------- */

  /** @returns {Promise<number|null>} */
  function getActiveTabId() {
    return readSessionArea('mna.activeTabId').then(function (value) {
      return (value === undefined || value === null) ? null : Number(value);
    }).catch(function () { return null; });
  }

  /** @param {number} tabId */
  function setActiveTabId(tabId) {
    if (tabId === null || tabId === undefined) { return clearActiveTabId(); }
    return writeSessionArea('mna.activeTabId', Number(tabId));
  }

  function clearActiveTabId() {
    return removeSessionArea('mna.activeTabId');
  }

  /**
   * Uzun oturumların tamamını chrome.storage.session'a yedekler.
   * NOT: Bu anahtar "mna.activeSession" DEĞİLDİR. Daha önce aynı isim
   * kullanıldığı için yedek, bir sonraki oturumun sonucunu bozuyordu.
   */
  function setSessionMirror(session) {
    if (!hasSessionStorage()) {
      // Eski tarayıcılarda yedek alanı yoksa hiç yazma: local alanına
      // yazmak aktif oturum göstergesini eziyordu.
      return Promise.resolve(false);
    }
    return writeSessionArea(MIRROR_KEY, session).then(function () { return true; });
  }

  function getSessionMirror() {
    if (!hasSessionStorage()) {
      return Promise.resolve(null);
    }
    return readSessionArea(MIRROR_KEY).then(function (value) {
      return (value && typeof value === 'object') ? value : null;
    }).catch(function () { return null; });
  }

  function clearSessionMirror() {
    if (!hasSessionStorage()) {
      return Promise.resolve(false);
    }
    return removeSessionArea(MIRROR_KEY).then(function () { return true; });
  }

  root.MNAStorage = {
    /* ayarlar */
    getSettings: getSettings,
    saveSettings: saveSettings,
    /* oturumlar */
    listSessions: listSessions,
    getSession: getSession,
    saveSession: saveSession,
    updateSession: updateSession,
    deleteSession: deleteSession,
    updateSessionTitle: updateSessionTitle,
    appendLines: appendLines,
    pruneSessions: pruneSessions,
    /* aktif oturum */
    getActiveSession: getActiveSession,
    setActiveSession: setActiveSession,
    clearActiveSession: clearActiveSession,
    /* aktif satır yedeği */
    getActiveLines: getActiveLines,
    setActiveLines: setActiveLines,
    clearActiveLines: clearActiveLines,
    /* yardımcılar */
    getActiveTabId: getActiveTabId,
    setActiveTabId: setActiveTabId,
    clearActiveTabId: clearActiveTabId,
    setSessionMirror: setSessionMirror,
    getSessionMirror: getSessionMirror,
    clearSessionMirror: clearSessionMirror
  };

  if (typeof module === 'object' && module && typeof module.exports === 'object') {
    module.exports = root.MNAStorage;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
