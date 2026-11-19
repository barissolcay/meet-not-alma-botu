/**
 * Meet Not Alma Botu — dışa aktarma formatlayıcıları.
 *
 * TXT / Markdown / JSON / SRT / VTT üretir. Saf fonksiyonlardır; DOM veya
 * Chrome API'sine ihtiyaç duymazlar.
 *
 * UMD sarmalayıcı: tarayıcıda `globalThis.MNAFormatters`,
 * Node'da `require('.../formatters.js')`.
 */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MNAFormatters = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_OPTIONS = {
    includeTimestamps: true,
    speakerFallback: 'Bilinmeyen',
    includeHeader: true,
    localSpeakerName: 'Ben',
  };

  /**
   * Meet'in yerel kullanıcı (host) için kullandığı etiketler.
   * Bunlar bir kişinin adı değildir; çıktıda kullanıcının seçtiği
   * "yerel kullanıcı adı"na (localSpeakerName) çevrilir.
   * Karşılaştırma normalize edilmiş (küçük harf, kırpılmış) tam kelimedir.
   * Türkçe Meet etiketi "Siz"dir; "Sen" gerçek ad olabilir.
   * "Tu", "Du" ve "Sie" listede yoktur: Meet'in bu metinleri ürettiğine
   * dair kanıt yok, gerçek katılımcı adı olarak kalırlar.
   */
  const LOCAL_SPEAKER_LABELS = [
    'siz', // Türkçe
    'you', // İngilizce
    'você', // Portekizce
    'voce', // Portekizce (aksan)
    'tú', // İspanyolca
    'vous', // Fransızca
    'вы', // Rusça
    '자신', // Korece
    'あなた' // Japonca
  ];

  function mergeOptions(opts) {
    const source = opts && typeof opts === 'object' ? opts : {};
    return {
      includeTimestamps:
        source.includeTimestamps === undefined
          ? DEFAULT_OPTIONS.includeTimestamps
          : !!source.includeTimestamps,
      speakerFallback:
        typeof source.speakerFallback === 'string'
          ? source.speakerFallback
          : DEFAULT_OPTIONS.speakerFallback,
      includeHeader:
        source.includeHeader === undefined
          ? DEFAULT_OPTIONS.includeHeader
          : !!source.includeHeader,
      localSpeakerName:
        typeof source.localSpeakerName === 'string' && source.localSpeakerName.trim()
          ? source.localSpeakerName.trim()
          : DEFAULT_OPTIONS.localSpeakerName,
    };
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function toMs(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }

  /**
   * "00:01:23" (withHours) veya "01:23" (withHours = false).
   * @param {number} ms
   * @param {{withHours?: boolean}} [opts]
   * @returns {string}
   */
  function formatTimestamp(ms, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const withHours = options.withHours !== false;
    const total = Math.max(0, Math.floor(toMs(ms) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (withHours) {
      return pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);
    }
    return pad2(minutes) + ':' + pad2(seconds);
  }

  /** SRT/VTT için "HH:MM:SS,mmm" / "HH:MM:SS.mmm". */
  function formatClockMs(ms, separator) {
    const value = Math.max(0, toMs(ms));
    const totalSeconds = Math.floor(value / 1000);
    const millis = Math.floor(value % 1000);
    return (
      pad2(Math.floor(totalSeconds / 3600)) +
      ':' +
      pad2(Math.floor((totalSeconds % 3600) / 60)) +
      ':' +
      pad2(totalSeconds % 60) +
      separator +
      String(millis).padStart(3, '0')
    );
  }

  /** "06.11.2026 17:35" biçiminde tarih. */
  function formatDateTr(ms) {
    if (!Number.isFinite(ms)) {
      return '';
    }
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    return (
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

  function getLines(session) {
    if (!session || !Array.isArray(session.lines)) {
      return [];
    }
    return session.lines.filter(function (line) {
      return (
        line && typeof line.text === 'string' && line.text.trim().length > 0
      );
    });
  }

  /** Zaman damgalarının göreli olduğu taban zaman (ms). */
  function getBaseTime(session) {
    if (session && Number.isFinite(session.startedAt)) {
      return session.startedAt;
    }
    const lines = getLines(session);
    if (lines.length && Number.isFinite(lines[0].startedAt)) {
      return lines[0].startedAt;
    }
    return 0;
  }

  /** Konuşmacı adını karşılaştırma için normalize eder. */
  function normalizeSpeakerName(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  /** Meet'in yerel kullanıcı etiketlerinden biri mi? (büyük/küçük harf duyarsız) */
  function isLocalSpeaker(speaker) {
    return LOCAL_SPEAKER_LABELS.indexOf(normalizeSpeakerName(speaker)) !== -1;
  }

  function getSpeaker(line, options) {
    const speaker =
      line && typeof line.speaker === 'string' ? line.speaker.trim() : '';
    if (!speaker) {
      return options.speakerFallback;
    }
    // "Siz" gibi yerel kullanıcı etiketleri gerçek bir isim değildir.
    if (isLocalSpeaker(speaker)) {
      return options.localSpeakerName || DEFAULT_OPTIONS.localSpeakerName;
    }
    return speaker;
  }

  /** Toplantı kodu: oturumda varsa, yoksa bağlantıdan türetilir. */
  function getMeetingCode(session) {
    const raw = session && typeof session.meetingCode === 'string' ? session.meetingCode.trim() : '';
    if (raw) {
      return raw;
    }
    const url = session && typeof session.meetingUrl === 'string' ? session.meetingUrl : '';
    const match = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.exec(url);
    return match ? match[1].toLowerCase() : '';
  }

  /** Toplantı bağlantısı. */
  function getMeetingUrl(session) {
    return session && typeof session.meetingUrl === 'string' ? session.meetingUrl.trim() : '';
  }

  /**
   * Başlıkta kullanılacak toplantı bilgilerini toplar.
   * @param {Object} session
   * @param {Object} options
   * @returns {{title: string, code: string, url: string, date: string, duration: string, participants: string[]}}
   */
  function collectHeaderInfo(session, options) {
    const title = session && typeof session.title === 'string' ? session.title.trim() : '';
    const startedAt =
      session && Number.isFinite(session.startedAt) ? session.startedAt : null;
    const durationMs = getDurationMs(session);

    return {
      title: title,
      code: getMeetingCode(session),
      url: getMeetingUrl(session),
      date: startedAt === null ? '' : formatDateTr(startedAt),
      duration: durationMs > 0 ? formatTimestamp(durationMs) : '',
      participants: getParticipants(session, options)
    };
  }

  /**
   * Düz metin başlığı (TXT ve "panoya kopyala" çıktısı aynı biçimi kullanır).
   * @param {Object} session
   * @param {Object} options
   * @returns {string[]}
   */
  function buildTextHeader(session, options) {
    const info = collectHeaderInfo(session, options);
    const lines = [];

    if (info.title) {
      lines.push('Toplantı: ' + info.title);
    }
    if (info.code) {
      lines.push('Toplantı Kodu: ' + info.code);
    }
    if (info.date) {
      lines.push('Tarih: ' + info.date);
    }
    if (info.duration) {
      lines.push('Süre: ' + info.duration);
    }
    if (info.participants.length) {
      lines.push('Katılımcılar: ' + info.participants.join(', '));
    }
    if (info.url) {
      lines.push('Bağlantı: ' + info.url);
    }

    return lines;
  }

  function getParticipants(session, options) {
    const seen = new Set();
    const participants = [];
    for (const line of getLines(session)) {
      const speaker = getSpeaker(line, options);
      if (!seen.has(speaker)) {
        seen.add(speaker);
        participants.push(speaker);
      }
    }
    return participants;
  }

  function getDurationMs(session) {
    const lines = getLines(session);
    if (!lines.length) {
      return 0;
    }
    const last = lines[lines.length - 1];
    if (!Number.isFinite(last.endedAt)) {
      return 0;
    }
    const base = getBaseTime(session);
    return Math.max(0, last.endedAt - base);
  }

  /**
   * Düz metin (txt) çıktısı.
   * @param {Object} session
   * @param {Object} [opts]
   * @returns {string}
   */
  function formatSessionText(session, opts) {
    const options = mergeOptions(opts);
    const lines = getLines(session);
    const base = getBaseTime(session);
    const output = [];

    if (options.includeHeader) {
      const header = buildTextHeader(session, options);
      output.push(...header);
      if (header.length) {
        output.push('');
      }
    }

    for (const line of lines) {
      const speaker = getSpeaker(line, options);
      const text = line.text.trim();
      if (options.includeTimestamps) {
        output.push(
          '[' + formatTimestamp(line.startedAt - base) + '] ' + speaker + ': ' + text
        );
      } else {
        output.push(speaker + ': ' + text);
      }
    }
    return output.join('\n');
  }

  /**
   * Markdown çıktısı.
   * @param {Object} session
   * @param {Object} [opts]
   * @returns {string}
   */
  function formatSessionMarkdown(session, opts) {
    const options = mergeOptions(opts);
    const lines = getLines(session);
    const base = getBaseTime(session);
    const info = collectHeaderInfo(session, options);
    const title = info.title;
    const output = [];

    output.push('# ' + (title || 'Toplantı Transkripti'));
    output.push('');

    if (options.includeHeader) {
      if (info.code) {
        output.push('- Toplantı Kodu: ' + info.code);
      }
      if (info.date) {
        output.push('- Tarih: ' + info.date);
      }
      output.push('- Süre: ' + (info.duration || formatTimestamp(getDurationMs(session))));
      output.push('- Katılımcılar: ' + info.participants.join(', '));
      if (info.url) {
        output.push('- Bağlantı: ' + info.url);
      }
      output.push('');
    }

    output.push('## Konuşma');
    output.push('');

    for (const line of lines) {
      const speaker = getSpeaker(line, options);
      const text = line.text.trim();
      if (options.includeTimestamps) {
        output.push(
          '[' + formatTimestamp(line.startedAt - base) + '] **' + speaker + ':** ' + text
        );
      } else {
        output.push('**' + speaker + ':** ' + text);
      }
    }
    return output.join('\n');
  }

  /**
   * JSON çıktısı (pretty).
   * @param {Object} session
   * @param {Object} [opts]
   * @returns {string}
   */
  function formatSessionJson(session, opts) {
    const options = mergeOptions(opts);
    const lines = getLines(session);
    const startedAt =
      session && Number.isFinite(session.startedAt) ? session.startedAt : null;
    const endedAt =
      session && Number.isFinite(session.endedAt)
        ? session.endedAt
        : lines.length && Number.isFinite(lines[lines.length - 1].endedAt)
          ? lines[lines.length - 1].endedAt
          : null;

    const payload = {
      id: session && session.id ? session.id : null,
      title: session && typeof session.title === 'string' ? session.title : '',
      meetingCode: getMeetingCode(session),
      meetingUrl:
        session && typeof session.meetingUrl === 'string' ? session.meetingUrl : '',
      startedAt: startedAt,
      endedAt: endedAt,
      durationMs: getDurationMs(session),
      participants: getParticipants(session, options),
      lines: lines.map(function (line) {
        return {
          id: line.id || null,
          speaker: getSpeaker(line, options),
          text: line.text.trim(),
          startedAt: Number.isFinite(line.startedAt) ? line.startedAt : null,
          endedAt: Number.isFinite(line.endedAt) ? line.endedAt : null,
          seq: Number.isFinite(line.seq) ? line.seq : null,
        };
      }),
    };

    try {
      return JSON.stringify(payload, null, 2);
    } catch (err) {
      console.warn('[MNA] JSON üretilemedi —', err);
      return JSON.stringify({ error: 'json-serilizasyon-hatasi' });
    }
  }

  /**
   * SRT altyazı dosyası.
   * @param {Object} session
   * @param {Object} [opts]
   * @returns {string}
   */
  function formatSessionSrt(session, opts) {
    const options = mergeOptions(opts);
    const lines = getLines(session);
    const base = getBaseTime(session);
    const cues = [];

    lines.forEach(function (line, index) {
      const start = Math.max(0, toMs(line.startedAt) - base);
      const end =
        Number.isFinite(line.endedAt) && line.endedAt > line.startedAt
          ? toMs(line.endedAt) - base
          : start;
      cues.push(
        String(index + 1) +
          '\n' +
          formatClockMs(start, ',') +
          ' --> ' +
          formatClockMs(end, ',') +
          '\n' +
          getSpeaker(line, options) +
          ': ' +
          line.text.trim()
      );
    });

    return cues.join('\n\n') + (cues.length ? '\n' : '');
  }

  /**
   * WebVTT altyazı dosyası.
   * @param {Object} session
   * @param {Object} [opts]
   * @returns {string}
   */
  function formatSessionVtt(session, opts) {
    const options = mergeOptions(opts);
    const lines = getLines(session);
    const base = getBaseTime(session);
    const cues = [];

    lines.forEach(function (line) {
      const start = Math.max(0, toMs(line.startedAt) - base);
      const end =
        Number.isFinite(line.endedAt) && line.endedAt > line.startedAt
          ? toMs(line.endedAt) - base
          : start;
      cues.push(
        formatClockMs(start, '.') +
          ' --> ' +
          formatClockMs(end, '.') +
          '\n' +
          getSpeaker(line, options) +
          ': ' +
          line.text.trim()
      );
    });

    return 'WEBVTT\n\n' + (cues.length ? cues.join('\n\n') + '\n' : '');
  }

  /**
   * Biçim ayırıcı (dispatcher).
   * @param {Object} session
   * @param {string} format "txt"|"md"|"json"|"srt"|"vtt"
   * @param {Object} [opts]
   * @returns {string}
   */
  function formatSession(session, format, opts) {
    const kind = typeof format === 'string' ? format.toLowerCase() : 'txt';
    switch (kind) {
      case 'txt':
      case 'text':
        return formatSessionText(session, opts);
      case 'md':
      case 'markdown':
        return formatSessionMarkdown(session, opts);
      case 'json':
        return formatSessionJson(session, opts);
      case 'srt':
        return formatSessionSrt(session, opts);
      case 'vtt':
        return formatSessionVtt(session, opts);
      default:
        console.warn('[MNA] Bilinmeyen biçim, txt kullanılıyor —', format);
        return formatSessionText(session, opts);
    }
  }

  /**
   * Düz metin çıktısı (yapay zekâya yapıştırmak için).
   *
   * Varsayılan olarak başlık bloğu (toplantı, kod, tarih, süre, katılımcılar,
   * bağlantı) üretir; başlık formatSessionText ile aynı biçimdedir.
   * `includeHeader: false` ile eski (başlıksız) davranış elde edilir.
   * @param {Object} session
   * @param {Object} [opts]
   * @returns {string}
   */
  function buildPlainTranscript(session, opts) {
    const options = mergeOptions(opts);
    const output = [];

    if (options.includeHeader) {
      const header = buildTextHeader(session, options);
      output.push(...header);
      if (header.length) {
        output.push('');
      }
    }

    for (const line of getLines(session)) {
      output.push(getSpeaker(line, options) + ': ' + line.text.trim());
    }
    return output.join('\n');
  }

  /**
   * Yapay zekâya (Gemini, ChatGPT, Claude…) yapıştırılacak hazır istem.
   * Eklenti ağa hiçbir şey göndermez: kullanıcı bu metni kendi yapay zekâsına yapıştırır.
   * Genel amaçlıdır; doldurulacak boşluk yoktur.
   */
  var AI_SUMMARY_PROMPT = [
    'Aşağıda bir Google Meet toplantısının otomatik altyazıdan alınmış transkripti var.',
    'Görevin: toplantıya katılan birinin 5 dakikada okuyup işine yarayacak KISA bir not çıkarmak. Transkripti yeniden anlatmanı ya da her şeyi kaydetmeni değil, işe yarayanı seçmeni istiyorum.',
    '',
    'ÖNCE TÜRÜ BELİRLE (kullanıcıya yazma, kendin karar ver):',
    '- EĞİTİM / SUNUM / WEBİNAR: bir kişi ağırlıklı olarak anlatıyor, diğerleri dinliyor ya da soru soruyor.',
    '- ÇALIŞMA TOPLANTISI: karar, iş paylaşımı ve tartışma var.',
    '',
    'EĞİTİM / SUNUM İSE şu başlıklarla yaz:',
    '1. Ne öğretildi: 2-3 cümle.',
    '2. Akılda kalması gereken 7-10 şey: her biri kısa bir başlık ve 1-2 cümle. Genel yöntem ya da bilgi olarak yaz; kimin hangi soruyu sorduğunu yazma.',
    '3. Uygulama adımları: anlatılan yöntemi kendi işinde uygulamak isteyen biri için sıralı, kısa adımlar ya da kontrol listesi (varsa).',
    '4. Dikkat edilecekler ve sık yapılan hatalar (varsa).',
    '5. Önemli örnek ve sayılar: en fazla 3.',
    '6. Eğitmenin verdiği ödev, kaynak ya da sonraki adım (yoksa bu başlığı hiç yazma).',
    '',
    'ÇALIŞMA TOPLANTISI İSE şu başlıklarla yaz:',
    '1. Özet: en fazla 3 cümle.',
    '2. Alınan kararlar.',
    '3. Aksiyonlar: ne, kim, ne zamana kadar (söylenmediyse "belirtilmedi"). Yalnızca açıkça söylenenleri yaz.',
    '4. Açık kalan konular.',
    '',
    'KURALLAR',
    '- Uzunluk: en fazla yaklaşık 500 kelime (bir sayfa). Toplantı ne kadar uzun olursa olsun bu sınırı aşma. Tablo kullanma, madde madde yaz.',
    '- Katılımcıların kendilerini tanıtmasını, kişisel projelerini, hikâyelerini, tek tek kim ne dedi bilgisini, selamlaşmayı ve ses/bağlantı sorunlarını yazma. Kişi adı yalnızca karar ya da aksiyonun sahibini belirtmek için kullanılır.',
    '- Zaman damgası, konu akışı tablosu, katılımcı listesi ve "şüpheli yerler" listesi yazma.',
    '- Yalnızca transkriptte geçen bilgiyi kullan; uydurma, dışarıdan bilgi ekleme. Altyazı otomatik üretildiği için bozuk kelimeler olabilir: anlamı bağlamdan çıkarabiliyorsan düzelterek yaz, çıkaramıyorsan o kısmı atla. Emin olmadığın özel isim ya da sayının yanına (?) koy.',
    '- Telefon, e-posta, adres gibi kişisel bilgileri yazma.',
    '- Dil: sade Türkçe.',
    '',
    'Transkript aşağıdadır.'
  ].join('\n');

  /**
   * "Yapay zekâya hazır paket": istem + başlıklı, zaman damgalı transkript.
   * @param {Object} session
   * @param {Object} [opts]
   * @returns {string}
   */
  function buildAiPackage(session, opts) {
    var options = Object.assign({}, opts || {}, { includeTimestamps: true, includeHeader: true });
    return (
      AI_SUMMARY_PROMPT +
      '\n\n===== TRANSKRİPT BAŞLANGICI =====\n' +
      formatSessionText(session, options) +
      '\n===== TRANSKRİPT SONU ====='
    );
  }

  return {
    AI_SUMMARY_PROMPT: AI_SUMMARY_PROMPT,
    buildAiPackage: buildAiPackage,
    formatTimestamp: formatTimestamp,
    formatSessionText: formatSessionText,
    formatSessionMarkdown: formatSessionMarkdown,
    formatSessionJson: formatSessionJson,
    formatSessionSrt: formatSessionSrt,
    formatSessionVtt: formatSessionVtt,
    formatSession: formatSession,
    buildPlainTranscript: buildPlainTranscript,
    formatClockMs: formatClockMs,
    formatDateTr: formatDateTr,
    getMeetingCode: getMeetingCode,
    isLocalSpeaker: isLocalSpeaker,
    LOCAL_SPEAKER_LABELS: LOCAL_SPEAKER_LABELS,
  };
});
