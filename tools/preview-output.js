/**
 * Çıktı önizleme aracı.
 *
 * Örnek oturumu kullanarak eklentinin ürettiği metin çıktıları gösterir.
 * Böylece "transkripti yapay zekâya yapıştırınca nasıl görünecek?"
 * sorusu yüklenmeden yanıtlanabilir.
 *
 * Kullanım:  node tools/preview-output.js [txt|md|json|srt|vtt|plain]
 */
'use strict';

const path = require('node:path');

const F = require(path.join(__dirname, '..', 'extension', 'src', 'lib', 'formatters.js'));
const { session } = require(path.join(__dirname, '..', 'test', 'fixtures', 'sample-session.js'));

const format = (process.argv[2] || 'txt').toLowerCase();

if (format === 'plain') {
  process.stdout.write(F.buildPlainTranscript(session, {}));
  process.exit(0);
}

if (!['txt', 'md', 'json', 'srt', 'vtt'].includes(format)) {
  console.error(`Bilinmeyen biçim: ${format}. Seçenekler: txt, md, json, srt, vtt, plain`);
  process.exit(1);
}

process.stdout.write(F.formatSession(session, format, {}));
