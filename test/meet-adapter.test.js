/**
 * Meet DOM adaptörü testleri (K7 / K8 / K11).
 * Çalıştırma: node --test test/meet-adapter.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMeetAdapter,
  REGION_SELECTORS,
} = require('../extension/src/content/meet-adapter.js');
const { el, doc, parseSelector } = require('./helpers/fake-dom.js');

/** Altyazı bölgesi + tek blok kurar. */
function makeRegion(label, blockChildren) {
  const region = el({
    tag: 'div',
    attrs: { role: 'region', 'aria-label': label || 'Captions' },
    children: [el({ tag: 'div', cls: ['nMcdL'], children: blockChildren || [] })],
  });
  return region;
}

test('K8) Konuşmacı adı yapısal fallback\'ta metne yapışmaz', () => {
  const block = el({
    tag: 'div',
    cls: ['nMcdL'],
    children: [
      el({ tag: 'div', cls: ['KcIKyf'], text: 'Siz' }),
      el({ tag: 'div', cls: ['taninmamisMetin'], text: 'Merhaba dünya' }),
    ],
  });
  const adapter = createMeetAdapter({ document: doc({ children: [block] }) });

  const result = adapter.readBlock(block);

  assert.ok(result, 'blok okunmalı');
  assert.strictEqual(result.speaker, 'Siz', 'konuşmacı "Siz" olmalı');
  assert.strictEqual(result.text, 'Merhaba dünya', 'metin tam olarak "Merhaba dünya" olmalı');
  assert.ok(!result.text.includes('Siz'), 'metin konuşmacı adını içermemeli');
  assert.ok(!/Siz\s*Merhaba/.test(result.text), 'yapışık kelime olmamalı');
});

test('K8b) Yapısal fallback metni konuşmacı adını içermez', () => {
  const block = el({
    tag: 'div',
    cls: ['nMcdL'],
    children: [
      el({ tag: 'div', cls: ['I9Ujf'], text: 'Siz' }),
      el({ tag: 'span', cls: ['bilinmeyen'], text: 'Merhaba dünya' }),
    ],
  });
  const adapter = createMeetAdapter({ document: doc({ children: [block] }) });

  const result = adapter.readBlock(block);

  assert.strictEqual(result.speaker, 'Siz');
  assert.strictEqual(result.text, 'Merhaba dünya');
});

test('K8c) Avatar adından türeyen konuşmacı da metne yapışmaz', () => {
  const block = el({
    tag: 'div',
    cls: ['nMcdL'],
    children: [
      el({ tag: 'img', attrs: { 'aria-label': 'Siz', alt: 'Siz' } }),
      'Siz',
      el({ tag: 'div', cls: ['bilinmeyen'], text: 'Merhaba dünya' }),
    ],
  });
  const adapter = createMeetAdapter({ document: doc({ children: [block] }) });

  const result = adapter.readBlock(block);

  assert.strictEqual(result.speaker, 'Siz');
  assert.strictEqual(result.text, 'Merhaba dünya');
  assert.ok(!result.text.includes('Siz'), 'metin konuşmacı adını içermemeli');
});

test('K8e) Konuşmacı adı ile başlayıp küçük harfle devam eden metin korunur (M1)', () => {
  const block = el({
    tag: 'div',
    cls: ['nMcdL'],
    children: [
      el({ tag: 'img', attrs: { 'aria-label': 'Siz', alt: 'Siz' } }),
      el({ tag: 'div', cls: ['bilinmeyen'], text: 'Siz de mi?' }),
    ],
  });
  const adapter = createMeetAdapter({ document: doc({ children: [block] }) });

  const result = adapter.readBlock(block);

  assert.ok(result, 'blok okunmalı');
  assert.strictEqual(result.speaker, 'Siz', 'konuşmacı "Siz" olmalı');
  assert.strictEqual(
    result.text,
    'Siz de mi?',
    'küçük harfle devam eden gerçek cümle korunmalı'
  );
});

test('K8f) Konuşmacı adı ardından boşluk ve büyük harfle başlayan metin kırpılır (M1)', () => {
  const block = el({
    tag: 'div',
    cls: ['nMcdL'],
    children: [
      el({ tag: 'img', attrs: { 'aria-label': 'Siz', alt: 'Siz' } }),
      'Siz ',
      el({ tag: 'div', cls: ['bilinmeyen'], text: 'Merhaba dünya' }),
    ],
  });
  const adapter = createMeetAdapter({ document: doc({ children: [block] }) });

  const result = adapter.readBlock(block);

  assert.ok(result, 'blok okunmalı');
  assert.strictEqual(result.speaker, 'Siz');
  assert.strictEqual(result.text, 'Merhaba dünya');
});

test('K8d) Canlı DOM\'a dokunulmaz (temizlik klon üzerinde yapılır)', () => {
  const block = el({
    tag: 'div',
    cls: ['nMcdL'],
    children: [
      el({ tag: 'div', cls: ['KcIKyf'], text: 'Siz' }),
      el({ tag: 'div', cls: ['bilinmeyen'], text: 'Merhaba dünya' }),
    ],
  });
  const document = doc({ children: [block] });
  const adapter = createMeetAdapter({ document });

  adapter.readBlock(block);

  assert.strictEqual(block.textContent, 'SizMerhaba dünya', 'canlı blok metni değişmemeli');
  assert.strictEqual(block.children.length, 2, 'canlı blok çocukları silinmemeli');
  assert.strictEqual(block.querySelector('.KcIKyf').textContent, 'Siz');
});

test('K7) Okunabilir blok içeren bölge -> true', () => {
  const region = makeRegion('Captions');
  const adapter = createMeetAdapter({ document: doc({ children: [region] }) });

  assert.strictEqual(adapter.isCaptionsLikelyOn(region), true);
});

test('K7b) Blok içermeyen bölge -> false ve uyarı verilir', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const region = el({
    tag: 'div',
    attrs: { role: 'region', 'aria-label': 'Captions' },
    children: [el({ tag: 'div', cls: ['bilinmeyen'] })],
  });
  const adapter = createMeetAdapter({ document: doc({ children: [region] }) });

  assert.strictEqual(adapter.isCaptionsLikelyOn(region), false);
  assert.strictEqual(warn.mock.calls.length, 1, 'tek uyarı verilmeli');
  const message = String(warn.mock.calls[0].arguments[0]);
  assert.match(message, /okunabilir altyazı bloğu yok/);
  assert.match(message, /extension\/src\/content\/meet-adapter\.js/);
});

test('K7c) Aynı bölge için uyarı tekrarlanmaz', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const region = el({
    tag: 'div',
    attrs: { role: 'region', 'aria-label': 'Captions' },
  });
  const adapter = createMeetAdapter({ document: doc({ children: [region] }) });

  adapter.isCaptionsLikelyOn(region);
  adapter.isCaptionsLikelyOn(region);
  adapter.isCaptionsLikelyOn(region);

  assert.strictEqual(warn.mock.calls.length, 1, 'uyarı yalnızca bir kez verilmeli');
});

test('K7d) DOM\'a bağlı olmayan bölge -> false, uyarı yok', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const region = el({
    tag: 'div',
    attrs: { role: 'region', 'aria-label': 'Captions' },
  });
  const adapter = createMeetAdapter({ document: doc({}) });

  assert.strictEqual(region.isConnected, false, 'bölge belgeye bağlı olmamalı');
  assert.strictEqual(adapter.isCaptionsLikelyOn(region), false);
  assert.strictEqual(warn.mock.calls.length, 0, 'uyarı verilmemeli');
});

test('K7e) Bölge yoksa -> false, uyarı yok', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const adapter = createMeetAdapter({ document: doc({}) });

  assert.strictEqual(adapter.isCaptionsLikelyOn(), false);
  assert.strictEqual(warn.mock.calls.length, 0, 'uyarı verilmemeli');
});

test('K11) Yerelleştirilmiş aria-label\'lı altyazı bölgeleri bulunur', () => {
  const labels = [
    '字幕',
    'キャプション',
    'Legendas',
    'Субтитры',
    'Didascalia',
    'Ondertiteling',
    'Napisy',
    'Tekstitys',
    '자막',
    'Subtítulos',
    'Captions',
    'Altyazılar',
  ];

  labels.forEach((label) => {
    const region = makeRegion(label);
    const adapter = createMeetAdapter({ document: doc({ children: [region] }) });

    const found = adapter.findCaptionsRegion();

    assert.ok(found, '"' + label + '" etiketli bölge bulunmalı');
    assert.strictEqual(found.getAttribute('aria-label'), label);
  });
});

test('K11b) Dışa aktarılan seçiciler geçerli CSS ve liste içinde', () => {
  assert.ok(Array.isArray(REGION_SELECTORS), 'seçici listesi dizi olmalı');

  REGION_SELECTORS.forEach((selector) => {
    assert.doesNotThrow(
      () => parseSelector(selector),
      'geçersiz seçici: ' + selector
    );
  });

  const adapter = createMeetAdapter({ document: doc({}) });
  assert.deepStrictEqual(adapter.REGION_SELECTORS, REGION_SELECTORS);
  assert.ok(
    REGION_SELECTORS.indexOf('div.aarpc') !== -1,
    'div.aarpc fallback korunmalı'
  );
  assert.ok(
    REGION_SELECTORS.indexOf('[jsname="yvBXue"]') !== -1,
    'jsname fallback korunmalı'
  );
  assert.ok(
    REGION_SELECTORS.indexOf('[role="region"][aria-label*="caption" i]') !== -1,
    'İngilizce etiket korunmalı'
  );
  assert.ok(
    REGION_SELECTORS.indexOf('[role="region"][aria-label*="altyaz" i]') !== -1,
    'Türkçe etiket korunmalı'
  );
});

test('K11c) Yeni etiketler bölge bulmayı bozmaz', () => {
  const region = el({
    tag: 'div',
    attrs: { role: 'region', 'aria-label': 'Subtítulos' },
    children: [el({ tag: 'div', cls: ['nMcdL'] })],
  });
  const adapter = createMeetAdapter({ document: doc({ children: [region] }) });

  assert.strictEqual(adapter.findCaptionsRegion(), region);
  assert.strictEqual(adapter.isCaptionsLikelyOn(region), true);
});

test('Toplantı kodu URL\'den çıkarılır', () => {
  const adapter = createMeetAdapter({ document: doc({}) });

  assert.strictEqual(
    adapter.extractMeetingCode('https://meet.google.com/abc-defg-hij'),
    'abc-defg-hij'
  );
  assert.strictEqual(adapter.extractMeetingCode(''), null);
});

test('Toplantı bilgisi başlık ve URL\'den okunur', () => {
  const document = doc({
    title: 'Haftalık Sync - Google Meet',
    location: { href: 'https://meet.google.com/abc-defg-hij' },
  });
  const adapter = createMeetAdapter({ document });

  const info = adapter.getMeetingInfo();

  assert.strictEqual(info.code, 'abc-defg-hij');
  assert.strictEqual(info.title, 'Haftalık Sync - Google Meet');
  assert.strictEqual(info.url, 'https://meet.google.com/abc-defg-hij');
});

test('Blok anahtarı aynı element için sabittir', () => {
  const block = el({ tag: 'div', cls: ['nMcdL'] });
  const adapter = createMeetAdapter({ document: doc({ children: [block] }) });

  const first = adapter.getBlockKey(block);
  const second = adapter.getBlockKey(block);

  assert.strictEqual(first, second);
  assert.notStrictEqual(first, adapter.getBlockKey(el({ tag: 'div' })));
});
