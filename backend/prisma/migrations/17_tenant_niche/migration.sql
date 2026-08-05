-- Business vertical chosen at signup (drives the seeded niche starter pack + the
-- per-niche integration recommendations shown in Settings).
--
-- SAFE / ADDITIVE (AP-T58): one nullable column on an existing table. No drop,
-- no rename, no backfill. IF NOT EXISTS keeps it idempotent.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "niche" TEXT;
