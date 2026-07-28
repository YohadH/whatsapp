-- Google OAuth state nonce store (CSRF / server-side tenant binding for Connect).
--
-- SAFE / ADDITIVE (AP-T58): a brand-new table — no existing row is touched, no drop,
-- no rename, no backfill. Reversible by dropping the table. Part of the Google add-on
-- (paired with 5_google_integration); like it, intentionally UNAPPLIED on the live DB
-- until the owner turns the add-on on — the code degrades gracefully (isTableMissing →
-- "feature not live") until then, mirroring the column-drift handling (AP-T71).
--
-- WHY THIS TABLE EXISTS: the public /api/integrations/google/callback route (Google's
-- real top-level browser redirect has NO Authorization header, so it CANNOT sit behind
-- requireAuth) must resolve which tenant a callback belongs to WITHOUT trusting a
-- client-asserted tenantId in the attacker-observable OAuth `state` param. /connect
-- mints a random single-use nonce here bound SERVER-SIDE to the initiating tenant;
-- /callback consumes it (DELETE ... RETURNING → single-use, replay-proof) to resolve
-- the tenant. See services/googleIntegration.js (createOAuthState / consumeOAuthState).
--
-- Uses IF NOT EXISTS so a re-run / out-of-band manual apply is idempotent, matching the
-- repo's hand-applied-migration reality (see the waPin + 5_google_integration notes).
CREATE TABLE IF NOT EXISTS "GoogleOAuthState" (
    "state"     TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoogleOAuthState_pkey" PRIMARY KEY ("state")
);

CREATE INDEX IF NOT EXISTS "GoogleOAuthState_expiresAt_idx" ON "GoogleOAuthState"("expiresAt");

-- FK to Tenant so a deleted tenant's pending states are cleaned up (matches schema.prisma).
DO $$ BEGIN
    ALTER TABLE "GoogleOAuthState"
        ADD CONSTRAINT "GoogleOAuthState_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
