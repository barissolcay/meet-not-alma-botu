/**
 * MNA Protocol - Eklentinin tüm mesaj tipleri, depolama anahtarları ve varsayılanlar.
 *
 * Bu dosya "paylaşılan kimlik" katmanıdır: içerik betiği, service worker, popup,
 * options ve history sayfaları aynı type string'lerini kullanır.
 *
 * UMD sarmalayıcı: tarayıcıda globalThis.MNAProtocol, Node'da module.exports.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && typeof module.exports === 'object') {
    module.exports = api;
  }
  root.MNAProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Mesaj tipleri. Anahtar ve değer aynıdır; böylece tip hem
   * MESSAGE_TYPES.MNA_STATUS hem de 'MNA_STATUS' olarak kullanılabilir.
   */
  var MESSAGE_TYPES = {
    /* Popup / History -> Content script */
    'MNA_STATUS': 'MNA_STATUS',
    'MNA_GET_LINES': 'MNA_GET_LINES',
    'MNA_SET_CAPTURE': 'MNA_SET_CAPTURE',
    'MNA_RESET': 'MNA_RESET',
    'MNA_FLUSH': 'MNA_FLUSH',
    'MNA_TOGGLE_CAPTIONS': 'MNA_TOGGLE_CAPTIONS',

    /* Content script -> Background */
    'MNA_LINES_APPENDED': 'MNA_LINES_APPENDED',

    /* Background -> Content script */
    'MNA_CAPTURE_STATE': 'MNA_CAPTURE_STATE',

    /* Popup / History -> Background */
    'MNA_SESSION_START': 'MNA_SESSION_START',
    'MNA_SESSION_STOP': 'MNA_SESSION_STOP',
    'MNA_SESSION_LIST': 'MNA_SESSION_LIST',
    'MNA_SESSION_GET': 'MNA_SESSION_GET',
    'MNA_SESSION_DELETE': 'MNA_SESSION_DELETE',
    'MNA_SESSION_UPDATE': 'MNA_SESSION_UPDATE',
    'MNA_ACTIVE_SESSION': 'MNA_ACTIVE_SESSION',

    /* Planlı katılım: popup -> background, background -> content */
    'MNA_SCHEDULE_SAVE': 'MNA_SCHEDULE_SAVE',
    'MNA_SCHEDULE_LIST': 'MNA_SCHEDULE_LIST',
    'MNA_SCHEDULE_CANCEL': 'MNA_SCHEDULE_CANCEL',
    'MNA_SCHEDULE_STATUS': 'MNA_SCHEDULE_STATUS',
    'MNA_SCHEDULED_HELLO': 'MNA_SCHEDULED_HELLO',
    'MNA_BEGIN_SCHEDULED_JOIN': 'MNA_BEGIN_SCHEDULED_JOIN',
    'MNA_SCHEDULED_CAPTURE_START': 'MNA_SCHEDULED_CAPTURE_START',
    'MNA_SCHEDULED_LEAVE': 'MNA_SCHEDULED_LEAVE',
    'MNA_SCHEDULED_CANCEL': 'MNA_SCHEDULED_CANCEL',
    'MNA_SCHEDULED_MEETING_ENDED': 'MNA_SCHEDULED_MEETING_ENDED',
    'MNA_JOIN_TRACE': 'MNA_JOIN_TRACE'
  };

  /** chrome.storage anahtarları */
  var STORAGE_KEYS = {
    settings: 'mna.settings',
    sessions: 'mna.sessions',
    activeSession: 'mna.activeSession',
    activeLines: 'mna.activeLines',
    scheduledJoins: 'mna.scheduledJoins'
  };

  /** Varsayılan ayarlar (settings.js içindeki DEFAULT_SETTINGS ile aynı) */
  var DEFAULTS = {
    graceMs: 2500,
    speakerFallback: 'Bilinmeyen',
    includeTimestamps: true,
    junkFilter: true,
    autoStartOnCc: false,
    autoStopWhenAlone: true,
    autoStopSilenceMin: 0,
    maxStoredSessions: 100
  };

  /**
   * Yardımcı mesaj tipleri.
   * Ana akış (MESSAGE_TYPES) dışında, içerik betiğinin sekmeye geri bağlanırken
   * arka planla konuşmak için kullanılabilecek toleranslı tip adları.
   */
  var AUX_MESSAGE_TYPES = {
    'MNA_CONTENT_READY': 'MNA_CONTENT_READY',
    'MNA_READY': 'MNA_READY',
    'MNA_HELLO': 'MNA_HELLO',
    'MNA_RESUME': 'MNA_RESUME',
    'MNA_CAPTURE_STATE_REQUEST': 'MNA_CAPTURE_STATE_REQUEST'
  };

  /** İçerik betiği service worker'a bağlanırken MNA_ACTIVE_SESSION gönderebilir. */
  var RESUME_HANDSHAKE_TYPE = 'MNA_ACTIVE_SESSION';

  return {
    MESSAGE_TYPES: MESSAGE_TYPES,
    AUX_MESSAGE_TYPES: AUX_MESSAGE_TYPES,
    STORAGE_KEYS: STORAGE_KEYS,
    DEFAULTS: DEFAULTS,
    RESUME_HANDSHAKE_TYPE: RESUME_HANDSHAKE_TYPE
  };
});
