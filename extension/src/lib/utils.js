/**
 * Meet Not Alma Botu — arayüz yardımcı fonksiyonları.
 *
 * Popup ve geçmiş sayfasının ortak kullandığı saf fonksiyonlar:
 * dosya adı üretimi, arama eşleşmesi, süre ve tarih biçimlendirme.
 * DOM veya Chrome API'sine dokunmazlar; test edilebilir olmaları için
 * ayrı bir modülde toplanmışlardır.
 *
 * UMD sarmalayıcı: tarayıcıda `globalThis.MNAUtils`,
 * Node'da `require('.../utils.js')`.
 */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MNAUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  /**
   * İndirilecek dosyanın adını üretir.
   * Örnek: meet-transkript-abc-defg-hij-20261107-143000.txt
   * @param {Object} session
   * @param {string} format
   * @returns {string}
   */
  function buildFilename(session, format) {
    const source = session && typeof session === 'object' ? session : {};
    const rawCode = String(source.meetingCode || '').trim();
    const code = rawCode.replace(/[^a-z0-9-]/gi, '') || 'oturum';
    const date = new Date(Number(source.startedAt) || Date.now());
    const stamp =
      date.getFullYear() +
      pad2(date.getMonth() + 1) +
      pad2(date.getDate()) +
      '-' +
      pad2(date.getHours()) +
      pad2(date.getMinutes()) +
      pad2(date.getSeconds());
    return `meet-transkript-${code}-${stamp}.${format}`;
  }

  /**
   * Türkçe büyük/küçük harf katlaması.
   * İ → i, I → ı. i ile ı, ş ile s birbirine karışmaz.
   * @param {*} value
   * @returns {string}
   */
  function foldTr(value) {
    return String(value == null ? '' : value).toLocaleLowerCase('tr');
  }

  /**
   * Arama sorgusuna uyan oturum mu?
   * Başlık, toplantı kodu, konuşmacı adı ve satır metni aranır.
   * Sorgu ve kayıt aynı Türkçe katlamadan geçer.
   * @param {Object} session dizin kaydı (özet)
   * @param {string} query arama metni
   * @param {Object} [fullSession] satırları içeren tam oturum
   * @returns {boolean}
   */
  function matchesQuery(session, query, fullSession) {
    const needle = foldTr(String(query == null ? '' : query).trim());
    if (!needle) {
      return true;
    }

    const source = session && typeof session === 'object' ? session : {};
    if (foldTr(source.title || '').indexOf(needle) !== -1) {
      return true;
    }
    if (foldTr(source.meetingCode || '').indexOf(needle) !== -1) {
      return true;
    }

    // Satır metni ve konuşmacı adı için tam oturum gerekir.
    const full = fullSession && typeof fullSession === 'object' ? fullSession : null;
    const lines = full && Array.isArray(full.lines) ? full.lines : [];
    return lines.some(function (line) {
      if (!line) {
        return false;
      }
      if (foldTr(line.speaker || '').indexOf(needle) !== -1) {
        return true;
      }
      return foldTr(line.text || '').indexOf(needle) !== -1;
    });
  }

  /**
   * Geçmiş listesini sorguya göre süzer.
   * Boş sorguda liste aynen döner; satırlar okunmaz.
   * Başlık ve kod yetmezse loadFull(session) ile tam oturum okunur.
   * @param {Array} sessions dizin kayıtları
   * @param {string} query
   * @param {Function} [loadFull] (session) => Promise<Object|null>
   * @returns {Promise<Array>}
   */
  async function filterSessionsByQuery(sessions, query, loadFull) {
    const list = Array.isArray(sessions) ? sessions : [];
    const raw = String(query == null ? '' : query).trim();
    if (!raw) {
      return list;
    }

    const visible = [];
    for (let i = 0; i < list.length; i += 1) {
      const session = list[i];
      if (matchesQuery(session, raw, null)) {
        visible.push(session);
        continue;
      }
      let full = null;
      if (typeof loadFull === 'function') {
        try {
          full = await loadFull(session);
        } catch (err) {
          full = null;
        }
      }
      if (matchesQuery(session, raw, full)) {
        visible.push(session);
      }
    }
    return visible;
  }

  const STALE_SESSION_MS = 10 * 60 * 1000;

  /**
   * Oturum süresi: "1 sa 5 dk" veya "12 dk 30 sn".
   * @param {Object} session
   * @returns {string}
   */
  function formatDuration(session) {
    const source = session && typeof session === 'object' ? session : {};
    const started = Number(source.startedAt) || 0;
    const now = Date.now();
    let ended = positiveTimestamp(source.endedAt);
    if (ended === null) {
      ended = now;
      if (Array.isArray(source.lines) && source.lines.length) {
        const last = source.lines[source.lines.length - 1];
        const lastTime = last && typeof last === 'object'
          ? (positiveTimestamp(last.endedAt) || positiveTimestamp(last.startedAt))
          : null;
        // Kapanışı yazılmadan yarım kalmış eski oturumlarda süre bugüne uzamasın.
        if (lastTime !== null && now - lastTime > STALE_SESSION_MS) {
          ended = lastTime;
        }
      }
    }
    const total = Math.max(0, Math.floor((ended - started) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      return `${hours} sa ${minutes % 60} dk`;
    }
    return `${minutes} dk ${seconds} sn`;
  }

  /**
   * Başlangıç zamanı: "Başlangıç: 06.11.2026 14:00".
   * @param {number} ms
   * @returns {string}
   */
  function formatDateTime(ms) {
    const date = new Date(Number(ms) || 0);
    return (
      'Başlangıç: ' +
      pad2(date.getDate()) +
      '.' +
      pad2(date.getMonth() + 1) +
      '.' +
      date.getFullYear() +
      ' ' +
      pad2(date.getHours()) +
      ':' +
      pad2(date.getMinutes())
    );
  }

  /**
   * Pozitif ve sonlu bir zaman damgası (epoch ms) ise sayıyı, değilse null döner.
   * 0, negatif, NaN ve boş değer toplantı başlangıcı sayılmaz.
   * @param {*} value
   * @returns {number|null}
   */
  function positiveTimestamp(value) {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) {
      return null;
    }
    return time;
  }

  /**
   * Kayıt durduktan sonra popup'ın kullandığı canlı döküm oturumu.
   *
   * Başlangıç saati indirme anı DEĞİLDİR. Önce içerik betiğinin kayıt
   * başlangıcı (`captureStartedAt`) kullanılır; o yoksa satırların en erken
   * `startedAt` değeri. İkisi de yoksa `startedAt` null kalır ve biçimlendirici
   * ilk satıra düşer. Böylece saatler 00:00:00'a çökmez.
   *
   * Satır dizisine dokunulmaz; metin kaybı olmaz.
   *
   * @param {{meeting?: Object, lines?: Array, captureStartedAt?: number}} input
   * @returns {Object}
   */
  function buildLiveExportSession(input) {
    const source = input && typeof input === 'object' ? input : {};
    const meeting = source.meeting && typeof source.meeting === 'object' ? source.meeting : {};
    const lines = Array.isArray(source.lines) ? source.lines : [];
    let earliest = null;
    for (let i = 0; i < lines.length; i += 1) {
      const lineTime = lines[i] && positiveTimestamp(lines[i].startedAt);
      if (lineTime !== null && (earliest === null || lineTime < earliest)) {
        earliest = lineTime;
      }
    }
    const captureStartedAt = positiveTimestamp(source.captureStartedAt);
    const title = typeof meeting.title === 'string' ? meeting.title.trim() : '';
    return {
      id: 'live',
      title: title || 'Meet Toplantısı',
      meetingUrl: typeof meeting.url === 'string' ? meeting.url : '',
      meetingCode: typeof meeting.code === 'string' ? meeting.code : '',
      startedAt: captureStartedAt !== null ? captureStartedAt : earliest,
      endedAt: null,
      lines: lines
    };
  }

  /**
   * Altyazı bölgesi durumuna göre hangi uyarının gösterileceğini belirler.
   *
   * - 'missing'   : Meet'te altyazı bölgesi yok -> CC kapalı, kullanıcı açmalı.
   * - 'unreadable': Bölge var ama okunabilir blok yok -> CC zaten açık, sadece
   *                 henüz konuşma yok ya da Meet arayüzü değişti. "CC'yi aç"
   *                 uyarısı burada yanlış olurdu (CC zaten açık).
   * - null        : Uyarı gerekmiyor.
   *
   * `captions.regionFound` bilinmiyorsa (eski içerik betiği) eski davranış
   * korunur: okunabilir blok yoksa 'missing' sayılır.
   *
   * @param {Object|null} captions içerik betiğinin bildirdiği altyazı durumu
   * @param {boolean} hasContent içerik betiğine ulaşıldı mı?
   * @returns {'missing'|'unreadable'|null}
   */
  function resolveCaptionsNotice(captions, hasContent) {
    if (!hasContent || !captions) {
      return null;
    }
    const regionKnown = typeof captions.regionFound === 'boolean';
    const regionFound = regionKnown ? captions.regionFound : captions.detected === true;
    if (!regionFound) {
      return 'missing';
    }
    if (captions.detected === false) {
      return 'unreadable';
    }
    return null;
  }

  return {
    buildFilename: buildFilename,
    matchesQuery: matchesQuery,
    filterSessionsByQuery: filterSessionsByQuery,
    formatDuration: formatDuration,
    formatDateTime: formatDateTime,
    buildLiveExportSession: buildLiveExportSession,
    resolveCaptionsNotice: resolveCaptionsNotice
  };
});
