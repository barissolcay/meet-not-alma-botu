# Katkı / Contributing

Katkılar memnuniyetle karşılanır. / Contributions are welcome.

## Başlamadan

```bash
npm test            # tüm testler (Node >= 18, bağımlılık yok)
npm run validate    # manifest + "ağ isteği yok / ses kaydı yok" denetimi
```

Eklentiyi denemek için: `chrome://extensions` → Geliştirici modu → *Paketlenmemiş öğe yükle* → `extension/`.

## Kurallar

1. **Ağ isteği ve ses/görüntü erişimi eklemeyin.** Projenin ana vaadi yerel çalışmasıdır; `npm run validate` bunu denetler.
2. **Önce test.** Bir hatayı düzeltirken önce başarısız olan bir test yazın, sonra düzeltin.
3. **Satır birleştirme motoruna (`transcript-engine.js`) dokunurken** özellikle dikkatli olun; çok sayıda gerçek toplantıdan çıkan kural içerir ve testleri kapsamlıdır.
4. **Kişisel veri yok.** Testlerde ve belgelerde gerçek isim, e-posta, toplantı kodu ya da gerçek transkript kullanmayın; sahte veri yazın (`abc-defg-hij`, `Ayşe Yılmaz` gibi).
5. Mesajlar ve kullanıcıya görünen metinler Türkçe, sade ve teknik jargonsuz olsun.

## Meet arayüzü değişince eklenti bozulursa

En sık sorun budur. Hata bildirirken:

1. Eklenti sayfasında (*Uzantı seçenekleri*) **Planlı katılım günlüğünü indirin** (planlı katılım takıldıysa).
2. Günlükte **kişisel bilgi olup olmadığına bakın** (sayfa metni özeti ve düğme adları içerir; e-postalar gizlenir ama toplantı/kişi adları kalabilir). Gerekirse düzenleyin.
3. Ne beklediğinizi, ne olduğunu ve Meet dilini yazın.

Düğme adları ve metin tanıma kuralları `extension/src/content/meet-join.js` (katılma/altyazı/bitiş) ve `extension/src/content/meet-adapter.js` (altyazı okuma) içindedir.
