# Project Progress / Conversation Handoff

> Read this file first after restarting Visual Studio / Claude Code so we can
> pick up where we left off. Last updated: **2026-06-09**.

## What this project is
WhatsApp Business AI Agent (Hebrew) — Node/Express + Prisma + SQLite backend,
React/Vite admin frontend. See [README.md](README.md) for full details.

---

## Done so far

### 1. Privacy Policy + Terms of Service pages (for the Meta app token) ✅
Meta requires publicly reachable Privacy + Terms URLs to issue an app token.
Added them as **public, no-auth** HTML pages served by the backend.

- **New file:** [backend/src/routes/legal.js](backend/src/routes/legal.js)
  — serves `GET /privacy` and `GET /terms`.
- **Mounted** in [backend/src/app.js](backend/src/app.js) (public routes section).
- **Config** added to [backend/src/config/index.js](backend/src/config/index.js)
  under `config.legal`, with matching vars in [backend/.env.example](backend/.env.example):
  `LEGAL_APP_NAME`, `LEGAL_COMPANY_NAME`, `LEGAL_CONTACT_EMAIL`,
  `LEGAL_WEBSITE_URL`, `LEGAL_EFFECTIVE_DATE`.
- **Verified:** booted the app, both pages return `200 text/html`.

URLs to give Meta (after deploying to a public HTTPS host):
- `https://<your-host>/privacy`
- `https://<your-host>/terms`

### 2. Supabase (Postgres) schema ✅
- **New file:** [backend/supabase/schema.sql](backend/supabase/schema.sql)
  — Postgres-native translation of [backend/prisma/schema.prisma](backend/prisma/schema.prisma)
  (jsonb, timestamptz, real FKs with cascade/set-null, indexes, unique constraints).
- Run it in Supabase: SQL Editor → New query → paste → Run. Safe to re-run.

### 3. Switched the app from SQLite to PostgreSQL/Supabase ✅
- [backend/prisma/schema.prisma](backend/prisma/schema.prisma): datasource
  `provider = "postgresql"`; the five JSON-string columns
  (`tags`, `triggerWords`, `options`, `metadata`, `rawPayload`) are now native
  `Json` (→ jsonb), matching [backend/supabase/schema.sql](backend/supabase/schema.sql).
- [backend/src/lib/prisma.js](backend/src/lib/prisma.js): **removed** the SQLite
  JSON (de)serialization middleware — Prisma now reads/writes plain arrays/objects
  natively, so the rest of the app is unchanged. Verified all app code already
  passes plain values (only the middleware ever stringified these fields).
- [backend/.env.example](backend/.env.example): `DATABASE_URL` now shows a
  Supabase pooler (pgBouncer, :6543) connection-string template.
- `prisma validate` passes and `prisma generate` (v5.22.0) succeeds with the new types.

> ⚠️ Local `backend/prisma/dev.db` (SQLite) is now orphaned — left in place but no
> longer used. Local dev now also needs a Postgres `DATABASE_URL`.

### 4. Per-question pre-recorded voice notes ✅
A flow question can now carry an optional **voice note** that the bot sends (as a
WhatsApp `audio` message) right before the question text.
- **Schema:** `FlowQuestion.voiceUrl String?` ([schema.prisma](backend/prisma/schema.prisma) +
  [supabase/schema.sql](backend/supabase/schema.sql), with an idempotent `alter table … add
  column if not exists`; applied to the live DB).
- **Upload:** [backend/src/routes/uploads.js](backend/src/routes/uploads.js) →
  `POST /api/uploads/audio` (multer memory storage, ≤16 MB, audio/* only). Stores the
  file in a **public Supabase Storage bucket `voice-notes`** ([lib/supabase.js](backend/src/lib/supabase.js),
  service-role key) and returns its public URL — survives Render redeploys. If
  `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` aren't set, falls back to local disk served
  at `/uploads/*` ([app.js](backend/src/app.js)). Bucket is created idempotently by
  [supabase/schema.sql](backend/supabase/schema.sql). New env vars in
  [.env.example](backend/.env.example): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `SUPABASE_STORAGE_BUCKET`.
- **Send:** `sendWhatsAppAudio()` in [whatsapp.js](backend/src/services/whatsapp.js);
  [conversationEngine.js](backend/src/services/conversationEngine.js) plays the asked
  question's `voiceUrl` (if any) before the text reply.
- **Admin UI:** [Flows.jsx](frontend/src/pages/Flows.jsx) question editor has an
  "upload recording" control + inline player + remove.
- **Verified:** upload returns a tunnel URL; `/uploads/<file>` serves `200 audio/ogg`.
- **Note:** for the true voice-note bubble the file must be `.ogg`/Opus; other audio
  formats are delivered as a playable audio attachment.

---

### 5. Deployed to Render (single service) ✅
One Render web service builds the React admin app and serves it from the Express
backend (same origin, no CORS). Live as of **2026-06-09**.
- Root [package.json](package.json) lets Render's default commands work:
  `postinstall` builds the frontend + installs the backend; `start` runs the backend.
  `--include=dev` forces vite/prisma to install despite `NODE_ENV=production`.
- [render.yaml](render.yaml) blueprint also present (for Blueprint-based deploys).
- Repo: `Brandzp/whatsapp-App` (origin re-pointed here after a GitHub Desktop fork
  detour; the fork `YohadH/whatsapp-App` also has the history).

---

## TODO / open items
- [ ] Edit env vars with **real** company name + contact email (placeholders won't pass Meta review).
- [ ] Point WhatsApp Cloud API webhook at `https://<render-url>/api/whatsapp/webhook`
      (verify token = `WHATSAPP_VERIFY_TOKEN`); set `PUBLIC_BASE_URL` to the Render URL.
- [ ] Paste the two legal URLs (`/privacy`, `/terms`) into the Meta app dashboard to unlock the token.
- [x] Deploy backend to a **public HTTPS** host → done (Render). **See §5.**
- [ ] (Optional, offered but not yet done) Seed SQL for Supabase: admin user + sample flow + KB.
- [x] Switch the app to Supabase (Prisma `provider = "postgresql"` + dropped the JSON
      string-bridge). **See "Done so far" §3.**
- [x] **Supabase switch finished & live:** real `DATABASE_URL` (Transaction pooler :6543) set
      in `backend/.env`; schema applied via new helper
      [backend/supabase/apply.js](backend/supabase/apply.js) (`node supabase/apply.js`);
      seeded with `node prisma/seed.js`. Verified jsonb round-trips as a real array.
      Admin logins: `admin@example.com` / `admin123` and `yohad@brandzp.co.il` / `ChangeMe123!`
      (change after first login).

---

## How to resume
Tell me: *"read PROGRESS.md and continue"* — then point me at the next TODO item.
