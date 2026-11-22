# Kullanım ayrıntıları

Kısa özet için [README](../README.md) yeterlidir. Bu sayfa, ayrıntı isteyenler içindir.

## Altyazı ve kayıt

- **Altyazı:** Meet'in kendi canlı altyazısı açık olmalıdır. **Kaydı Başlat** kapalıysa açmayı dener; açılmazsa popup'taki **"Altyazıları açmayı dene"** düğmesine bir kez basın ya da Meet'te **CC** düğmesini elle açın.
- **Popup kapansa da kayıt sürer:** Satırlar arka planda saklanır; sekme yenilense bile geri yüklenir.
- **Başkası toplantıyı kapatmazsa:** Herkes çıkıp yalnız kalırsanız (yaklaşık 5 dakika sonra) kayıt kendiliğinden durur. İsterseniz ayarlardan "sessizlik süresi" ekleyebilirsiniz.

## Dökümü yapay zekâya aktarmak

**En kolay yol:** Popup'taki **"Yapay Zekâ İçin Kopyala"** (veya geçmiş sayfasındaki **"Yapay zekâ için kopyala (istem + transkript)"**) düğmesi, hazır bir **özet istemi** ile başlıklı, zaman damgalı transkripti tek parça olarak panoya koyar. Kendi yapay zekânıza yapıştırıp göndermeniz yeter. İstem **kısa** bir not ister (en fazla ~500 kelime, tablo yok) ve toplantı türünü kendisi anlar: **eğitim/sunum** ise "ne öğretildi, akılda kalacak 7–10 şey, uygulama adımları, dikkat edilecekler, örnek ve sayılar, ödev/kaynak"; **çalışma toplantısı** ise "özet, kararlar, aksiyonlar (ne/kim/ne zaman), açık konular" yazar. Katılımcıların kendilerini tanıtması, kişisel projeleri, kim ne dedi ve şüpheli-kelime listeleri özete konmaz; uydurmaması söylenir. Doldurulacak boşluk yoktur. İstem metni [OZET-ISTEMI.txt](OZET-ISTEMI.txt) dosyasında da durur. Eklenti hiçbir şeyi ağa göndermez: metni yapay zekâya siz yapıştırırsınız.

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
- **Toplantı sahibi gelmediyse:** Bekleme odası zaman aşımına uğrar ("katılma isteğinizi kimse yanıtlamadı") ya da Meet sizi ana sayfaya atarsa eklenti toplantı bağlantısını yeniden açıp isteği tekrar gönderir; pencere dolana kadar yaklaşık 20 saniyede bir yeniden dener.
- **60 dakikalık katılım penceresi:** Planlanan saatte Meet sekmesi açılır. Alarm gecikse bile başlangıçtan sonraki **60 dakika** içinde katılım denenir; 60 dakika dolduğunda hâlâ toplantıya girilememişse katılım sonlanır. O sırada başka bir canlı kayıt sürüyorsa planlı toplantı atlanır.
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
