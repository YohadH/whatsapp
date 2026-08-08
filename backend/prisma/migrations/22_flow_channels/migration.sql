-- Channel scope for automations: which channels a Flow runs on. null/empty = all
-- channels; else a subset of ['whatsapp','instagram','messenger']. Additive.
ALTER TABLE "Flow" ADD COLUMN IF NOT EXISTS "channels" JSONB;
