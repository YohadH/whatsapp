-- Per-tenant integration connection config (outbound webhook targets):
--   { webhook: { url, secret }, zapier: { url, secret }, calendly: { url } }
--
-- SAFE / ADDITIVE (AP-T58): one nullable JSONB column on an existing table. No
-- drop, no rename, no backfill. IF NOT EXISTS keeps it idempotent.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "integrationConfig" JSONB;
