-- Stripe Billing wiring (WA-DEV-STRIPE): replaces PayPlus as the live payment
-- gateway. Adds subscription tracking to Tenant so the recurring HeyIL plan
-- (Stripe Billing, price_...) can be linked back to a tenant from webhooks
-- (checkout.session.completed sets these; invoice.paid keeps subscriptionStatus
-- in sync on renewal). See services/payments.js + routes/payments.js.
--
-- SAFE / ADDITIVE (AP-T58): three NULLABLE columns on an existing table, no
-- drop, no rename, no backfill, no change to existing columns. Old deployed
-- code (which doesn't know these columns) is unaffected — Prisma's generated
-- client only selects columns known at its own generate-time. Reversible by
-- dropping the columns. IF NOT EXISTS keeps it idempotent (this DB has had
-- out-of-band DDL applied before — see waPin / BUG-WA-002 notes).
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "subscriptionStatus" TEXT;
