# HeyIL local-agent starter

Two ready-to-run examples of connecting a **local Claude agent** to HeyIL — safely,
through scoped credentials. Your Anthropic key and HeyIL secrets stay on your machine.

```bash
cd examples/local-agent
npm install
cp .env.example .env      # fill in the values (see below)
```

---

## 1. Reply provider — the "escalation brain" (`reply-server.mjs`)

HeyIL calls your endpoint when its built-in bot isn't enough; you answer with Claude.

```bash
node reply-server.mjs                              # starts on :8787
cloudflared tunnel --url http://localhost:8787     # → prints an https URL
# (or: ngrok http 8787)
```

Then in **HeyIL → Settings → מנוע הבינה → מוח תגובות מותאם**:
- **כתובת ה-endpoint**: `https://<your-tunnel>/reply`
- **סוד לחתימה**: any random string — put the SAME value in `.env` as `HEYIL_SECRET`
- Enable it, choose **"רק כשהבוט לא מספיק"**, and hit **שליחת בדיקה**.

Contract (already implemented in `reply-server.mjs`):
- **In:** `{ tenant, conversation, customer, message, history, knowledgeBase, flows }`,
  header `X-HeyIL-Signature: sha256=HMAC(secret, rawBody)`.
- **Out:** `{ "reply": "…" }` to answer, or `{ "pass": true }` to let HeyIL fall back to a
  human. Return within 30s; anything else → HeyIL falls back automatically.

**Reliability:** if your machine is off/slow, HeyIL just hands off to a human as usual —
customers are never stuck. So this is safe to run from a laptop.

---

## 2. Ops agent — ask in plain language (`ops-agent.mjs`)

Uses a scoped **API key** (Settings → מפתחות API) to read/act via the HeyIL Agent API.

```bash
node ops-agent.mjs "כמה לידים ממתינים לנציג? סכם אותם"
node ops-agent.mjs "שלח ל-972501234567: התור שלך אושר למחר ב-10:00"
```

Give the key only the scopes you need:
- **read** → `GET /api/agent/leads`, `/conversations/:id`, `/campaigns`, `/knowledge-base`, `/expenses`
- **write:messaging** → `POST /api/agent/messages { phone, text }`

For a **data-sync / read-only** agent, create a key with only `read` and call the same
`GET` endpoints from your own scripts — no write access, revocable anytime.

---

## Security notes
- The API key and reply secret are **scoped + revocable** — kill either in Settings and
  the pipeline stops; nothing else is affected.
- HeyIL only ever reaches your reply endpoint over **HTTPS** and signs every request.
- Least privilege: give each agent the minimum scopes it needs.
