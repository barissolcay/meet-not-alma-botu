/**
 * Meet Not Alma Botu - ayarlar sayfası.
 *
 * Ayarlar chrome.storage.local içindeki "mna.settings" anahtarında tutulur.
 */
(function () {
  'use strict';

  const Settings = window.MNASettings;
  const DEFAULT_SETTINGS = (Settings && Settings.DEFAULT_SETTINGS) || {
    graceMs: 2500,
    speakerFallback: 'Bilinmeyen',
    localSpeakerName: 'Ben',
    includeTimestamps: true,
    junkFilter: true,
    autoStartOnCc: false,
    autoStopWhenAlone: true,
    autoStopSilenceMin: 0,
    maxStoredSessions: 100
  };

  const GRACE_MIN = 500;
  const GRACE_MAX = 5000;

  let el = {};
  let toastTimer = null;

  function cacheDom() {
    el = {
      form: document.getElementById('settingsForm'),
      graceMs: document.getElementById('graceMs'),
      speakerFallback: document.getElementById('speakerFallback'),
      localSpeakerName: document.getElementById('localSpeakerName'),
      includeTimestamps: document.getElementById('includeTimestamps'),
      junkFilter: document.getElementById('junkFilter'),
      autoStartOnCc: document.getElementById('autoStartOnCc'),
      autoStopWhenAlone: document.getElementById('autoStopWhenAlone'),
      autoStopSilenceMin: document.getElementById('autoStopSilenceMin'),
      maxStoredSessions: document.getElementById('maxStoredSessions'),
      formError: document.getElementById('formError'),
      saveBtn: document.getElementById('saveBtn'),
      resetBtn: document.getElementById('resetBtn'),
      toast: document.getElementById('toast')
    };
  }

  function fillForm(settings) {
    el.graceMs.value = settings.graceMs;
    el.speakerFallback.value = settings.speakerFallback;
    el.localSpeakerName.value = settings.localSpeakerName || DEFAULT_SETTINGS.localSpeakerName;
    el.includeTimestamps.checked = Boolean(settings.includeTimestamps);
    el.junkFilter.checked = Boolean(settings.junkFilter);
    el.autoStartOnCc.checked = Boolean(settings.autoStartOnCc);
    el.autoStopWhenAlone.checked = settings.autoStopWhenAlone !== false;
    el.autoStopSilenceMin.value = Number(settings.autoStopSilenceMin) || 0;
    el.maxStoredSessions.value = settings.maxStoredSessions;
  }

  function readForm() {
    return {
      graceMs: Number(el.graceMs.value),
      speakerFallback: el.speakerFallback.value,
      localSpeakerName: el.localSpeakerName.value,
      includeTimestamps: el.includeTimestamps.checked,
      junkFilter: el.junkFilter.checked,
      autoStartOnCc: el.autoStartOnCc.checked,
      autoStopWhenAlone: el.autoStopWhenAlone.checked,
      autoStopSilenceMin: Number(el.autoStopSilenceMin.value) || 0,
      maxStoredSessions: Number(el.maxStoredSessions.value)
    };
  }

  /** Form değerlerini doğrular; hata varsa mesajı döndürür. */
  function validate(values) {
    if (!Number.isFinite(values.graceMs) || values.graceMs < GRACE_MIN || values.graceMs > GRACE_MAX) {
      return `Satır birleştirme süresi ${GRACE_MIN}–${GRACE_MAX} ms aralığında olmalı.`;
    }
    if (!Number.isFinite(values.maxStoredSessions) || values.maxStoredSessions < 1 || values.maxStoredSessions > 1000) {
      return 'Saklanacak oturum sayısı 1–1000 aralığında olmalı.';
    }
    if (
      !Number.isFinite(values.autoStopSilenceMin) ||
      values.autoStopSilenceMin < 0 ||
      (values.autoStopSilenceMin > 0 && (values.autoStopSilenceMin < 10 || values.autoStopSilenceMin > 240))
    ) {
      return 'Sessizlik süresi 0 (kapalı) ya da 10–240 dakika olmalı.';
    }
    if (!String(values.speakerFallback || '').trim()) {
      return 'Konuşmacı bilinmiyorsa alanı boş bırakamazsınız.';
    }
    if (!String(values.localSpeakerName || '').trim()) {
      return 'Yerel kullanıcı adı boş bırakılamaz.';
    }
    return '';
  }

  async function load() {
    try {
      const settings = Settings ? await Settings.getSettings() : DEFAULT_SETTINGS;
      fillForm(settings);
    } catch (err) {
      console.error('[MNA] Ayarlar yüklenemedi:', err);
      fillForm(DEFAULT_SETTINGS);
      toast('Ayarlar okunamadı, varsayılanlar gösteriliyor.', true);
    }
  }

  async function save(values, silent) {
    const error = validate(values);
    el.formError.textContent = error;
    if (error) {
      toast(error, true);
      return false;
    }
    try {
      if (Settings) {
        await Settings.saveSettings(values);
      } else {
        await chrome.storage.local.set({ 'mna.settings': values });
      }
      if (!silent) {
        toast('Ayarlar kaydedildi.');
      }
      return true;
    } catch (err) {
      console.error('[MNA] Ayarlar kaydedilemedi:', err);
      toast('Ayarlar kaydedilemedi.', true);
      return false;
    }
  }

  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.className = 'toast' + (isError ? ' toast--error' : '');
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 3000);
  }

  function bindEvents() {
    el.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      el.saveBtn.disabled = true;
      const ok = await save(readForm(), false);
      el.saveBtn.disabled = false;
      if (ok) {
        const settings = Settings ? await Settings.getSettings() : readForm();
        fillForm(settings);
      }
    });

    el.resetBtn.addEventListener('click', async () => {
      fillForm(DEFAULT_SETTINGS);
      el.formError.textContent = '';
      const ok = await save(Object.assign({}, DEFAULT_SETTINGS), true);
      if (ok) {
        toast('Varsayılan ayarlar geri yüklendi.');
      }
    });
  }

  /* ---------------- planlı katılım günlüğü ---------------- */

  const TRACE_KEY = 'mna.joinTrace';

  function pad(value, size) {
    return String(value).padStart(size || 2, '0');
  }

  function formatTraceTime(ms) {
    const d = new Date(ms);
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' +
      pad(d.getMilliseconds(), 3)
    );
  }

  /** Günlük kayıtlarını okunur metne çevirir. */
  function formatTrace(list) {
    const lines = [];
    let version = '';
    try {
      version = chrome.runtime.getManifest().version;
    } catch (err) {
      version = '?';
    }
    lines.push('Meet Not Alma Botu - planlı katılım günlüğü');
    lines.push('Eklenti sürümü: ' + version);
    lines.push('Oluşturulma: ' + formatTraceTime(Date.now()));
    lines.push('Kayıt sayısı: ' + list.length);
    lines.push('Kaynaklar: sw = arka plan, page = Meet sayfası');
    lines.push('');
    list.forEach((entry) => {
      if (!entry) {
        return;
      }
      let data = '';
      try {
        data = entry.data === null || entry.data === undefined ? '' : ' ' + JSON.stringify(entry.data);
      } catch (err) {
        data = '';
      }
      const id = entry.id ? String(entry.id).slice(-6) : '-';
      lines.push(
        formatTraceTime(Number(entry.t) || 0) + '  [' + entry.src + '] ' + id + '  ' + entry.type + data
      );
    });
    return lines.join('\n') + '\n';
  }

  async function readTrace() {
    const result = await chrome.storage.local.get(TRACE_KEY);
    const list = result && result[TRACE_KEY];
    return Array.isArray(list) ? list : [];
  }

  async function refreshTraceInfo() {
    if (!el.traceInfo) {
      return;
    }
    try {
      const list = await readTrace();
      el.traceInfo.textContent = list.length
        ? 'Kayıtlı olay sayısı: ' + list.length + ' (son: ' + formatTraceTime(Number(list[list.length - 1].t) || 0) + ')'
        : 'Henüz kayıt yok.';
    } catch (err) {
      el.traceInfo.textContent = '';
    }
  }

  async function downloadTrace() {
    try {
      const list = await readTrace();
      if (!list.length) {
        toast('Günlükte henüz kayıt yok.', true);
        return;
      }
      const blob = new Blob([formatTrace(list)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const stamp = formatTraceTime(Date.now()).replace(/[: ]/g, '-').slice(0, 19);
      anchor.href = url;
      anchor.download = 'meet-planli-katilim-gunlugu-' + stamp + '.txt';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (err) {
      console.error('[MNA] Günlük indirilemedi:', err);
      toast('Günlük indirilemedi.', true);
    }
  }

  async function clearTrace() {
    try {
      await chrome.storage.local.remove(TRACE_KEY);
      toast('Günlük temizlendi.');
      refreshTraceInfo();
    } catch (err) {
      toast('Günlük temizlenemedi.', true);
    }
  }

  function bindTrace() {
    el.traceInfo = document.getElementById('traceInfo');
    const download = document.getElementById('traceDownloadBtn');
    const clear = document.getElementById('traceClearBtn');
    if (download) {
      download.addEventListener('click', downloadTrace);
    }
    if (clear) {
      clear.addEventListener('click', clearTrace);
    }
    refreshTraceInfo();
  }

  function init() {
    cacheDom();
    bindEvents();
    bindTrace();
    load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
