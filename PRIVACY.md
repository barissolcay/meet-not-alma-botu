# Gizlilik / Privacy

**Kısaca:** Eklenti hiçbir veriyi bir sunucuya göndermez. Her şey tarayıcınızda, sizin bilgisayarınızda kalır.

*In short: the extension sends nothing to any server. Everything stays in your browser, on your computer.*

## Neyi okur?

- `https://meet.google.com/*` sayfalarında **ekranda zaten yazılı olan canlı altyazı metnini** (konuşmacı adı + cümle) ve toplantı başlığı/kodunu okur.
- **Ses veya görüntü kaydetmez.** Mikrofon ve kameraya erişmez. Planlı katılımda mikrofon/kamera **kapalı** girilir.

## Neyi saklar? (`chrome.storage.local`, yalnız sizin tarayıcınızda)

| Veri | Ne için |
|---|---|
| Kayıtlı oturumlar (transkript satırları, başlık, süre, katılımcı adları) | Geçmiş, dışa aktarma |
| Ayarlar | Tercihleriniz |
| Planlı katılımlar (bağlantı, başlangıç/bitiş saati, durum) | Zamanlayıcı |
| Planlı katılım günlüğü (son 600 olay: alarm, sekme, sayfada görünen düğme adları, kısa sayfa metni özeti) | Takılırsa nedenini bulmak. Altyazı/konuşma metni yazılmaz (en iyi çabayla); e-posta adresleri ve hesap adı gizlenir. Sayfa metni özetinde ve düğme adlarında kişi ya da toplantı adları görünebilir. |

Bu verileri **Geçmiş** sayfasından silebilir, günlüğü **Uzantı seçenekleri** sayfasından temizleyebilirsiniz. Eklentiyi kaldırmak tüm verileri siler.

## Ağ

Kodda `fetch`, `XMLHttpRequest`, `WebSocket` yoktur; analiz, reklam ya da uzak kod yüklemesi yoktur. `node tools/validate.js` bunu otomatik denetler. "Yapay Zekâ İçin Kopyala" düğmesi yalnızca metni **panoya** koyar; yapıştırmayı ve nereye yapıştıracağınızı siz yaparsınız.

## İzinler (neden gerekli?)

| İzin | Neden |
|---|---|
| `storage` | Oturumları, ayarları ve zamanlayıcıyı yerelde saklamak |
| `downloads` | TXT/MD/JSON/SRT/VTT dosyası indirmek |
| `alarms` | Planlı katılım saatinde eklentiyi uyandırmak |
| `https://meet.google.com/*` | Meet sayfasındaki altyazıyı okumak ve planlı katılımda sekmeyi yönetmek |

## Sorumluluk

Bir toplantıyı yazıya dökmek, katılımcılara bildirilmesi gereken bir işlemdir. Başkalarının toplantılarında önceden haber verin ve izin alın; KVKK/GDPR ve kurum kuralları kullanıcının sorumluluğundadır. Planlı katılım sizin hesabınızla katılır ve katılımcı listesinde adınızla görünür; toplantıda siz bulunmayabilirsiniz ve diğer katılımcılar hesabınızın not aldığını bilmeyebilir, bu yüzden önceden izin alın ya da toplantının başında bildirin. Transkript kişisel veri içerebilir; saklanması, paylaşılması ve yapay zekâ hizmetlerine gönderilmesi kullanıcının sorumluluğundadır. Meet'in kullanım şartları otomatik etkileşimi kısıtlıyor olabilir; "Google" ve "Meet" ilgili sahiplerinin ticari markalarıdır.

---

## English

The extension reads the **live caption text already shown on screen** in Google Meet (speaker name + sentence) and the meeting title/code. It does **not** record audio or video and does not access your microphone or camera (a scheduled join tries to enter with both turned **off**, on a best-effort basis: it does not join if their state cannot be read).

Everything is stored in `chrome.storage.local` on your own computer: saved sessions, settings, scheduled joins and a local troubleshooting log (last 600 events; no caption text on a best-effort basis, e-mail addresses and account name masked, participant or meeting names may still appear). Uninstalling the extension removes all of it. There are no network requests, analytics, ads or remote code. Transcribing a meeting is something participants should be told about: get consent, and follow your local law and organisation policy. A scheduled join uses *your own account* and appears under your name in the participant list.
