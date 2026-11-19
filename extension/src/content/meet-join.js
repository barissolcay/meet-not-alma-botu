/**
 * Planlı katılımın Meet arayüzü.
 *
 * Altyazı okuyan koda tıklama yazılmaz. Meet düğmeleri değişirse
 * yalnızca bu dosyadaki seçiciler ve etiketler güncellenir.
 *
 * Mikrofon/kamera: "kapat / turn off" açıktır ve katılmadan önce kapatılır.
 * "aç / turn on" zaten kapalıdır, tıklanmaz (tersine açmak izin ister).
 * «Mikrofonu kullan» / «Use microphone» izin diyaloğunun düğmeleridir;
 * basılmaz. Diyalog yalnız kendi X düğmesiyle geçer.
 * «İzin gerekiyor» aygıtı açık sayılmaz ve basılmaz.
 * Altyazı İngilizce açılırsa planlı katılım Türkçeye çevirir.
 * İzin penceresindeki düğmeye basılmaz. Ad alanı okunmaz ve değiştirilmez.
 * Hesap değiştirme ve yükseltme düğmelerine basılmaz.
 *
 * UMD: tarayıcıda globalThis.MNAJoin, Node'da module.exports.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && typeof module.exports === 'object') {
    module.exports = api;
  }
  if (root) {
    root.MNAJoin = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SELECTORS = {
    /** Katıl / mikrofon / kamera / ayrıl düğmelerinin arandığı tek seçici. */
    controls: 'button, [role="button"]',
    captionRegion: [
      '[role="region"][aria-label*="caption" i]',
      '[role="region"][aria-label*="altyaz" i]',
      '[role="region"][aria-label*="subtitle" i]'
    ]
  };

  var DEFAULT_POLL_MS = 3000;

  /**
   * «Sizi duysunlar mı?» diyaloğunun başlığı.
   * Uzun parçalar önce yazılır; eşleşme bu listeden yapılır.
   */
  var HEAR_YOU_TITLE_TR = [
    'sizi duymasını istiyor',
    'sizi duymanızı istiyor',
    'duymasını ister',
    'duymanızı ister',
    'görmesini ve duymasını'
  ];

  /** Basılırsa mikrofonu/kamerayı açar ve tarayıcı izni ister. */
  var MEDIA_USE_TR = [
    'mikrofon ve kamerayı kullan',
    'mikrofon ve kamerayi kullan',
    'mikrofonu kullan'
  ];
  var MEDIA_USE_EN = [
    'use microphone and camera',
    'use mic and camera',
    'use microphone',
    'use mic'
  ];

  /** Diyaloğun X düğmesi. Kısa adlarda «kapat / close» da yeter; aygıt düğmesi sayılmaz. */
  var DISMISS_EXACT_TR = ['kapat', 'diyaloğu kapat', 'diyalogu kapat'];
  var DISMISS_EXACT_EN = ['close', 'close dialog'];

  function norm(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLocaleLowerCase('tr');
  }

  /** İngilizce etiketler Türkçe İ/I katlanmasından etkilenmesin. */
  function normEn(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function both(value) {
    return norm(value) + '\n' + normEn(value);
  }

  function accessibleName(element) {
    if (!element) {
      return '';
    }
    var label = '';
    try {
      if (typeof element.getAttribute === 'function') {
        label = element.getAttribute('aria-label') || '';
      }
    } catch (err) {
      label = '';
    }
    if (String(label).trim()) {
      return String(label).trim();
    }
    var text = element.textContent || '';
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function controls(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return [];
    }
    try {
      return Array.prototype.slice.call(doc.querySelectorAll(SELECTORS.controls) || []);
    } catch (err) {
      return [];
    }
  }

  /**
   * Dil ve altyazı listeleri düğme olmak zorunda değil.
   * Meet bunları menuitem veya option olarak açar. Katıl düğmesi bu listeye girmez.
   */
  function menuChoices(doc) {
    var found = controls(doc);
    if (!doc || typeof doc.querySelectorAll !== 'function') {
      return found;
    }
    var extra = [];
    try {
      extra = Array.prototype.slice.call(
        doc.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"]') || []
      );
    } catch (err) {
      extra = [];
    }
    for (var i = 0; i < extra.length; i += 1) {
      if (found.indexOf(extra[i]) === -1) {
        found.push(extra[i]);
      }
    }
    return found;
  }

  function isControl(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    var tag = String(node.tagName || '').toUpperCase();
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return true;
    }
    try {
      return node.getAttribute && node.getAttribute('role') === 'button';
    } catch (err) {
      return false;
    }
  }

  /**
   * Konuşma/yazışma bölgesi mi (canlı altyazı ya da yan panel)? Buradaki
   * "toplantı bitti" ya da "çıkarıldı" gibi sözler toplantının bittiği anlamına gelmez.
   */
  function isCaptionRegionNode(node) {
    if (!node || node.nodeType !== 1 || typeof node.getAttribute !== 'function') {
      return false;
    }
    try {
      var role = normEn(node.getAttribute('role') || '');
      var label = normEn(node.getAttribute('aria-label') || '');
      // Yan panel (<aside aria-label="Yan panel">): sohbet mesajları, kişi listesi
      // ve etkinlikler burada durur. Gerçek Meet'te doğrulandı: sohbet mesajı
      // bu kabın içindedir. Orada yazılan söz de toplantıyı bitirmez.
      if (String(node.tagName || '').toUpperCase() === 'ASIDE' || role === 'complementary') {
        return true;
      }
      if (role === 'region' && /caption|altyaz|subtitle/.test(label)) {
        return true;
      }
      if (node.getAttribute('jsname') === 'yvBXue') {
        return true;
      }
      var cls = String(node.getAttribute('class') || '');
      return /(^|\s)aarpc(\s|$)/.test(cls);
    } catch (err) {
      return false;
    }
  }

  /** Altyazı bölgesi her zaman atlanır; skipControls ise düğme etiketlerini de atlar. */
  function walkText(node, skipControls) {
    if (!node) {
      return '';
    }
    if (node.nodeType === 3) {
      return node.textContent || '';
    }
    if (node.nodeType !== 1 || isCaptionRegionNode(node) || (skipControls && isControl(node))) {
      return '';
    }
    var parts = [];
    var children = node.childNodes || [];
    for (var i = 0; i < children.length; i += 1) {
      parts.push(walkText(children[i], skipControls));
    }
    return parts.join(' ');
  }

  /** Düğme etiketleri bekleme/bitiş metnine karışmasın. */
  function textOutsideControls(node) {
    return walkText(node, true);
  }

  /** Sayfa metni (altyazı bölgesi hariç): bitiş ekranı yalnız bundan okunur. */
  function pageText(doc) {
    if (doc && doc.body && doc.body.childNodes) {
      return walkText(doc.body, false);
    }
    if (doc && doc.body && typeof doc.body.textContent === 'string') {
      return doc.body.textContent;
    }
    return '';
  }

  function hasPhrase(text, phrases) {
    for (var i = 0; i < phrases.length; i += 1) {
      if (text.indexOf(phrases[i]) !== -1) {
        return true;
      }
    }
    return false;
  }

  /**
   * Meet'in «sizi duysunlar mı?» diyaloğundaki kullan düğmeleri.
   * Ön katılım mikrofon/kamera anahtarı değildir; basmak aygıtı açar.
   */
  function isMediaUsePrompt(name) {
    var tr = norm(name);
    var en = normEn(name);
    if (!tr && !en) {
      return false;
    }
    return hasPhrase(tr, MEDIA_USE_TR) || hasPhrase(en, MEDIA_USE_EN);
  }

  /**
   * «Mikrofon ve kamera olmadan devam et» / «Continue without microphone and
   * camera»: duyulma diyaloğunun GÜVENLİ seçeneği. Aygıtı açmaz ve tarayıcı izni
   * istemez. Gerçek Meet'te bu diyaloğun X düğmesi yoktur; geçmenin yolu budur.
   */
  function isContinueWithoutMedia(name) {
    var tr = norm(name);
    var en = normEn(name);
    if (!tr && !en) {
      return false;
    }
    if (isUnsafePress(name)) {
      return false;
    }
    if (tr.indexOf('olmadan devam') !== -1 && /mikrofon|kamera/.test(tr)) {
      return true;
    }
    return en.indexOf('continue without') !== -1 && /microphone|camera|\bmic\b/.test(en);
  }

  function findContinueWithoutMedia(doc) {
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      if (isContinueWithoutMedia(accessibleName(buttons[i]))) {
        return buttons[i];
      }
    }
    return null;
  }

  function isHearYouTitle(text) {
    var tr = norm(text);
    var en = normEn(text);
    if (hasPhrase(tr, HEAR_YOU_TITLE_TR)) {
      return true;
    }
    return en.indexOf('hear you') !== -1 &&
      (en.indexOf('meeting') !== -1 || en.indexOf('want') !== -1);
  }

  function isPermissionNeeded(name) {
    var tr = norm(name);
    var en = normEn(name);
    if (tr.indexOf('izin gerek') !== -1) {
      return true;
    }
    return en.indexOf('permission needed') !== -1 || en.indexOf('permission required') !== -1;
  }

  /** İzin, kullan, hesap ve yükseltme düğmeleri hiç basılmaz. */
  function isUnsafePress(name) {
    var tr = norm(name);
    var en = normEn(name);
    if (isMediaUsePrompt(name) || isPermissionNeeded(name)) {
      return true;
    }
    if (tr.indexOf('izin ver') !== -1 || /\ballow\b/.test(en)) {
      return true;
    }
    if (
      tr.indexOf('hesap değiştir') !== -1 ||
      tr.indexOf('hesap degistir') !== -1 ||
      tr.indexOf('başka bir hesap') !== -1 ||
      tr.indexOf('baska bir hesap') !== -1 ||
      tr.indexOf('yükselt') !== -1 ||
      tr.indexOf('yukselt') !== -1
    ) {
      return true;
    }
    if (en.indexOf('switch account') !== -1 || en.indexOf('another account') !== -1) {
      return true;
    }
    return en === 'upgrade' || en.indexOf('upgrade to') !== -1;
  }

  /**
   * X'in adı tam «Kapat» olmayabilir: «close» ikonu veya «Kapat» geçen kısa ad.
   * Mikrofonu kapat / altyazıyı kapat / İzin ver bu listeye girmez.
   */
  function isDismissName(name) {
    var tr = norm(name);
    var en = normEn(name);
    if (!tr && !en) {
      return false;
    }
    if (isUnsafePress(name)) {
      return false;
    }
    if (/mikrofon|kamera|altyaz|izin/.test(tr)) {
      return false;
    }
    if (/microphone|camera|caption|subtitle|\bmic\b/.test(en)) {
      return false;
    }
    if (DISMISS_EXACT_TR.indexOf(tr) !== -1 || DISMISS_EXACT_EN.indexOf(en) !== -1) {
      return true;
    }
    if (tr.length > 40 || en.length > 48) {
      return false;
    }
    if (tr.indexOf('kapat') !== -1) {
      return true;
    }
    if (en === 'close' || en.indexOf('close ') === 0 || en.indexOf(' close') !== -1) {
      return true;
    }
    return false;
  }

  function deviceKind(name) {
    if (isMediaUsePrompt(name)) {
      return null;
    }
    var n = both(name);
    if (/mikrofon|microphone|\bmic\b/.test(n)) {
      return 'mic';
    }
    if (/kamera|camera/.test(n)) {
      return 'cam';
    }
    return null;
  }

  /**
   * true: aygıt açık, katılmadan kapatılmalı.
   * false: kapalı veya «izin gerekiyor»; basılmaz, katılmaya engel değildir.
   * null: etiket tanınmıyor; basılmaz, katılmaya engel değildir.
   */
  function deviceIsLive(button) {
    var name = accessibleName(button);
    if (isPermissionNeeded(name) || isMediaUsePrompt(name) || isUnsafePress(name)) {
      return false;
    }
    var n = both(name);
    if (/turn on|unmute|mikrofonu aç|mikrofonu ac|kamerayı aç|kamerayı ac|kamerayi aç|kamerayi ac/.test(n)) {
      return false;
    }
    if (/turn off|\bmute\b|mikrofonu kapat|kamerayı kapat|kamerayi kapat/.test(n)) {
      return true;
    }
    if (!button || typeof button.getAttribute !== 'function') {
      return null;
    }
    var flag = button.getAttribute('data-is-muted');
    if (flag === 'true') {
      return false;
    }
    if (flag === 'false') {
      return true;
    }
    return null;
  }

  /**
   * @returns {'ask'|'join'|'pending'|null}
   * pending: istek duruyor, yeniden tıklanmaz.
   */
  function joinKind(name) {
    var tr = norm(name);
    var en = normEn(name);
    if (!tr && !en) {
      return null;
    }
    if (/izin ver/.test(tr) || /\ballow\b/.test(en)) {
      return null;
    }
    if (
      tr.indexOf('gönderildi') !== -1 ||
      tr.indexOf('gonderildi') !== -1 ||
      en.indexOf('asking to join') !== -1 ||
      en.indexOf('asking to be let in') !== -1
    ) {
      return 'pending';
    }
    if (
      tr.indexOf('katılma isteği') !== -1 ||
      tr.indexOf('katilma istegi') !== -1 ||
      en.indexOf('ask to join') !== -1 ||
      en.indexOf('request to join') !== -1
    ) {
      return 'ask';
    }
    if (
      tr === 'katıl' ||
      tr === 'katil' ||
      tr === 'şimdi katıl' ||
      tr === 'simdi katil' ||
      tr.indexOf('toplantıya katıl') !== -1 ||
      tr.indexOf('toplantiya katil') !== -1 ||
      en === 'join' ||
      en === 'join now' ||
      en === 'join meeting' ||
      en.indexOf('join now') !== -1
    ) {
      return 'join';
    }
    return null;
  }

  function isMoreOptions(name) {
    var tr = norm(name);
    var en = normEn(name);
    // «Ayşe Yılmaz için diğer seçenekler» bir kişi karesinin menüsüdür, görüşme menüsü değil.
    if (tr.indexOf(' için diğer') !== -1 || tr.indexOf(' icin diger') !== -1 || /more options (for|on)\b/.test(en)) {
      return false;
    }
    return tr.indexOf('diğer seçenekler') !== -1 ||
      tr.indexOf('diger secenekler') !== -1 ||
      en.indexOf('more options') !== -1;
  }

  /** @returns {'tr'|'en'|null} */
  function languageCode(name) {
    var tr = norm(name);
    var en = normEn(name);
    if (!tr && !en) {
      return null;
    }
    if (tr.indexOf('türkçe') !== -1 || tr.indexOf('turkce') !== -1 || en.indexOf('turkish') !== -1) {
      return 'tr';
    }
    if (tr.indexOf('ingilizce') !== -1 || en.indexOf('english') !== -1) {
      return 'en';
    }
    return null;
  }

  function inMenu(element) {
    var node = element ? element.parentElement : null;
    while (node) {
      var role = '';
      try {
        role = node.getAttribute ? normEn(node.getAttribute('role') || '') : '';
      } catch (err) {
        role = '';
      }
      if (role === 'menu' || role === 'listbox') {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function isLeave(name) {
    var tr = norm(name);
    var en = normEn(name);
    if (!tr || tr.indexOf('izin') !== -1 || /\ballow\b/.test(en)) {
      return false;
    }
    if (tr.indexOf('aramadan ayrıl') !== -1 || tr.indexOf('aramadan ayril') !== -1) {
      return true;
    }
    if (tr.indexOf('toplantıdan ayrıl') !== -1 || tr.indexOf('toplantidan ayril') !== -1) {
      return true;
    }
    // Gerçek Meet (Türkçe arayüz) düğmesi: «Görüşmeden çık».
    if (
      tr.indexOf('görüşmeden çık') !== -1 ||
      tr.indexOf('gorusmeden cik') !== -1 ||
      tr.indexOf('toplantıdan çık') !== -1 ||
      tr.indexOf('toplantidan cik') !== -1
    ) {
      return true;
    }
    if (en.indexOf('leave call') !== -1 || en.indexOf('leave meeting') !== -1) {
      return true;
    }
    return tr === 'ayrıl' || tr === 'ayril' || en === 'leave';
  }

  /** @returns {'showing'|'hidden'|null} showing: altyazı açık, düğme kapatır. */
  function captionsMode(name) {
    var n = both(name);
    if (n.indexOf('altyaz') === -1 && n.indexOf('caption') === -1 && n.indexOf('subtitle') === -1) {
      return null;
    }
    // «Altyazı ayarlarını aç», «En yeni altyazılara git»: açma/kapama düğmesi değildir.
    if (
      n.indexOf('ayar') !== -1 ||
      n.indexOf('setting') !== -1 ||
      n.indexOf('en yeni') !== -1 ||
      n.indexOf('latest') !== -1
    ) {
      return null;
    }
    // Gerçek Meet: «Canlı altyazıları devre dışı bırak» (açık),
    // «Altyazıları etkinleştir» (kapalı).
    if (
      n.indexOf('kapat') !== -1 ||
      n.indexOf('turn off') !== -1 ||
      n.indexOf('devre dışı') !== -1 ||
      n.indexOf('devre disi') !== -1 ||
      n.indexOf('disable') !== -1
    ) {
      return 'showing';
    }
    if (
      n.indexOf('aç') !== -1 ||
      n.indexOf('turn on') !== -1 ||
      n.indexOf('etkinleştir') !== -1 ||
      n.indexOf('etkinlestir') !== -1 ||
      n.indexOf('enable') !== -1
    ) {
      return 'hidden';
    }
    return null;
  }

  /**
   * Altyazı menüsünü açan düğme (gerçek Meet: «Altyazılar ve çeviri»,
   * aria-pressed). Açma/kapama düğmesi değildir; menüde asıl düğme çıkar.
   */
  function isCaptionsMenuButton(button) {
    var name = accessibleName(button);
    var n = both(name);
    if (n.indexOf('altyaz') === -1 && n.indexOf('caption') === -1 && n.indexOf('subtitle') === -1) {
      return false;
    }
    if (captionsMode(name) || isUnsafePress(name)) {
      return false;
    }
    if (n.indexOf('ayar') !== -1 || n.indexOf('setting') !== -1 || n.indexOf('en yeni') !== -1) {
      return false;
    }
    try {
      return button.getAttribute('aria-pressed') !== 'true';
    } catch (err) {
      return false;
    }
  }

  /** «Çıkarıldınız» / «you were removed»: bildirim kullanıcının kendisi için mi? */
  function removedSelf(n) {
    return (
      n.indexOf('çıkarıldınız') !== -1 ||
      n.indexOf('cikarildiniz') !== -1 ||
      n.indexOf('removed you') !== -1 ||
      n.indexOf('you were removed') !== -1 ||
      n.indexOf('you have been removed') !== -1 ||
      n.indexOf("you've been removed") !== -1
    );
  }

  /**
   * @param {string} text
   * @param {boolean=} inCall Görüşme düğmesi ekranda mı? Öyleyse toplantı sürüyordur:
   *   başka katılımcı için çıkan «Ali çıkarıldı» bildirimi bitiş sayılmaz.
   */
  function endReason(text, inCall) {
    var n = both(text);
    if (!n) {
      return null;
    }
    if (
      (n.indexOf('çıkarıld') !== -1 ||
        n.indexOf('cikarild') !== -1 ||
        n.indexOf('removed from') !== -1 ||
        n.indexOf('been removed') !== -1 ||
        n.indexOf('were removed') !== -1) &&
      (!inCall || removedSelf(n))
    ) {
      return 'removed';
    }
    // Kullanıcı kendisi ayrıldı (gerçek Meet ekranı: «Toplantıdan ayrıldınız»).
    if (
      n.indexOf('toplantıdan ayrıldınız') !== -1 ||
      n.indexOf('toplantidan ayrildiniz') !== -1 ||
      n.indexOf('görüşmeden ayrıldınız') !== -1 ||
      n.indexOf('gorusmeden ayrildiniz') !== -1 ||
      n.indexOf('you left the meeting') !== -1 ||
      n.indexOf('you left the call') !== -1
    ) {
      return 'left';
    }
    if (
      n.indexOf('arama sona erdi') !== -1 ||
      n.indexOf('görüşme sona erdi') !== -1 ||
      n.indexOf('gorusme sona erdi') !== -1 ||
      n.indexOf('call ended') !== -1 ||
      n.indexOf('call has ended') !== -1
    ) {
      return 'call-ended';
    }
    if (
      n.indexOf('toplantı bitti') !== -1 ||
      n.indexOf('toplanti bitti') !== -1 ||
      n.indexOf('toplantı sona erdi') !== -1 ||
      n.indexOf('toplanti sona erdi') !== -1 ||
      n.indexOf('meeting has ended') !== -1 ||
      n.indexOf('meeting ended') !== -1
    ) {
      return 'ended';
    }
    return null;
  }

  function isWaiting(doc) {
    var outside = both(textOutsideControls(doc && doc.body));
    if (outside) {
      var phrases = [
        'gönderildi',
        'gonderildi',
        'asking to join',
        'someone lets you in',
        'lets you in',
        'waiting to be let in',
        'kabul etmesi bekleniyor',
        'sizi görüşmeye alana',
        'sizi gorusmeye alana',
        'sizi toplantıya alana',
        'brings you into the call',
        'birisi sizi içeri',
        'birisi sizi iceri'
      ];
      for (var p = 0; p < phrases.length; p += 1) {
        if (outside.indexOf(phrases[p]) !== -1) {
          return true;
        }
      }
    }
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      if (joinKind(accessibleName(buttons[i])) === 'pending') {
        return true;
      }
    }
    return false;
  }

  function findJoin(doc) {
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      var kind = joinKind(accessibleName(buttons[i]));
      if (kind === 'ask' || kind === 'join') {
        return { el: buttons[i], kind: kind };
      }
    }
    return null;
  }

  function findLeave(doc) {
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      if (isLeave(accessibleName(buttons[i]))) {
        return buttons[i];
      }
    }
    return null;
  }

  function findDevices(doc, kind) {
    var found = [];
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      if (deviceKind(accessibleName(buttons[i])) === kind) {
        found.push(buttons[i]);
      }
    }
    return found;
  }

  function findCaptions(doc, mode) {
    var buttons = menuChoices(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      if (captionsMode(accessibleName(buttons[i])) === mode) {
        return buttons[i];
      }
    }
    return null;
  }

  function captionsAreOn(doc) {
    if (findCaptions(doc, 'showing')) {
      return true;
    }
    if (!doc || typeof doc.querySelector !== 'function') {
      return false;
    }
    for (var i = 0; i < SELECTORS.captionRegion.length; i += 1) {
      try {
        if (doc.querySelector(SELECTORS.captionRegion[i])) {
          return true;
        }
      } catch (err) {
        /* seçici bu belgede yok sayılır */
      }
    }
    return false;
  }

  /**
   * Altyazıyı açmak için basılacak ilk öğe. Meet'te CC çoğu zaman doğrudan düğme
   * değildir: önce «Altyazılar ve çeviri» (ya da ⋮ Diğer seçenekler) menüsü açılır,
   * öğe sonra görünür.
   * @returns {{kind: 'on'|'toggle'|'menu'|'more', el: Element|null}|null}
   */
  /**
   * Görüşmedeki kişi sayısı (kendisi dahil). Meet'in «Kullanıcılar 12» / «People 12»
   * düğmesinin üstündeki sayıdan okunur. Düğme yoksa ya da sayı okunamazsa null.
   */
  function participantCount(doc) {
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      var name = String(accessibleName(buttons[i]) || '').replace(/\s+/g, ' ').trim();
      var match = /^(kullanıcılar|kullanicilar|katılımcılar|katilimcilar|people|participants)\s*(\d{1,4})$/i.exec(name);
      if (match) {
        return Number(match[2]);
      }
    }
    return null;
  }

  var ALONE_DEFAULT_MS = 5 * 60 * 1000;

  /**
   * «Toplantıda yalnız kaldım» izleyicisi. Yalnızca daha önce başkaları da
   * görüşmedeyken ve kişi sayısı ardışık olarak ALONE_MS boyunca 1'e (ya da altına)
   * düşmüşse true döner. Sayı okunamazsa sayaç sıfırlanır (emin değilken durdurmaz).
   * @param {{aloneMs?:number, now?:function():number}} opts
   */
  function createAloneWatcher(opts) {
    var settings = opts && typeof opts === 'object' ? opts : {};
    var aloneMs = Number(settings.aloneMs);
    if (!Number.isFinite(aloneMs) || aloneMs <= 0) {
      aloneMs = ALONE_DEFAULT_MS;
    }
    var clock = typeof settings.now === 'function' ? settings.now : function () { return Date.now(); };
    var seenOthers = false;
    var since = null;
    return {
      update: function (doc) {
        var count = participantCount(doc);
        if (count === null) {
          since = null;
          return false;
        }
        if (count >= 2) {
          seenOthers = true;
          since = null;
          return false;
        }
        if (!seenOthers) {
          return false;
        }
        var at = clock();
        if (since === null) {
          since = at;
        }
        return at - since >= aloneMs;
      }
    };
  }

  /**
   * Görüşme arayüzü gitti mi? Ayrıl düğmesi yok ve «Yeniden katıl» / «Katıl» /
   * «Ana ekrana dön» gibi görüşme dışı bir düğme var. Bitiş metni beklenmedik
   * yazılsa da toplantıdan ayrıldığını yakalar.
   */
  function outOfCall(doc) {
    if (findLeave(doc)) {
      return false;
    }
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      var name = accessibleName(buttons[i]);
      if (joinKind(name) === 'join' || joinKind(name) === 'ask') {
        return true;
      }
      var n = both(name);
      if (
        n.indexOf('yeniden katıl') !== -1 ||
        n.indexOf('yeniden katil') !== -1 ||
        n.indexOf('rejoin') !== -1 ||
        n.indexOf('ana ekrana dön') !== -1 ||
        n.indexOf('ana ekrana don') !== -1 ||
        n.indexOf('return to home') !== -1
      ) {
        return true;
      }
    }
    return false;
  }

  function captionsEntry(doc) {
    if (captionsAreOn(doc)) {
      return { kind: 'on', el: findCaptions(doc, 'showing') };
    }
    var hidden = findCaptions(doc, 'hidden');
    if (hidden) {
      return { kind: 'toggle', el: hidden };
    }
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      if (isCaptionsMenuButton(buttons[i])) {
        return { kind: 'menu', el: buttons[i] };
      }
    }
    var more = findMoreOptions(doc);
    return more ? { kind: 'more', el: more } : null;
  }

  function collectElements(node, out) {
    var children = node && node.childNodes ? node.childNodes : [];
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i];
      if (child && child.nodeType === 1) {
        out.push(child);
        collectElements(child, out);
      }
    }
    return out;
  }

  function controlsWithin(root) {
    var nodes = [];
    collectElements(root, nodes);
    var found = [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (isControl(nodes[i])) {
        found.push(nodes[i]);
      }
    }
    return found;
  }

  function subtreeHasMediaPrompt(root) {
    var buttons = controlsWithin(root);
    for (var i = 0; i < buttons.length; i += 1) {
      if (isMediaUsePrompt(accessibleName(buttons[i]))) {
        return true;
      }
    }
    return false;
  }

  function findDismissWithin(root) {
    var buttons = controlsWithin(root);
    for (var i = 0; i < buttons.length; i += 1) {
      if (isDismissName(accessibleName(buttons[i]))) {
        return buttons[i];
      }
    }
    return null;
  }

  /**
   * Başlığı taşıyan en küçük öğeden yukarı çık.
   * Diyalog, başlık ile «kullan» düğmesini birlikte içeren kutudur.
   * Kök gövde sayılmaz; sayfadaki başka «Kapat» düğmesine basılmaz.
   * @returns {{root:Element, close:Element|null}|null}
   */
  function findHearDialog(doc) {
    if (!doc || !doc.body) {
      return null;
    }
    var nodes = collectElements(doc.body, []);
    var best = null;
    var bestLen = Infinity;
    for (var i = 0; i < nodes.length; i += 1) {
      var text = nodes[i].textContent || '';
      if (!isHearYouTitle(text)) {
        continue;
      }
      if (text.length < bestLen) {
        best = nodes[i];
        bestLen = text.length;
      }
    }
    if (!best) {
      return null;
    }
    var node = best;
    while (node && node !== doc.body && node !== doc.documentElement) {
      if (subtreeHasMediaPrompt(node)) {
        return { root: node, close: findDismissWithin(node) };
      }
      node = node.parentElement;
    }
    return null;
  }

  function findMoreOptions(doc) {
    var buttons = controls(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      if (isMoreOptions(accessibleName(buttons[i]))) {
        return buttons[i];
      }
    }
    return null;
  }

  function isLanguageCandidate(element) {
    if (!element || inMenu(element)) {
      return false;
    }
    var name = accessibleName(element);
    if (!languageCode(name) || captionsMode(name) || isUnsafePress(name)) {
      return false;
    }
    var tr = norm(name);
    var en = normEn(name);
    if (tr.length > 80 || en.length > 80) {
      return false;
    }
    return true;
  }

  function findLanguageTrigger(doc) {
    var buttons = controls(doc);
    var fallback = null;
    for (var i = 0; i < buttons.length; i += 1) {
      if (!isLanguageCandidate(buttons[i])) {
        continue;
      }
      var name = both(accessibleName(buttons[i]));
      if (
        name.indexOf('dil') !== -1 ||
        name.indexOf('language') !== -1 ||
        name.indexOf('altyaz') !== -1 ||
        name.indexOf('caption') !== -1
      ) {
        return buttons[i];
      }
      if (!fallback) {
        fallback = buttons[i];
      }
    }
    return fallback;
  }

  function findTurkishOption(doc, trigger) {
    var buttons = menuChoices(doc);
    for (var i = 0; i < buttons.length; i += 1) {
      if (buttons[i] === trigger) {
        continue;
      }
      var name = accessibleName(buttons[i]);
      if (languageCode(name) !== 'tr' || captionsMode(name) || isUnsafePress(name)) {
        continue;
      }
      return buttons[i];
    }
    return null;
  }

  function findLanguageMenu(doc) {
    if (!doc || !doc.body) {
      return null;
    }
    var nodes = collectElements(doc.body, []);
    var fallback = null;
    for (var i = 0; i < nodes.length; i += 1) {
      var role = '';
      try {
        role = nodes[i].getAttribute ? normEn(nodes[i].getAttribute('role') || '') : '';
      } catch (err) {
        role = '';
      }
      if (role !== 'menu' && role !== 'listbox') {
        continue;
      }
      if (!fallback) {
        fallback = nodes[i];
      }
      var text = both(nodes[i].textContent || '');
      if (
        text.indexOf('türkçe') !== -1 ||
        text.indexOf('turkish') !== -1 ||
        text.indexOf('ingilizce') !== -1 ||
        text.indexOf('english') !== -1
      ) {
        return nodes[i];
      }
    }
    return fallback;
  }

  function isInCall(doc) {
    if (isWaiting(doc) || findJoin(doc)) {
      return false;
    }
    return !!findLeave(doc);
  }

  function clickLeave(doc) {
    var button = findLeave(doc);
    if (!button || typeof button.click !== 'function') {
      return false;
    }
    button.click();
    return true;
  }

  /**
   * @param {{document:Document, now?:function():number, sleep?:function(number):Promise,
   *   pollMs?:number, deadlineAt?:number,
   *   onCaptionsReady?:function():*, onMeetingEnded?:function(object):*,
   *   onStatus?:function(object):*, onTrace?:function({kind:string,data:*}):*}} deps
   */
  function createMeetJoin(deps) {
    var options = deps && typeof deps === 'object' ? deps : {};
    var doc = options.document;
    var now = typeof options.now === 'function' ? options.now : function () { return Date.now(); };
    var sleep = typeof options.sleep === 'function'
      ? options.sleep
      : function (ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
      };
    var pollMs = Number(options.pollMs);
    if (!Number.isFinite(pollMs) || pollMs < 500) {
      pollMs = DEFAULT_POLL_MS;
    }
    var deadlineAt = Number(options.deadlineAt);
    if (!Number.isFinite(deadlineAt)) {
      deadlineAt = null;
    }

    var aloneWatcher = options.autoStopWhenAlone === false
      ? null
      : createAloneWatcher({ aloneMs: options.aloneMs, now: now });
    var phase = 'idle';
    var stopped = false;
    var running = false;
    var sawWaiting = false;
    var recordingStarted = false;
    var startRequested = false;
    var leaveClicked = false;
    var clicks = [];
    var pressedJoins = typeof WeakSet === 'function' ? new WeakSet() : null;
    var lastNotified = '';
    var hearOpenSince = null;
    /** Duyulma diyaloğu bu süre kapanmazsa durum «izin gerekiyor» olur. */
    var HEAR_STUCK_MS = 45000;
    /** Menü DOM'a gecikmeli girebilir; bu süre dolmadan yeni menü düğmesine basılmaz. */
    var CAPTION_MENU_WAIT_MS = 2000;
    var lastCaptionMenuAt = null;
    var triedCaptionMenus = typeof WeakSet === 'function' ? new WeakSet() : [];

    function rememberClick(element, kind) {
      clicks.push({ kind: kind, label: accessibleName(element) });
      emit('click', { kind: kind, label: clean(accessibleName(element), 60) });
    }

    /* ---- tanılama günlüğü (onTrace): yalnız yerelde saklanır ---- */

    /** Tek satıra indirir, e-posta adreslerini gizler, kısaltır. */
    function clean(value, max) {
      return String(value || '')
        .replace(/(google hesab[ıi]|google account)\s*[:：]\s*[^|]*/i, '$1: <gizli>')
        .replace(/\S+@\S+/g, '<e-posta>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
    }

    function emit(kind, data) {
      if (typeof options.onTrace !== 'function') {
        return;
      }
      try {
        options.onTrace({ kind: kind, data: data });
      } catch (err) {
        /* günlük hataları katılımı bozmaz */
      }
    }

    var lastSnapshot = '';
    var lastSnapshotAt = 0;
    var SNAPSHOT_REPEAT_MS = 30000;

    /** Sayfada ne var: görünen düğme adları, sayfa metni özeti, kısa bayraklar. */
    function traceSnapshot() {
      if (typeof options.onTrace !== 'function') {
        return;
      }
      var snap = null;
      try {
        var names = [];
        var seen = {};
        var buttons = controls(doc);
        for (var i = 0; i < buttons.length && names.length < 30; i += 1) {
          var name = clean(accessibleName(buttons[i]), 40);
          if (name && !seen[name]) {
            seen[name] = true;
            names.push(name);
          }
        }
        snap = {
          phase: phase,
          buttons: names,
          text: clean(textOutsideControls(doc && doc.body), 240),
          inCall: isInCall(doc),
          waiting: isWaiting(doc),
          captionsOn: captionsAreOn(doc),
          hearDialog: !!findHearDialog(doc)
        };
      } catch (err) {
        snap = null;
      }
      if (!snap) {
        return;
      }
      var key = JSON.stringify(snap);
      var at = now();
      if (key === lastSnapshot && at - lastSnapshotAt < SNAPSHOT_REPEAT_MS) {
        return;
      }
      lastSnapshot = key;
      lastSnapshotAt = at;
      emit('page', snap);
    }

    function press(element, kind) {
      if (!element || typeof element.click !== 'function') {
        return false;
      }
      var tag = String(element.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return false;
      }
      if (isUnsafePress(accessibleName(element))) {
        return false;
      }
      rememberClick(element, kind);
      element.click();
      return true;
    }

    function joinAlreadyPressed(element) {
      if (!pressedJoins || !element) {
        return false;
      }
      try {
        return pressedJoins.has(element);
      } catch (err) {
        return false;
      }
    }

    function markJoinPressed(element) {
      if (!pressedJoins || !element) {
        return;
      }
      try {
        pressedJoins.add(element);
      } catch (err) {
        /* yoksay */
      }
    }

    /**
     * Duyulma diyaloğu açıksa yalnız X'e basar.
     * @returns {{open:boolean}} open: diyalog hâlâ duruyor, katılma.
     */
    function dismissHearDialog() {
      var skip = findContinueWithoutMedia(doc);
      if (skip) {
        // Güvenli yol: aygıt açmadan devam et. Başlık tanınmasa da bu düğme yeter.
        press(skip, 'continue-without-media');
        return { open: !!findContinueWithoutMedia(doc) || !!findHearDialog(doc) };
      }
      var dialog = findHearDialog(doc);
      if (!dialog) {
        return { open: false };
      }
      if (dialog.close) {
        press(dialog.close, 'dismiss');
        if (!findHearDialog(doc)) {
          return { open: false };
        }
      }
      return { open: true };
    }

    /**
     * Yalnız açık okunan aygıta basar. Kapalı, izin gerekiyor ve tanınmayan
     * denetim katılmayı kilitlemez. Açık etiket kapanmazsa sonraki yoklama yeniden dener.
     * @returns {{ok:boolean, reason?:string}}
     */
    function ensureDeviceOff(kind) {
      var buttons = findDevices(doc, kind);
      for (var i = 0; i < buttons.length; i += 1) {
        if (deviceIsLive(buttons[i]) === true) {
          press(buttons[i], kind);
        }
      }
      var readableOff = false;
      for (var j = 0; j < buttons.length; j += 1) {
        var live = deviceIsLive(buttons[j]);
        if (live === true) {
          return { ok: false, reason: 'still-on' };
        }
        if (live === false) {
          readableOff = true;
        }
      }
      // Aygıt düğmeleri var ama durumları okunamıyorsa (arayüz değişmiş olabilir)
      // emin değiliz: katılma. Hiç düğme yoksa (ör. kamerası olmayan bilgisayar) engel değil.
      if (buttons.length && !readableOff) {
        return { ok: false, reason: 'unreadable' };
      }
      return { ok: true };
    }

    function ensureDevicesOff() {
      var mic = ensureDeviceOff('mic');
      var cam = ensureDeviceOff('cam');
      if (!mic.ok) {
        return mic;
      }
      return cam;
    }

    function notify(next, reason) {
      phase = next;
      var key = next + ':' + (reason || '');
      if (key !== lastNotified) {
        emit('phase', { phase: next, reason: reason || null });
      }
      if (key === lastNotified || typeof options.onStatus !== 'function') {
        lastNotified = key;
        return Promise.resolve(phase);
      }
      lastNotified = key;
      return Promise.resolve(options.onStatus({ phase: next, reason: reason || null })).then(
        function () { return phase; },
        function () { return phase; }
      );
    }

    function finishExpired() {
      stopped = true;
      return notify('expired', 'expired');
    }

    function clickLeaveOnce() {
      if (leaveClicked) {
        return false;
      }
      var button = findLeave(doc);
      if (!button) {
        return false;
      }
      leaveClicked = true;
      return press(button, 'leave');
    }

    function finishEnd(reason) {
      if (stopped && phase === reason) {
        return Promise.resolve(phase);
      }
      var chain = Promise.resolve();
      if (typeof options.onMeetingEnded === 'function') {
        chain = Promise.resolve(options.onMeetingEnded({ reason: reason }));
      }
      return chain.then(function () {
        clickLeaveOnce();
        stopped = true;
        return notify(reason, reason);
      }, function () {
        clickLeaveOnce();
        stopped = true;
        return notify(reason, reason);
      });
    }

    function resetCaptionMenus() {
      triedCaptionMenus = typeof WeakSet === 'function' ? new WeakSet() : [];
    }

    function hasTriedCaptionMenu(button) {
      if (!button) {
        return false;
      }
      if (typeof triedCaptionMenus.has === 'function') {
        return triedCaptionMenus.has(button);
      }
      return triedCaptionMenus.indexOf(button) !== -1;
    }

    function markTriedCaptionMenu(button) {
      if (!button) {
        return;
      }
      if (typeof triedCaptionMenus.add === 'function') {
        triedCaptionMenus.add(button);
      } else if (triedCaptionMenus.indexOf(button) === -1) {
        triedCaptionMenus.push(button);
      }
    }

    function isCaptionMenuCoolingDown(at) {
      return lastCaptionMenuAt !== null && at - lastCaptionMenuAt < CAPTION_MENU_WAIT_MS;
    }

    /**
     * Menü düğmesine basar; öğe hemen görünürse seçer.
     * true döndüğünde bu tick'te başka menü düğmesine basılmamalıdır.
     */
    function openCaptionMenu(button, kind, at) {
      if (!press(button, kind)) {
        markTriedCaptionMenu(button);
        return false;
      }
      lastCaptionMenuAt = at;
      markTriedCaptionMenu(button);
      var hidden = findCaptions(doc, 'hidden');
      if (hidden && !captionsAreOn(doc)) {
        press(hidden, 'captions');
        resetCaptionMenus();
      }
      return true;
    }

    function captionMenuCandidates() {
      var candidates = [];
      var menuButtons = controls(doc);
      for (var m = 0; m < menuButtons.length; m += 1) {
        if (isCaptionsMenuButton(menuButtons[m])) {
          candidates.push({ el: menuButtons[m], kind: 'captions-menu' });
        }
      }
      var more = findMoreOptions(doc);
      if (more) {
        var dup = false;
        for (var d = 0; d < candidates.length; d += 1) {
          if (candidates[d].el === more) {
            dup = true;
            break;
          }
        }
        if (!dup) {
          candidates.push({ el: more, kind: 'more' });
        }
      }
      return candidates;
    }

    function tryEnableCaptions() {
      if (captionsAreOn(doc)) {
        resetCaptionMenus();
        return;
      }
      var hidden = findCaptions(doc, 'hidden');
      if (hidden) {
        press(hidden, 'captions');
        resetCaptionMenus();
        return;
      }
      var at = now();
      if (isCaptionMenuCoolingDown(at)) {
        return;
      }
      var candidates = captionMenuCandidates();
      if (!candidates.length) {
        return;
      }
      for (var i = 0; i < candidates.length; i += 1) {
        if (!hasTriedCaptionMenu(candidates[i].el) && openCaptionMenu(candidates[i].el, candidates[i].kind, at)) {
          return;
        }
      }
      // Tüm mevcut menü düğmeleri bu turda denendi; yeniden başlamak için sıfırla.
      resetCaptionMenus();
      for (var j = 0; j < candidates.length; j += 1) {
        if (openCaptionMenu(candidates[j].el, candidates[j].kind, at)) {
          return;
        }
      }
    }

    function closeLanguageMenu() {
      var menu = findLanguageMenu(doc);
      if (!menu) {
        return;
      }
      var closeBtn = findDismissWithin(menu);
      if (closeBtn) {
        press(closeBtn, 'dismiss');
      }
    }

    /** Açık altyazıyı kapatmaz. İngilizceyse Türkçeyi seçer; yoksa kaydı bekletmez. */
    function trySetTurkish() {
      var trigger = findLanguageTrigger(doc);
      if (!trigger) {
        return;
      }
      var current = languageCode(accessibleName(trigger));
      if (current === 'tr') {
        return;
      }
      if (current !== 'en') {
        return;
      }
      var option = findTurkishOption(doc, trigger);
      if (!option) {
        press(trigger, 'lang');
        option = findTurkishOption(doc, trigger);
      }
      if (option) {
        press(option, 'lang');
        closeLanguageMenu();
      }
    }

    function enterCall() {
      ensureDevicesOff();
      if (!captionsAreOn(doc)) {
        tryEnableCaptions();
      }
      if (!captionsAreOn(doc)) {
        return notify('admitted');
      }
      trySetTurkish();
      if (recordingStarted) {
        phase = 'recording';
        // Kayıt sürerken: yalnız kalındı mı ya da uzun süredir konuşma gelmedi mi?
        if (aloneWatcher && aloneWatcher.update(doc)) {
          return finishEnd('alone');
        }
        if (typeof options.shouldEnd === 'function') {
          var extra = null;
          try {
            extra = options.shouldEnd();
          } catch (err) {
            extra = null;
          }
          if (extra) {
            return finishEnd(String(extra));
          }
        }
        return Promise.resolve(phase);
      }
      if (startRequested) {
        return Promise.resolve(phase);
      }
      phase = 'incall';
      startRequested = true;
      var started = typeof options.onCaptionsReady === 'function'
        ? options.onCaptionsReady()
        : { ok: true };
      return Promise.resolve(started).then(function (result) {
        if (result && result.ok === false) {
          startRequested = false;
          return notify('blocked');
        }
        recordingStarted = true;
        resetCaptionMenus();
        return notify('recording');
      }, function () {
        startRequested = false;
        return notify('blocked');
      });
    }

    function tick() {
      if (stopped) {
        return Promise.resolve(phase);
      }
      traceSnapshot();
      var ended = endReason(pageText(doc), !!findLeave(doc));
      if (ended) {
        return finishEnd(ended);
      }
      var hear = dismissHearDialog();
      if (hear.open) {
        if (deadlineAt !== null && now() > deadlineAt) {
          return finishExpired();
        }
        if (hearOpenSince === null) {
          hearOpenSince = now();
        }
        // Diyalog ne X ne «olmadan devam et» ile kapanmıyor: izin elle verilmeli.
        // Kullanıcı sessizce 30 dakika beklemesin, durum satırında ne yapacağı yazsın.
        if (now() - hearOpenSince >= HEAR_STUCK_MS) {
          return notify('blocked', 'permission');
        }
        phase = 'looking';
        return Promise.resolve(phase);
      }
      hearOpenSince = null;
      if (isInCall(doc)) {
        return enterCall();
      }
      if (deadlineAt !== null && now() > deadlineAt) {
        return finishExpired();
      }
      if (isWaiting(doc)) {
        sawWaiting = true;
        return notify('waiting');
      }
      var joinBtn = findJoin(doc);
      if (!joinBtn) {
        phase = 'looking';
        return Promise.resolve(phase);
      }
      var renew = joinBtn.kind === 'ask' && sawWaiting;
      if (!joinAlreadyPressed(joinBtn.el) || renew) {
        var muted = ensureDevicesOff();
        if (!muted.ok) {
          emit('note', { devicesNotOff: muted.reason || true });
          phase = 'looking';
          return Promise.resolve(phase);
        }
        if (press(joinBtn.el, joinBtn.kind)) {
          markJoinPressed(joinBtn.el);
        }
        if (joinBtn.kind === 'ask') {
          sawWaiting = false;
        }
        var endedAfter = endReason(pageText(doc), !!findLeave(doc));
        if (endedAfter) {
          return finishEnd(endedAfter);
        }
        if (isInCall(doc)) {
          return enterCall();
        }
        if (isWaiting(doc)) {
          sawWaiting = true;
          return notify('waiting');
        }
        return notify('joining');
      }
      return Promise.resolve(phase);
    }

    function run() {
      if (running) {
        return;
      }
      running = true;
      var loop = function () {
        if (stopped) {
          return;
        }
        Promise.resolve()
          .then(tick)
          .then(function () {
            if (stopped) {
              return null;
            }
            return sleep(pollMs);
          })
          .then(function () {
            if (!stopped) {
              loop();
            }
          })
          .catch(function (err) {
            stopped = true;
            console.warn('[MNA] Planlı katılım durdu —', err);
          });
      };
      loop();
    }

    function stop() {
      stopped = true;
      resetCaptionMenus();
    }

    function leave() {
      clickLeaveOnce();
    }

    return {
      tick: tick,
      run: run,
      stop: stop,
      leave: leave,
      getPhase: function () { return phase; },
      getClicks: function () {
        return clicks.map(function (item) {
          return { kind: item.kind, label: item.label };
        });
      }
    };
  }

  return {
    createMeetJoin: createMeetJoin,
    clickLeave: clickLeave,
    SELECTORS: SELECTORS,
    joinKind: joinKind,
    deviceIsLive: deviceIsLive,
    endReason: endReason,
    captionsEntry: captionsEntry,
    outOfCall: outOfCall,
    participantCount: participantCount,
    createAloneWatcher: createAloneWatcher,
    /** Bu sayfa bir bitiş ekranı mı? (altyazı ve yan panel metni sayılmaz) */
    meetingEndReason: function (document) {
      var reason = endReason(pageText(document));
      // Görüşme düğmesi hâlâ varsa toplantı sürüyor: ekrandaki bildirim
      // ("Ali çıkarıldı") bitiş değildir.
      if (reason && findLeave(document)) {
        return null;
      }
      return reason;
    }
  };
});
