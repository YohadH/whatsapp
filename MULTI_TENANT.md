# Multi-tenant architecture

One deployment serves many businesses. Each business is a **Tenant** with its own
WhatsApp credentials, branding, plan, and fully isolated data.

## Roles

- **super_admin** — the platform owner (you). `tenantId = null`. Manages all
  tenants via `/api/admin/*`. To use a tenant's dashboards, acts "as" that tenant
  by sending an `X-Tenant-Id` header.
- **admin / agent** — a tenant user. Locked to their own `tenantId` (carried in
  the JWT); can never see another tenant's data.

## How isolation works

- Every domain table has a `tenantId` column (`prisma/schema.prisma`).
- `requireAuth` puts the JWT (`{ sub, role, tenantId }`) on `req.user`;
  `withTenant` (`middleware/tenant.js`) resolves the active tenant and sets
  `req.tenantId`. A tenant user's `tenantId` is authoritative; a super_admin
  supplies `X-Tenant-Id`.
- Every route query is filtered by `req.tenantId`. By-id reads use
  `findFirst({ id, tenantId })`; by-id writes use `updateMany/deleteMany({ id,
  tenantId })` — so a guessed id from another tenant returns nothing (no IDOR).
- `Customer` and `SuppressedNumber` are unique on `[tenantId, phone]`, so the same
  phone can belong to two tenants independently.
- Verified by the isolation test (see “Testing” below).

## WhatsApp credentials & webhook routing

- Each tenant stores `waPhoneNumberId`, `waBusinessAccountId`, `waVerifyToken`,
  and `waTokenEnc` — the access token **encrypted at rest** (AES-256-GCM,
  `lib/crypto.js`, key from `CREDENTIALS_ENC_KEY`).
- All tenants share one webhook URL. Inbound messages are routed to a tenant by
  the Meta `phone_number_id` in the payload (`value.metadata.phone_number_id`).
- Webhook signatures are verified against `WHATSAPP_APP_SECRET`
  (`X-Hub-Signature-256`). The common setup is one Meta "tech provider" app
  (one app secret, one webhook) onboarding many client WABAs.

## Plans & limits (`lib/plans.js`)

`trial | starter | pro` set each tenant's `dailyBroadcastCap` (rolling-24h
business-initiated cap) and `monthlyMessageLimit`. Assigning a plan sets the
entitlements the app enforces. **Payment collection (Stripe) is not wired** —
hook a provider's webhook to flip `tenant.plan` on payment.

## Onboarding a new customer (super-admin)

```http
POST /api/admin/tenants
{
  "name": "Acme Studio",
  "slug": "acme",
  "plan": "starter",
  "waPhoneNumberId": "1234567890",
  "waBusinessAccountId": "9876543210",
  "waToken": "EAAG...",              // stored encrypted
  "admin": { "email": "owner@acme.com", "password": "temp-pass" }
}
```

Then point that WABA's webhook at `https://<host>/api/whatsapp/webhook`. Verify
the token live with `POST /api/admin/tenants/:id/verify-credentials`. The tenant
admin logs in and is prompted to reset their password.

## Migrating the existing single-tenant database

The new schema requires `tenantId` on every row, so migrate deliberately — do
**not** point `prisma db push` at a populated production DB (it will try to add a
NOT NULL column to existing rows). Recommended order against a staging copy:

1. Add the `Tenant` table + **nullable** `tenantId` columns.
2. `node scripts/backfill-tenants.mjs` — creates a "default" tenant from the env
   WhatsApp creds and assigns every existing row to it.
3. Set the `tenantId` columns `NOT NULL` and add the unique/index constraints
   (the shape in `prisma/migrations/0_init`).

For a **fresh** SaaS database, just run `prisma migrate deploy` then `db:seed`.

## Required environment

`CREDENTIALS_ENC_KEY` (32-byte hex), `WHATSAPP_APP_SECRET`, `JWT_SECRET`,
`DATABASE_URL`, and the master `WHATSAPP_*` fallback creds. In production the
server refuses to boot if `JWT_SECRET` or `CREDENTIALS_ENC_KEY` is missing or
left at the dev default (`config/index.js`).

## Testing

- `mt-unit` — crypto round-trip, credential decryption, webhook parsing/HMAC,
  opt-out, plans (no DB).
- `mt-http-gates` — auth/signature/rate-limit gates on a booted app (no DB).
- `mt-isolation` — real cross-tenant isolation, IDOR, cascade, per-tenant
  uniqueness, run against a throwaway Postgres schema.

## Onboarding at scale — Meta Embedded Signup

Instead of pasting each client's token by hand, the super-admin console has a
one-click **Connect WhatsApp** button (tenant edit modal) that runs Meta's
Embedded Signup:

1. Frontend loads the Facebook JS SDK and launches `FB.login` with your
   `META_CONFIG_ID` (`lib/fbEmbeddedSignup.js`); the customer picks/creates their
   WABA + number. The flow returns an auth `code` + the `phone_number_id`/`waba_id`.
2. `POST /api/admin/tenants/:id/connect-whatsapp` exchanges the code for a token,
   subscribes our app to the WABA's webhooks, registers the number (best-effort),
   and stores the encrypted token (`services/embeddedSignup.js`).

Requires `META_APP_ID`, `META_CONFIG_ID`, and the app secret
(`META_APP_SECRET`, falls back to `WHATSAPP_APP_SECRET`). If unset, the button is
hidden and manual credential entry still works.

## Operations

- **Monthly usage reset** — `services/usageReset.js` zeroes each tenant's
  `messagesThisPeriod` once its window (`USAGE_PERIOD_DAYS`, default 30) elapses;
  scheduled at boot + every 6h from `server.js`.
- **Error tracking** — Sentry (`lib/observability.js`), a no-op unless
  `SENTRY_DSN` is set. Captures 5xx from the error handler plus
  unhandledRejection / uncaughtException.

## Not yet built (follow-ups)

- **Frontend super-admin console** — done: tenant CRUD, credential verify,
  admin management, act-as-tenant, and Embedded Signup connect.
- **Stripe billing** — plans/caps + usage window exist and are enforced/reset;
  payment collection (checkout + webhook flipping `tenant.plan`) must be wired.
- **Full Sentry tracing** — errors are captured; request/performance tracing
  needs Sentry initialized via a `--import` bootstrap before Express loads.
- **Per-tenant Meta app secrets** — current model assumes one shared tech-provider
  app secret for webhook verification.
