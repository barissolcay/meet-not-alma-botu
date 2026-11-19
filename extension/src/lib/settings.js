/**
 * MNA Settings - Varsayılan ayarlar ve ayar okuma/yazma işlemleri.
 *
 * Bu dosya kendi başına çalışabilir (chrome.storage.local kullanır);
 * storage.js'in bulunmadığı ortamlarda da kullanılabilir olması için
 * MNAStorage'ya yalnızca "yumuşak" (opsiyonel) bağımlılık vardır.
 */
(function (root) {
  'use strict';

  /** Ayarların varsayılan değerleri. */
  var DEFAULT_SETTINGS = {
    /* Altyazı satırlarının birleştirilmesi için beklenecek süre (ms) */
    graceMs: 2500,
    /* Konuşmacı bilinmiyorsa kullanılacak etiket */
    speakerFallback: 'Bilinmeyen',
    /* Meet'in "Siz" gibi yerel kullanıcı etiketlerinin karşılığı */
    localSpeakerName: 'Ben',
    /* Dışa aktarımda zaman damgası eklensin mi */
    includeTimestamps: true,
    /* Altyazı gürültülerini (yankı vb.) temizle */
    junkFilter: true,
    /* Meet'te altyazılar açıldığında kaydı otomatik başlat */
    autoStartOnCc: false,
    /* Başkaları çıkıp tek başına kalınca (≈5 dk sonra) kaydı durdur */
    autoStopWhenAlone: true,
    /* Bu kadar dakika hiç konuşma satırı gelmezse kaydı durdur (0 = kapalı) */
    autoStopSilenceMin: 0,
    /* Saklanacak azami oturum sayısı (aşılırsa en eskiler silinir) */
    maxStoredSessions: 100
  };

  var PROTOCOL = root.MNAProtocol || null;
  var STORAGE_KEY = (PROTOCOL && PROTOCOL.STORAGE_KEYS && PROTOCOL.STORAGE_KEYS.settings) || 'mna.settings';

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /**
   * Ayarları okur; eksik alanlar varsayılanlarla tamamlanır.
   * @returns {Promise<Object>}
   */
  function getSettings() {
    try {
      return chrome.storage.local.get(STORAGE_KEY).then(function (result) {
        var stored = (result && result[STORAGE_KEY]) || {};
        return Object.assign({}, DEFAULT_SETTINGS, stored);
      }).catch(function (err) {
        console.error('[MNA] Ayarlar okunamadı:', err);
        return Object.assign({}, DEFAULT_SETTINGS);
      });
    } catch (err) {
      console.error('[MNA] Ayarlar okunamadı:', err);
      return Promise.resolve(Object.assign({}, DEFAULT_SETTINGS));
    }
  }

  /**
   * Ayarları yazar (yarım güncelleme - patch).
   * @param {Object} patch
   * @returns {Promise<Object>} kaydedilmiş ayarlar
   */
  function saveSettings(patch) {
    return getSettings().then(function (current) {
      var next = Object.assign({}, current, patch || {});

      next.graceMs = clamp(Math.round(Number(next.graceMs)) || DEFAULT_SETTINGS.graceMs, 500, 5000);
      next.maxStoredSessions = clamp(Math.round(Number(next.maxStoredSessions)) || DEFAULT_SETTINGS.maxStoredSessions, 1, 1000);
      next.speakerFallback = String(next.speakerFallback == null ? '' : next.speakerFallback).trim() || DEFAULT_SETTINGS.speakerFallback;
      next.localSpeakerName = String(next.localSpeakerName == null ? '' : next.localSpeakerName).trim() || DEFAULT_SETTINGS.localSpeakerName;
      next.includeTimestamps = Boolean(next.includeTimestamps);
      next.junkFilter = Boolean(next.junkFilter);
      next.autoStartOnCc = Boolean(next.autoStartOnCc);
      next.autoStopWhenAlone = next.autoStopWhenAlone === undefined ? true : Boolean(next.autoStopWhenAlone);
      var silence = Math.round(Number(next.autoStopSilenceMin));
      // 0 = kapalı; açıksa en az 10, en çok 240 dakika.
      next.autoStopSilenceMin = !Number.isFinite(silence) || silence <= 0 ? 0 : clamp(silence, 10, 240);

      var payload = {};
      payload[STORAGE_KEY] = next;

      return chrome.storage.local.set(payload).then(function () {
        // Oturum sayısı sınırı düşürüldüyse eski oturumları temizle (yumuşak bağımlılık).
        var storage = root.MNAStorage;
        if (storage && typeof storage.pruneSessions === 'function') {
          return Promise.resolve(storage.pruneSessions(next.maxStoredSessions))
            .catch(function (err) { console.error('[MNA] Oturum temizleme hatası:', err); })
            .then(function () { return next; });
        }
        return next;
      });
    }).catch(function (err) {
      console.error('[MNA] Ayarlar kaydedilemedi:', err);
      throw err;
    });
  }

  root.MNASettings = {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    getSettings: getSettings,
    saveSettings: saveSettings
  };

  if (typeof module === 'object' && module && typeof module.exports === 'object') {
    module.exports = root.MNASettings;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
