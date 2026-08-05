-- AI activation + daily free-reply quota (opt-in AI + 10 free AI replies/day).
--
-- aiEnabled   : master switch for automatic AI replies. Default true so EXISTING
--               tenants keep working (grandfathered); routes/auth.js register() sets
--               it false for new self-serve signups (opt-in — they turn it on in Settings).
-- aiDailyCount: how many AI replies the tenant has used on aiDailyDate.
-- aiDailyDate : the yyyy-mm-dd (Asia/Jerusalem) the counter belongs to; a new day resets it.
--
-- All three are additive with constant defaults (fast, no table rewrite) and IF NOT
-- EXISTS (idempotent — safe to re-run / safe for `migrate deploy` on Render).
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "aiEnabled"    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "aiDailyCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "aiDailyDate"  TEXT;
