-- Receipts-by-WhatsApp (services/receipts.js): the owner photographs a receipt
-- into their own business number; the webhook books it as an Expense. Adds the
-- per-tenant owner-recognition phone and the Expense table itself.
--
-- SAFE / ADDITIVE (AP-T58): one NULLABLE column on Tenant + one brand-new table,
-- no drop, no rename, no backfill, no change to existing columns. Old deployed
-- code is unaffected (Prisma clients select only generate-time-known columns).
-- IF NOT EXISTS keeps it idempotent — this change was first applied to the dev
-- DB via `prisma db push` (02/08), so the live apply must tolerate re-runs.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "ownerPhone" TEXT;

CREATE TABLE IF NOT EXISTS "Expense" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageWaId" TEXT,
    "mediaId" TEXT,
    "imagePath" TEXT,
    "vendor" TEXT,
    "total" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "vatAmount" DECIMAL(12,2),
    "expenseDate" TIMESTAMP(3),
    "category" TEXT,
    "summary" TEXT,
    "status" TEXT NOT NULL DEFAULT 'parsed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Expense_tenantId_messageWaId_key" ON "Expense"("tenantId", "messageWaId");
CREATE INDEX IF NOT EXISTS "Expense_tenantId_expenseDate_idx" ON "Expense"("tenantId", "expenseDate");
CREATE INDEX IF NOT EXISTS "Expense_tenantId_createdAt_idx" ON "Expense"("tenantId", "createdAt");

-- FK added conditionally (idempotent — no IF NOT EXISTS for constraints in PG).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Expense_tenantId_fkey'
    ) THEN
        ALTER TABLE "Expense" ADD CONSTRAINT "Expense_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
