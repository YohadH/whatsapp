-- Phase-1/3 roadmap batch (03/08): saved recipient lists (דיוור), structured
-- business hours on the knowledge base, dormant tenant BYO-AI provider fields,
-- and a campaign label on broadcast jobs.
--
-- SAFE / ADDITIVE (AP-T58): nullable columns on existing tables + two brand-new
-- tables. No drop, no rename, no backfill. IF NOT EXISTS keeps every statement
-- idempotent (first applied to dev via prisma db push).
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "aiProvider" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "aiApiKeyEnc" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "aiModel" TEXT;
ALTER TABLE "KnowledgeBase" ADD COLUMN IF NOT EXISTS "businessHours" JSONB;
ALTER TABLE "BroadcastJob" ADD COLUMN IF NOT EXISTS "label" TEXT;

CREATE TABLE IF NOT EXISTS "RecipientList" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientList_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RecipientList_tenantId_updatedAt_idx" ON "RecipientList"("tenantId", "updatedAt");

CREATE TABLE IF NOT EXISTS "RecipientListMember" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "vars" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "RecipientListMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "RecipientListMember_listId_phone_key" ON "RecipientListMember"("listId", "phone");
CREATE INDEX IF NOT EXISTS "RecipientListMember_listId_idx" ON "RecipientListMember"("listId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RecipientList_tenantId_fkey') THEN
        ALTER TABLE "RecipientList" ADD CONSTRAINT "RecipientList_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'RecipientListMember_listId_fkey') THEN
        ALTER TABLE "RecipientListMember" ADD CONSTRAINT "RecipientListMember_listId_fkey"
            FOREIGN KEY ("listId") REFERENCES "RecipientList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
