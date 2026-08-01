-- Owner-toggled integrations map (Gmail, Calendar, Sheets, Webhook/CRM, …).
-- Additive & nullable: safe to apply ahead of / independently of the app rollout.
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "integrations" JSONB;
