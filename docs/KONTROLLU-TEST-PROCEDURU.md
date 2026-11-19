# Kontrollü Test Prosedürü

Meet canlı altyazılarının kalitesini ölçmek ve **eklentinin mi altyazının mı** sorusunu ayırmak için kullanılır. Her testten sonra indirilen `.txt` dosyasını `npm run analyze <dosya.txt>` ile incele.

---

## Neden bu prosedür?

Aynı odada iki ayrı cihazdan katılınca **çapraz konuşma (cross-talk)** olur: senin mikrofonun onun sesini, onunki senin sesini alır. Meet'in altyazı motoru tek bir karışmış ses akışından çalıştığı için:

- kimin ne söylediğini yanlış atayabilir,
- aynı cümleyi iki kez yazabilir,
- anlamsız cümleler üretebilir.

Bu, **Meet'in altyazı kalitesidir**, eklentinin hatası değildir. Aşağıdaki testler ikisini ayırır.

---

## Hazırlık

1. Eklentiyi yükle, `chrome://extensions` → eklenti → **Uzantı seçenekleri** → *Satır birleştirme süresi*'ni **2500 ms** (varsayılan) bırak. Daha uzun cümlelerde sorun çıkarsa 3000 ms yapabilirsin; ama eklenti artık kesinleşmiş satırları da 30 saniyelik bir "revizyon penceresi"yle geri alabiliyor, yani çoğu bölünme zaten kendiliğinden düzelir.
2. Test cümlelerini önceden yaz (aşağıdaki listeyi kullan), her cümleyi **numarayla** oku: "Bir. ... İki. ..." Böylece "hangi cümle nerede" net görünür.
3. Her testte toplantı kodunu değiştir, çıktıyı `toplantı-kodu` ile adlandır.
4. Aynı cihazda, aynı odada, aynı mikrofonla yap (karşılaştırılabilirlik için).

> **Not:** Dökümde Meet'in sizin konuşmanız için kullandığı **"Siz"** etiketi **"Ben"** olarak yazılır (ayarlardan değiştirilebilir). Yani "Siz" ve "Ben" aynı kişidir; çapraz konuşma analizi yaparken bunu göz önünde bulundur.

### Test cümleri (karışık kelime + sayı + isim)

```
1. Altın kırmızı çiçek ışığı.
2. Üç yüz yirmi dört adet elma.
3. Yarın İstanbul'dan Ankara'ya gideceğim.
4. Şirketin kurucusu Fatma Kaya'dir.
5. Fiyat yüz on iki Türk lirası otuz kuruş.
```

Zor kelimeler (altın, Fatma Kaya, yüz on iki) altyazının zorlandığı yerlerdir; eklentinin değil Meet'in motorunun kalitesini ölçer.

---

## Test A — Yalıtım (tek konuşmacı)

**Senaryo:** A konuşur, B mikrofonu kapalı. Sonra B konuşur, A mikrofonu kapalı.

**Beklenti:** Her cümle tam ve doğru, tek konuşmacı etiketiyle. Tekrar yok.

**Ölçüt:** 5/5 cümle doğru, 0 tekrarsız satır, 0 kesik cümle.

**Ne anlama gelir:** Eklenti kusursuz çalışıyor demektir. Burada hata varsa **eklenti hatasıdır** — bu dosyayı analiz aracıyla inceleyin ve gerekirse bir *issue* açın (gerçek konuşma içeriği paylaşmayın).

---

## Test B — Sıralı konuşma

**Senaryo:** A konuşur, B dinler ve mikrofonu kapalı. Sonra sıra B'de.

**Beklenti:** Konuşma turları doğru atanmış, cümleler bölünmemiş.

**Ne aranacak:** B konuşmaya başladığında A'nın son satırı kesilmemeli. Kesilme varsa bu **grace ayarı** meselesidir — `npm run analyze` çıktısında "GRACE kaynaklı" olarak görünür.

---

## Test C — Gerçekçi çok katılımcı (X, Y, Z)

**Senaryo:** Gerçekteki gibi **X, Y ve Z** — üç kişi, **üç ayrı cihaz**, **üç ayrı oda** (veya en azından mikrofonlar birbirini duymayacak kadar uzak). Herkes kendi cümlesini okur, aralarda sohbet eder.

**Neden önemli:** Senin asıl kullanım senaryon bu. Bu testte konuşmacı ataması gerçek koşullarda ölçülür.

**Beklenti:** Üç ayrı isim, doğru atanmış cümleler, turlar net.

**Ne aranacak:**
- Yanlış isim ataması → Meet'in atama hatası (çapraz konuşma yoksa, bu bizim adaptör hatası olabilir → issue açın).
- Kayıp cümle → **mutlaka issue olarak bildirin**, bu yakalama kaybı demektir.

---

## Test D — Çapraz konuşma (bilinçli)

**Senaryo:** Aynı Test A, ama **iki kişi aynı anda** konuşuyor ve ikisi de mikrofonu açık.

**Beklenti:** Bozuk metin, yanlış atama, mükerrer cümleler.

**Ne anlama gelir:** Bu bozulma **eklentinin değil, ortamın** etkisi. Test A ile karşılaştırınca fark, doğrudan çapraz konuşmanın maliyetini gösterir. Gerçek toplantılarda insanlar zaten sırayla konuştuğu için bu durum yaygın değildir.

---

## Test E — Yapay zekâ sınavı (asıl hedef)

**Senaryo:** Test C'nin dökümünü indir, Gemini'ye yapıştır, şunu iste:

> "Bu toplantı dökümünü yönetici özetine çevir: kararlar, aksiyon maddeleri (sorumlu + termin), açık kalan sorular. Ton: kısa ve resmî."

**Ölçüt:**
- Aksiyon maddeleri doğru çıkarıldı mı? (Sorumlu ve termin uydurulmamalı — dökümde yoksa "belirtilmemiş" demeli.)
- Özet, dökümde **olmayan** bilgi uydurdu mu? (Olmamalı.)
- Toplantının ne olduğu ilk 3 cümleden anlaşılıyor mu?

**Neden önemli:** Bu, projenin asıl değer ölçütü. Döküm ne kadar temizse yapay zekânın çıktısı o kadar iyi.

---

## Her testten sonra

```
npm run analyze toplanti-kodu.txt
```

Çıktı sana şunu söyler:

| Çıktı | Anlamı | Eylem |
|---|---|---|
| "GRACE kaynaklı bölünme" + "grace yolu" | Ayar meselesi, süreyi artırmakla düzelir | Ayarlardan süreyi artır |
| "GRACE kaynaklı bölünme" + "revizyon penceresi" | Eklenti zaten birleştiriyor | Dokunma, sorun değil |
| "KESİŞME kaynaklı bölünme" | Konuşma turu sadakati, kasıtlı | Dokunma, sorun değil |
| Hiçbiri yok | Döküm temiz | — |

Ayrıca `npm test` ve `npm run validate` hâlâ geçiyor mu diye bak — kod tarafında bir şey değişmediyse geçmesi gerekir.

---

## Hata bildirirken neleri ekleyin?

1. Test A'nın `.txt` dosyası → **yalıtılmış davranışın referansı**
2. Test C'nın `.txt` dosyası → **gerçek senaryo**
3. Test D'nın `.txt` dosyası → **çapraz konuşmanın maliyeti**
4. `npm run analyze` çıktıları (üçü de)
5. Dikkatini çeken bir şey varsa yazıyla

Test A'da bile bir sorun çıkarsa (kayıp cümle, yanlış isim, tekrarlı satır) **o tek başına yeterli** — eklentiyle ilgili bir sorun olduğu anlamına gelir; bunu issue olarak bildirmeniz çok yardımcı olur.
