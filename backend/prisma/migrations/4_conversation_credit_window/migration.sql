-- AI-credit billing unit = a rolling 24-HOUR CONVERSATION window (1 credit = one
-- handled conversation within 24h, NOT one credit per AI message). Track the currently
-- open window per conversation; chargeAiCredit() charges only when an AI reply OPENS a
-- new window (windowExpiresAt IS NULL OR windowExpiresAt <= now). See lib/credits.js
-- and CREDITS_DESIGN.md.
--
-- SAFE / ADDITIVE: adds two NULLABLE columns only. No backfill, no NOT NULL, no drops,
-- no constraint changes. Existing rows get NULL windows (= no open window) so the FIRST
-- AI reply after this deploy opens a window and charges once, as intended. IF NOT EXISTS
-- guards keep it idempotent (this DB has had out-of-band DDL applied — see waPin/BUG-WA-002).
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "windowStartedAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "windowExpiresAt" TIMESTAMP(3);

-- The conditional window-open gate filters on windowExpiresAt per conversation id; the
-- id PK already covers the equality, this index helps any window-expiry sweeps/reporting.
CREATE INDEX IF NOT EXISTS "Conversation_windowExpiresAt_idx" ON "Conversation"("windowExpiresAt");
