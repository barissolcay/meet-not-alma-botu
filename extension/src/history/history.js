/**
 * Meet Not Alma Botu - geçmiş sayfası.
 *
 * Oturum listesi ve detayı arka plandan (MNA_SESSION_*) okunur.
 * Arama doluyken satır metni için tam oturum (getSession) okunur.
 * Boş arama, satır içermeyen özet listeyi olduğu gibi gösterir.
 */
(function () {
  'use strict';

  const T = window.MNAProtocol.MESSAGE_TYPES;
  const F = window.MNAFormatters;
  const Storage = window.MNAStorage;
  /** Yardımcı fonksiyonlar (utils.js) — yüklenemezse arama/süre gösterimi devre dışı kalır. */
  const Utils = window.MNAUtils || null;

  const FORMAT_MIME = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    srt: 'application/x-subrip',
    vtt: 'text/vtt'
  };

  const state = {
    sessions: [],
    selectedId: null,
    selected: null,
    query: '',
    settings: null
  };

  let el = {};
  let toastTimer = null;
  let searchTimer = null;
  let listToken = 0;

  /* -------------------- DOM -------------------- */

  function cacheDom() {
    el = {
      searchInput: document.getElementById('searchInput'),
      listCount: document.getElementById('listCount'),
      sessionList: document.getElementById('sessionList'),
      emptyState: document.getElementById('emptyState'),
      detailPlaceholder: document.getElementById('detailPlaceholder'),
      detailContent: document.getElementById('detailContent'),
      titleInput: document.getElementById('titleInput'),
      saveTitleBtn: document.getElementById('saveTitleBtn'),
      sessionMeta: document.getElementById('sessionMeta'),
      transcript: document.getElementById('transcript'),
      transcriptEmpty: document.getElementById('transcriptEmpty'),
      copyBtn: document.getElementById('copyBtn'),
      copyAiBtn: document.getElementById('copyAiBtn'),
      deleteBtn: document.getElementById('deleteBtn'),
      toast: document.getElementById('toast')
    };
    el.exportButtons = Array.prototype.slice.call(document.querySelectorAll('[data-format]'));
  }

  function bindEvents() {
    el.searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.query = el.searchInput.value.trim();
        renderList();
      }, 180);
    });

    el.saveTitleBtn.addEventListener('click', onSaveTitle);
    el.copyBtn.addEventListener('click', onCopyTranscript);
    el.copyAiBtn.addEventListener('click', onCopyPlain);
    el.deleteBtn.addEventListener('click', onDelete);

    el.exportButtons.forEach((button) => {
      button.addEventListener('click', () => onExport(button.dataset.format));
    });
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

  function getSettings() {
    return chrome.storage.local.get('mna.settings').then((result) => {
      const stored = (result && result['mna.settings']) || {};
      return Object.assign(
        { graceMs: 2500, speakerFallback: 'Bilinmeyen', includeTimestamps: true, localSpeakerName: 'Ben' },
        stored
      );
    }).catch(() => ({ graceMs: 2500, speakerFallback: 'Bilinmeyen', includeTimestamps: true, localSpeakerName: 'Ben' }));
  }

  /* -------------------- veri yükleme -------------------- */

  async function loadSessions() {
    const result = await sendRuntime({ type: T.MNA_SESSION_LIST });
    if (result && result.ok && Array.isArray(result.sessions)) {
      state.sessions = result.sessions;
    } else {
      state.sessions = [];
    }
    renderList();
  }

  async function selectSession(sessionId) {
    if (!sessionId) {
      state.selectedId = null;
      state.selected = null;
      renderDetail();
      return;
    }
    const result = await sendRuntime({ type: T.MNA_SESSION_GET, sessionId: sessionId });
    if (!result || !result.ok || !result.session) {
      toast('Oturum açılamadı.', true);
      return;
    }
    state.selectedId = sessionId;
    state.selected = result.session;
    renderList();
    renderDetail();
  }

  /* -------------------- liste ------------------- */

  /**
   * Arama sorgusuna uyan oturumları süzer.
   * Boş sorguda özet liste aynen döner. Sorgu doluyken satır metni
   * için tam oturum okunur. utils.js yoksa yalnızca başlık katlanır.
   */
  function filterSessions() {
    if (!state.query) {
      return state.sessions;
    }
    if (!Utils || typeof Utils.filterSessionsByQuery !== 'function') {
      const needle = String(state.query).toLocaleLowerCase('tr');
      return state.sessions.filter(
        (session) => String(session.title || '').toLocaleLowerCase('tr').indexOf(needle) !== -1
      );
    }
    return Utils.filterSessionsByQuery(state.sessions, state.query, (session) => {
      if (!Storage || typeof Storage.getSession !== 'function' || !session || !session.id) {
        return null;
      }
      return Storage.getSession(session.id);
    });
  }

  async function renderList() {
    const token = ++listToken;
    let visible = state.sessions;
    try {
      visible = await filterSessions();
    } catch (err) {
      console.error('[MNA] Liste süzülemedi:', err);
      visible = state.sessions;
    }
    if (token !== listToken) {
      return;
    }
    el.sessionList.innerHTML = '';
    el.emptyState.hidden = state.sessions.length > 0;

    if (!state.sessions.length) {
      el.listCount.textContent = '';
      return;
    }
    el.listCount.textContent = state.query
      ? `${visible.length} / ${state.sessions.length} oturum`
      : `${state.sessions.length} oturum`;

    visible.forEach((session) => {
      const item = document.createElement('li');
      item.className = 'session-item' + (session.id === state.selectedId ? ' session-item--active' : '');
      item.dataset.sessionId = session.id;

      const title = document.createElement('div');
      title.className = 'session-item__title';
      title.textContent = session.title || 'Adsız oturum';

      const meta = document.createElement('div');
      meta.className = 'session-item__meta';

      const date = document.createElement('span');
      date.textContent = formatDate(session.startedAt);
      meta.appendChild(date);

      if (session.meetingCode) {
        const code = document.createElement('span');
        code.className = 'session-item__badge';
        code.textContent = session.meetingCode;
        meta.appendChild(code);
      }

      const count = document.createElement('span');
      count.textContent = `${session.lineCount || 0} satır`;
      meta.appendChild(count);

      const duration = document.createElement('span');
      duration.textContent = Utils ? Utils.formatDuration(session) : '—';
      meta.appendChild(duration);

      item.appendChild(title);
      item.appendChild(meta);
      item.addEventListener('click', () => {
        selectSession(session.id);
      });

      el.sessionList.appendChild(item);
    });
  }

  /* -------------------- detay ------------------- */

  function renderDetail() {
    const session = state.selected;
    const hasFormatters = !!F;

    if (!session) {
      el.detailPlaceholder.hidden = false;
      el.detailContent.hidden = true;
      el.copyBtn.disabled = true;
      el.copyAiBtn.disabled = true;
      el.deleteBtn.disabled = true;
      el.exportButtons.forEach((button) => { button.disabled = true; });
      return;
    }

    el.detailPlaceholder.hidden = true;
    el.detailContent.hidden = false;
    el.copyBtn.disabled = !hasFormatters;
    el.copyAiBtn.disabled = !hasFormatters;
    el.deleteBtn.disabled = false;
    el.exportButtons.forEach((button) => { button.disabled = !hasFormatters; });

    el.titleInput.value = session.title || '';
    el.sessionMeta.innerHTML = '';

    const metaItems = [
      Utils ? Utils.formatDateTime(session.startedAt) : formatDate(session.startedAt),
      `Süre: ${Utils ? Utils.formatDuration(session) : '—'}`,
      `Satır: ${(session.lines || []).length}`,
      session.meetingCode ? `Kod: ${session.meetingCode}` : null,
      session.endedAt ? 'Tamamlandı' : 'Yarım kaldı'
    ].filter(Boolean);

    metaItems.forEach((text) => {
      const span = document.createElement('span');
      span.textContent = text;
      el.sessionMeta.appendChild(span);
    });

    if (session.meetingUrl) {
      const link = document.createElement('a');
      link.href = session.meetingUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = session.meetingUrl;
      link.style.color = 'var(--accent-2)';
      link.style.fontSize = '12px';
      el.sessionMeta.appendChild(link);
    }

    renderTranscript(session);
  }

  function renderTranscript(session) {
    el.transcript.innerHTML = '';
    const lines = Array.isArray(session.lines) ? session.lines : [];
    const base = Number.isFinite(session.startedAt) ? session.startedAt : 0;
    el.transcriptEmpty.hidden = lines.length > 0;

    lines.forEach((line) => {
      const row = document.createElement('div');
      row.className = 'line';

      const time = document.createElement('span');
      time.className = 'line__time';
      time.textContent = formatLineTime(line, base);
      row.appendChild(time);

      const body = document.createElement('div');
      body.className = 'line__body';

      const speaker = document.createElement('span');
      speaker.className = 'line__speaker';
      const speakerName = displaySpeaker(line);
      speaker.textContent = speakerName;
      applySpeakerColor(speaker, speakerName);
      body.appendChild(speaker);

      const text = document.createElement('span');
      text.textContent = line.text || '';
      body.appendChild(text);

      row.appendChild(body);
      el.transcript.appendChild(row);
    });
  }

  /** Konuşmacı adı; Meet'in "Siz" gibi yerel etiketleri kullanıcı adına çevrilir. */
  function displaySpeaker(line) {
    const raw = (line && typeof line.speaker === 'string' && line.speaker.trim()) || '';
    if (!raw) {
      return fallbackName();
    }
    if (F && typeof F.isLocalSpeaker === 'function' && F.isLocalSpeaker(raw)) {
      return (state.settings && state.settings.localSpeakerName) || 'Ben';
    }
    return raw;
  }

  /** Konuşmacı adına göre sabit bir renk üretir. */
  function applySpeakerColor(node, name) {
    let hash = 0;
    const text = String(name || '');
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) % 360;
    }
    node.style.background = `hsl(${hash}, 55%, 22%)`;
    node.style.color = `hsl(${hash}, 85%, 74%)`;
    node.style.border = `1px solid hsl(${hash}, 55%, 42%)`;
  }

  /* -------------------- eylemler ------------------- */

  async function onSaveTitle() {
    if (!state.selected) {
      return;
    }
    const title = el.titleInput.value.trim();
    if (!title) {
      toast('Başlık boş bırakılamaz.', true);
      return;
    }
    const result = await sendRuntime({ type: T.MNA_SESSION_UPDATE, sessionId: state.selected.id, title: title });
    if (!result || !result.ok) {
      toast((result && result.error) || 'Başlık güncellenemedi.', true);
      return;
    }
    state.selected = result.session;
    const summary = state.sessions.find((item) => item.id === result.session.id);
    if (summary) {
      summary.title = result.session.title;
    }
    toast('Başlık güncellendi.');
    renderList();
  }

  async function onCopyTranscript() {
    if (!F || !state.selected) {
      toast('Biçimlendirme modülü (formatters.js) yüklenemedi.', true);
      return;
    }
    let text = '';
    try {
      text = F.formatSession(state.selected, 'txt', formatOptions());
    } catch (err) {
      console.error('[MNA] Transkript oluşturulamadı:', err);
      toast('Transkript oluşturulamadı.', true);
      return;
    }
    const copied = await copyToClipboard(text);
    toast(copied ? 'Transkript panoya kopyalandı.' : 'Panoya kopyalanamadı.', !copied);
  }

  async function onCopyPlain() {
    if (!F || !state.selected) {
      toast('Biçimlendirme modülü (formatters.js) yüklenemedi.', true);
      return;
    }
    let text = '';
    try {
      text = typeof F.buildAiPackage === 'function'
        ? F.buildAiPackage(state.selected, formatOptions())
        : F.buildPlainTranscript(state.selected, formatOptions());
    } catch (err) {
      console.error('[MNA] Yapay zekâ metni oluşturulamadı:', err);
      toast('Yapay zekâ metni oluşturulamadı.', true);
      return;
    }
    const copied = await copyToClipboard(text);
    toast(copied
      ? 'İstem + transkript panoya kopyalandı. Yapay zekâya yapıştırıp gönderin.'
      : 'Panoya kopyalanamadı.', !copied);
  }

  async function onExport(format) {
    if (!F || !state.selected) {
      toast('Biçimlendirme modülü (formatters.js) yüklenemedi.', true);
      return;
    }
    if (!Utils) {
      toast('Yardımcı modül (utils.js) yüklenemedi.', true);
      return;
    }
    let text = '';
    try {
      text = F.formatSession(state.selected, format, formatOptions());
    } catch (err) {
      console.error('[MNA] Dışa aktarma başarısız:', err);
      toast('Dışa aktarma başarısız.', true);
      return;
    }
    const filename = Utils.buildFilename(state.selected, format);
    await downloadText(filename, text, FORMAT_MIME[format] || 'text/plain');
  }

  async function onDelete() {
    if (!state.selected) {
      return;
    }
    const confirmed = window.confirm(`"${state.selected.title || 'Bu oturum'}" oturumu kalıcı olarak silinecek. Onaylıyor musunuz?`);
    if (!confirmed) {
      return;
    }
    const result = await sendRuntime({ type: T.MNA_SESSION_DELETE, sessionId: state.selected.id });
    if (!result || !result.ok) {
      toast((result && result.error) || 'Oturum silinemedi.', true);
      return;
    }
    toast('Oturum silindi.');
    state.selectedId = null;
    state.selected = null;
    await loadSessions();
    renderDetail();
  }

  /* -------------------- yardımcılar ------------------- */

  function formatOptions() {
    return {
      includeTimestamps: !state.settings || state.settings.includeTimestamps !== false,
      speakerFallback: fallbackName(),
      localSpeakerName: (state.settings && state.settings.localSpeakerName) || 'Ben'
    };
  }

  function fallbackName() {
    return (state.settings && state.settings.speakerFallback) || 'Bilinmeyen';
  }

  /** Zaman damgası, oturum başlangıcına göre göreli (formatters.js ile aynı). */
  function formatLineTime(line, base) {
    if (F && typeof F.formatTimestamp === 'function') {
      try {
        const startedAt = Number.isFinite(line.startedAt) ? line.startedAt : 0;
        return `[${F.formatTimestamp(Math.max(0, startedAt - base), { withHours: true })}]`;
      } catch (err) {
        console.error('[MNA] Zaman damgası biçimlenemedi:', err);
      }
    }
    return '';
  }

  function formatDate(ms) {
    const date = new Date(Number(ms) || 0);
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
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
    await loadSessions();
    renderDetail();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
