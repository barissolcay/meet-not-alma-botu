# Meet Not Alma Botu 📝

> **Toplantıyı kaçırmayın, notları unutmayın.** Eklenti, planladığınız toplantıya hesabınızla zamanında katılabilir, konuşulanları yazıya döker ve özetini yapay zekâya tek tıkla yaptırmanızı sağlar. Böylece zamanınızı not tutmaya değil, toplantıya ve işe ayırırsınız.

| | |
|---|---|
| ⏰ **Zamanında orada** | **Planlı katılım:** bağlantıyı ve saati girin; Chrome açıkken eklenti toplantıya kendi hesabınızla katılır (mikrofon ve kamera kapalı), altyazıyı açar ve bitince ayrılır. |
| 📝 **Notlar kendiliğinden** | Meet'in canlı altyazısından konuşmacı adlı, zaman damgalı döküm çıkarır. TXT, Markdown, JSON, SRT, VTT. |
| ✨ **Tek tıkla özet** | Hazır özet istemi + döküm panoya kopyalanır; kendi yapay zekânıza (Gemini, ChatGPT, Claude…) yapıştırırsınız. |
| 🛑 **Kendiliğinden durur** | Toplantıdan ayrılınca, toplantı bitince, toplantıda yalnız kalınca (ya da isteğe bağlı sessizlikte). |
| 🔒 **Yerel ve size özel** | Ses kaydı yok, ağ isteği yok. Her şey sizin bilgisayarınızda kalır. |

> English summary: a Chrome extension that helps you **never miss a meeting or forget its notes**. It captures Google Meet live captions into a transcript, can join a scheduled meeting with *your own account* (microphone and camera off), and copies a ready-made summary prompt plus the transcript for the AI of your choice. Fully local: no audio recording, no network requests. See [README.en.md](README.en.md).

---

## Kurulum (2 dakika, bilgisayar bilgisi gerekmez)

1. Bu sayfanın sağ üstündeki yeşil **Code** düğmesine tıklayın → **Download ZIP**. İnen dosyayı bir klasöre **çıkarın** (sağ tık → *Tümünü ayıkla*).
2. Chrome'un adres çubuğuna `chrome://extensions` yazıp Enter'a basın.
3. Sağ üstteki **Geliştirici modu** düğmesini açın.
4. Sol üstte çıkan **Paketlenmemiş öğe yükle** düğmesine tıklayın (bu düğme Geliştirici modu açılınca belirir). Çıkardığınız klasörün içindeki **`extension`** klasörünü seçin; `manifest.json` dosyasını görüyorsanız doğru yerdesiniz, klasörün içine girmeyin. ZIP iç içe bir klasör oluşturduysa onu açıp `extension` klasörünü bulun.
5. Chrome'un araç çubuğundaki yapboz 🧩 simgesine tıklayıp **Meet Not Alma Botu**'nu sabitleyin (iğne simgesi). Açık bir Meet sekmeniz varsa **F5** ile yenileyin. Hepsi bu.

> **Not:** Chrome eklentiyi o klasörden çalıştırır; klasörü silmeyin ya da taşımayın. **Güncellemek** için yeni ZIP'i aynı klasörün üzerine çıkarıp `chrome://extensions` sayfasında eklentinin ↻ düğmesine basın ve açık Meet sekmelerini yenileyin. Node, npm ya da hesap gerekmez.

---

## Hızlı kullanım

**A) Elle kayıt (en basit)**
1. Meet toplantısına girin.
2. Eklenti simgesi → **Kaydı Başlat**. (Altyazı kapalıysa eklenti açmayı kendisi dener.)
3. Bitince **Kaydı Durdur**, sonra **Yapay Zekâ İçin Kopyala** ya da bir dışa aktarma düğmesi.

**B) Kendiliğinden katılım (toplantıyı kaçırmamak için)**
1. Eklenti simgesi → **Planlı katılım** bölümüne Meet bağlantısını ve başlangıç saatini girin. İsterseniz bitiş saatini de yazın; bitiş saati özellikle önerilir.
2. **Katılımı kaydet** düğmesine basın. Toplantı saatinde Chrome **açık**, Google hesabınız **girişli** ve bilgisayar **uyku modunda değil** ise eklenti katılır.
3. Sonucu eklenti simgesinden ve **Geçmişi Aç** sayfasından görürsünüz.

**C) Özet**
**Yapay Zekâ İçin Kopyala** düğmesine basın, kendi yapay zekânıza yapıştırıp gönderin. İstem, toplantı türünü (eğitim/sunum ya da çalışma toplantısı) anlayıp kısa, işe yarar bir not üretir.

---

## Önemli notlar

- **Amaç:** Kendi katıldığınız toplantılarda notları kaçırmamak ve daha verimli çalışmak. Eklenti gizli ya da habersiz bir izleme aracı olarak tasarlanmamıştır.
- **İzin ve bilgilendirme:** Bir toplantıyı yazıya dökerken katılımcıları bilgilendirmeniz önerilir; ülkenize, kurumunuza ve toplantı sahibine göre izin gerekebilir. Planlı katılım sizin hesabınızla katılır ve katılımcı listesinde **sizin adınızla görünür**. Bu araçla yaptığınız her kullanımın (izin alma, yasalara ve kurum kurallarına uyma, notların saklanması ve paylaşılması dâhil) **sorumluluğu kullanıcıya aittir**.
- **Katılımcıların bilgisi:** Planlı katılımda toplantıda siz bulunmayabilirsiniz ve diğer katılımcılar hesabınızın not aldığını bilmeyebilir. Bu yüzden toplantı sahibinden ve katılımcılardan **önceden izin alın** ya da toplantının başında not aldığınızı söyleyin.
- **Google şartları:** Meet'in kullanım şartları otomatik etkileşimi kısıtlıyor olabilir; eklentiyi kendi hesabınızda kullanmanın sonuçları size aittir. "Google" ve "Meet" ilgili sahiplerinin ticari markalarıdır.
- **Resmî değildir:** Google ile bağlantısı yoktur. Meet'in ekran yapısına bağlı çalışır; Meet arayüzü değişince bozulabilir. Bozulursa bir *issue* açmanız yeterli.
- **Garanti yok:** Yazılım MIT lisansıyla "olduğu gibi" sunulur; transkriptin eksiksizliği ya da doğruluğu garanti edilmez (altyazı Meet tarafından otomatik üretilir). Önemli kararlar için notları kontrol edin.

---

## Gizlilik taahhütleri (kod tabanında doğrulanır)

| | |
|---|---|
| 🎙️ **Ses kaydı yok** | `getUserMedia` / `MediaRecorder` / `AudioContext` kullanılmaz. Yalnızca ekranda zaten yazılı metin okunur. |
| 🌐 **Ağ isteği yok** | `fetch` / `XHR` / `WebSocket` yoktur. Hiçbir veri dışarı çıkmaz. |
| 👤 **Ayrı bot hesabı yok** | Planlı katılım (isteğe bağlı) **kendi hesabınızla** ve mikrofon/kamera kapalı katılır. Elle kayıtta toplantıya hiçbir şey katılmaz. |
| 🔒 **Yerel** | Tüm kayıtlar `chrome.storage` içinde, sizin makinenizde kalır. Ayrıntı: [PRIVACY.md](PRIVACY.md). |

`node tools/validate.js` bu kuralları ve manifesti otomatik denetler.

---

## Kullanım ayrıntıları

- **Altyazı:** Meet'in kendi canlı altyazısı açık olmalıdır. **Kaydı Başlat** kapalıysa açmayı dener; açılmazsa popup'taki **"Altyazıları açmayı dene"** düğmesine bir kez basın ya da Meet'te **CC** düğmesini elle açın.
- **Popup kapansa da kayıt sürer:** Satırlar arka planda saklanır; sekme yenilense bile geri yüklenir.
- **Başkası toplantıyı kapatmazsa:** Herkes çıkıp yalnız kalırsanız (yaklaşık 5 dakika sonra) kayıt kendiliğinden durur. İsterseniz ayarlardan "sessizlik süresi" ekleyebilirsiniz.

### Dökümü Gemini'ye göndermek

**En kolay yol:** Popup'taki **"Yapay Zekâ İçin Kopyala"** (veya geçmiş sayfasındaki **"Yapay zekâ için kopyala (istem + transkript)"**) düğmesi, hazır bir **özet istemi** ile başlıklı, zaman damgalı transkripti tek parça olarak panoya koyar. Yapay zekâya (Gemini, ChatGPT, Claude…) yapıştırıp göndermeniz yeter. İstem **kısa** bir not ister (en fazla ~500 kelime, tablo yok) ve toplantı türünü kendisi anlar: **eğitim/sunum** ise "ne öğretildi, akılda kalacak 7–10 şey, uygulama adımları, dikkat edilecekler, örnek ve sayılar, ödev/kaynak"; **çalışma toplantısı** ise "özet, kararlar, aksiyonlar (ne/kim/ne zaman), açık konular" yazar. Katılımcıların kendilerini tanıtması, kişisel projeleri, kim ne dedi ve şüpheli-kelime listeleri özete konmaz; uydurmaması söylenir. Doldurulacak boşluk yoktur. İstem metni [docs/OZET-ISTEMI.txt](docs/OZET-ISTEMI.txt) dosyasında da durur. Eklenti hiçbir şeyi ağa göndermez: metni yapay zekâya siz yapıştırırsınız.

Popup'taki **"Transkripti Kopyala"** düğmesi, zaman damgalarını atıp `Konuşmacı: metin` satırlarını panoya kopyalar. Başlık bilgileri (toplantı adı, kodu, bağlantısı, tarihi, süresi, katılımcı listesi) **korunur** — yapay zekâ toplantının kim olduğunu ve kimin konuştuğunu böylece bilir.

İndirilen `.txt` ise varsayılan olarak hem bu başlık bloğunu hem de `[00:00:00]` biçiminde satır zaman damgalarını içerir — doğrudan yönetici özeti üretmeye hazırdır (zaman damgalarını Ayarlar'dan kapatabilirsiniz):

```
Toplantı: Haftalık Ürün Planlama Toplantısı
Toplantı Kodu: abc-defg-hij
Tarih: 06.11.2026 17:00
Süre: 00:01:18
Katılımcılar: Kerem Yılmaz, Elif Demir, Murat Öztürk
Bağlantı: https://meet.google.com/abc-defg-hij

[00:00:00] Kerem Yılmaz: Haftalık planlamayı başlayalım.
[00:00:08] Elif Demir: Ben mobil taraftan ilerleme durumunu paylaşayım.
...
```

Bu çıktının tamamını görmek için: `node tools/preview-output.js txt`

> Meet sizin konuşmanızı **"Siz"** etiketiyle gösterir. Bu bir kişi adı değildir; eklenti bunu **"Ben"** yazar (ayarlardan değiştirilebilir). Aksi hâlde yapay zekâ "Siz"i bir katılımcı sanırdı.

---

## Planlı katılım

Popup'taki **Planlı katılım** bölümüne geçerli bir Google Meet bağlantısı, **Başlangıç** saati ve isteğe bağlı **Bitiş** saati girerek toplantıya otomatik katılım planlayabilirsiniz:

- **Ön koşullar:** **Chrome açık** ve **Google hesabınız girişli** olmalıdır; eklenti kendi hesabınızla katılır (ayrı bir bot hesabı yoktur). Bilgisayar **uyku modundan uyandırılmaz**.
- **30 dakikalık katılım penceresi:** Planlanan saatte Meet sekmesi açılır. Alarm gecikse bile başlangıçtan sonraki **30 dakika** içinde katılım denenir; 30 dakika dolduğunda hâlâ toplantıya girilememişse katılım sonlanır. O sırada başka bir canlı kayıt sürüyorsa planlı toplantı atlanır.
- **Mikrofon ve kamera kapalı girilir (en iyi çabayla):** Katılmadan önce açık olan mikrofon ve kamera kapatılır; durumları okunamıyorsa ya da kapatılamıyorsa toplantıya girilmez, girdikten sonra da açık görünen aygıt kapatılır. Meet arayüzü değişirse bu garanti edilemez; bu yüzden ilk denemelerinizi başınızdayken yapın.
- **İzin penceresi uyarısı (45 sn):** Meet'in *"Sizi duysunlar mı?"* / mikrofon-kamera izin penceresi (*"Mikrofon ve kamera olmadan devam et"* veya kapat düğmesiyle) **45 saniye** içinde geçilemezse planlı katılım durum satırında uyarı gösterilir. Çözüm olarak toplantı sekmesindeki izin penceresini elle kapatın ya da *"Mikrofon ve kamera olmadan devam et"* seçeneğini seçin; mikrofon ve kamera kapalı kalmalıdır.
- **Altyazı ve otomatik durdurma:** Toplantıya girildiğinde Meet'in canlı altyazıları (CC) açılmaya çalışılır (altyazı dili İngilizce görünüyorsa Türkçeye çevrilmeye çalışılır) ve kayıt başlar. Toplantıdan ayrıldığınızda, toplantı bittiğinde/çıkarıldığınızda veya tanımladıysanız **Bitiş** saatinde kayıt otomatik durdurulur.
- **Tanılama günlüğü:** Planlı katılım takılırsa nedenini bulmak için adım adım kayıt tutulur: alarmın ne zaman çaldığı, sekmenin açılması, sayfada görünen düğme adları, basılan düğmeler ve durum değişimleri. Altyazı/konuşma metni yazılmaz (en iyi çabayla), e-posta adresleri ve hesap adı gizlenir, ağa hiçbir şey gönderilmez; sayfa metni özetinde kişi ya da toplantı adları yine de görünebilir; son 600 kayıt `chrome.storage.local` içinde saklanır. Popup'taki **Ayarlar** düğmesiyle açılan sayfadan **Günlüğü indir (.txt)** ile alınır. Günlükte hiç `alarm-fired` kaydı yoksa alarm hiç çalmamıştır (Chrome kapalı, bilgisayar uykuda vb.).

---

## Ayarlar

Ayar sayfası (popup'taki **Ayarlar** düğmesi; ya da `chrome://extensions` → eklenti → *Uzantı seçenekleri*):

| Ayar | Etkisi |
|---|---|
| **Satır birleştirme süresi** | Altyazı metni bu süre değişmezse cümle tamamlanmış sayılır (500–5000 ms, varsayılan 2500). |
| **Konuşmacı bilinmiyorsa** | Ad okunamayan satırlarda kullanılacak etiket (varsayılan "Bilinmeyen"). |
| **Yerel kullanıcı adı** | Meet'in sizin konuşmanız için kullandığı "Siz" etiketinin yerine yazılacak ad (varsayılan "Ben"). |
| **Zaman damgaları** | Dışa aktarımda zaman damgası eklensin mi. |
| **Altyazı gürültülerini temizle** | Tekrarlanan, yalnızca noktalama veya boşluk içeren parçaları atar. |
| **Altyazılar açılınca otomatik başlat** | Meet'te CC açıldığında kayıt kendiliğinden başlar. |
| **Yalnız kalınca durdur** | Başkaları çıkıp ~5 dk görüşmede tek başınıza kalırsanız kayıt durur (planlı katılımda eklenti toplantıdan ayrılır). Katılımcı sayısı Meet'in «Kullanıcılar N» düğmesinden okunur; okunamazsa durdurmaz. Varsayılan açık. |
| **Sessizlik süresi** | N dakika hiç altyazı değişmezse kayıt durur (0 = kapalı, açıksa 10–240 dk). Uzun tek kişilik anlatım sessizlik sayılmaz. Varsayılan kapalı. |
| **Azami oturum sayısı** | Bu sayıyı aşan eski oturumlar silinir (varsayılan 100). |

Ayarlar çalışma anında değiştirilir; yeniden yükleme gerekmez.

---

## Çıktı formatları

| Format | İçerik |
|---|---|
| **TXT** | Başlık bloğu + `[00:12:34] Konuşmacı: metin` — rapora hazır düz metin |
| **MD** | Başlık + tarih + katılımcılar + konuşma (okunabilir rapor biçimi) |
| **JSON** | `{ id, title, meetingCode, startedAt, durationMs, participants, lines[] }` — işlenebilir |
| **SRT** | Altyazı dosyası (`00:00:00,000 --> ...`) |
| **VTT** | Web altyazı dosyası (`WEBVTT`) |

---

## Mükerrer satırlar nasıl önleniyor

Meet canlı altyazıda konuşma metnini **sürekli revize eder**: konuşmacı cümle ortasında duraksadığında Meet o bloğu kapatır ve konuşma sürdüğünde biriken metni **yeni bir blokla** verir. Eklenti ilk bloğu "tamamlandı" sayıp kesinleştirirse, ikinci blok ayrı bir satır olarak görünür — dökümde "ön ek + uzantı" çiftleri oluşur.

Bunun için üç mekanizma birlikte çalışır:

1. **Satır birleştirme süresi (grace)** — altyazı metni bu süre değişmezse cümle tamamlanmış sayılır (varsayılan 2500 ms).
2. **Revizyon penceresi** — kesinleşmiş son satır, Meet'in oluşturduğu yeni blokla 30 saniye içinde ve *yeni metin eskisinin uzantısıysa* yerinde güncellenir; yeni satır açılmaz. Araya başka bir konuşmacı girmişse (A, B, A deseni) birleştirme yapılmaz — konuşma turlarının sadakati korunur.
3. **Sekme gizlenmez** — sekme değiştirmek (`visibilitychange`) satırları erken kesinleştirmez. Erken kesinleştirme, Meet'in sonraki revizyonunun birleştirilememesine yol açardı.

Birleştirme **hiçbir metin kaybettirmez**: yeni metin eskisinin uzantısı olduğu için birleşen satırda iki konuşma da eksiksiz bulunur.

### Çapraz konuşma mükerrer gibi görünebilir

Aynı odada iki cihazla bulunuyorsanız (örneğin yan yana iki dizüstü), her iki mikrofon da iki konuşmacının da sesini alır. Meet buna göre **"Siz"** ve karşıdakinin adını karışık atar; dökümde A, B, A dizisi görürsünüz. Bu **eklentinin hatası değildir**, ortam kaynaklıdır. Kontrollü ölçüm için `docs/KONTROLLU-TEST-PROCEDURU.md` dosyasındaki Test A ve Test C adımlarını uygulayın.

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

### Kayıt sorumluluğu

Eklenti yalnızca **kendi tarayıcınızda, sizin erişiminizde** olan metni okur. Yine de bir toplantıyı kaydediyorsanız katılımcılara bunu önceden bildirin; bulunduğunuz ülkeye göre kayıt için yazılı rıza gerekebilir.

### Sorumluluk reddi

Bu yazılım MIT lisansıyla, herhangi bir garanti vermeden "olduğu gibi" sunulur. Kullanımından doğan sonuçların (toplantı katılımcılarından izin alınması, yasal ve kurumsal kurallara uyum, transkriptlerin saklanması, paylaşılması ve yapay zekâ hizmetlerine gönderilmesi dâhil) sorumluluğu kullanıcıya aittir. Proje Google ile bağlantılı değildir.
