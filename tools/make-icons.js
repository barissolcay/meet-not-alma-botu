#!/usr/bin/env node
/**
 * Meet Not Alma Botu - Chrome MV3 ikon üreticisi.
 *
 * Sıfır bağımlılık: yalnızca Node'un yerleşik "zlib" ve "buffer" modülleri kullanılır.
 * PNG şeması elle yazılır: imza (8 bayt) + IHDR + IDAT (zlib deflate, filtre tipi 0) + IEND.
 * Her yığın CRC32 ile doğrulanır.
 *
 * Kullanım:
 *   node tools/make-icons.js            -> extension/icons/ altına 16/32/48/128 PNG üretir
 *   node tools/make-icons.js --verify   -> üretilen PNG'lerin imzasını ve boyutlarını doğrular
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_DIR = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* ------------------------------------------------------------------ */
/* CRC32                                                               */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ */
/* PNG yazımı                                                          */
/* ------------------------------------------------------------------ */

function buildChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/**
 * RGBA piksel verisini PNG'ye çevirir.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba width*height*4 bayt
 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit derinliği
  ihdr[9] = 6;  // renk tipi: RGBA
  ihdr[10] = 0; // sıkıştırma yöntemi
  ihdr[11] = 0; // filtre yöntemi
  ihdr[12] = 0; // interlace yok

  // Her satırın başına filtre tipi 0 (None) yazılır.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', idat),
    buildChunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ */
/* Çizim yardımcıları (normalize koordinatlar 0..1)                  */
/* ------------------------------------------------------------------ */

function roundedRectTest(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) {
    return false;
  }
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function edgeSign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function triangleTest(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = edgeSign(px, py, ax, ay, bx, by);
  const d2 = edgeSign(px, py, bx, by, cx, cy);
  const d3 = edgeSign(px, py, cx, cy, ax, ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function mixColor(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
}

/* Tasarım: koyu lacivert/mor zemin + açık konuşma balonu + üç dalga çubuğu. */
const COLOR_BG_TOP = [76, 29, 149];    // #4C1D95 mor
const COLOR_BG_BOTTOM = [30, 58, 138]; // #1E3A8A lacivert
const COLOR_BUBBLE = [243, 245, 255];  // #F3F5FF
const COLOR_BARS = [
  [56, 189, 248],  // #38BDF8 gök mavisi
  [167, 139, 250], // #A78BFA mor
  [52, 211, 153]   // #34D399 nane yeşili
];

/* Konuşma balonu */
const BUBBLE = { x0: 0.17, y0: 0.19, x1: 0.83, y1: 0.68, r: 0.11 };
/* Balonun kuyruğu (sol alt) */
const TAIL = { ax: 0.30, ay: 0.63, bx: 0.46, by: 0.63, cx: 0.31, cy: 0.87 };
/* Dalga çubukları: x merkezi 0.5, genişlik 0.09, aralık 0.05 */
const BARS = [
  { x0: 0.315, x1: 0.405, y0: 0.35, y1: 0.52 },
  { x0: 0.455, x1: 0.545, y0: 0.29, y1: 0.58 },
  { x0: 0.595, x1: 0.685, y0: 0.33, y1: 0.54 }
];

/**
 * Tek bir örnek noktanın rengini döndürür (normalize koordinat).
 * @returns {{r:number,g:number,b:number,a:number}}
 */
function sampleColor(nx, ny) {
  // Şekiller altta üste doğru boyanır; sonraki şekil öncekini ezer.
  let result = { r: 0, g: 0, b: 0, a: 0 };

  // 1) Zemin (yuvarlatılmış kare, köşeler saydam)
  if (roundedRectTest(nx, ny, 0, 0, 1, 1, 0.22)) {
    const t = Math.min(1, Math.max(0, nx * 0.45 + ny * 0.55));
    const color = mixColor(COLOR_BG_TOP, COLOR_BG_BOTTOM, t);
    result = { r: color[0], g: color[1], b: color[2], a: 255 };
  }

  // 2) Balon kuyruğu (balonun altında kalacak şekilde önce çizilir)
  if (triangleTest(nx, ny, TAIL.ax, TAIL.ay, TAIL.bx, TAIL.by, TAIL.cx, TAIL.cy)) {
    result = { r: COLOR_BUBBLE[0], g: COLOR_BUBBLE[1], b: COLOR_BUBBLE[2], a: 255 };
  }

  // 3) Konuşma balonu
  if (roundedRectTest(nx, ny, BUBBLE.x0, BUBBLE.y0, BUBBLE.x1, BUBBLE.y1, BUBBLE.r)) {
    result = { r: COLOR_BUBBLE[0], g: COLOR_BUBBLE[1], b: COLOR_BUBBLE[2], a: 255 };
  }

  // 4) Dalga çubukları (kapsül biçiminde yuvarlatılmış dikdörtgen)
  for (let i = 0; i < BARS.length; i += 1) {
    const bar = BARS[i];
    const radius = (bar.x1 - bar.x0) / 2;
    if (roundedRectTest(nx, ny, bar.x0, bar.y0, bar.x1, bar.y1, radius)) {
      const color = COLOR_BARS[i];
      result = { r: color[0], g: color[1], b: color[2], a: 255 };
    }
  }

  return result;
}

/**
 * İkonu 4x4 supersampling ile rasterize eder (kenarlar yumuşak olsun).
 * @param {number} size
 * @returns {Buffer} RGBA piksel verisi
 */
function renderIcon(size) {
  const samples = 4;
  const out = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const nx = (px + (sx + 0.5) / samples) / size;
          const ny = (py + (sy + 0.5) / samples) / size;
          const color = sampleColor(nx, ny);
          const a = color.a / 255;
          r += color.r * a;
          g += color.g * a;
          b += color.b * a;
          alpha += a;
        }
      }

      const total = samples * samples;
      const index = (py * size + px) * 4;
      out[index] = alpha > 0 ? Math.round(r / alpha) : 0;
      out[index + 1] = alpha > 0 ? Math.round(g / alpha) : 0;
      out[index + 2] = alpha > 0 ? Math.round(b / alpha) : 0;
      out[index + 3] = Math.round((alpha / total) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Üretim ve doğrulama                                                 */
/* ------------------------------------------------------------------ */

function generate() {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  SIZES.forEach((size) => {
    const rgba = renderIcon(size);
    const png = encodePng(size, size, rgba);
    const target = path.join(ICON_DIR, `icon${size}.png`);
    fs.writeFileSync(target, png);
    console.log(`✓ ${path.relative(path.join(__dirname, '..'), target)} (${size}x${size}, ${png.length} bayt)`);
  });
}

/** PNG başlığını okuyup imzayı ve boyutları doğrular. */
function verify() {
  let allOk = true;
  SIZES.forEach((size) => {
    const target = path.join(ICON_DIR, `icon${size}.png`);
    if (!fs.existsSync(target)) {
      console.error(`✗ ${path.basename(target)} bulunamadı`);
      allOk = false;
      return;
    }
    const buffer = fs.readFileSync(target);
    const signatureOk = buffer.length >= 8 && buffer.slice(0, 8).equals(PNG_SIGNATURE);
    const width = buffer.length >= 16 ? buffer.readUInt32BE(16) : 0;
    const height = buffer.length >= 20 ? buffer.readUInt32BE(20) : 0;
    const sizeOk = width === size && height === size;
    const label = path.basename(target);
    if (signatureOk && sizeOk) {
      console.log(`✓ ${label}: imza geçerli, ${width}x${height}`);
    } else {
      console.error(`✗ ${label}: imza=${signatureOk ? 'geçerli' : 'geçersiz'}, ${width}x${height} (beklenen ${size}x${size})`);
      allOk = false;
    }
  });
  if (!allOk) {
    process.exitCode = 1;
  }
}

if (process.argv.indexOf('--verify') !== -1) {
  verify();
} else {
  generate();
}
