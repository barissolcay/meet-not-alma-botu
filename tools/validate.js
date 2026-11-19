/**
 * Eklenti doğrulama aracı — "Meet Not Alma Botu"
 *
 * Kullanım:  node tools/validate.js
 *
 * Bu araç, Chrome eklentisinin manifest'ini, dosya referanslarını ve ikon
 * dosyalarını kontrol eder; ayrıca projenin temel vaadini (ağ isteği yapma,
 * ses/görüntü yakalamama) kod tabanında denetler.
 *
 * Bağımlılık yok — sadece Node.js yerleşik modülleri.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'extension');

/** İzin beyaz listesi: bu eklenti yalnızca bunlara ihtiyaç duyar. */
const ALLOWED_PERMISSIONS = new Set(['storage', 'downloads', 'alarms']);
/** İzin verilen tek host kalıbı (tam eşleşme). */
const EXPECTED_HOST = 'https://meet.google.com/*';
/** Content script dosyalarının zorunlu sırası: motor -> adaptör -> katılım -> orkestratör. */
const EXPECTED_CONTENT_SCRIPT_JS = [
  'src/content/transcript-engine.js',
  'src/content/meet-adapter.js',
  'src/content/meet-join.js',
  'src/content/content.js'
];
/** chrome.storage.session yalnızca Chrome 102+ ile çalışır. */
const MIN_CHROME_VERSION = 102;

const errors = [];
const warnings = [];
const notes = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}
function ok(msg) {
  notes.push(msg);
}

/* ------------------------------------------------------------------ */
/* 1) Manifest                                                         */
/* ------------------------------------------------------------------ */
const manifestPath = path.join(EXT, 'manifest.json');
let manifest = null;

if (!fs.existsSync(manifestPath)) {
  fail('extension/manifest.json bulunamadı');
} else {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    ok('manifest.json geçerli JSON');
  } catch (err) {
    fail(`manifest.json parse hatası: ${err.message}`);
  }
}

if (manifest) {
  if (manifest.manifest_version !== 3) {
    fail(`manifest_version 3 olmalı, bulunan: ${manifest.manifest_version}`);
  } else {
    ok('manifest_version = 3');
  }

  const perms = manifest.permissions || [];
  const optionalPerms = manifest.optional_permissions || [];
  for (const p of perms.concat(optionalPerms)) {
    if (!ALLOWED_PERMISSIONS.has(p)) {
      fail(
        `manifest izinleri sıra dışı: "${p}" — yalnızca ` +
          `${[...ALLOWED_PERMISSIONS].join(', ')} kullanılmalı (gereksiz izin = gereksiz güven).`
      );
    }
  }
  ok('izinler: ' + (perms.join(', ') || '(yok)'));

  const hosts = (manifest.host_permissions || []).concat(
    (manifest.permissions || []).filter((p) => /^https?:/.test(p))
  );
  for (const h of hosts) {
    if (h !== EXPECTED_HOST) {
      fail(`host_permissions yalnızca "${EXPECTED_HOST}" olmalı, bulunan: ${h}`);
    }
  }
  ok('host_permissions: ' + (hosts.join(', ') || '(yok)'));

  // Referanslanan dosyalar var mı?
  const referenced = [];
  if (manifest.background && manifest.background.service_worker) {
    referenced.push(manifest.background.service_worker);
  }
  if (manifest.action && manifest.action.default_popup) {
    referenced.push(manifest.action.default_popup);
  }
  if (manifest.options_page) referenced.push(manifest.options_page);
  for (const cs of manifest.content_scripts || []) {
    referenced.push(...(cs.js || []), ...(cs.css || []));
  }
  for (const size of Object.keys((manifest.icons || {}))) {
    referenced.push(manifest.icons[size]);
  }
  for (const size of Object.keys((manifest.action && manifest.action.default_icon) || {})) {
    referenced.push(manifest.action.default_icon[size]);
  }

  for (const rel of referenced) {
    const abs = path.join(EXT, rel);
    if (!fs.existsSync(abs)) fail(`manifest'te referans verilen dosya eksik: extension/${rel}`);
  }
  ok(`${referenced.length} manifest referansı kontrol edildi`);

  // Content script sadece Meet'te mi çalışıyor? (tam eşleşme gerekir)
  for (const cs of manifest.content_scripts || []) {
    for (const m of cs.matches || []) {
      if (m !== EXPECTED_HOST) {
        fail(`content script yalnızca "${EXPECTED_HOST}" için çalışmalı, bulunan: ${m}`);
      }
    }
  }

  // Content script dosya sırası: motor -> adaptör -> orkestratör.
  const contentScripts = manifest.content_scripts || [];
  if (!contentScripts.length) {
    fail('manifest content_scripts tanımlı değil');
  } else {
    const js = (contentScripts[0] && contentScripts[0].js) || [];
    const sameOrder =
      js.length === EXPECTED_CONTENT_SCRIPT_JS.length &&
      js.every((file, index) => file === EXPECTED_CONTENT_SCRIPT_JS[index]);
    if (!sameOrder) {
      fail(
        'content_scripts[0].js sırası hatalı: ' + JSON.stringify(js) +
          ' — beklenen: ' + JSON.stringify(EXPECTED_CONTENT_SCRIPT_JS) +
          ' (motor -> adaptör -> orkestratör)'
      );
    } else {
      ok('content_scripts[0].js sırası doğru (motor -> adaptör -> katılım -> orkestratör)');
    }
  }

  // minimum_chrome_version: chrome.storage.session Chrome 102+ ister.
  const minChrome = manifest.minimum_chrome_version;
  if (minChrome === undefined || minChrome === null || minChrome === '') {
    fail(
      'manifest minimum_chrome_version yok — chrome.storage.session yalnızca Chrome ' +
        MIN_CHROME_VERSION + '+ ile çalışır'
    );
  } else {
    const parsedMin = parseInt(String(minChrome), 10);
    if (!Number.isFinite(parsedMin)) {
      fail(`minimum_chrome_version sayı değil: ${minChrome}`);
    } else if (parsedMin < MIN_CHROME_VERSION) {
      fail(
        `minimum_chrome_version ${MIN_CHROME_VERSION} veya üzeri olmalı, bulunan: ${minChrome}`
      );
    } else {
      ok('minimum_chrome_version = ' + minChrome);
    }
  }

  // MV3 service worker module olmamalı (import/export yok).
  if (manifest.background && manifest.background.type === 'module') {
    warn('service_worker type=module; classic script kabul edilir ama ESM import yazmayı unutma.');
  }
}

/* ------------------------------------------------------------------ */
/* 2) İkonlar (PNG başlığı + boyut)                                     */
/* ------------------------------------------------------------------ */
function readPngInfo(abs) {
  const buf = fs.readFileSync(abs);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) return { ok: false, reason: 'geçersiz PNG imzası' };
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') {
    return { ok: false, reason: 'IHDR chunk bulunamadı' };
  }
  return { ok: true, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

const iconDir = path.join(EXT, 'icons');
if (!fs.existsSync(iconDir)) {
  fail('extension/icons klasörü yok');
} else {
  for (const size of [16, 32, 48, 128]) {
    const p = path.join(iconDir, `icon${size}.png`);
    if (!fs.existsSync(p)) {
      fail(`ikon eksik: extension/icons/icon${size}.png`);
      continue;
    }
    const info = readPngInfo(p);
    if (!info.ok) {
      fail(`icon${size}.png geçersiz: ${info.reason}`);
    } else if (info.width !== size || info.height !== size) {
      fail(`icon${size}.png boyutu ${info.width}x${info.height}, ${size}x${size} olmalı`);
    } else {
      ok(`icon${size}.png geçerli (${info.width}x${info.height}, ${info.bytes} bayt)`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3) Kaynak dosyaları tara: ağ isteği / kayıt yasağı / kapsam          */
/* ------------------------------------------------------------------ */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(js|html|css)$/i.test(entry.name)) out.push(abs);
  }
  return out;
}

const sourceFiles = walk(EXT).filter((f) => !f.includes(`${path.sep}icons${path.sep}`));

const NETWORK_PATTERNS = [
  { re: /\bfetch\s*\(/, label: 'fetch()' },
  { re: /XMLHttpRequest/, label: 'XMLHttpRequest' },
  { re: /navigator\.sendBeacon/, label: 'navigator.sendBeacon' },
  { re: /\bnew\s+WebSocket\b/, label: 'WebSocket' },
  { re: /EventSource/, label: 'EventSource' },
  { re: /import\s*\(/, label: 'dinamik import()' },
];

const CAPTURE_PATTERNS = [
  { re: /getUserMedia/, label: 'getUserMedia' },
  { re: /getDisplayMedia/, label: 'getDisplayMedia' },
  { re: /desktopCapture/, label: 'desktopCapture' },
  { re: /tabCapture/, label: 'tabCapture' },
  { re: /MediaRecorder/, label: 'MediaRecorder' },
  { re: /AudioContext/, label: 'AudioContext' },
  { re: /AudioWorklet/, label: 'AudioWorklet' },
  { re: /MediaStreamTrack/, label: 'MediaStreamTrack' },
  { re: /captureStream/, label: 'captureStream' },
  // Standart ad "SpeechRecognition"; "webkit" öneki ayrıca yakalanır.
  { re: /\bSpeechRecognition\b/, label: 'SpeechRecognition' },
  { re: /webkitSpeechRecognition/, label: 'webkitSpeechRecognition' },
];

for (const file of sourceFiles) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');
  for (const { re, label } of NETWORK_PATTERNS) {
    if (re.test(src)) fail(`${rel}: ağ çağrısı yasağı ihlali — ${label} bulundu`);
  }
  for (const { re, label } of CAPTURE_PATTERNS) {
    if (re.test(src)) fail(`${rel}: ses/görüntü yakalama yasağı ihlali — ${label} bulundu`);
  }
}
if (sourceFiles.length) {
  ok(`${sourceFiles.length} kaynak dosya ağ/kayıt yasağına karşı tarandı`);
}

/* ------------------------------------------------------------------ */
/* 4) Protokol tutarlılığı                                              */
/* ------------------------------------------------------------------ */
const protocolPath = path.join(EXT, 'src', 'lib', 'protocol.js');
const usedTypes = new Set();

for (const file of sourceFiles.filter((f) => f.endsWith('.js'))) {
  const src = fs.readFileSync(file, 'utf8');
  const re = /['"](MNA_[A-Z_]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) usedTypes.add(m[1]);
}

if (!fs.existsSync(protocolPath)) {
  fail('extension/src/lib/protocol.js bulunamadı');
} else {
  const proto = fs.readFileSync(protocolPath, 'utf8');
  const declared = new Set();
  const dre = /['"](MNA_[A-Z_]+)['"]\s*:/g;
  let m;
  while ((m = dre.exec(proto)) !== null) declared.add(m[1]);

  for (const t of usedTypes) {
    if (!declared.has(t)) {
      warn(`protokol.js içinde tanımsız mesaj tipi kullanılıyor: ${t}`);
    }
  }
  ok(`${declared.size} mesaj tipi protocol.js içinde tanımlı`);
}

/* ------------------------------------------------------------------ */
/* 5) Formatter API'si (popup/history bunu kullanıyor)                 */
/* ------------------------------------------------------------------ */
const formattersPath = path.join(EXT, 'src', 'lib', 'formatters.js');
const REQUIRED_EXPORTS = [
  'formatTimestamp',
  'formatSessionText',
  'formatSessionMarkdown',
  'formatSessionJson',
  'formatSessionSrt',
  'formatSessionVtt',
  'formatSession',
  'buildPlainTranscript',
];

if (!fs.existsSync(formattersPath)) {
  fail('extension/src/lib/formatters.js bulunamadı');
} else {
  const src = fs.readFileSync(formattersPath, 'utf8');
  for (const name of REQUIRED_EXPORTS) {
    if (!new RegExp(`\\b${name}\\b`).test(src)) {
      fail(`formatters.js '${name}' fonksiyonunu içermiyor`);
    }
  }
  ok(`formatters.js ${REQUIRED_EXPORTS.length} beklenen export'u içeriyor`);

  /* 5b) Biçim regresyonu: fonksiyon adına bakmak yetmez, gerçek çıktı
   * üretilip biçim denetimleri yapılmalı. */
  let formatters = null;
  try {
    formatters = require(formattersPath);
  } catch (err) {
    fail('formatters.js yüklenemedi: ' + err.message);
  }

  let sampleSession = null;
  const samplePath = path.join(ROOT, 'test', 'fixtures', 'sample-session.js');
  if (!fs.existsSync(samplePath)) {
    fail('örnek oturum bulunamadı: test/fixtures/sample-session.js');
  } else {
    try {
      sampleSession = require(samplePath).session;
    } catch (err) {
      fail('örnek oturum yüklenemedi: ' + err.message);
    }
  }

  if (formatters && sampleSession) {
    const outputs = {};
    for (const fmt of ['txt', 'md', 'json', 'srt', 'vtt']) {
      let out = '';
      try {
        out = formatters.formatSession(sampleSession, fmt, {});
      } catch (err) {
        fail(`formatters.js '${fmt}' çıktısı üretilemedi: ${err.message}`);
        continue;
      }
      if (typeof out !== 'string' || !out.trim()) {
        fail(`formatters.js '${fmt}' çıktısı boş`);
        continue;
      }
      outputs[fmt] = out;
    }

    if (outputs.txt) {
      if (!/\[\d{2}:\d{2}:\d{2}\]/.test(outputs.txt)) {
        fail("TXT çıktısında '[HH:MM:SS]' zaman damgası deseni yok");
      }
      if (!/\S+:\s\S/.test(outputs.txt)) {
        fail("TXT çıktısında 'Konuşmacı: metin' deseni yok");
      }
    }
    if (outputs.json) {
      try {
        const parsed = JSON.parse(outputs.json);
        if (!Array.isArray(parsed.lines) || !parsed.lines.length) {
          fail("JSON çıktısında 'lines' dizisi yok veya boş");
        }
      } catch (err) {
        fail('JSON çıktısı geçerli JSON değil: ' + err.message);
      }
    }
    if (outputs.srt && !outputs.srt.includes('-->')) {
      fail("SRT çıktısında '-->' zaman kodu ayracı yok");
    }
    if (outputs.vtt && !outputs.vtt.trimStart().startsWith('WEBVTT')) {
      fail("VTT çıktısı 'WEBVTT' başlığıyla başlamıyor");
    }
    try {
      const plain = formatters.buildPlainTranscript(sampleSession, {});
      if (typeof plain !== 'string' || !plain.trim()) {
        fail("formatters.js 'buildPlainTranscript' çıktısı boş");
      }
    } catch (err) {
      fail("formatters.js 'buildPlainTranscript' çıktısı üretilemedi: " + err.message);
    }
    ok('formatters.js örnek oturumla 5 biçimde çıktı üretti ve biçim denetimleri geçti');
  }
}

/* ------------------------------------------------------------------ */
/* 6) HTML sayfalarında script referansları                             */
/* ------------------------------------------------------------------ */
for (const page of ['popup', 'options', 'history']) {
  const p = path.join(EXT, 'src', page, `${page}.html`);
  if (!fs.existsSync(p)) {
    fail(`eksik sayfa: extension/src/${page}/${page}.html`);
    continue;
  }
  const html = fs.readFileSync(p, 'utf8');
  const re = /<script[^>]+src=["']([^"']+)["']/g;
  let m;
  let count = 0;
  while ((m = re.exec(html)) !== null) {
    count += 1;
    const rel = m[1].replace(/^\.?\//, '').replace(/^\.\.\//, '');
    const abs = path.resolve(path.dirname(p), m[1]);
    if (!fs.existsSync(abs)) fail(`${page}.html referans verdiği betik eksik: ${m[1]}`);
  }
  if (count === 0) warn(`${page}.html hiç script referansı içermiyor`);
  else ok(`${page}.html ${count} script referansı doğrulandı`);
}

/* ------------------------------------------------------------------ */
/* Rapor                                                                */
/* ------------------------------------------------------------------ */
console.log('\n=== Meet Not Alma Botu — eklenti doğrulaması ===\n');
for (const n of notes) console.log('  [OK]   ' + n);
if (warnings.length) {
  console.log('');
  for (const w of warnings) console.log('  [UYARI] ' + w);
}
if (errors.length) {
  console.log('');
  for (const e of errors) console.log('  [HATA] ' + e);
  console.log(`\nSONUÇ: BAŞARISIZ — ${errors.length} hata, ${warnings.length} uyarı\n`);
  process.exit(1);
}
console.log(`\nSONUÇ: BAŞARILI — ${warnings.length} uyarı\n`);
