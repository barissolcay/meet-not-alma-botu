/**
 * Meet Not Alma Botu — Google Meet DOM adaptörü.
 *
 * Bu dosya DOM'u bilen TEK katmandır. Transkript mantığı
 * `transcript-engine.js` içinde saf olarak kalır.
 *
 * UMD sarmalayıcı: tarayıcıda `globalThis.MNAAdapter`,
 * Node'da `require('.../meet-adapter.js')`.
 */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MNAAdapter = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Altyazı bölgesi adayları, öncelik sırasıyla.
   * Etiket dili değişebildiği için (Captions / Altyazılar / Sous-titres ...)
   * önce İngilizce aria-label, sonra "caption" içeren genel eşleşme, ardından
   * yerelleştirilmiş etiketler ve son olarak sınıf/jsname fallback'leri denenir.
   *
   * Yerelleştirme matrisi (K11):
   *   en: caption · tr: altyazı · es: subtítulo · pt: legenda · it: didascalia
   *   ja: 字幕 / キャプション · ru: субтитр · pl: napisy
   *   nl: ondertitel · fi: tekstitys · ko: 자막
   */
  const REGION_SELECTORS = [
    '[role="region"][aria-label="Captions"]',
    '[role="region"][aria-label*="caption" i]',
    '[role="region"][aria-label*="subtitle" i]',
    '[role="region"][aria-label*="altyaz" i]',
    '[role="region"][aria-label*="sous-titre" i]',
    '[role="region"][aria-label*="untertitel" i]',
    // Yerelleştirilmiş etiketler (büyük/küçük harf duyarsız).
    '[role="region"][aria-label*="subtítul" i]',
    '[role="region"][aria-label*="subtitul" i]',
    '[role="region"][aria-label*="legenda" i]',
    '[role="region"][aria-label*="didascalia" i]',
    '[role="region"][aria-label*="字幕" i]',
    '[role="region"][aria-label*="キャプション" i]',
    '[role="region"][aria-label*="субтитр" i]',
    '[role="region"][aria-label*="napisy" i]',
    '[role="region"][aria-label*="ondertitel" i]',
    '[role="region"][aria-label*="tekstitys" i]',
    '[role="region"][aria-label*="자막" i]',
    'div.aarpc',
    '[jsname="yvBXue"]',
    '[jsname="yvBXue"] [role="region"]',
  ];

  /** Konuşmacı bloğu (bir cümle + konuşmacı adı) */
  const BLOCK_SELECTORS = ['.nMcdL', '.AdDDte', '.r6x1ue'];

  /** Konuşmacı adı elementi (yeni / eski Meet sürümleri) */
  const SPEAKER_SELECTORS = ['.KcIKyf', '.I9Ujf', '.adLgBb'];

  /** Altyazı metin elementi (yeni / eski Meet sürümleri) */
  const TEXT_SELECTORS = ['.ygicle', '.aagIjf', '.a4Iad', '.YajGde'];

  /** Avatar/görsel öğeleri */
  const AVATAR_SELECTORS = ['img', 'c-wiz > div > img', '[data-avatar-url]'];

  function toArray(nodeList) {
    return Array.prototype.slice.call(nodeList || []);
  }

  function cleanText(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Metnin başında yapışık kalan konuşmacı adını kaldırır (K8).
   *   "SizMerhaba dünya" -> "Merhaba dünya"
   *   "Siz Merhaba dünya" -> "Merhaba dünya"
   * Küçük harle devam eden cümle ("Siz de mi?") gerçek altyazı metni
   * olabileceğinden korunur.
   * @param {string} text
   * @param {string} speaker
   * @returns {string}
   */
  function stripSpeakerPrefix(text, speaker) {
    if (!text || !speaker) {
      return text;
    }
    const name = String(speaker);
    if (text.toLowerCase().indexOf(name.toLowerCase()) !== 0) {
      return text;
    }
    const rest = text.slice(name.length);
    const trimmed = rest.trim();
    if (!trimmed) {
      return '';
    }
    const first = trimmed.charAt(0);
    const startsLower = first === first.toLowerCase() && first !== first.toUpperCase();
    if (/^\s/.test(rest) && startsLower) {
      return text;
    }
    return trimmed;
  }

  function safeQueryAll(root, selector) {
    try {
      return toArray(root.querySelectorAll(selector));
    } catch (err) {
      console.warn('[MNA] meet-adapter: seçici hatası —', selector, err);
      return [];
    }
  }

  function safeQuery(root, selector) {
    try {
      return root.querySelector(selector);
    } catch (err) {
      console.warn('[MNA] meet-adapter: seçici hatası —', selector, err);
      return null;
    }
  }

  function firstMatch(root, selectors) {
    for (const selector of selectors) {
      const found = safeQuery(root, selector);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Meet DOM adaptörü.
   * @param {{document: Document, window: Window}} deps
   */
  function createMeetAdapter(deps) {
    const options = deps && typeof deps === 'object' ? deps : {};
    const doc =
      options.document ||
      (typeof document !== 'undefined' ? document : null);
    const win =
      options.window || (typeof window !== 'undefined' ? window : null);

    /** Blok elementine kararlı anahtar verir (WeakMap). */
    const keyMap = new WeakMap();
    let keyCounter = 0;
    /** Son uyarılan bölge: aynı bölge için uyarı tekrar edilmez. */
    let warnedRegion = null;

    function regionHasBlocks(region) {
      if (!region || typeof region.querySelectorAll !== 'function') {
        return false;
      }
      for (const selector of BLOCK_SELECTORS) {
        if (safeQueryAll(region, selector).length > 0) {
          return true;
        }
      }
      return false;
    }

    /**
     * Altyazı bölgesini bulur.
     * @returns {Element|null}
     */
    function findCaptionsRegion() {
      if (!doc || !doc.querySelectorAll) {
        return null;
      }
      const fallback = [];
      for (const selector of REGION_SELECTORS) {
        const matches = safeQueryAll(doc, selector);
        if (!matches.length) {
          continue;
        }
        // Önce gerçekten altyazı bloğu içeren bölgeyi tercih et.
        for (const match of matches) {
          if (regionHasBlocks(match)) {
            return match;
          }
        }
        fallback.push(matches[0]);
      }
      return fallback.length ? fallback[0] : null;
    }

    /**
     * Yapısal fallback: avatar (img) + metin içeren en yakın kapsayıcı blok.
     */
    function structuralBlocks(region) {
      const blocks = [];
      const seen = new Set();
      const images = safeQueryAll(region, AVATAR_SELECTORS.join(','));
      for (const img of images) {
        let node = img.parentElement;
        while (node && node !== region) {
          const hasText = cleanText(node.textContent).length > 0;
          if (hasText) {
            if (!seen.has(node)) {
              seen.add(node);
              blocks.push(node);
            }
            break;
          }
          node = node.parentElement;
        }
      }
      return blocks;
    }

    /**
     * Konuşmacı bloklarını döndürür.
     * @param {Element} region
     * @returns {Array<Element>}
     */
    function collectBlocks(region) {
      if (!region || !region.querySelectorAll) {
        return [];
      }
      for (const selector of BLOCK_SELECTORS) {
        const found = safeQueryAll(region, selector);
        if (found.length) {
          return found;
        }
      }
      return structuralBlocks(region);
    }

    /** Klon üzerinden avatar/toolbar metinlerini temizler (canlı DOM'a dokunmaz). */
    function stripNoise(clone) {
      const textSelector = TEXT_SELECTORS.join(',');
      const noisy = clone.querySelectorAll(
        SPEAKER_SELECTORS.join(',') + ', button, [role="button"], [aria-label]'
      );
      toArray(noisy).forEach(function (node) {
        if (!node || node.nodeType !== 1) {
          return;
        }
        // Metin taşıyan kaplar temizlenmez.
        if (node.matches(textSelector)) {
          return;
        }
        if (node.querySelector(textSelector)) {
          return;
        }
        try {
          node.remove();
        } catch (err) {
          /* yoksay */
        }
      });
      return clone;
    }

    /**
     * Klon üzerindeki konuşmacı düğümünü altyazı metninden ayırır (K8).
     * Konuşmacı düğümü altyazı metnini de içeriyorsa düğüm silinmez; yalnızca
     * kendi doğrudan metin çocukları temizlenir.
     * @param {Element} speakerNode
     * @returns {boolean} konuşmacı metni metinden tamamen çıkarıldıysa true
     */
    function detachSpeakerNode(speakerNode) {
      if (!speakerNode) {
        return false;
      }
      const textSelector = TEXT_SELECTORS.join(',');
      try {
        if (speakerNode.querySelector(textSelector)) {
          const children = toArray(speakerNode.childNodes || []);
          children.forEach(function (child) {
            if (child && child.nodeType === 3) {
              child.remove();
            }
          });
          return false;
        }
        speakerNode.remove();
        return true;
      } catch (err) {
        return false;
      }
    }

    /**
     * Bloktan konuşmacı ve metin okur.
     * @param {Element} block
     * @returns {{speaker: string, text: string}|null}
     */
    function readBlock(block) {
      if (!block || block.nodeType !== 1) {
        return null;
      }

      const speakerEl = firstMatch(block, SPEAKER_SELECTORS);
      let speaker = speakerEl ? cleanText(speakerEl.textContent) : '';

      if (!speaker) {
        const avatar = firstMatch(block, AVATAR_SELECTORS);
        if (avatar) {
          speaker = cleanText(
            avatar.getAttribute('aria-label') ||
              avatar.getAttribute('alt') ||
              avatar.getAttribute('data-avatar-url') ||
              ''
          );
        }
      }

      const textEl = firstMatch(block, TEXT_SELECTORS);
      let text = textEl ? cleanText(textEl.textContent) : '';

      if (!text) {
        // Yapısal fallback: blokun kendi metni (avatar/toolbar metinleri temizlenerek).
        try {
          const clone = block.cloneNode(true);
          // Konuşmacı adı metne yapışmasın: konuşmacı düğümü klon üzerinden ayrılır.
          const speakerDetached = detachSpeakerNode(
            firstMatch(clone, SPEAKER_SELECTORS)
          );
          stripNoise(clone);
          text = cleanText(clone.textContent);
          if (!speakerDetached && speaker) {
            // Konuşmacı düğümü ayrılamadıysa (ör. avatar adından türedi),
            // metnin başındaki yapışık konuşmacı adı temizlenir.
            text = stripSpeakerPrefix(text, speaker);
          }
        } catch (err) {
          console.warn('[MNA] meet-adapter: blok klonlanamadı —', err);
          text = cleanText(block.textContent);
        }
      }

      if (!speaker && !text) {
        return null;
      }
      return { speaker: speaker, text: text };
    }

    /**
     * Blok elementine kararlı anahtar verir (aynı element -> aynı anahtar).
     * @param {Element} block
     * @returns {string}
     */
    function getBlockKey(block) {
      if (!block || typeof block !== 'object') {
        return '';
      }
      let key = keyMap.get(block);
      if (!key) {
        keyCounter += 1;
        key = 'b' + keyCounter;
        keyMap.set(block, key);
      }
      return key;
    }

    /** Meet toplantı kodunu (abc-defg-hij) URL'den çıkarır. */
    function extractMeetingCode(url) {
      if (!url) {
        return null;
      }
      const patterns = [
        /\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$|\?|#| )/i,
        /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i,
        /\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i,
      ];
      for (const pattern of patterns) {
        const match = String(url).match(pattern);
        if (match && match[1]) {
          return match[1].toLowerCase();
        }
      }
      return null;
    }

    /**
     * Toplantı bilgisi.
     * @returns {{url: string, code: string|null, title: string}}
     */
    function getMeetingInfo() {
      let url = '';
      if (win && win.location && win.location.href) {
        url = win.location.href;
      } else if (doc && doc.location && doc.location.href) {
        url = doc.location.href;
      }
      const title = doc && doc.title ? doc.title : '';
      return { url: url, code: extractMeetingCode(url), title: title };
    }

    /**
     * Altyazı bölgesi DOM'da var mı ve okunabilir mi (CC açık mı)?
     * Bölge bulunsa bile içinde okunabilir altyazı bloğu yoksa CC açık
     * sayılmaz; Meet arayüzü değişmiş olabilir.
     * @param {Element} [region]
     * @returns {boolean}
     */
    function isCaptionsLikelyOn(region) {
      const target = region === undefined ? findCaptionsRegion() : region;
      if (!target) {
        return false;
      }
      if (target.isConnected === false) {
        return false;
      }
      if (regionHasBlocks(target)) {
        return true;
      }
      if (warnedRegion !== target) {
        warnedRegion = target;
        console.warn(
          '[MNA] Altyazı bölgesi bulundu ancak okunabilir altyazı bloğu yok. ' +
            'Meet arayüzü değişmiş olabilir — extension/src/content/meet-adapter.js ' +
            'içindeki seçicileri güncelleyin.'
        );
      }
      return false;
    }

    return {
      findCaptionsRegion: findCaptionsRegion,
      collectBlocks: collectBlocks,
      readBlock: readBlock,
      getBlockKey: getBlockKey,
      getMeetingInfo: getMeetingInfo,
      isCaptionsLikelyOn: isCaptionsLikelyOn,
      extractMeetingCode: extractMeetingCode,
      REGION_SELECTORS: REGION_SELECTORS,
      BLOCK_SELECTORS: BLOCK_SELECTORS,
      SPEAKER_SELECTORS: SPEAKER_SELECTORS,
      TEXT_SELECTORS: TEXT_SELECTORS,
    };
  }

  return {
    createMeetAdapter: createMeetAdapter,
    REGION_SELECTORS: REGION_SELECTORS,
    BLOCK_SELECTORS: BLOCK_SELECTORS,
    SPEAKER_SELECTORS: SPEAKER_SELECTORS,
    TEXT_SELECTORS: TEXT_SELECTORS,
  };
});
