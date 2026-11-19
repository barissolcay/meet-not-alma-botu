# Geliştirici notları

Katkı kuralları için [CONTRIBUTING.md](../CONTRIBUTING.md) dosyasına bakın.

## Mükerrer satırlar nasıl önleniyor

Meet canlı altyazıda konuşma metnini **sürekli revize eder**: konuşmacı cümle ortasında duraksadığında Meet o bloğu kapatır ve konuşma sürdüğünde biriken metni **yeni bir blokla** verir. Eklenti ilk bloğu "tamamlandı" sayıp kesinleştirirse, ikinci blok ayrı bir satır olarak görünür — dökümde "ön ek + uzantı" çiftleri oluşur.

Bunun için üç mekanizma birlikte çalışır:

1. **Satır birleştirme süresi (grace)** — altyazı metni bu süre değişmezse cümle tamamlanmış sayılır (varsayılan 2500 ms).
2. **Revizyon penceresi** — kesinleşmiş son satır, Meet'in oluşturduğu yeni blokla 30 saniye içinde ve *yeni metin eskisinin uzantısıysa* yerinde güncellenir; yeni satır açılmaz. Araya başka bir konuşmacı girmişse (A, B, A deseni) birleştirme yapılmaz — konuşma turlarının sadakati korunur.
3. **Sekme gizlenmez** — sekme değiştirmek (`visibilitychange`) satırları erken kesinleştirmez. Erken kesinleştirme, Meet'in sonraki revizyonunun birleştirilememesine yol açardı.

Birleştirme **hiçbir metin kaybettirmez**: yeni metin eskisinin uzantısı olduğu için birleşen satırda iki konuşma da eksiksiz bulunur.

### Çapraz konuşma mükerrer gibi görünebilir

Aynı odada iki cihazla bulunuyorsanız (örneğin yan yana iki dizüstü), her iki mikrofon da iki konuşmacının da sesini alır. Meet buna göre **"Siz"** ve karşıdakinin adını karışık atar; dökümde A, B, A dizisi görürsünüz. Bu **eklentinin hatası değildir**, ortam kaynaklıdır. Kontrollü ölçüm için `KONTROLLU-TEST-PROCEDURU.md` dosyasındaki Test A ve Test C adımlarını uygulayın.

---

## Dosya yapısı

```
extension/
  manifest.json                 MV3 tanımı
  src/content/
    meet-adapter.js             Meet DOM bilgisi (selector'lar) — tek yer
    transcript-engine.js        Saf motor: stabilizasyon, dedup, birleştirme
    meet-join.js                Planlı katılımın Meet arayüzü ve tıklama döngüsü
    content.js                  Gözlemciler + ayarlar + mesajlaşma
  src/background/
    service-worker.js           Oturum yönetimi, storage, sekme geri yükleme, planlı alarmlar
  src/lib/
    protocol.js                 Mesaj tipleri + storage anahtarları
    storage.js                  Oturum/ayar kalıcılığı
    settings.js                 Varsayılan ayarlar
    formatters.js               TXT/MD/JSON/SRT/VTT üreticileri
    utils.js                    Saf yardımcılar (dosya adı, arama, süre biçimi)
    schedule.js                 Planlı katılım kuralları (bağlantı, 30 dk pencere, durum metinleri)
  src/popup/                    Araç çubuğu arayüzü
  src/options/                  Ayarlar
  src/history/                  Oturum geçmişi + transkript görüntüleyici
  icons/                        16/32/48/128 PNG
tools/
  make-icons.js                 Sıfır bağımlılıkla PNG ikon üretici
  validate.js                   Eklenti doğrulama aracı
  preview-output.js             Örnek döküm önizlemesi
  analyze-transcript.js         Döküm tekrarlarını sınıflandırır (grace / kesişme)
test/
  transcript-engine.test.js     Motor birim testleri
  meet-adapter.test.js          Meet DOM adaptörü testleri (sahte DOM)
  content-orchestration.test.js İçerik betiği davranış testleri
  formatters.test.js            Formatlayıcı birim testleri
  ui-utils.test.js              Arayüz saf fonksiyon testleri
  ai-ready-output.test.js       "Yapay zekâya hazır çıktı" kabul testleri
  settings.test.js              Ayar uygulama testleri
  integration.test.js           Uçtan uca entegrasyon (sahte Chrome API)
  analyze-transcript.test.js    Döküm analiz aracı testleri
  scheduled-join.test.js        Planlı katılım kuralları ve akış testleri
  helpers/harness.js            Test ortamı taklidi
  helpers/fake-dom.js           Sahte DOM taklidi
  fixtures/sample-session.js    Örnek toplantı oturumu
docs/
  KONTROLLU-TEST-PROCEDURU.md  Altyazı kalitesini ölçen test protokolü
  OZET-ISTEMI.txt              Yapay zekâya yapıştırılan hazır özet istemi
.github/ISSUE_TEMPLATE/        Hata bildirimi şablonu
PRIVACY.md · CONTRIBUTING.md · LICENSE · README.en.md
```

---

## Geliştirici

```bash
npm test                # tüm testler (birim + kabul + uçtan uca entegrasyon)
npm run validate        # manifest / ikon / yasak API denetimi
npm run preview         # örnek döküm çıktısı (txt|md|json|srt|vtt|plain)
npm run analyze <döküm.txt>  # dökümdeki tekrarları sınıflandırır (grace / kesişme)
npm run icons           # ikonları yeniden üret
```

> `node --test test/` dizin argümanıyla çalışmaz (Node 22 dizini modül sanar). `npm test` kullanın.

### Meet DOM kırılgandır

Meet arayüzünü sık sık değiştirir ve sınıf adları (`nMcdL`, `KcIKyf`, `ygicle`…) zamanla değişir. Altyazılar durup başlarsa önce `extension/src/content/meet-adapter.js` içindeki seçiciler kontrol edilmelidir. Bu yüzden seçiciler bilinçli olarak tek dosyada toplandı ve birden fazla fallback içerir (yerelleştirilmiş "Altyazılar" etiketi dâhil).
