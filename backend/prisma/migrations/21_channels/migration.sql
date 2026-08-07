-- Multi-channel foundation: let a contact/conversation/message belong to WhatsApp,
-- Instagram, or Messenger. Additive + backfill; existing rows become 'whatsapp'.
--
-- Customer identity generalizes from phone-only to (channel, externalId): externalId is
-- the phone for WhatsApp, or the PSID/IGSID for Messenger/Instagram (who have no phone).
-- phone becomes NULLable (NULL off-WhatsApp) but the old per-tenant phone-unique stays
-- for WhatsApp back-compat (Postgres treats NULLs as distinct, so many NULL-phone IG/FB
-- contacts don't collide).
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "channel"    TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
UPDATE "Customer" SET "externalId" = "phone" WHERE "externalId" IS NULL;
ALTER TABLE "Customer" ALTER COLUMN "phone" DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_tenantId_channel_externalId_key"
  ON "Customer" ("tenantId", "channel", "externalId");

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE "Message"      ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'whatsapp';
