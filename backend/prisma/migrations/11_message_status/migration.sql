-- Outbound delivery state (sent | delivered | read | failed), advanced by Meta's
-- status webhooks. Additive & nullable — safe to apply ahead of the app rollout.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "status" TEXT;
