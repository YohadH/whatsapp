#!/usr/bin/env node
// One-shot: apply migration 8_meta_cost_entry_unique to the LIVE DB (SAFE/ADDITIVE —
// adds a UNIQUE index to the empty MetaCostEntry table, no data change) via the
// DIRECT/session connection, then record it in _prisma_migrations so `migrate status`
// stays consistent.
//
// Idempotency guard for Meta's at-least-once status-webhook redelivery
// (whatsapp-agent-metacostentry-has-no-idempotency). Mirrors
// apply-meta-cost-migration.mjs.
//
// Run from backend/:  node scripts/apply-meta-cost-unique-migration.mjs
// Idempotent (IF NOT EXISTS). AP-T58: classified SAFE/ADDITIVE — verified the live
// table had 0 rows / 0 violating groups before authoring, so the UNIQUE index cannot
// fail on existing data.
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIR = path.resolve(__dirname, '../prisma/migrations/8_meta_cost_entry_unique');
const MIGRATION_NAME = '8_meta_cost_entry_unique';

// Derive the DIRECT/session URL from the pooler URL (6543→5432, drop pgbouncer/limit).
function directUrl() {
  let url = process.env.DATABASE_URL || '';
  url = url.replace(':6543', ':5432');
  url = url.replace(/pgbouncer=true&?/g, '').replace(/connection_limit=\d+&?/g, '');
  url = url.replace(/[?&]+$/g, '').replace(/\?&/g, '?');
  return url;
}

const STATEMENTS = [
  `CREATE UNIQUE INDEX IF NOT EXISTS "MetaCostEntry_tenantId_waMessageId_category_key"
     ON "MetaCostEntry"("tenantId", "waMessageId", "category")`,
];

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: directUrl() } } });
  try {
    // Guardrail: refuse to proceed if the table somehow already has true duplicates
    // (would make the CREATE UNIQUE INDEX fail mid-flight). Report them instead.
    const dupes = await prisma.$queryRawUnsafe(`
      SELECT "tenantId", "waMessageId", "category", count(*)::int AS n
      FROM "MetaCostEntry"
      WHERE "waMessageId" IS NOT NULL
      GROUP BY "tenantId", "waMessageId", "category"
      HAVING count(*) > 1
      LIMIT 20`);
    if (dupes.length > 0) {
      console.error('ABORT: existing duplicate MetaCostEntry rows would violate the new unique index:');
      console.error(JSON.stringify(dupes, null, 2));
      process.exit(2);
    }

    for (const stmt of STATEMENTS) {
      await prisma.$executeRawUnsafe(stmt);
    }
    console.log('applied MetaCostEntry unique index (tenantId, waMessageId, category)');

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
      console.log('_prisma_migrations bookkeeping skipped:', e.code || e.message);
    }

    const check = await prisma.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'MetaCostEntry'
         AND indexname = 'MetaCostEntry_tenantId_waMessageId_category_key'`
    );
    console.log('unique index live now:', check.length > 0 ? check[0].indexname : 'MISSING');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('MIGRATION ERROR:', e);
  process.exit(1);
});
