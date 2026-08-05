-- Scoped API keys — connect an external agent to a narrow, revocable slice of the
-- HeyIL API (ops / data-sync). Only the SHA-256 hash of the key is stored.
--
-- SAFE / ADDITIVE (AP-T58): one brand-new table + its indexes. No change to any
-- existing table. IF NOT EXISTS keeps every statement idempotent.
CREATE TABLE IF NOT EXISTS "ApiKey" (
    "id"         TEXT NOT NULL,
    "tenantId"   TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "prefix"     TEXT NOT NULL,
    "keyHash"    TEXT NOT NULL,
    "scopes"     JSONB NOT NULL DEFAULT '[]',
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt"  TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX IF NOT EXISTS "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApiKey_tenantId_fkey') THEN
        ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
