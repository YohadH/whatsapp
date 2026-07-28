-- Per-tenant Meta (WhatsApp) conversation-cost ledger (system-gap-analysis §2.7 + §4 /
-- WA-DEV-META-COST). One row per billable Meta conversation event captured from the
-- inbound webhook's `statuses[]` pricing object. This is the COST side of the margin
-- equation, parallel to CreditTransaction (revenue). See services/metaCost.js.
--
-- SAFE / ADDITIVE (AP-T58): creates a NEW table + indexes only. No changes to any
-- existing table, no drops, no renames, no backfill. Applying it on the live
-- production DB cannot touch existing rows or break existing queries. Reversible by
-- dropping the table. IF NOT EXISTS guards keep it idempotent (this DB has had
-- out-of-band DDL applied — see waPin / BUG-WA-002 notes).
CREATE TABLE IF NOT EXISTS "MetaCostEntry" (
  "id"                 TEXT NOT NULL,
  "tenantId"           TEXT NOT NULL,
  "conversationId"     TEXT,
  "metaConversationId" TEXT,
  "waMessageId"        TEXT,
  "category"           TEXT NOT NULL,
  "rawCategory"        TEXT,
  "pricingModel"       TEXT,
  "billable"           BOOLEAN NOT NULL DEFAULT true,
  "costEstimateCents"  INTEGER NOT NULL DEFAULT 0,
  "currency"           TEXT NOT NULL DEFAULT 'USD',
  "placeholder"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MetaCostEntry_pkey" PRIMARY KEY ("id")
);

-- FK to Tenant with ON DELETE CASCADE (matches every other domain table). Guarded so a
-- re-run does not error on an already-present constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'MetaCostEntry_tenantId_fkey'
  ) THEN
    ALTER TABLE "MetaCostEntry"
      ADD CONSTRAINT "MetaCostEntry_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "MetaCostEntry_tenantId_createdAt_idx" ON "MetaCostEntry"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "MetaCostEntry_tenantId_category_idx" ON "MetaCostEntry"("tenantId", "category");
