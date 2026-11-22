/**
 * Planlı katılım — saf kurallar.
 *
 * Bağlantı doğrulama, 60 dakikalık pencere ve kullanıcıya görünen durum
 * metinleri burada toplanır. DOM tıklaması ve chrome.alarms bu dosyada yoktur.
 *
 * UMD: tarayıcıda globalThis.MNASchedule, Node'da module.exports.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && typeof module.exports === 'object') {
    module.exports = api;
  }
  if (root) {
    root.MNASchedule = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Katılma isteği bu süreden sonra yenilenmez. Başlangıç saatinden ölçülür. */
  var JOIN_WINDOW_MS = 60 * 60 * 1000;
  /**
   * datetime-local dakika hassastır; içinde bulunulan dakika "geçmiş" sayılmaz.
   * Bundan eski bir saat kaydedilmez.
   */
  var PAST_GRACE_MS = 60 * 1000;

  var STORAGE_KEY = 'mna.scheduledJoins';

  var LINK_ERROR = 'Geçerli bir Google Meet bağlantısı girin (ör. https://meet.google.com/abc-defg-hij).';

  var STATUS_TEXT = {
    scheduled: 'Planlandı',
    opening: 'Katılım başlıyor.',
    joining: 'Toplantı sekmesi açıldı.',
    waiting: 'Katılma isteği gönderildi, kabul bekleniyor.',
    admitted: 'Toplantıya katıldı, altyazı açılıyor.',
    recording: 'Toplantıya katıldı, kayıt başladı.',
    blocked: 'Mikrofon veya kamera kapatılamadı; katılınmadı.',
    permission: 'Mikrofon/kamera izin penceresi geçilemedi. Toplantı sekmesinde izin verip mikrofonu ve kamerayı kapatın.',
    skipped: 'Mevcut kayıt yüzünden bu toplantı atlandı.',
    expired: 'Başlangıçtan 60 dakika geçti, katılınmadı.',
    ended: 'Toplantı bitti, kayıt durduruldu.',
    removed: 'Toplantıdan çıkarıldınız, kayıt durduruldu.',
    callEnded: 'Arama sona erdi, kayıt durduruldu.',
    left: 'Toplantıdan ayrıldınız, kayıt durduruldu.',
    alone: 'Toplantıda yalnız kaldınız, kayıt durduruldu.',
    idleStop: 'Uzun süre konuşma gelmediği için kayıt durduruldu.',
    endedByTime: 'Bitiş saatinde kayıt durduruldu.',
    failed: 'Toplantı sekmesi açılamadı.',
    tabClosedRecording: 'Toplantı sekmesi kapatıldı, kayıt durduruldu.',
    tabClosedNotJoined: 'Toplantı sekmesi kapatıldı, katılınmadı.'
  };

  /** İçerik betiğinden gelen ara durumlar, bitiş durumlarının üzerine yazılamaz. */
  var STATUS_RANK = {
    scheduled: 1,
    opening: 2,
    joining: 3,
    waiting: 4,
    admitted: 5,
    blocked: 3,
    recording: 6,
    ended: 7,
    endedByTime: 7,
    expired: 7,
    skipped: 7,
    failed: 7
  };

  var RESUMABLE = {
    opening: true,
    joining: true,
    waiting: true,
    admitted: true,
    blocked: true,
    recording: true
  };

  var CANCEL_STOPS = {
    scheduled: true,
    opening: true,
    joining: true,
    waiting: true,
    admitted: true,
    blocked: true
  };

  function statusText(code) {
    return STATUS_TEXT[code] || '';
  }

  function statusRank(status) {
    var rank = STATUS_RANK[status];
    return typeof rank === 'number' ? rank : 0;
  }

  function joinAlarmName(id) {
    return 'mna.join.' + id;
  }

  function endAlarmName(id) {
    return 'mna.end.' + id;
  }

  function parseAlarmName(name) {
    var text = String(name || '');
    var join = /^mna\.join\.(.+)$/.exec(text);
    if (join) {
      return { kind: 'join', id: join[1] };
    }
    var end = /^mna\.end\.(.+)$/.exec(text);
    if (end) {
      return { kind: 'end', id: end[1] };
    }
    return null;
  }

  /**
   * @param {string} input
   * @returns {{ok:true, url:string, meetingCode:string}|{ok:false, error:string}}
   */
  function parseMeetLink(input) {
    var raw = String(input == null ? '' : input).trim();
    if (!raw || /[\s<>]/.test(raw)) {
      return { ok: false, error: LINK_ERROR };
    }
    var candidate = raw;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
      candidate = 'https://' + candidate.replace(/^\/\//, '');
    }
    if (!/^https:\/\//i.test(candidate)) {
      return { ok: false, error: LINK_ERROR };
    }
    var match = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?=$|[/?#])/i.exec(candidate);
    if (!match) {
      return { ok: false, error: LINK_ERROR };
    }
    var code = match[1].toLowerCase();
    var url = 'https://meet.google.com/' + code;
    var rest = candidate.slice(match[0].length);
    if (rest.charAt(0) === '?') {
      var query = rest.split('#')[0];
      if (/^\?[A-Za-z0-9._~%=&+-]*$/.test(query)) {
        url += query;
      }
    }
    return { ok: true, url: url, meetingCode: code };
  }

  /**
   * datetime-local değeri (YYYY-MM-DDTHH:mm) yerel saate çevrilir.
   * @returns {number|null}
   */
  function parseDateTimeLocal(value) {
    var text = String(value || '').trim();
    var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
    if (!match) {
      return null;
    }
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var hour = Number(match[4]);
    var minute = Number(match[5]);
    var second = match[6] ? Number(match[6]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return null;
    }
    var date = new Date(year, month - 1, day, hour, minute, second, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    var time = date.getTime();
    return Number.isFinite(time) ? time : null;
  }

  /**
   * @param {{url:string, startAt:number, endAt?:number|null, now?:number}} input
   */
  function validateSchedule(input) {
    var src = input || {};
    var now = Number(src.now);
    if (!Number.isFinite(now)) {
      now = Date.now();
    }
    var parsed = parseMeetLink(src.url);
    if (!parsed.ok) {
      return parsed;
    }
    var startAt = Number(src.startAt);
    if (!Number.isFinite(startAt)) {
      return { ok: false, error: 'Başlangıç saati geçerli değil.' };
    }
    if (startAt < now - PAST_GRACE_MS) {
      return { ok: false, error: 'Başlangıç saati geçmişte. Gelecek bir saat seçin.' };
    }
    var endAt = null;
    if (src.endAt !== null && src.endAt !== undefined && src.endAt !== '') {
      endAt = Number(src.endAt);
      if (!Number.isFinite(endAt)) {
        return { ok: false, error: 'Bitiş saati geçerli değil.' };
      }
      if (endAt <= startAt) {
        return { ok: false, error: 'Bitiş saati başlangıçtan sonra olmalı.' };
      }
    }
    return {
      ok: true,
      url: parsed.url,
      meetingCode: parsed.meetingCode,
      startAt: startAt,
      endAt: endAt
    };
  }

  /**
   * Alarm geç kalsa da karar başlangıç saatine göre verilir.
   * @returns {'join'|'expired'|'skipped'|'ignore'}
   */
  function decideJoinAlarm(item, now, recordingLive) {
    if (!item || item.status !== 'scheduled') {
      return 'ignore';
    }
    var startAt = Number(item.startAt);
    var at = Number(now);
    if (!Number.isFinite(startAt) || !Number.isFinite(at)) {
      return 'ignore';
    }
    if (at > startAt + JOIN_WINDOW_MS) {
      return 'expired';
    }
    if (recordingLive) {
      return 'skipped';
    }
    return 'join';
  }

  /**
   * Sekme yenilense bile bitiş gözlemi sürsün. Pencere kapandıysa
   * henüz içeri alınmamış katılım yeniden başlamaz.
   */
  function shouldResume(item, tabId, now) {
    if (!item || item.tabId !== tabId || !RESUMABLE[item.status]) {
      return false;
    }
    if (item.status === 'recording' || item.status === 'admitted') {
      return true;
    }
    var startAt = Number(item.startAt);
    var at = Number(now);
    if (!Number.isFinite(startAt) || !Number.isFinite(at)) {
      return false;
    }
    return at <= startAt + JOIN_WINDOW_MS;
  }

  function cancelsRunningJoin(status) {
    return !!CANCEL_STOPS[status];
  }

  /**
   * İçerik betiğinin bildirdiği faz → depolanan durum ve görünen metin.
   * @returns {{status:string, text:string}|null}
   */
  function phaseUpdate(phase, reason) {
    var key = reason || phase;
    if (key === 'alone' || phase === 'alone') {
      return { status: 'ended', text: STATUS_TEXT.alone };
    }
    if (key === 'silence' || phase === 'silence') {
      return { status: 'ended', text: STATUS_TEXT.idleStop };
    }
    if (key === 'removed' || phase === 'removed') {
      return { status: 'ended', text: STATUS_TEXT.removed };
    }
    if (key === 'left' || phase === 'left') {
      return { status: 'ended', text: STATUS_TEXT.left };
    }
    if (key === 'call-ended' || phase === 'call-ended') {
      return { status: 'ended', text: STATUS_TEXT.callEnded };
    }
    if (key === 'ended' || phase === 'ended') {
      return { status: 'ended', text: STATUS_TEXT.ended };
    }
    if (key === 'expired' || phase === 'expired') {
      return { status: 'expired', text: STATUS_TEXT.expired };
    }
    if (phase === 'waiting') {
      return { status: 'waiting', text: STATUS_TEXT.waiting };
    }
    if (phase === 'joining') {
      return { status: 'joining', text: STATUS_TEXT.joining };
    }
    if (phase === 'admitted') {
      return { status: 'admitted', text: STATUS_TEXT.admitted };
    }
    if (phase === 'recording') {
      return { status: 'recording', text: STATUS_TEXT.recording };
    }
    if (phase === 'blocked') {
      if (reason === 'permission') {
        return { status: 'blocked', text: STATUS_TEXT.permission };
      }
      return { status: 'blocked', text: STATUS_TEXT.blocked };
    }
    return null;
  }

  function sortJoins(list) {
    var items = Array.isArray(list) ? list.filter(Boolean) : [];
    items.sort(function (a, b) {
      var start = (Number(a.startAt) || 0) - (Number(b.startAt) || 0);
      if (start !== 0) {
        return start;
      }
      return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
    });
    return items;
  }

  return {
    JOIN_WINDOW_MS: JOIN_WINDOW_MS,
    PAST_GRACE_MS: PAST_GRACE_MS,
    STORAGE_KEY: STORAGE_KEY,
    LINK_ERROR: LINK_ERROR,
    STATUS_TEXT: STATUS_TEXT,
    statusText: statusText,
    statusRank: statusRank,
    joinAlarmName: joinAlarmName,
    endAlarmName: endAlarmName,
    parseAlarmName: parseAlarmName,
    parseMeetLink: parseMeetLink,
    parseDateTimeLocal: parseDateTimeLocal,
    validateSchedule: validateSchedule,
    decideJoinAlarm: decideJoinAlarm,
    shouldResume: shouldResume,
    cancelsRunningJoin: cancelsRunningJoin,
    phaseUpdate: phaseUpdate,
    sortJoins: sortJoins
  };
});
