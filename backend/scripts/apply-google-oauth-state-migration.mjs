#!/usr/bin/env node
// One-shot: apply migration 6_google_oauth_state to the LIVE DB (SAFE/ADDITIVE — new
// table only, no changes to existing tables/data) via the DIRECT/session connection,
// then record it in _prisma_migrations so `migrate status` stays consistent.
//
// Run from backend/:  node scripts/apply-google-oauth-state-migration.mjs
// Idempotent (IF NOT EXISTS / constraint guard). AP-T58: classified SAFE/ADDITIVE.
// Mirrors scripts/apply-meta-cost-migration.mjs (the established hand-apply pattern).
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = path.resolve(__dirname, '../prisma/migrations/6_google_oauth_state');
const MIGRATION_NAME = '6_google_oauth_state';

// Derive the DIRECT/session URL from the pooler URL (6543→5432, drop pgbouncer/limit).
function directUrl() {
  let url = process.env.DATABASE_URL || '';
  url = url.replace(':6543', ':5432');
  url = url.replace(/pgbouncer=true&?/g, '').replace(/connection_limit=\d+&?/g, '');
  url = url.replace(/[?&]+$/g, '').replace(/\?&/g, '?');
  return url;
}

// The migration SQL, split into individually-executable statements. We cannot split
// the file naively on ';' because the FK guard is a DO $$ ... $$; block that contains ';'.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "GoogleOAuthState" (
    "state"     TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoogleOAuthState_pkey" PRIMARY KEY ("state")
  )`,
  `CREATE INDEX IF NOT EXISTS "GoogleOAuthState_expiresAt_idx" ON "GoogleOAuthState"("expiresAt")`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'GoogleOAuthState_tenantId_fkey') THEN
       ALTER TABLE "GoogleOAuthState"
         ADD CONSTRAINT "GoogleOAuthState_tenantId_fkey"
         FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: directUrl() } } });
  try {
    for (const stmt of STATEMENTS) {
      await prisma.$executeRawUnsafe(stmt);
    }
    console.log('applied GoogleOAuthState table + index + FK');

    // Record in _prisma_migrations (if that bookkeeping table exists here).
    try {
      const sqlText = fs.readFileSync(path.join(MIGRATION_DIR, 'migration.sql'), 'utf8');
      const checksum = crypto.createHash('sha256').update(sqlText).digest('hex');
      const already = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM "_prisma_migrations" WHERE migration_name = $1 LIMIT 1`,
        MIGRATION_NAME
      );
      if (!already || already.length === 0) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "_prisma_migrations"
             (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
           VALUES ($1, $2, $3, now(), now(), 1)`,
          crypto.randomUUID(),
          checksum,
          MIGRATION_NAME
        );
        console.log('recorded in _prisma_migrations');
      } else {
        console.log('_prisma_migrations already has this migration');
      }
    } catch (e) {
      // _prisma_migrations may not exist on this DB (P3005 history) — non-fatal.
      console.log('_prisma_migrations bookkeeping skipped:', e.code || e.message);
    }

    // Verify: table genuinely exists live + is recorded.
    const check = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public."GoogleOAuthState"')::text AS t`
    );
    console.log('GoogleOAuthState live now:', check[0].t);

    const cols = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='GoogleOAuthState' ORDER BY ordinal_position`
    );
    console.log('columns:', cols.map((c) => c.column_name).join(', '));

    const rec = await prisma.$queryRawUnsafe(
      `SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE migration_name = $1`,
      MIGRATION_NAME
    );
    console.log('_prisma_migrations row:', JSON.stringify(rec));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('MIGRATION ERROR:', e);
  process.exit(1);
});
