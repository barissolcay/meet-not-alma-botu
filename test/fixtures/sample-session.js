/**
 * Örnek toplantı oturumu — biçimlendirici ve çıktı kalitesi testleri için.
 *
 * Gerçekçi bir Meet altyazı dökümünü taklit eder: aynı konuşmacının
 * bölünmüş cümleleri, kısa cevaplar, ara boşluklar ve farklı konuşmacılar.
 */
'use strict';

const START = Date.UTC(2026, 10, 6, 14, 0, 0);

function at(seconds) {
  return START + seconds * 1000;
}

/** @type {Array<{speaker: string, text: string, start: number, end: number}>} */
const SCRIPT = [
  { speaker: 'Kerem Yılmaz', text: 'Haftalık planlamayı başlayalım.', start: 0, end: 3 },
  { speaker: 'Kerem Yılmaz', text: 'Haftalık planlamayı başlayalım, gündemi paylaşayım.', start: 3, end: 7 },
  { speaker: 'Elif Demir', text: 'Ben mobil taraftan ilerleme durumunu paylaşayım.', start: 8, end: 13 },
  { speaker: 'Elif Demir', text: 'Onboarding akışı sonunda, kalan iki ekran var.', start: 13, end: 18 },
  { speaker: 'Murat Öztürk', text: 'Sunucu tarafında gecikme sorunu çözüldü mü?', start: 19, end: 23 },
  { speaker: 'Elif Demir', text: 'Evet, dün akşam çözüldü. Ortalama yanıt süresi 180 ms.', start: 23, end: 29 },
  { speaker: 'Kerem Yılmaz', text: 'Güzel. Peki yeni müşteriler için fiyatlandırma ne olacak?', start: 30, end: 36 },
  { speaker: 'Murat Öztürk', text: 'Finansla görüşüyoruz, ay sonuna kadar netleşecek.', start: 37, end: 43 },
  { speaker: 'Kerem Yılmaz', text: 'O zaman fiyatlandırmayı beklıyoruz.', start: 44, end: 47 },
  { speaker: 'Elif Demir', text: 'Bir de dokümantasyon eksikleri var, iki günlük iş.', start: 48, end: 54 },
  { speaker: 'Kerem Yılmaz', text: 'Alalım, Elif ilgili sayfaları sen yaz.', start: 55, end: 59 },
  { speaker: 'Elif Demir', text: 'Tamam, pazartesiye kadar tamamlarım.', start: 59, end: 63 },
  { speaker: 'Kerem Yılmaz', text: 'Son olarak bütçe kalemi ne kadar kaldı?', start: 64, end: 68 },
  { speaker: 'Murat Öztürk', text: 'Yazılım bütçesinden 120 bin TL kaldı.', start: 68, end: 73 },
  { speaker: 'Kerem Yılmaz', text: 'Teşekkürler, toplantıyı kapatıyorum.', start: 74, end: 78 }
];

const lines = SCRIPT.map((item, index) => ({
  id: 'l' + (index + 1),
  speaker: item.speaker,
  text: item.text,
  startedAt: at(item.start),
  endedAt: at(item.end),
  seq: index + 1
}));

const session = {
  id: 'sess_1765127200000_test01',
  title: 'Haftalık Ürün Planlama Toplantısı',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  meetingCode: 'abc-defg-hij',
  startedAt: START,
  endedAt: at(78),
  createdAt: START,
  updatedAt: at(78),
  source: 'extension',
  lines
};

module.exports = { session, lines, START };
