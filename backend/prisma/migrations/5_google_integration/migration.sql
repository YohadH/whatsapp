-- Google integration (Gmail + Calendar) — paid per-tenant add-on, OFF by default.
--
-- SAFE / ADDITIVE / NULLABLE-safe (AP-T58): adds three columns to Tenant, all
-- either NULLABLE or with a DEFAULT, so applying this on the live production DB
-- does NOT touch existing rows' data and cannot break existing queries. No drops,
-- no renames, no NOT-NULL backfill. Reversible by dropping the three columns.
--
--   googleIntegrationEnabled — per-tenant feature flag; DEFAULT false → every
--                              existing tenant stays OFF (add-on not purchased).
--   googleTokensEnc          — AES-256-GCM-encrypted OAuth token set (nullable).
--   googleConnectedEmail     — the connected Google account (nullable).
--
-- Uses IF NOT EXISTS so a re-run (or an out-of-band manual apply) is idempotent,
-- matching the repo's existing hand-applied-migration reality (see waPin note).
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "googleIntegrationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "googleTokensEnc" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "googleConnectedEmail" TEXT;
