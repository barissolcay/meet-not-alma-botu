/**
 * Test harness'ı: gerçek eklenti kodunu sahte bir Chrome API ortamında çalıştırır.
 *
 * Amaç: MV3 ortamını (service worker + içerik betiği) tarayıcı olmadan
 * uçtan uca sürebilmek. Gerçek dosyalar yüklenir; yalnızca Chrome API'leri
 * ve (içerik betiği için) DOM sahte nesneler taklit edilir.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'extension');

const CONTENT_SCRIPT = path.join(EXT, 'src', 'content', 'content.js');
const ENGINE = path.join(EXT, 'src', 'content', 'transcript-engine.js');
const SERVICE_WORKER = path.join(EXT, 'src', 'background', 'service-worker.js');

/** Depolama alanı taklidi (local / session). */
function createStorageArea(name, onChanged, gate) {
  const store = new Map();

  /**
   * Depolama okuma kapısı: `gate.pending` doğruysa okuma, kapı açılana kadar
   * bekler. Testler "ayarlar promise'i ne zaman çözülür?" sorusunu denetlemek
   * için kullanır (varsayılan kapı kapalıdır -> mevcut davranış değişmez).
   */
  function withGate(read) {
    if (!gate || !gate.pending) {
      return read();
    }
    return new Promise((resolve) => {
      gate.waiters.push(function () {
        resolve(read());
      });
    });
  }

  /**
   * Gerçek Chrome depolamaya structured-clone ile yazar: okunan değer
   * canlı bir referans DEĞİLDİR. Taklit de birebir böyle davranmalı, yoksa
   * okuma-değiştirme-yazma yarışları (sessiz satır kaybı) testte görünmez.
   */
  const clone = (value) => {
    if (value === undefined || value === null) {
      return value;
    }
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (err) {
        return value;
      }
    }
    return JSON.parse(JSON.stringify(value));
  };

  function notify(changes) {
    if (!onChanged) {
      return;
    }
    for (const listener of onChanged.slice()) {
      try {
        listener(changes, name);
      } catch (err) {
        console.error('[harness] storage.onChanged dinleyicisi hata verdi:', err);
      }
    }
  }

  return {
    store,
    get(keys) {
      return withGate(function () {
        if (keys === null || keys === undefined) {
          const all = {};
          for (const [key, value] of store) {
            all[key] = clone(value);
          }
          return Promise.resolve(all);
        }
        if (typeof keys === 'string') {
          return Promise.resolve(store.has(keys) ? { [keys]: clone(store.get(keys)) } : {});
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) {
            if (store.has(key)) {
              out[key] = clone(store.get(key));
            }
          }
          return Promise.resolve(out);
        }
        if (typeof keys === 'object') {
          const out = Object.assign({}, keys);
          for (const key of Object.keys(keys)) {
            if (store.has(key)) {
              out[key] = clone(store.get(key));
            }
          }
          return Promise.resolve(out);
        }
        return Promise.resolve({});
      });
    },
    set(items) {
      const changes = {};
      for (const [key, value] of Object.entries(items || {})) {
        const oldValue = store.has(key) ? clone(store.get(key)) : undefined;
        store.set(key, clone(value));
        changes[key] = { oldValue, newValue: clone(value) };
      }
      notify(changes);
      return Promise.resolve();
    },
    remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (store.has(key)) {
          changes[key] = { oldValue: clone(store.get(key)), newValue: undefined };
          store.delete(key);
        }
      }
      notify(changes);
      return Promise.resolve();
    },
    clear() {
      store.clear();
      return Promise.resolve();
    }
  };
}

/**
 * @param {Object} [options]
 * @param {Object} [options.adapter] içerik betiği için sahte Meet adaptörü
 * @param {boolean} [options.withServiceWorker] service worker'ı da yükle
 * @param {boolean} [options.deferLocalGet] chrome.storage.local.get çağrıları
 *   `resolveLocalGet()` çağrılana kadar beklesin (ayarların yüklenme anını
 *   denetlemek için).
 * @param {Object} [options.engine] içerik betiği için sahte transkript motoru
 *   (gerçek motor yerine kullanılır).
 * @param {number} [options.contentSenderTabId] Verilirse içerik betiğinin
 *   `chrome.runtime.sendMessage` çağrıları bu sekmeden gelmiş sayılır
 *   (gerçek Chrome `sender.tab` ekler). Varsayılan: sekme eklenmez.
 *   `sendToBackground` etkilenmez.
 */
function createHarness(options) {
  const opts = options || {};

  /** Sandbox içinde kurulan ve hâlâ bekleyen zamanlayıcılar. */
  const pendingTimers = new Set();

  const runtimeListeners = [];
  const swListeners = [];
  const contentListeners = [];
  const tabListeners = new Map();
  const storageChangedListeners = [];
  const removedListeners = [];
  const installedListeners = [];
  const downloads = [];

  /** Kaydedilen DOM olay dinleyicileri ({ target, type, listener }). */
  const registeredEvents = [];
  /** Oluşturulan MutationObserver örnekleri (hedefleriyle birlikte). */
  const observerInstances = [];
  /** Depolama okuma kapısı (deferLocalGet seçeneği). */
  const localGate = { pending: opts.deferLocalGet === true, waiters: [] };

  const local = createStorageArea('local', storageChangedListeners, localGate);
  const session = createStorageArea('session', storageChangedListeners);

  /** Bir olay dinleyicisi kaydeder (testler hangi olayların dinlendiğini görür). */
  function recordEvent(target, type, listener) {
    registeredEvents.push({ target: target, type: type, listener: listener });
  }

  const tabs = new Map();
  tabs.set(1, { id: 1, url: 'https://meet.google.com/abc-defg-hij', title: 'Meet' });

  /**
   * Dinleyicileri çağırır ve yanıtı bekler.
   *
   * Chrome'un gerçek davranışı taklit edilir: bir dinleyici asenkron yanıt
   * verecekse `true` döndürmek ZORUNDADIR; döndürmezse yanıt kanalı kapanır
   * ve asenkron `sendResponse` çağrısı yok sayılır. Bu, gerçek tarayıcıda
   * sessizce bozulan mesajlaşma hatalarının testte yakalanmasını sağlar.
   */
  function dispatch(listeners, message, sender) {
    return new Promise((resolve) => {
      let settled = false;
      let expectsAsync = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      for (const listener of listeners.slice()) {
        if (settled) {
          return;
        }
        try {
          const result = listener(message, sender, finish);
          if (result === true) {
            // Yanıt asenkron gelecek; callback'i bekleniyor.
            expectsAsync = true;
            return;
          }
        } catch (err) {
          console.error('[harness] dinleyici hata verdi:', err);
        }
      }
      if (expectsAsync) {
        return;
      }
      // Kimse yanıt vermediyse undefined döner (gerçek davranış).
      setTimeout(() => finish(undefined), 0);
    });
  }

  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        },
      },
      onInstalled: {
        addListener(listener) {
          installedListeners.push(listener);
        },
      },
      sendMessage(message, callback) {
        const sender = { id: 'test-extension' };
        if (typeof opts.contentSenderTabId === 'number') {
          const tab = tabs.get(opts.contentSenderTabId);
          sender.tab = {
            id: opts.contentSenderTabId,
            url: tab && tab.url ? tab.url : ''
          };
        }
        dispatch(swListeners, message, sender).then((response) => {
          if (typeof callback === 'function') {
            callback(response);
          }
        });
      },
      getURL(p) {
        return 'chrome-extension://test/' + p;
      },
    },
    storage: {
      local,
      session,
      onChanged: {
        addListener(listener) {
          storageChangedListeners.push(listener);
        },
      },
    },
    tabs: {
      query(queryInfo, callback) {
        let list = Array.from(tabs.values());
        if (queryInfo && queryInfo.active) {
          list = list.filter((tab) => tab.active);
        }
        if (typeof callback === 'function') {
          callback(list);
        }
        return Promise.resolve(list);
      },
      get(tabId, callback) {
        const tab = tabs.get(tabId);
        if (typeof callback === 'function') {
          callback(tab);
        }
        return Promise.resolve(tab);
      },
      create(createProperties, callback) {
        let id = 1;
        for (const key of tabs.keys()) {
          if (key >= id) {
            id = key + 1;
          }
        }
        const tab = {
          id: id,
          url: (createProperties && createProperties.url) || '',
          title: 'Meet',
          active: !!(createProperties && createProperties.active)
        };
        tabs.set(id, tab);
        if (typeof callback === 'function') {
          callback(tab);
        }
        return Promise.resolve(tab);
      },
      sendMessage(tabId, message, callback) {
        const listener = tabListeners.get(tabId);
        if (!listener) {
          // Gerçek Chrome: içerik betiği yoksa hata verir.
          chrome.runtime.lastError = { message: 'Could not establish connection.' };
          if (typeof callback === 'function') {
            callback(undefined);
          }
          chrome.runtime.lastError = undefined;
          return;
        }
        dispatch([listener], message, { id: 'test-extension', tab: { id: tabId } }).then((response) => {
          if (typeof callback === 'function') {
            callback(response);
          }
        });
      },
      onRemoved: {
        addListener(listener) {
          removedListeners.push(listener);
        },
      },
    },
    downloads: {
      download(options, callback) {
        downloads.push(options);
        if (typeof callback === 'function') {
          callback(downloads.length);
        }
        return Promise.resolve(downloads.length);
      },
    }
  };

  const sandbox = {
    chrome,
    // Konsol uyarı/hataları gerçek konsola aktarılır: test içinde neden
    // bir şeyin olmadığını görmek için sessizce yutmak yanıltıcıdır.
    console: {
      log: () => {},
      info: () => {},
      warn: (...args) => console.warn('[harness]', ...args),
      error: (...args) => console.error('[harness]', ...args)
    },
    // Zamanlayıcılar takip edilir: test sonunda "ne ayakta kaldı?" sorusu
    // yanıtlanabilir olsun.
    setTimeout: function (fn, ms, ...rest) {
      const timer = setTimeout(fn, ms, ...rest);
      pendingTimers.add(timer);
      return timer;
    },
    clearTimeout: function (timer) {
      pendingTimers.delete(timer);
      return clearTimeout(timer);
    },
    // Aralıklar "unref" edilir: içerik betiğinin periyodik zamanlayıcıları
    // Node'un olay döngüsünü ayakta tutmasın, test dosyası çıkabilsin.
    setInterval: function (...args) {
      const timer = setInterval(...args);
      if (timer && typeof timer.unref === 'function') {
        timer.unref();
      }
      return timer;
    },
    clearInterval,
    queueMicrotask,
    addEventListener(type, listener) {
      recordEvent('window', type, listener);
    },
    removeEventListener: () => {},
    dispatchEvent: () => {},
    Promise,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Error,
    TypeError,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    URL,
    Blob: function Blob() {},
    globalThis: null
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);

  function runFile(file) {
    const code = fs.readFileSync(file, 'utf8');
    vm.runInContext(code, context, { filename: file });
  }

  /** Service worker'ı (ve bağımlılıklarını) yükler. */
  function loadServiceWorker() {
    sandbox.importScripts = (...files) => {
      for (const rel of files) {
        runFile(path.resolve(path.dirname(SERVICE_WORKER), rel));
      }
    };
    const before = runtimeListeners.length;
    runFile(SERVICE_WORKER);
    // Service worker'ın kendi dinleyicileri (içerik betiği sonradan yüklenecek).
    for (const listener of runtimeListeners.slice(before)) {
      swListeners.push(listener);
    }
    return harness;
  }

  /** İçerik betiğini yükler (motor gerçek, adaptör sahte). */
  function loadContentScript(tabId) {
    runFile(ENGINE);
    sandbox.MNAAdapter = {
      createMeetAdapter() {
        return opts.adapter || createStubAdapter();
      },
    };
    if (opts.engine) {
      // Test için sahte motor: gerçek motorun sözleşmesi taklit edilir.
      sandbox.MNAEngine = {
        createTranscriptEngine() {
          return opts.engine;
        },
      };
    }

    // Minimal DOM taklidi.
    sandbox.document = {
      body: {},
      title: 'Haftalık Sync - Google Meet',
      visibilityState: 'visible',
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener(type, listener) {
        recordEvent('document', type, listener);
      },
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    };
    sandbox.location = { href: 'https://meet.google.com/abc-defg-hij' };
    sandbox.MutationObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.target = null;
        this.options = null;
        observerInstances.push(this);
      }
      observe(target, options) {
        this.target = target;
        this.options = options || null;
      }
      disconnect() {}
      trigger() {
        this.callback([]);
      }
    };
    sandbox.MutationObserver.instances = observerInstances;
    sandbox.navigator = { clipboard: { writeText: async () => {} } };

    return bindContentScript(tabId);
  }

  /** İçerik betiğinin mesaj dinleyicisini yakalar ve sekmeye bağlar. */
  function bindContentScript(tabId) {
    const before = runtimeListeners.length;
    runFile(CONTENT_SCRIPT);
    const listener = runtimeListeners[before];
    contentListeners.push(listener);
    tabListeners.set(tabId, listener);
    return harness;
  }

  /**
   * Sekmeye "canlı" ama sahte bir içerik betiği bağlar: her mesaja `{ok:true}`
   * ile yanıt verir. Yalnızca service worker tarafının tek başına
   * sınanması gereken testlerde kullanılır.
   */
  function attachEchoContentScript(tabId) {
    const listener = (message, sender, sendResponse) => {
      if (message && message.type === 'MNA_STATUS') {
        sendResponse({
          ok: true,
          capture: { active: false, startedAt: null, lineCount: 0, lastLineAt: null },
          captions: { detected: true },
          meeting: {
            url: 'https://meet.google.com/abc-defg-hij',
            code: 'abc-defg-hij',
            title: 'Haftalık Sync'
          }
        });
        return false;
      }
      if (message && message.type === 'MNA_GET_LINES') {
        sendResponse({ ok: true, lines: [] });
        return false;
      }
      if (message && message.type === 'MNA_FLUSH') {
        sendResponse({ ok: true, lines: [] });
        return false;
      }
      sendResponse({ ok: true });
      return false;
    };
    contentListeners.push(listener);
    tabListeners.set(tabId, listener);
    return harness;
  }

  const harness = {
    chrome,
    context,
    sandbox,
    local,
    session,
    downloads,
    runtimeListeners,
    swListeners,
    contentListeners,
    removedListeners,
    installedListeners,
    /** Kaydedilen DOM olay dinleyicileri ({ target, type, listener }). */
    registeredEvents,
    /** Oluşturulan MutationObserver örnekleri (hedefleriyle birlikte). */
    observers: observerInstances,
    loadServiceWorker,
    loadContentScript,
    bindContentScript,
    attachEchoContentScript,

    /**
     * Depolama okuma kapısını açar: bekleyen chrome.storage.local.get
     * çağrıları çözülür (deferLocalGet seçeneğiyle kullanılır).
     */
    resolveLocalGet() {
      localGate.pending = false;
      const waiters = localGate.waiters.splice(0, localGate.waiters.length);
      for (const waiter of waiters) {
        waiter();
      }
      return harness;
    },

    /** Service worker'a mesaj gönderir. */
    sendToBackground(message, sender) {
      return dispatch(swListeners, message, sender || { id: 'test-extension' });
    },

    /** İçerik betiğine (bir sekmeye) mesaj gönderir. */
    sendToTab(tabId, message) {
      const listener = tabListeners.get(tabId);
      if (!listener) {
        return Promise.resolve(undefined);
      }
      return dispatch([listener], message, { id: 'test-extension', tab: { id: tabId } });
    },

    /** Sekmeyi kapatma olayını tetikler. */
    removeTab(tabId) {
      tabs.delete(tabId);
      for (const listener of removedListeners.slice()) {
        listener(tabId, { windowId: 1, isWindowClosing: false });
      }
      return harness;
    },

    cleanup() {
      for (const timer of harness._timers || []) {
        clearInterval(timer);
      }
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
    },

    /** Hâlâ bekleyen zamanlayıcı sayısı (test sonunda teşhis için). */
    pendingTimerCount() {
      return pendingTimers.size;
    }
  };

  return harness;
}

/** İçerik betiği için varsayılan sahte Meet adaptörü. */
function createStubAdapter(overrides) {
  const blocks = (overrides && overrides.blocks) || [];
  let keyCounter = 0;
  const keys = new WeakMap();
  // Sabit bölge nesnesi: her çağrıda yeni nesne dönmek, içerik betiğinin
  // gözlemciyi her taramada yeniden bağlamasına yol açardı.
  const region = { id: 'region' };

  return {
    /** Canlı blok listesi (testler blok ekleyip çıkarabilir). */
    blocks: blocks,
    /**
     * Blok listesini değiştirir. Liste boşaltılırsa altyazı bölgesi
     * bulunamaz (Meet'te CC'nin kapatılması taklit edilir).
     */
    setBlocks(next) {
      blocks.length = 0;
      if (Array.isArray(next)) {
        for (const block of next) {
          blocks.push(block);
        }
      }
      return blocks;
    },
    findCaptionsRegion() {
      return blocks.length ? region : null;
    },
    collectBlocks() {
      return blocks.slice();
    },
    getBlockKey(block) {
      if (!keys.has(block)) {
        keyCounter += 1;
        keys.set(block, 'b' + keyCounter);
      }
      return keys.get(block);
    },
    readBlock(block) {
      return block && block.speaker !== undefined
        ? { speaker: block.speaker, text: block.text }
        : null;
    },
    getMeetingInfo() {
      return {
        url: 'https://meet.google.com/abc-defg-hij',
        code: 'abc-defg-hij',
        title: 'Haftalık Sync',
      };
    },
    isCaptionsLikelyOn(region) {
      return !!region;
    }
  };
}

module.exports = {
  createHarness,
  createStubAdapter,
  EXT,
  ROOT
};
