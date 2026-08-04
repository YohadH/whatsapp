-- Mark simulator/test conversations so they can be hidden from the real inbox.
--
-- SAFE / ADDITIVE (AP-T58): one non-null column WITH a default on an existing
-- table. Postgres backfills existing rows to false. IF NOT EXISTS keeps it idempotent.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "isTest" BOOLEAN NOT NULL DEFAULT false;
