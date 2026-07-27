-- Persist the Meta 2-step-verification PIN per tenant so it is reused on every
-- /register call. Meta requires the SAME PIN on re-registration of an already-
-- registered number; a fresh random PIN on a second admin save breaks it.
-- Nullable plaintext (not a secret like waTokenEnc). See services/whatsapp.js.
ALTER TABLE "Tenant" ADD COLUMN "waPin" TEXT;
