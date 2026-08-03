# Integrations — Implementation Plan

Status of the six connections shown in **Settings → אינטגרציות**. Today all render
as **"בקרוב"** (readiness-gated — no dead toggles). This plan makes them real, in
priority order by what we can ship without external dependencies.

Legend: 🟢 buildable by us now · 🟡 needs owner-provided credentials/app first.

---

## 1. Webhook / CRM + Zapier / Make 🟢 (one feature, highest value)

Webhook/CRM and Zapier/Make are the **same mechanism** — an outbound webhook. When a
lead event happens, we POST a JSON payload to a URL the owner pastes. Zapier/Make
expose a "Catch Hook" URL; most CRMs accept an inbound webhook. One build covers both.

**Data model** (additive, migration `15_integration_config`)
- `Tenant.integrationConfig Json?` — `{ webhook: { url, secret }, zapier: { url }, calendly: { url } }`.
  (Or fold config into the existing `integrations` map by upgrading values from
  `boolean` → `{ enabled, ...config }` with back-compat in `readIntegrations`.)

**Backend**
- `services/outboundWebhook.js` → `deliverLeadEvent(tenant, event)`:
  - Guard: integration enabled + a valid `https://` URL.
  - **SSRF protection**: reject non-HTTPS, private/loopback/link-local IPs, and
    metadata hosts (169.254.169.254). Resolve host and re-check before sending.
  - Sign the body: `X-HeyIL-Signature: sha256=HMAC(secret, rawBody)` so the
    receiver can verify authenticity.
  - Timeout ~5s, **best-effort**, non-blocking (never delays a customer reply),
    with a small bounded retry (e.g. 2 attempts) on 5xx/timeout.
- **Fire points** (in `conversationEngine` / lead scoring): `lead.created`,
  `lead.updated` (status/score change), `lead.needs_human`. Payload:
  `{ event, tenant, contact:{name,phone}, conversationId, leadScore, status, lastMessage, ts }`.
- **Endpoints** (`routes/settings.js`):
  - `PUT /api/settings/integrations/webhook` `{ url, secret? }` — save + validate.
  - `POST /api/settings/integrations/webhook/test` — send a sample payload and
    return the receiver's status, so the owner can confirm the wiring live.

**Frontend** — the toggle expands to a small form: URL field, optional secret,
"שליחת בדיקה" button showing success/failure. Mark `ready: true` for `webhook`/`zapier`.

**Effort**: ~1 focused build. Delivers Webhook/CRM **and** Zapier/Make together.

---

## 2. Calendly 🟢 (small)

Simplest real connection: store the owner's Calendly scheduling link; the AI agent
shares it when a customer wants to book, and it can appear on the bio page.

**Backend** — `integrationConfig.calendly.url` (same column as above). Validate it's
a `calendly.com` (or generic https) URL. Expose the link to the agent so a booking
intent replies with it.
**Frontend** — toggle expands to a single URL field. `ready: true` once a link is set.
**Effort**: small (no delivery pipeline; just store + surface).

---

## 3. Gmail / Calendar / Sheets 🟡 (needs Google app — owner's "tech" side)

The OAuth code already exists (`services/googleIntegration.js`, `/api/integrations/
google/connect`, the "חיבור Google" panel). It's gated on two things:

1. **Platform Google OAuth app** — create a Google Cloud project + OAuth client,
   then set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (and the authorized redirect
   URI `<host>/api/integrations/google/callback`) in the server env.
   → flips `config.google.enabled = true`, so these move from "בקרוב" to connectable.
2. **Per-tenant paid add-on** — a super-admin enables the Google add-on for the
   tenant (`POST /api/admin/tenants/:id/google-integration`). This stays a paid gate.

Once (1) is done, the owner clicks **חיבור Google** and authorizes their account —
Gmail send, Calendar events, and Sheets export become live. **No new code needed** on
our side; it's configuration + the add-on grant.

**Blocking dependency**: the Google Cloud OAuth app/credentials (owner-provided).
Sheets export specifically may need a thin `appendLeadRow()` helper once enabled.

---

## Suggested order

1. **Webhook/CRM + Zapier/Make** (🟢, highest value, no external deps).
2. **Calendly** (🟢, quick win).
3. **Gmail/Calendar/Sheets** (🟡) — the moment the Google OAuth credentials exist,
   flip readiness on; wire the Sheets `appendLeadRow` helper.

Each ships independently and flips its slug's `ready` flag in
`routes/settings.js#isIntegrationReady` so the UI reveals it exactly when it works.
