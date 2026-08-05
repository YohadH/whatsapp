-- Platform-level config singleton: the CENTRAL local-Claude pipeline that answers
-- every opted-in customer (one URL + signing secret, set once by the platform owner).
-- Single row, id='singleton'. Additive + IF NOT EXISTS (idempotent, safe for migrate deploy).
CREATE TABLE IF NOT EXISTS "PlatformConfig" (
  "id"             TEXT NOT NULL DEFAULT 'singleton',
  "replyEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "replyUrl"       TEXT,
  "replySecretEnc" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);
