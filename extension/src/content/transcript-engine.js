/**
 * Meet Not Alma Botu — saf transkript motoru.
 *
 * Bu dosya DOM'A DOKUNMAZ. Meet'in canlı altyazılarını okuyan tek yer
 * `meet-adapter.js` dosyasıdır; buradaki motor yalnızca
 * "{ key, speaker, text }" girdilerini alıp zaman damgalı, tekrarsız
 * satırlar üretir. Böylece Node üzerinde `node --test` ile test edilebilir.
 *
 * UMD sarmalayıcı: tarayıcıda `globalThis.MNAEngine`,
 * Node'da `require('.../transcript-engine.js')`.
 */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MNAEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Meet'in altyazı bölgesine yazdığı arayüz metinleri (tam/blocklist eşleşmesi).
   * Karşılaştırma küçük harf ve normalize edilmiş metin üzerinden yapılır.
   */
  const UI_BLOCKLIST = new Set([
    'frame_person',
    'more_vert',
    'more_horiz',
    'backgrounds and effects',
    'turn on captions',
    'turn off captions',
    'caption_settings',
    'noise cancellation',
    'low light',
    'blur background',
    'settings',
    'leave call',
    'chat',
    'people',
    'activities',
    'present now',
    'record',
    'stop recording',
    'captions',
  ]);

  /** camelCase arayüz tanımlayıcıları (metnin tamamı bu tek kelime ise). */
  const UI_TOKENS = new Set([
    'moreVert',
    'moreHoriz',
    'framePerson',
    'captionSettings',
    'backgroundsAndEffects',
    'noiseCancellation',
    'blurBackground',
    'lowLight',
    'presentNow',
    'stopRecording',
    'leaveCall',
    'turnOnCaptions',
    'turnOffCaptions',
    'fullscreenPresent',
    'raiseHand',
  ]);

  /** Metni normalize eder: satır sonları ve fazla boşluklar tek boşluğa indirilir. */
  function normalizeText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Meet arayüz metni mi? (tam eşleşme + genel arayüz kalıpları)
   */
  function isJunkText(raw) {
    const text = normalizeText(raw);
    if (!text) {
      return false;
    }
    const lower = text.toLowerCase();

    if (UI_BLOCKLIST.has(lower)) {
      return true;
    }
    if (UI_TOKENS.has(text)) {
      return true;
    }
    // snake_case kalıpları: frame_person, caption_settings, more_vert ...
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(lower)) {
      return true;
    }
    // metin içinde geçen "frame_xxx" arayüz kalıbı
    if (/(^|[\s(])frame_[a-z_]+/.test(lower)) {
      return true;
    }
    // camelCase tek kelime: moreVert, framePerson, captionSettings
    if (/^[a-z]{4,}[A-Z][A-Za-z0-9]*$/.test(text)) {
      return true;
    }
    return false;
  }

  /**
   * Türkçe cümle sonu işaretleri. Gövde karşılaştırmasından önce eski
   * metnin SONUNDAN yalnızca bunlar ve boşluk atılır:
   * nokta, virgül, soru, ünlem, iki nokta, noktalı virgül, üç nokta, tırnak.
   * Art arda gelen ASCII noktalar (.) üç noktayı da karşılar; tek karakterli
   * üç nokta (…) kümede ayrı durur. Başka dilin işaretleri bu kümede yoktur.
   */
  const SENTENCE_MARKS = new Set([
    '.',
    ',',
    '?',
    '!',
    ':',
    ';',
    '\u2026',
    '"',
    "'",
    '\u201C',
    '\u201D',
    '\u2018',
    '\u2019',
    '\u00AB',
    '\u00BB',
    '\u201E',
  ]);

  function isSentenceMark(ch) {
    return SENTENCE_MARKS.has(ch);
  }

  /**
   * Eski metnin sonundaki cümle işaretlerini ve boşlukları atar.
   * Harf ve rakam düşmez; atılan her karakter bu kümeden ya da boşluktandır.
   */
  function stripTrailingSentenceMarks(value) {
    const text = normalizeText(value);
    let end = text.length;
    while (end > 0) {
      const ch = text.charAt(end - 1);
      if (ch !== ' ' && !isSentenceMark(ch)) {
        break;
      }
      end -= 1;
    }
    return text.slice(0, end);
  }

  /**
   * Aynı konuşma turu mu?
   *
   * 'extend': metin yeni metinle yerinde büyür. Ya eski metin yeninin tam
   *   öneki ve yeni metin ondan uzun, ya da eski metnin sonundaki işaretler
   *   ve boşluk atılınca kalan gövde yeni metnin birebir öneki ve yeni metin
   *   gövdeden uzun.
   * 'hold':   aynı tur; metin kısalmaz ve yeni satır açılmaz.
   * 'none':   ayrı satır. Harf ya da rakam atmak gerekirse sonuç budur.
   */
  function matchContinuation(olderText, newerText) {
    const older = normalizeText(olderText);
    const newer = normalizeText(newerText);
    if (!older || !newer) {
      return 'none';
    }
    const olderFold = older.toLowerCase();
    const newerFold = newer.toLowerCase();
    if (newerFold.startsWith(olderFold) || olderFold.startsWith(newerFold)) {
      return newer.length > older.length ? 'extend' : 'hold';
    }
    const body = stripTrailingSentenceMarks(older);
    if (body && body.length !== older.length) {
      const bodyFold = body.toLowerCase();
      if (newerFold.startsWith(bodyFold) && newer.length > body.length) {
        return 'extend';
      }
    }
    return matchTailRevision(older, newer);
  }

  /** Kelimeyi karşılaştırma için sadeleştirir (küçük harf, kenar noktalama atılır). */
  function foldWord(word) {
    return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  }

  /**
   * Kuyruk revizyonu: Meet konuşma tanıma sonucunu düzeltirken cümlenin SON
   * kelimelerini değiştirir ("...bilgileri konusunda" -> "...bilgileri Evet
   * durumlar bunlar."). Yeni metin eskinin öneki ya da uzantısı değildir ama
   * baştaki uzun kısım kelime kelime aynıdır; bu aynı konuşma turudur.
   *
   * Koşul: ortak kelime öneki en az MIN_SHARED_WORDS kelime ve kısa metnin
   * en az %80'i. Farklı iki cümle bu kadar uzun ortak başlangıç taşımaz.
   * Yeni metin eskisinden kısa değilse 'extend' (eski metin yenisiyle değişir),
   * kısaysa 'hold' (eski metin korunur, yeni satır açılmaz).
   */
  const MIN_SHARED_WORDS = 6;
  const MIN_SHARED_RATIO = 0.8;

  function matchTailRevision(older, newer) {
    const olderWords = older.split(' ');
    const newerWords = newer.split(' ');
    const limit = Math.min(olderWords.length, newerWords.length);
    let shared = 0;
    while (shared < limit && foldWord(olderWords[shared]) === foldWord(newerWords[shared])) {
      shared += 1;
    }
    if (shared < MIN_SHARED_WORDS || shared < Math.ceil(limit * MIN_SHARED_RATIO)) {
      return 'none';
    }
    return newerWords.length >= olderWords.length ? 'extend' : 'hold';
  }

  /**
   * Uzun konuşmalarda Meet'in altyazı bloğu "kayan pencere" gibi davranır:
   * metnin BAŞINDAN kırpılır ve sonuna yeni konuşma eklenir. Yeni metin eskinin
   * öneki değildir ama eski metinle birebir örtüşür:
   *   eski: "A B C D E"   yeni: "C D E"        -> yeni, eskinin içinde (kırpılmış)
   *   eski: "A B C D E"   yeni: "D E F G"      -> örtüşme var; birleşik: "A B C D E F G"
   * Bu durum satır sayısını artırmamalı ve metin KAYBETTİRMEMELİDİR.
   *
   * Kısa metinler ve düzeltmeler etkilenmesin diye yeni metin en az
   * OVERLAP_MIN_CHARS uzunlukta olmalıdır.
   *
   * @returns {string|null} satırın yeni metni (eskisiyle aynıysa değişmez);
   *   ilişki yoksa null.
   */
  const OVERLAP_MIN_CHARS = 40;
  /** Eski metnin sonundaki yarım kalmış kelimeler için tolerans (normalize karakter). */
  const OVERLAP_TAIL_SLACK = 25;

  /**
   * Metni yalnızca harf ve rakamlara indirger (küçük harf, boşluk ve noktalama
   * yok) ve her karakterin özgün metindeki konumunu döndürür. Meet, çakışan
   * bölgede noktalama ve büyük harf düzeltmeleri yaptığı için karşılaştırma
   * bu biçimde yapılır. Türkçe ı/İ/I hepsi "i" olur (uzunluk korunur).
   */
  function foldWithMap(text) {
    const chars = [];
    const map = [];
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charAt(i);
      if (!/[\p{L}\p{N}]/u.test(ch)) {
        continue;
      }
      if (ch === 'ı' || ch === 'İ' || ch === 'I') {
        chars.push('i');
      } else {
        const lower = ch.toLowerCase();
        chars.push(lower.length === 1 ? lower : ch);
      }
      map.push(i);
    }
    return { text: chars.join(''), map: map };
  }

  function mergeSlidingText(olderText, newerText) {
    const older = normalizeText(olderText);
    const newer = normalizeText(newerText);
    if (!older || !newer) {
      return null;
    }
    const o = foldWithMap(older);
    const n = foldWithMap(newer);
    if (n.text.length < OVERLAP_MIN_CHARS || !o.text.length) {
      return null;
    }
    const pos = o.text.lastIndexOf(n.text.slice(0, OVERLAP_MIN_CHARS));
    if (pos < 0) {
      return null;
    }
    const tail = o.text.slice(pos);
    if (tail.startsWith(n.text)) {
      // Yeni metin eskinin içinde (başından kırpılmış): eski korunur.
      return older;
    }
    // Eskinin sonundaki yarım kelime düzeltilmiş olabilir: son kısım için tolerans.
    const core = tail.slice(0, Math.max(0, tail.length - OVERLAP_TAIL_SLACK));
    if (!n.text.startsWith(core)) {
      return null;
    }
    if (n.text.length < tail.length - 5) {
      // Yeni metin eskinin sonuna ulaşmıyor: eski daha eksiksiz, eski korunur.
      return older;
    }
    // Eskinin başı + yeninin tamamı (yeni, çakışan bölgenin düzeltilmiş halidir).
    return older.slice(0, o.map[pos]) + newer;
  }
  /**
   * İki metin birbirinin uzantısı/öneki mi, yoksa Meet'in cümle sonuna
   * koyduğu işaret atılınca eski gövde yeninin birebir öneki mi?
   * (Meet bloğu yeniden kurduğunda aynı cümlenin parçalanmasını önler.)
   */
  function isContinuation(olderText, newerText) {
    return matchContinuation(olderText, newerText) !== 'none';
  }

  /**
   * Kesinleşmiş bir satırın Meet tarafından revize edilmesine tolerans
   * penceresi (ms).
   *
   * Meet canlı altyazıda konuşma sırasında metni revize eder. Bazen revizyon
   * grace süresi dolduktan SONRA gelir: o an satır kesinleşmiş olur ve yeni
   * metin ayrı bir satır olarak mükerrer görünür. Bu pencere, kesinleşmiş
   * son satırın bu süre içinde revize edilmesini kabul eder.
   *
   * Değer neden 30 sn: birleşme yalnızca "yeni metin, eskinin uzantısı" ve
   * "araya başka konuşma girmemiş" olduğunda gerçekleşir; yani aradaki süre
   * konuşmacının cümle ortasındaki duraksamasıdır (gerçek testte ~6,5 sn).
   * Birleştirme hiçbir metin kaybettirmez (yeni metin eskisinin uzantısıdır),
   * bu yüzden birleştirmeye yönelik kayma güvenli taraftadır.
   */
  const REVISION_WINDOW_MS = 30000;
  /** Bu uzunluktan uzun iki metin arasındaki devam ilişkisi zaman sınırına bakmaz. */
  const LONG_TURN_CHARS = 400;

  /**
   * Transkript motoru.
   *
   * @param {Object} [options]
   * @param {number} [options.graceMs=2500] Metin değişmeden geçen süre; dolunca satır kesinleşir.
   * @param {boolean} [options.junkFilter=true] Meet arayüz metinleri filtrelenir mi?
   * @param {string} [options.speakerFallback='Bilinmeyen'] Konuşmacı adı boşsa kullanılır.
   * @param {number} [options.minLineChars=1] Bu karakter sayısından kısa metinler atlanır.
   * @param {Function} [options.now] Epoch ms üreten saat (testlerde sahte saat verilir).
   */
  function createTranscriptEngine(options) {
    const opts = options && typeof options === 'object' ? options : {};
    let graceMs = Number.isFinite(opts.graceMs) ? opts.graceMs : 2500;
    let junkFilter = opts.junkFilter !== false;
    let speakerFallback =
      typeof opts.speakerFallback === 'string' ? opts.speakerFallback : 'Bilinmeyen';
    let minLineChars = Number.isFinite(opts.minLineChars) ? opts.minLineChars : 1;
    let revisionWindowMs = Number.isFinite(opts.revisionWindowMs)
      ? opts.revisionWindowMs
      : REVISION_WINDOW_MS;
    const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };

    /** @type {Array<Object>} kesinleşmiş satırlar */
    let lines = [];
    /** @type {Map<string, Object>} bekleyen satırlar (anahtar -> satır) */
    let pending = new Map();
    /**
     * Kesinleşmiş satırların blok anahtarı (anahtar -> satır). Motor kesinleşen
     * bloğun anahtarını unutursa, aynı DOM öğesi sonradan kırpılmış ya da
     * uzamış metinle görüldüğünde kopya satır doğar. Sınırlıdır.
     */
    const committedByKey = new Map();
    const COMMITTED_KEY_MAX = 2000;
    /** monotonik sayaç */
    let seq = 0;
    /** en son gözlenen bekleyen satır (birleştirme adayı) */
    let activeLine = null;

    function createLine(speaker, text, at) {
      seq += 1;
      return {
        id: 'l' + seq,
        speaker: speaker,
        text: text,
        startedAt: at,
        endedAt: null,
        seq: seq,
        rootKey: '',
        keys: new Set(),
        lastChangedAt: at,
      };
    }

    function toPublic(line) {
      return {
        id: line.id,
        speaker: line.speaker,
        text: line.text,
        startedAt: line.startedAt,
        endedAt: line.endedAt,
        seq: line.seq,
      };
    }

    /** Bekleyen satırı kesinleştirir ve çıktı listesine ekler. */
    function commitLine(line, at) {
      line.endedAt = at;
      const pub = toPublic(line);
      line.keys.forEach(function (key) {
        pending.delete(key);
        committedByKey.delete(key);
        committedByKey.set(key, pub);
      });
      while (committedByKey.size > COMMITTED_KEY_MAX) {
        const oldest = committedByKey.keys().next();
        if (oldest.done) {
          break;
        }
        committedByKey.delete(oldest.value);
      }
      line.keys.clear();
      if (activeLine === line) {
        activeLine = null;
      }
      lines.push(pub);
      return pub;
    }

    /** Bekleyen satırları seq sırasıyla, tekilleştirilmiş olarak döndürür. */
    function pendingLines() {
      const unique = [];
      const seen = new Set();
      pending.forEach(function (line) {
        if (!seen.has(line)) {
          seen.add(line);
          unique.push(line);
        }
      });
      unique.sort(function (a, b) {
        return a.seq - b.seq;
      });
      return unique;
    }

    /**
     * Yeni/güncellenmiş bir altyazı bloğunu bildirir.
     * @param {{key: string, speaker: string, text: string}} input
     * @returns {{committed: Array<Object>, updated: Array<Object>}}
     *   committed: bu gözlemde ilk kez kesinleşen satırlar.
     *   updated:   daha önce kesinleşmiş, metni sonradan revize edilmiş
     *              satırlar (aynı id ile döner; arka plan yerinde günceller).
     */
    function observe(input) {
      const committed = [];
      const updated = [];
      if (!input || typeof input !== 'object') {
        return { committed: committed, updated: updated };
      }

      const key =
        typeof input.key === 'string' && input.key
          ? input.key
          : input.key === null || input.key === undefined
            ? ''
            : String(input.key);
      const rawText =
        typeof input.text === 'string' ? input.text : input.text == null ? '' : String(input.text);
      const rawSpeaker =
        typeof input.speaker === 'string'
          ? input.speaker
          : input.speaker == null
            ? ''
            : String(input.speaker);

      const at = now();
      const text = rawText.trim();
      const speaker = rawSpeaker.trim() || speakerFallback;

      // 1) Çok kısa metinler atlanır (varsayılan minLineChars = 1 -> boş string).
      if (text.length < minLineChars) {
        return { committed: committed, updated: updated };
      }

      if (junkFilter) {
        // 2) Meet arayüz metinleri satır olmaz.
        if (isJunkText(text)) {
          return { committed: committed, updated: updated };
        }
        // 3) Konuşmacı alanı da arayüz metniyse satır atlanır.
        if (isJunkText(speaker)) {
          return { committed: committed, updated: updated };
        }
      }

      const existing = key ? pending.get(key) : undefined;

      if (existing) {
        // Aynı anahtar, farklı konuşmacı -> önceki satır kesinleşir, yeni satır açılır.
        if (existing.speaker !== speaker) {
          committed.push(commitLine(existing, at));
          const line = createLine(speaker, text, at);
          line.rootKey = key;
          line.keys.add(key);
          pending.set(key, line);
          activeLine = line;
          return { committed: committed, updated: updated };
        }

        const isRootKey = existing.rootKey === key;
        if (existing.text !== text) {
          if (isRootKey) {
            // Meet revizyonu: metin uzar ya da yeniden yazılır -> son hali kullanılır,
            // startedAt korunur, satır sayısı artmaz. Kayan pencerede (başı kırpılmış)
            // eski metin kaybolmasın diye örtüşme önce denenir.
            const slid = mergeSlidingText(existing.text, text);
            existing.text = slid !== null ? slid : text;
            existing.lastChangedAt = at;
          } else if (matchContinuation(existing.text, text) === 'extend') {
            // Aliased (birleştirilmiş) anahtar: yalnızca uzatma kabul edilir,
            // birleşmiş metin asla kısalmasın. Noktalı büyüme de aynı karardır.
            existing.text = text;
            existing.lastChangedAt = at;
          }
        }
        activeLine = existing;
        return { committed: committed, updated: updated };
      }

      // Anahtarı daha önce kesinleşmiş bir satıra ait (aynı DOM öğesi): Meet o
      // öğenin metnini sonradan uzattı, düzeltti ya da başından kırptı. Bu yeni
      // bir cümle değildir; aynı satır yerinde güncellenir, metin kaybolmaz.
      const prior = key ? committedByKey.get(key) : undefined;
      if (prior && prior.speaker === speaker) {
        let nextText = null;
        if (matchContinuation(prior.text, text) === 'extend') {
          nextText = text;
        } else {
          nextText = mergeSlidingText(prior.text, text);
        }
        if (nextText !== null) {
          if (nextText !== prior.text) {
            prior.text = nextText;
            prior.endedAt = at;
            updated.push(Object.assign({}, prior));
          }
          return { committed: committed, updated: updated };
        }
      }

      // Yeni anahtar. Bekleyen satır aynı konuşmacıdaysa ve metin devamsa
      // (tam önek ya da sondaki cümle işareti atılmış gövde öneki) aynı satırda
      // birleşir. Bu karar satır HENÜZ AÇIKKEN verilir: kapanışı bu çağrıda
      // yapıp yalnızca activeLine boşken son satıra bakmak, kapanış ile yeni
      // metin aynı observe()'da olunca kopya satır bırakır.
      let openRelation =
        activeLine && activeLine.speaker === speaker
          ? matchContinuation(activeLine.text, text)
          : 'none';
      let openSlid = null;
      if (openRelation === 'none' && activeLine && activeLine.speaker === speaker) {
        openSlid = mergeSlidingText(activeLine.text, text);
        if (openSlid !== null) {
          openRelation = 'slide';
        }
      }
      if (openRelation !== 'none') {
        if (openRelation === 'extend') {
          activeLine.text = text;
        } else if (openRelation === 'slide') {
          activeLine.text = openSlid;
        }
        activeLine.lastChangedAt = at;
        if (key) {
          activeLine.keys.add(key);
          pending.set(key, activeLine);
        }
        return { committed: committed, updated: updated };
      }

      // Yeni anahtar ve bekleyen satır da devam değil.
      //
      // Son kesinleşmiş satır Meet'in revizyonu OLABİLİR: Meet, konuşma sırasında
      // altyazı bloğunu YENİ bir blokla değiştirir. Yeni metin eskinin tam
      // öneki olabilir ya da Meet cümle sonuna noktalama koyup cümleyi
      // büyütmüş olabilir. O satır grace dolduğu için zaten kesinleşmişti;
      // yeni satır açmak aynı konuşma turunu iki kez yazdırırdı (mükerrer
      // satır). Bu yüzden eski satır yerinde güncellenir: aynı id, aynı
      // startedAt, metin yeni metindir.
      //
      // "activeLine yok" koşulu şarttır: araya başka bir konuşma girmişse
      // bekleyen bir satır bulunur ve konuşma turlarının sadakati korunur
      // (A, B, A deseni bozulmaz). Açık satırın kendi devamı yukarıda
      // openRelation ile çözülür; burada yalnızca kapanmış son satıra bakılır.
      const lastCommitted = lines.length ? lines[lines.length - 1] : null;
      let closedRelation =
        lastCommitted && !activeLine && lastCommitted.speaker === speaker
          ? matchContinuation(lastCommitted.text, text)
          : 'none';
      let closedSlid = null;
      if (closedRelation === 'none' && lastCommitted && !activeLine && lastCommitted.speaker === speaker) {
        closedSlid = mergeSlidingText(lastCommitted.text, text);
        if (closedSlid !== null) {
          closedRelation = closedSlid !== normalizeText(lastCommitted.text) ? 'extend' : 'hold';
        }
      }
      if (closedRelation !== 'none') {
        const committedAt = Number.isFinite(lastCommitted.endedAt)
          ? lastCommitted.endedAt
          : lastCommitted.startedAt;
        // Uzun metinde ortak başlangıç ya da örtüşme tesadüf olamaz; sekme
        // arka planda donup taramalar dakikalarca aralıklı yapıldığında da
        // aynı konuşma turudur. Zaman sınırı yalnızca kısa metinler içindir.
        const longTurn =
          Math.min(normalizeText(lastCommitted.text).length, normalizeText(text).length) >=
          LONG_TURN_CHARS;
        if (longTurn || (Number.isFinite(committedAt) && at - committedAt <= revisionWindowMs)) {
          if (closedRelation === 'extend') {
            // Meet metni uzatmış: aynı konuşma turu -> satır yerinde güncellenir.
            lastCommitted.text = closedSlid !== null ? closedSlid : text;
            lastCommitted.endedAt = at;
            updated.push(Object.assign({}, lastCommitted));
          }
          // Metin aynı ya da kısalmış: yeni satır AÇILMAZ (mükerrer olurdu),
          // mevcut satır korunur.
          return { committed: committed, updated: updated };
        }
      }

      // Yeni anahtar ve devam değil -> önceki bekleyen satır kesinleşir.
      if (activeLine) {
        committed.push(commitLine(activeLine, at));
      }

      const line = createLine(speaker, text, at);
      line.rootKey = key;
      if (key) {
        line.keys.add(key);
        pending.set(key, line);
      }
      activeLine = line;
      return { committed: committed, updated: updated };
    }

    /** Grace süresi dolan bekleyen satırları kesinleştirir. */
    function tick() {
      const committed = [];
      const at = now();
      const candidates = pendingLines();
      for (const line of candidates) {
        if (at - line.lastChangedAt >= graceMs) {
          committed.push(commitLine(line, at));
        }
      }
      return { committed: committed, updated: [] };
    }

    /** Tüm bekleyen satırları anında kesinleştirir. */
    function flush() {
      const committed = [];
      const at = now();
      const candidates = pendingLines();
      for (const line of candidates) {
        committed.push(commitLine(line, at));
      }
      return { committed: committed, updated: [] };
    }

    /**
     * Motoru sıfırlar (satırlar, bekleyen satırlar).
     *
     * ⚠️ seq (satır sayacı) BİLEREK sıfırlanmaz. Arka planda saklanan
     * oturumdaki satırların id'leri "l1, l2, ..." biçimindedir; sayaç sıfırlanırsa
     * yeni satırlar eski id'leri tekrar kullanır ve arka plan aynı id'li satırı
     * güncellerken ESKİ metni ezer -> sessiz veri kaybı.
     */
    function reset() {
      lines = [];
      pending = new Map();
      committedByKey.clear();
      activeLine = null;
    }

    /** Kesinleşmiş satırların kopyası. */
    function getLines() {
      return lines.map(function (line) {
        return {
          id: line.id,
          speaker: line.speaker,
          text: line.text,
          startedAt: line.startedAt,
          endedAt: line.endedAt,
          seq: line.seq,
        };
      });
    }

    /** Kesinleşmemiş satırların kopyası (debug / arayüz için). */
    function getPending() {
      return pendingLines().map(function (line) {
        return {
          id: line.id,
          speaker: line.speaker,
          text: line.text,
          startedAt: line.startedAt,
          endedAt: line.endedAt,
          seq: line.seq,
        };
      });
    }

    /**
     * Sekme yenilendiğinde kayıp olmaması için background'dan gelen
     * satırları motorun içine geri yükler.
     *
     * Mevcut satırlar SİLİNMEZ; aynı "id"ye sahip satırlar atlanır,
     * diğerleri kronolojik sıraya göre eklenir (çift kayıt ve veri kaybı olmaz).
     * @param {Array<Object>} items
     */
    function restore(items) {
      if (!Array.isArray(items)) {
        return { ok: false, error: 'geçersiz satır listesi' };
      }
      const known = new Set();
      lines.forEach(function (line) {
        known.add(line.id);
      });
      // Bekleyen satırların id'leri de "bilinen" sayılır: geri yüklenen satır
      // ile aynı id'ye sahip canlı bir satır çakışıp id tekrarına yol açmasın.
      pending.forEach(function (line) {
        known.add(line.id);
      });

      let count = 0;
      for (const item of items) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const text = typeof item.text === 'string' ? item.text.trim() : '';
        if (!text) {
          continue;
        }
        const lineSeq = Number.isFinite(item.seq) && item.seq > 0 ? item.seq : seq + 1;
        const id = typeof item.id === 'string' && item.id ? item.id : 'l' + lineSeq;
        if (known.has(id)) {
          // Bu satır zaten elimizde (çift kayıt olmasın).
          if (lineSeq > seq) {
            seq = lineSeq;
          }
          continue;
        }
        known.add(id);
        if (lineSeq > seq) {
          seq = lineSeq;
        }
        lines.push({
          id: id,
          speaker:
            typeof item.speaker === 'string' && item.speaker.trim()
              ? item.speaker.trim()
              : speakerFallback,
          text: text,
          startedAt: Number.isFinite(item.startedAt) ? item.startedAt : now(),
          endedAt: Number.isFinite(item.endedAt) ? item.endedAt : null,
          seq: lineSeq,
        });
        count += 1;
      }

      // Kronolojik sırayı koru.
      lines.sort(function (a, b) {
        if (a.startedAt !== b.startedAt) {
          return a.startedAt - b.startedAt;
        }
        return a.seq - b.seq;
      });

      return { ok: true, lineCount: count, total: lines.length };
    }

    /**
     * Ayarları çalışma anında günceller (ayarlar sayfasından gelen değişiklikler).
     * Geçersiz değerler yok sayılır; mevcut satırlara dokunulmaz.
     * @param {Object} patch
     * @returns {Object} uygulanan ayarların anlık görüntüsü
     */
    function configure(patch) {
      const p = patch && typeof patch === 'object' ? patch : {};
      if (Number.isFinite(p.graceMs)) {
        // Ayarlar sayfasının kabul ettiği aralıkla aynı: 500-5000 ms.
        graceMs = Math.min(5000, Math.max(500, Math.round(p.graceMs)));
      }
      if (typeof p.junkFilter === 'boolean') {
        junkFilter = p.junkFilter;
      }
      if (typeof p.speakerFallback === 'string' && p.speakerFallback.trim()) {
        speakerFallback = p.speakerFallback.trim();
      }
      if (Number.isFinite(p.minLineChars)) {
        minLineChars = Math.max(0, Math.round(p.minLineChars));
      }
      return {
        graceMs: graceMs,
        junkFilter: junkFilter,
        speakerFallback: speakerFallback,
        minLineChars: minLineChars,
      };
    }

    return {
      observe: observe,
      tick: tick,
      flush: flush,
      reset: reset,
      getLines: getLines,
      getPending: getPending,
      restore: restore,
      configure: configure,
    };
  }

  return {
    createTranscriptEngine: createTranscriptEngine,
    isJunkText: isJunkText,
    isContinuation: isContinuation,
    normalizeText: normalizeText,
    UI_BLOCKLIST: UI_BLOCKLIST,
    UI_TOKENS: UI_TOKENS,
    REVISION_WINDOW_MS: REVISION_WINDOW_MS,
  };
});
