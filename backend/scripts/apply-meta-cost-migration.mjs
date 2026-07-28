#!/usr/bin/env node
// One-shot: apply migration 7_meta_cost_entry to the LIVE DB (SAFE/ADDITIVE — new
// table only, no changes to existing tables/data) via the DIRECT/session connection,
// then record it in _prisma_migrations so `migrate status` stays consistent.
//
// Run from backend/:  node scripts/apply-meta-cost-migration.mjs
// Idempotent (IF NOT EXISTS / constraint guard). AP-T58: classified SAFE/ADDITIVE.
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = path.resolve(__dirname, '../prisma/migrations/7_meta_cost_entry');
const MIGRATION_NAME = '7_meta_cost_entry';

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
  `CREATE TABLE IF NOT EXISTS "MetaCostEntry" (
    "id"                 TEXT NOT NULL,
    "tenantId"           TEXT NOT NULL,
    "conversationId"     TEXT,
    "metaConversationId" TEXT,
    "waMessageId"        TEXT,
    "category"           TEXT NOT NULL,
    "rawCategory"        TEXT,
    "pricingModel"       TEXT,
    "billable"           BOOLEAN NOT NULL DEFAULT true,
    "costEstimateCents"  INTEGER NOT NULL DEFAULT 0,
    "currency"           TEXT NOT NULL DEFAULT 'USD',
    "placeholder"        BOOLEAN NOT NULL DEFAULT true,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaCostEntry_pkey" PRIMARY KEY ("id")
  )`,
  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MetaCostEntry_tenantId_fkey') THEN
       ALTER TABLE "MetaCostEntry"
         ADD CONSTRAINT "MetaCostEntry_tenantId_fkey"
         FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS "MetaCostEntry_tenantId_createdAt_idx" ON "MetaCostEntry"("tenantId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "MetaCostEntry_tenantId_category_idx" ON "MetaCostEntry"("tenantId", "category")`,
];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: directUrl() } } });
  try {
    for (const stmt of STATEMENTS) {
      await prisma.$executeRawUnsafe(stmt);
    }
    console.log('applied MetaCostEntry table + FK + indexes');

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

    const check = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public."MetaCostEntry"')::text AS t`
    );
    console.log('MetaCostEntry live now:', check[0].t);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('MIGRATION ERROR:', e);
  process.exit(1);
});
