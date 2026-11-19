# Meet Not Alma Botu — never miss a meeting, never lose the notes 📝

A small, **fully local** Chrome extension (Manifest V3) that helps you attend meetings on time and keep good notes: it turns **Google Meet live captions** into a clean transcript (speaker names + timestamps), can **join a scheduled meeting for you**, and copies a ready-made **summary prompt + transcript** for the AI of your choice. Türkçe: [README.md](README.md).

| | |
|---|---|
| ⏰ **On time, automatically** | *Scheduled join*: enter the Meet link and start time; while Chrome is open the extension joins with **your own account** (microphone and camera **off**), turns on captions, and leaves at the end time. |
| 📝 **Notes without effort** | Transcript with speaker names and timestamps. Export TXT, Markdown, JSON, SRT, VTT. |
| ✨ **One-click summary** | Copies a short, useful summary prompt plus the transcript; paste it into Gemini / ChatGPT / Claude. |
| 🛑 **Stops by itself** | When you leave, the meeting ends, you are left alone (participant count), or after an optional silence timeout. |
| 🔒 **Local & private** | No audio recording. No network requests. Nothing leaves your computer. |

## Install (2 minutes)

1. Download `meet-not-alma-botu-v1.0.0.zip` from **Releases → v1.0.0** (right side of this page) and extract it.
2. In Chrome open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the extracted folder (it should contain `manifest.json`).
5. Pin the extension from the puzzle-piece 🧩 menu.

Keep the folder in place (Chrome runs the extension from it). To update: extract the new ZIP over it, press ↻ on `chrome://extensions`, and refresh open Meet tabs.

## Quick use

- **Manual:** join a meeting → extension icon → **Start recording** (*Kaydı Başlat*) → when finished **Stop** (*Kaydı Durdur*), then **Copy for AI** (*Yapay Zekâ İçin Kopyala*) or an export button.
- **Scheduled:** icon → *Planlı katılım* (scheduled join) → paste the link, set start (and ideally end) time → **Katılımı kaydet** (save). The extension keeps trying for 30 minutes after the start time; if a microphone/camera permission dialog blocks it, it will tell you in the status line. Chrome must be open, you must be signed in to Google, and the computer awake.

## Good to know

- **Purpose:** to help you keep up with your own meetings and work more productively — not a tool for covert monitoring.
- **Participants:** with a scheduled join you may not be present, and others may not know your account is taking notes — please get permission beforehand or announce it at the start.
- **Google terms:** Meet's terms may restrict automated interaction; using the extension on your own account is at your own risk. "Google" and "Meet" are trademarks of their respective owners.
- **Troubleshooting log:** scheduled joins keep a local log (last 600 events; no caption text, e-mails masked; names may still appear) that you can download from the **Ayarlar** (settings) page.
- **Consent & responsibility:** let participants know you are taking notes; depending on your country, organisation and the meeting owner, permission may be required. A scheduled join appears under your name in the participant list. How you use the tool (consent, laws such as GDPR/KVKK, storing and sharing notes, sending them to an AI service) is **your responsibility**.
- **Unofficial:** not affiliated with Google. It depends on Meet's page structure and can break when Meet changes — please open an issue.
- **No warranty:** MIT license, provided "as is". Captions are generated automatically by Meet, so double-check important details.

## Develop

```bash
npm test            # unit + acceptance + integration tests (Node >= 18, no dependencies)
npm run validate    # manifest + "no network / no audio" checks
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [PRIVACY.md](PRIVACY.md). License: MIT.
