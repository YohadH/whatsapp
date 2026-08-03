-- Business logo/avatar on the tenant (Settings → פרטי העסק). The owner uploads an
-- image via /api/uploads/image and its public URL is stored here.
--
-- SAFE / ADDITIVE (AP-T58): one nullable column on an existing table. No drop,
-- no rename, no backfill. IF NOT EXISTS keeps it idempotent.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "logoUrl" TEXT;
