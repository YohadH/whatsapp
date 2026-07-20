# WhatsApp Onboarding Setup — One-Time Platform Checklist

This is the **one-time** setup that turns on WhatsApp for the whole platform. You do
it **once** as the platform owner (Meta calls this the **Tech Provider** role). After
it's done, onboarding a customer is pure software — customers never touch Meta.

Legend:
- 🧑‍💻 **You do this** (external — Meta dashboard, business docs, buying SIMs). Cannot be automated from code.
- ✅ **Already done in the code** — nothing to build, just needs the value wired in.
- 🔑 Produces an **env var** the app reads (names match `backend/.env`).

> **What unblocks what**
> - Steps 1–6 make the **self-connect button** appear for customers who already have a number (the free, instant path).
> - Steps 7–8 (App Review + business verification) are what let you message **real customers at scale** instead of just test numbers.
> - Step 9 is the **concierge "we give you a number"** pilot (the +972 prepaid-SIM flow).

---

## 1. Meta Business + Facebook Developer accounts 🧑‍💻
- [ ] Create/confirm a **Meta Business account** at [business.facebook.com](https://business.facebook.com).
- [ ] Create a **Meta for Developers** account at [developers.facebook.com](https://developers.facebook.com) (same login).
- [ ] Start **Business Verification** early (Business Settings → Security Center). It can take days and gates higher messaging limits — don't leave it for last.

## 2. Create the Meta app + add WhatsApp 🧑‍💻 🔑
- [ ] developers.facebook.com → **Create App** → type **Business**.
- [ ] In the app, **Add Product → WhatsApp**.
- [ ] Note the **App ID** → 🔑 `META_APP_ID`
- [ ] App Settings → Basic → note the **App Secret** → 🔑 `META_APP_SECRET` (the app also accepts `WHATSAPP_APP_SECRET` as a fallback for the same value).

> The App Secret is what verifies inbound webhook signatures (`X-Hub-Signature-256`).
> ✅ The verification code already exists in `routes/whatsapp.js` — it just needs the secret set.

## 3. Register as a Tech Provider / configure Embedded Signup 🧑‍💻 🔑
This is what powers the **one-click "connect my number"** button.
- [ ] In the app, set up **Embedded Signup** (App Dashboard → WhatsApp → Embedded Signup / "Facebook Login for Business" configuration).
- [ ] Create a **configuration** and note its **Configuration ID** → 🔑 `META_CONFIG_ID`
- [ ] Add your deployed domain to **Allowed Domains** / Valid OAuth redirect URIs (e.g. `https://your-app.onrender.com`).

> ✅ The frontend launcher (`lib/fbEmbeddedSignup.js`) and backend exchange
> (`services/embeddedSignup.js`, `routes/settings.js`, `routes/admin.js`) are already built.
> The **green "🔗 חיבור WhatsApp" button appears automatically** the moment
> `META_APP_ID` + `META_CONFIG_ID` + an app secret are all present.

## 4. Webhook configuration 🧑‍💻 🔑
- [ ] In App Dashboard → WhatsApp → Configuration, set the **Callback URL** to:
      `https://<your-host>/api/whatsapp/webhook`
- [ ] Set the **Verify Token** to any random string → 🔑 `WHATSAPP_VERIFY_TOKEN` (must match `.env`).
- [ ] Subscribe to the **`messages`** field.

> ✅ Both the GET verification handshake and the POST message handler already exist and work
> (verified locally). The signature check activates once `META_APP_SECRET`/`WHATSAPP_APP_SECRET` is set.

## 5. Master/fallback number (optional but recommended) 🧑‍💻 🔑
A single "house" number under your own WABA — used for testing and as a fallback.
- [ ] App Dashboard → WhatsApp → API Setup: note the **Phone Number ID** → 🔑 `WHATSAPP_PHONE_NUMBER_ID`
- [ ] Note the **WhatsApp Business Account (WABA) ID** → 🔑 `WHATSAPP_BUSINESS_ACCOUNT_ID` (needed for the broadcast templates dropdown).
- [ ] Create a **System User** (Business Settings → Users → System Users) with a **permanent token** and assign it to the app + WABA → 🔑 `WHATSAPP_TOKEN`

> Use a **permanent** system-user token, not the 24-hour temporary one from the test panel.

## 6. Set the env vars 🧑‍💻
Set these in your host (Render dashboard → Environment, or `backend/.env` locally).
Most are already declared in `render.yaml` as `sync:false` (you enter them once).

| Env var | From | Purpose |
|---|---|---|
| `META_APP_ID` | Step 2 | **Turns on the connect button** |
| `META_CONFIG_ID` | Step 3 | **Turns on the connect button** |
| `META_APP_SECRET` (or `WHATSAPP_APP_SECRET`) | Step 2 | Connect button + webhook signature check |
| `WHATSAPP_VERIFY_TOKEN` | Step 4 | Webhook handshake |
| `WHATSAPP_TOKEN` | Step 5 | Master/fallback sends |
| `WHATSAPP_PHONE_NUMBER_ID` | Step 5 | Master/fallback number |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Step 5 | Broadcast templates |
| `CREDENTIALS_ENC_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | **Required** — encrypts every tenant's token at rest |

> ⚠️ Without `CREDENTIALS_ENC_KEY` the app refuses to boot in production and cannot
> store any connected number. Generate it once and keep it safe (rotating it makes all
> stored tokens undecryptable).

## 7. Request permissions / App Review 🧑‍💻
- [ ] Request these permissions for the app: **`whatsapp_business_management`** and **`whatsapp_business_messaging`**.
- [ ] Complete **App Review** for Embedded Signup / Tech Provider use.
- [ ] Complete **Business Verification** (from step 1) so you can graduate past the test-number stage and raise messaging limits.

> Until App Review + Business Verification pass, you can only message a handful of
> **test** numbers. This is the gate between "demo" and "real customers."

## 8. Verify end-to-end 🧑‍💻 / ✅
- [ ] After setting the env vars and redeploying, open **Settings** in the app → the **🔗 חיבור WhatsApp** button should now appear.
- [ ] Connect a test number and send yourself a WhatsApp message → confirm the agent replies.
- [ ] `GET /health` should return `{ ok: true }` and the webhook should show your test number's messages arriving.

---

## 9. Concierge "we give you a +972 number" pilot 🧑‍💻
For customers with **no** number. Start manual — no automation until demand is proven.
- [ ] Buy **2–3 Israeli prepaid mobile SIMs** (05X numbers — Rami Levy / 019 / We4G). These look most legit to Israeli customers; **avoid 072/073** (reads as telemarketer).
- [ ] Keep each SIM minimally topped up so the number stays alive.
- [ ] When a customer requests a number: register one SIM to WhatsApp (receive the one-time code), then connect it to their tenant using the same connect flow.
- [ ] Charge for this as a **paid tier** (covers SIM cost + your time, and blocks spammers).
- [ ] Track which number belongs to which tenant. *(A small super-admin screen for this is the next code task — best built once the new database is live so it can be tested.)*

---

## Division of labour — quick reference

| Task | Who | Status |
|---|---|---|
| Meta app, App Secret, App Review, Business Verification | 🧑‍💻 You | External — not automatable |
| Embedded Signup config → `META_CONFIG_ID` | 🧑‍💻 You | External |
| One-click connect flow (frontend + backend) | — | ✅ Built |
| Tenant self-connect from Settings | — | ✅ Built |
| Webhook verify + inbound handling | — | ✅ Built (verified locally) |
| Per-tenant encrypted token storage | — | ✅ Built (needs `CREDENTIALS_ENC_KEY`) |
| Buying/registering prepaid SIMs | 🧑‍💻 You | External — manual (concierge) |
| Super-admin "provided numbers" tracking screen | — | ⏳ Next code task (after new DB) |
