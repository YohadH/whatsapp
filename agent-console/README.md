# HeyIL Agent Console 🎛️

A tiny **local control panel** for your HeyIL agents — a single window that shows, at a
glance, whether everything is wired up and answering. It runs **only on your computer**
and is **never part of the deployed app**, so nothing here is exposed to the internet
(except the one reply endpoint you deliberately tunnel).

It's two things in one small program:
1. **Status dashboard** — reply agent, HeyIL connection, API key, live activity. Auto-refreshes.
2. **Reply-provider endpoint** (`POST /reply`) — the "escalation brain" HeyIL calls; it
   answers with **your** Claude (via your Anthropic key).

Zero dependencies, so it packages into a **single `.exe`** you can double-click.

---

## Run it (two ways)

### Option A — double-click (needs Node.js installed)
1. Copy `config.example.json` → **`config.json`** and fill in your values.
2. Double-click **`start.bat`**. Your browser opens to `http://localhost:8790`.

### Option B — standalone `.exe` (no Node needed on the target machine)
```bash
cd agent-console
npm install
npm run build      # → dist/HeyIL-Agent-Console.exe
```
Put `config.json` **next to the .exe**, then double-click the `.exe`.

---

## config.json
| field | what it is |
|---|---|
| `anthropicKey` | Your Anthropic API key — powers the replies. |
| `heyilSecret` | Any long random string. **Paste the SAME value** into HeyIL → Settings → מנוע הבינה → מוח תגובות מותאם → סוד לחתימה. |
| `heyilBaseUrl` | `https://www.heyil.co.il` |
| `heyilApiKey` | *(optional)* An Ops API key (Settings → מפתחות API) — only used to show the "מפתח API" status card. |
| `model` | Defaults to `claude-opus-5`. |
| `port` | Defaults to `8790`. |

---

## Connect it to HeyIL (so the app talks to this)
The console listens on `http://localhost:8790`, but HeyIL (in the cloud) can't reach your
`localhost`. Expose just the reply endpoint with a tunnel:
```bash
cloudflared tunnel --url http://localhost:8790
```
Take the printed `https://…trycloudflare.com` URL, add **`/reply`**, and paste it into
HeyIL → **מוח תגובות מותאם → כתובת ה-endpoint**. Put your `heyilSecret` in **סוד לחתימה**,
choose **"בכל הודעה"** while testing, enable, save, and hit **שליחת בדיקה**. The dashboard's
"פעילות אחרונה" will light up.

---

## What the cards mean
- **🧠 סוכן התגובות** — is your Anthropic key set, is the signing secret set, how many
  replies/PASSes handled, and when the last one was.
- **🌐 חיבור ל-HeyIL** — can this machine reach `www.heyil.co.il`, and which build is live.
- **🔑 מפתח API (Ops)** — is your optional Ops key valid (green), invalid (red), or unset.
- **⚙️ הקונסולה** — the console itself: port + uptime.

## Security
- **Always set `heyilSecret`** — the reply endpoint verifies HeyIL's HMAC signature; without
  a secret it can't tell real requests from anyone who finds the tunnel URL.
- `config.json` and `dist/` are git-ignored — your keys never get committed.
- Only tunnel port **8790**. If the console is off, HeyIL simply falls back to a human — safe.
