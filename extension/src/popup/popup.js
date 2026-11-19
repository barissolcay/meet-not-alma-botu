/**
 * Meet Not Alma Botu - popup arayüzü.
 *
 * Popup, aktif Meet sekmesinin durumunu içerik betiğinden (MNA_STATUS) ve
 * arka plandaki aktif oturumu (MNA_ACTIVE_SESSION) okuyarak gösterir.
 */
(function () {
  'use strict';

  const T = window.MNAProtocol.MESSAGE_TYPES;
  const F = window.MNAFormatters;
  const Schedule = window.MNASchedule || null;
  /** Yardımcı fonksiyonlar (utils.js) — yüklenemezse özellikler devre dışı kalır. */
  const Utils = window.MNAUtils || null;

  const REFRESH_MS = 1500;
  const FORMAT_MIME = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    srt: 'application/x-subrip',
    vtt: 'text/vtt'
  };

  const state = {
    tabId: null,
    isMeet: false,
    hasContent: false,
    status: null,
    active: null,
    settings: null,
    schedules: [],
    /** İşlem sürerken düğmeler kilitli tutulur (çift oturumu önler). */
    busy: false
  };

  let el = {};
  let toastTimer = null;
  let refreshTimer = null;
  /** Sekme yenilenmişse arka plandan durum geri yüklemesi istenir (kısıtlı frekans). */
  let lastRestoreRequest = 0;
  const RESTORE_REQUEST_COOLDOWN_MS = 5000;
  /** Bu süreden yeni kayıtlar için geri yükleme isteği gönderilmez. */
  const RESTORE_MIN_AGE_MS = 5000;

  /* -------------------- DOM -------------------- */

  function cacheDom() {
    el = {
      statusPill: document.getElementById('statusPill'),
      notMeetNotice: document.getElementById('notMeetNotice'),
      reloadNotice: document.getElementById('reloadNotice'),
      recordState: document.getElementById('recordState'),
      lineCount: document.getElementById('lineCount'),
      meetingCode: document.getElementById('meetingCode'),
      meetingLink: document.getElementById('meetingLink'),
      ccWarning: document.getElementById('ccWarning'),
      ccUnreadable: document.getElementById('ccUnreadable'),
      toggleCcBtn: document.getElementById('toggleCcBtn'),
      startBtn: document.getElementById('startBtn'),
      stopBtn: document.getElementById('stopBtn'),
      copyBtn: document.getElementById('copyBtn'),
      copyAiBtn: document.getElementById('copyAiBtn'),
      historyBtn: document.getElementById('historyBtn'),
      optionsBtn: document.getElementById('optionsBtn'),
      exportButtons: Array.prototype.slice.call(document.querySelectorAll('[data-format]')),
      toast: document.getElementById('toast'),
      scheduleUrl: document.getElementById('scheduleUrl'),
      scheduleStart: document.getElementById('scheduleStart'),
      scheduleEnd: document.getElementById('scheduleEnd'),
      scheduleSave: document.getElementById('scheduleSave'),
      scheduleError: document.getElementById('scheduleError'),
      scheduleList: document.getElementById('scheduleList')
    };
  }

  function bindEvents() {
    el.startBtn.addEventListener('click', onStart);
    el.stopBtn.addEventListener('click', onStop);
    el.copyBtn.addEventListener('click', onCopy);
    if (el.copyAiBtn) {
      el.copyAiBtn.addEventListener('click', onCopyAi);
    }
    el.historyBtn.addEventListener('click', onOpenHistory);
    el.optionsBtn.addEventListener('click', onOpenOptions);
    el.toggleCcBtn.addEventListener('click', onToggleCaptions);
    el.exportButtons.forEach((button) => {
      button.addEventListener('click', () => onExport(button.dataset.format));
    });
    if (el.scheduleSave) {
      el.scheduleSave.addEventListener('click', onScheduleSave);
    }
    if (el.scheduleList) {
      el.scheduleList.addEventListener('click', onScheduleListClick);
    }
  }

  /* -------------------- chrome sarmalayıcıları -------------------- */

  function sendRuntime(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch (err) {
        console.error('[MNA] Arka plana mesaj gönderilemedi:', err);
        resolve(null);
      }
    });
  }

  function sendTab(tabId, message) {
    return new Promise((resolve) => {
      if (typeof tabId !== 'number' || tabId < 0) {
        resolve(null);
        return;
      }
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch (err) {
        console.error('[MNA] İçerik betiğine mesaj gönderilemedi:', err);
        resolve(null);
      }
    });
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          void chrome.runtime.lastError;
          resolve(Array.isArray(tabs) && tabs.length ? tabs[0] : null);
        });
      } catch (err) {
        resolve(null);
      }
    });
  }

  function getSettings() {
    return chrome.storage.local.get('mna.settings').then((result) => {
      const stored = (result && result['mna.settings']) || {};
      return Object.assign(
        { graceMs: 2500, speakerFallback: 'Bilinmeyen', includeTimestamps: true, localSpeakerName: 'Ben' },
        stored
      );
    }).catch((err) => {
      console.error('[MNA] Ayarlar okunamadı:', err);
      return { graceMs: 2500, speakerFallback: 'Bilinmeyen', includeTimestamps: true, localSpeakerName: 'Ben' };
    });
  }

  /* -------------------- durum yenileme -------------------- */

  async function refresh() {
    const tab = await getActiveTab();
    state.tabId = tab ? tab.id : null;
    state.isMeet = !!(tab && /^https:\/\/meet\.google\.com\//.test(tab.url || ''));
    state.hasContent = false;
    state.status = null;

    if (state.isMeet) {
      const status = await sendTab(state.tabId, { type: T.MNA_STATUS });
      if (status && status.ok) {
        state.status = status;
        state.hasContent = true;
      }
    }

    const activeResult = await sendRuntime({ type: T.MNA_ACTIVE_SESSION });
    state.active = activeResult && activeResult.ok ? activeResult.active : null;

    const scheduleResult = await sendRuntime({ type: 'MNA_SCHEDULE_LIST' });
    state.schedules = scheduleResult && scheduleResult.ok && Array.isArray(scheduleResult.items)
      ? scheduleResult.items
      : [];

    await requestRestoreIfNeeded();
    render();
  }

  /**
   * Arka planda aktif kayıt var ama içerik betiğinde yakalama kapalıysa
   * sekme yenilenmiş demektir: arka plandan durumu geri yüklemesini iste.
   */
  async function requestRestoreIfNeeded() {
    if (!state.active || !state.hasContent || !state.status || !state.status.capture) {
      return;
    }
    if (state.status.capture.active === true) {
      return;
    }
    // Kayıt yeni başlatılmışsa içerik betiği henüz hazır olmayabilir;
    // bu durumda geri yükleme isteği gönderilmez.
    const age = Date.now() - (Number(state.active.startedAt) || 0);
    if (age < RESTORE_MIN_AGE_MS) {
      return;
    }
    const now = Date.now();
    if (now - lastRestoreRequest < RESTORE_REQUEST_COOLDOWN_MS) {
      return;
    }
    lastRestoreRequest = now;
    await sendRuntime({ type: T.MNA_ACTIVE_SESSION, restore: true, tabId: state.tabId });
  }

  function render() {
    const capture = state.status && state.status.capture ? state.status.capture : null;
    const meeting = state.status && state.status.meeting ? state.status.meeting : {};
    const captions = state.status && state.status.captions ? state.status.captions : null;
    const isRecording = !!state.active;

    el.notMeetNotice.hidden = state.isMeet;
    el.reloadNotice.hidden = !(state.isMeet && !state.hasContent);

    el.statusPill.textContent = isRecording ? 'Kayıt yapılıyor' : 'Durduruldu';
    el.statusPill.className = 'pill ' + (isRecording ? 'pill--live' : 'pill--idle');
    el.recordState.textContent = isRecording ? 'Kayıt yapılıyor' : 'Durduruldu';

    const liveCount = capture && typeof capture.lineCount === 'number' ? capture.lineCount : 0;
    el.lineCount.textContent = String(liveCount);

    const code = meeting.code || (state.active && state.active.meetingCode) || '';
    el.meetingCode.textContent = code || '—';

    const url = meeting.url || (state.active && state.active.meetingUrl) || '';
    if (url) {
      el.meetingLink.href = url;
      el.meetingLink.textContent = url;
      el.meetingLink.hidden = false;
    } else {
      el.meetingLink.hidden = true;
    }

    // Altyazı bölgesi durumu:
    //   - 'missing'   -> CC kapalı: kullanıcı Meet'te CC'yi açmalı.
    //   - 'unreadable'-> CC açık ama okunabilir blok yok. "CC'yi aç" uyarısı
    //     yanlış olurdu (CC zaten açık), bu yüzden ayrı ve yumuşak bir uyarı.
    const notice = Utils && typeof Utils.resolveCaptionsNotice === 'function'
      ? Utils.resolveCaptionsNotice(captions, state.hasContent)
      : state.hasContent && captions && captions.detected === false
        ? 'missing'
        : null;
    el.ccWarning.hidden = notice !== 'missing';
    if (el.ccUnreadable) {
      el.ccUnreadable.hidden = notice !== 'unreadable';
    }

    el.startBtn.hidden = isRecording;
    el.stopBtn.hidden = !isRecording;

    renderSchedules();
    updateButtonStates();
  }

  function formatWhen(ts) {
    const value = Number(ts);
    if (!Number.isFinite(value)) {
      return '';
    }
    try {
      return new Date(value).toLocaleString('tr-TR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (err) {
      return '';
    }
  }

  function scheduleAction(status) {
    if (
      status === 'scheduled' ||
      status === 'opening' ||
      status === 'joining' ||
      status === 'waiting' ||
      status === 'admitted' ||
      status === 'blocked'
    ) {
      return 'cancel';
    }
    if (status === 'recording') {
      return null;
    }
    return 'dismiss';
  }

  function renderSchedules() {
    if (!el.scheduleList) {
      return;
    }
    el.scheduleList.textContent = '';
    const items = state.schedules || [];
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'schedule__empty';
      empty.textContent = 'Kayıtlı katılım yok.';
      el.scheduleList.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'schedule__item';
      const title = document.createElement('div');
      title.className = 'schedule__title';
      let label = (item.meetingCode || 'Meet') + ' · ' + formatWhen(item.startAt);
      if (item.endAt) {
        label += ' – ' + formatWhen(item.endAt);
      }
      title.textContent = label;
      title.title = item.url || '';
      const status = document.createElement('div');
      status.className = 'schedule__status';
      status.textContent = item.statusText || '';
      li.appendChild(title);
      li.appendChild(status);
      const action = scheduleAction(item.status);
      if (action && item.id) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn--ghost btn--small';
        button.dataset.id = item.id;
        button.textContent = action === 'cancel' ? 'İptal' : 'Kapat';
        li.appendChild(button);
      }
      el.scheduleList.appendChild(li);
    });
  }

  function showScheduleError(message) {
    if (!el.scheduleError) {
      return;
    }
    el.scheduleError.textContent = message || '';
    el.scheduleError.hidden = !message;
  }

  /**
   * Düğmelerin etkin durumunu hesaplar.
   * Busy bayrağı, periyodik yenilemenin disabled durumunu ezmesini engeller.
   */
  function updateButtonStates() {
    const unusable = !state.isMeet || !state.hasContent;
    const hasFormatters = !!F;
    const locked = unusable || state.busy;

    el.startBtn.disabled = locked;
    el.stopBtn.disabled = state.busy;
    el.toggleCcBtn.disabled = locked;
    el.copyBtn.disabled = locked || !hasFormatters;
    el.copyBtn.title = hasFormatters ? '' : 'Biçimlendirme modülü (formatters.js) yüklenemedi.';
    if (el.copyAiBtn) {
      el.copyAiBtn.disabled = locked || !hasFormatters || typeof F.buildAiPackage !== 'function';
    }
    el.exportButtons.forEach((button) => {
      button.disabled = locked || !hasFormatters;
      button.title = hasFormatters ? '' : 'Biçimlendirme modülü (formatters.js) yüklenemedi.';
    });
  }

  /* -------------------- eylemler -------------------- */

  async function onScheduleSave() {
    if (!Schedule) {
      toast('Planlama modülü yüklenemedi.', true);
      return;
    }
    const startAt = Schedule.parseDateTimeLocal(el.scheduleStart.value);
    const endRaw = String(el.scheduleEnd.value || '').trim();
    const endAt = endRaw ? Schedule.parseDateTimeLocal(endRaw) : null;
    if (el.scheduleStart.value && startAt === null) {
      showScheduleError('Başlangıç saati geçerli değil.');
      return;
    }
    if (endRaw && endAt === null) {
      showScheduleError('Bitiş saati geçerli değil.');
      return;
    }
    if (el.scheduleSave) {
      el.scheduleSave.disabled = true;
    }
    try {
      const result = await sendRuntime({
        type: 'MNA_SCHEDULE_SAVE',
        url: el.scheduleUrl.value,
        startAt: startAt,
        endAt: endAt
      });
      if (result && result.ok) {
        showScheduleError('');
        el.scheduleUrl.value = '';
        el.scheduleStart.value = '';
        el.scheduleEnd.value = '';
        toast('Katılım kaydedildi.');
      } else {
        const error = (result && result.error) || 'Katılım kaydedilemedi.';
        showScheduleError(error);
        toast(error, true);
      }
    } finally {
      if (el.scheduleSave) {
        el.scheduleSave.disabled = false;
      }
    }
    await refresh();
  }

  async function onScheduleCancel(id) {
    const result = await sendRuntime({ type: 'MNA_SCHEDULE_CANCEL', id: id });
    if (result && result.ok) {
      toast('Katılım iptal edildi.');
    } else {
      toast((result && result.error) || 'Katılım iptal edilemedi.', true);
    }
    await refresh();
  }

  function onScheduleListClick(event) {
    const target = event.target;
    if (!target || !target.dataset || !target.dataset.id) {
      return;
    }
    onScheduleCancel(target.dataset.id);
  }

  async function onStart() {
    setBusy(true);
    try {
      const result = await sendRuntime({ type: T.MNA_SESSION_START });
      if (result && result.ok) {
        toast('Kayıt başlatıldı.');
      } else {
        toast((result && result.error) || 'Kayıt başlatılamadı.', true);
      }
    } finally {
      setBusy(false);
    }
    await refresh();
  }

  async function onStop() {
    setBusy(true);
    try {
      const result = await sendRuntime({ type: T.MNA_SESSION_STOP });
      if (result && result.ok) {
        toast('Kayıt durduruldu.');
      } else {
        toast((result && result.error) || 'Kayıt durdurulamadı.', true);
      }
    } finally {
      setBusy(false);
    }
    await refresh();
  }

  async function onCopy() {
    if (!F) {
      toast('Biçimlendirme modülü (formatters.js) yüklenemedi.', true);
      return;
    }
    const source = await getTranscriptSource();
    if (!source || !Array.isArray(source.lines) || !source.lines.length) {
      toast('Kopyalanacak transkript bulunamadı.', true);
      return;
    }
    let text = '';
    try {
      text = F.buildPlainTranscript(source, {
        speakerFallback: fallbackName(),
        localSpeakerName: localSpeakerName()
      });
    } catch (err) {
      console.error('[MNA] Transkript oluşturulamadı:', err);
      toast('Transkript oluşturulamadı.', true);
      return;
    }
    const copied = await copyToClipboard(text);
    toast(copied ? 'Transkript panoya kopyalandı.' : 'Panoya kopyalanamadı.', !copied);
  }

  /** Hazır özet istemi + transkript: yapay zekâya yapıştırılıp gönderilir. */
  async function onCopyAi() {
    if (!F || typeof F.buildAiPackage !== 'function') {
      toast('Biçimlendirme modülü (formatters.js) yüklenemedi.', true);
      return;
    }
    const source = await getTranscriptSource();
    if (!source || !Array.isArray(source.lines) || !source.lines.length) {
      toast('Kopyalanacak transkript bulunamadı.', true);
      return;
    }
    let text = '';
    try {
      text = F.buildAiPackage(source, {
        speakerFallback: fallbackName(),
        localSpeakerName: localSpeakerName()
      });
    } catch (err) {
      console.error('[MNA] Yapay zekâ metni oluşturulamadı:', err);
      toast('Yapay zekâ metni oluşturulamadı.', true);
      return;
    }
    const copied = await copyToClipboard(text);
    toast(copied ? 'İstem + transkript kopyalandı. Yapay zekâya yapıştırın.' : 'Panoya kopyalanamadı.', !copied);
  }

  async function onExport(format) {
    if (!F) {
      toast('Biçimlendirme modülü (formatters.js) yüklenemedi.', true);
      return;
    }
    if (!Utils) {
      toast('Yardımcı modül (utils.js) yüklenemedi.', true);
      return;
    }
    const source = await getTranscriptSource();
    if (!source || !Array.isArray(source.lines) || !source.lines.length) {
      toast('Dışa aktarılacak transkript bulunamadı.', true);
      return;
    }
    let text = '';
    try {
      text = F.formatSession(source, format, {
        includeTimestamps: !state.settings || state.settings.includeTimestamps !== false,
        speakerFallback: fallbackName(),
        localSpeakerName: localSpeakerName()
      });
    } catch (err) {
      console.error('[MNA] Dışa aktarma başarısız:', err);
      toast('Dışa aktarma başarısız.', true);
      return;
    }
    const filename = Utils.buildFilename(source, format);
    await downloadText(filename, text, FORMAT_MIME[format] || 'text/plain');
  }

  async function onOpenHistory() {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') });
      window.close();
    } catch (err) {
      console.error('[MNA] Geçmiş açılamadı:', err);
      toast('Geçmiş açılamadı.', true);
    }
  }

  function onOpenOptions() {
    try {
      chrome.runtime.openOptionsPage();
    } catch (err) {
      console.error('[MNA] Ayarlar açılamadı:', err);
      toast('Ayarlar açılamadı.', true);
    }
  }

  async function onToggleCaptions() {
    const friendly = "Meet'teki CC düğmesine basmanız gerekir.";
    const result = await sendTab(state.tabId, { type: T.MNA_TOGGLE_CAPTIONS });
    if (!result) {
      toast(friendly, true);
      return;
    }
    if (result.ok === false) {
      const error = String(result.error || '');
      // İçerik betiği bu mesajı desteklemiyorsa anlaşılır bir yönlendirme göster.
      toast(error && error.indexOf('bilinmeyen') === -1 ? error : friendly, true);
      return;
    }
    toast('Meet altyazı durumu değiştirildi.');
  }

  /* -------------------- yardımcılar -------------------- */

  /**
   * İşlem sürerken düğmeleri kilitler.
   * Bayrağı state içinde tutulur; periyodik render() bu durumu ezmez.
   */
  function setBusy(busy) {
    state.busy = !!busy;
    updateButtonStates();
  }

  function fallbackName() {
    return (state.settings && state.settings.speakerFallback) || 'Bilinmeyen';
  }

  /** Meet'in "Siz" gibi yerel kullanıcı etiketlerinin karşılığı. */
  function localSpeakerName() {
    return (state.settings && state.settings.localSpeakerName) || 'Ben';
  }

  /**
   * Transkript kaynağı: kayıt sürüyorsa arka plandaki oturum.
   * Kayıt durmuşsa Meet sekmesindeki satırlar kullanılır; başlangıç saati
   * içerik betiğindeki kayıt başlangıcıdır, indirme anı değildir.
   */
  async function getTranscriptSource() {
    if (state.active && state.active.sessionId) {
      const result = await sendRuntime({ type: T.MNA_SESSION_GET, sessionId: state.active.sessionId });
      if (result && result.ok && result.session) {
        return result.session;
      }
    }

    if (state.isMeet && state.hasContent) {
      const result = await sendTab(state.tabId, { type: T.MNA_GET_LINES });
      if (result && result.ok && Array.isArray(result.lines)) {
        const meeting = (state.status && state.status.meeting) || {};
        const capture = (state.status && state.status.capture) || {};
        if (Utils && typeof Utils.buildLiveExportSession === 'function') {
          return Utils.buildLiveExportSession({
            meeting: meeting,
            lines: result.lines,
            captureStartedAt: capture.startedAt
          });
        }
        const started = Number(capture.startedAt);
        return {
          id: 'live',
          title: meeting.title || 'Meet Toplantısı',
          meetingUrl: meeting.url || '',
          meetingCode: meeting.code || '',
          startedAt: Number.isFinite(started) && started > 0 ? started : null,
          endedAt: null,
          lines: result.lines
        };
      }
    }
    return null;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // Pano erişimi kapalıysa eski yöntemle dene.
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (copyErr) {
        console.error('[MNA] Panoya kopyalama başarısız:', copyErr);
      }
      document.body.removeChild(area);
      return ok;
    }
  }

  async function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const objectUrl = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url: objectUrl, filename: filename, saveAs: false });
      toast(`İndirildi: ${filename}`);
    } catch (err) {
      console.error('[MNA] İndirme başarısız:', err);
      // Blob reddedilirse data URL ile tekrar dene.
      try {
        const dataUrl = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
        await chrome.downloads.download({ url: dataUrl, filename: filename, saveAs: false });
        toast(`İndirildi: ${filename}`);
      } catch (fallbackErr) {
        console.error('[MNA] Yedek indirme de başarısız:', fallbackErr);
        toast('Dosya indirilemedi.', true);
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    }
  }

  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.className = 'toast' + (isError ? ' toast--error' : '');
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.hidden = true;
    }, 3200);
  }

  /* -------------------- başlat ------------------- */

  async function init() {
    cacheDom();
    bindEvents();
    state.settings = await getSettings();
    await refresh();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      refresh().catch((err) => console.error('[MNA] Durum yenilenemedi:', err));
    }, REFRESH_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
