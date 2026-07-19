// STEP 3 of the tenant migration — the IRREVERSIBLE finalize step, wrapped in a
// SINGLE transaction so a failure partway rolls the WHOLE thing back instead of
// leaving the schema half-migrated.
//
// What it does (all inside ONE prisma.$transaction):
//   1. SET NOT NULL on tenantId for every gated table (all tables that gained
//      tenantId EXCEPT AdminUser, whose tenantId is nullable by design — a
//      super_admin has tenantId = null).
//   2. DROP the old single-tenant unique constraint "Customer_phone_key"
//      (phone was globally unique; multi-tenant makes phone unique PER tenant).
//   3. ADD the new multi-tenant unique indexes (idempotent, IF NOT EXISTS):
//        Customer          UNIQUE (tenantId, phone)
//        SuppressedNumber  UNIQUE (tenantId, phone)
//        Message           UNIQUE (tenantId, waMessageId)
//      These mirror the @@unique(...) blocks in schema.prisma. CREATE UNIQUE
//      INDEX IF NOT EXISTS is idempotent, so re-running is safe.
//
// HARD PRECONDITIONS (checked before the transaction opens):
//   • MIGRATION_DIRECT_URL set to the DIRECT (5432) connection — never the app
//     pooler DATABASE_URL, never a pgbouncer/6543 URL.
//   • The 0-NULL gate (see migrate-02) passes for every gated table. If any
//     gated table still has a NULL tenantId, this ABORTS before any DDL runs.
//   • Because this step is irreversible, it also refuses to run unless the
//     preflight backup marker file exists (backend/backups/*.dump) OR the
//     operator passes --backup-confirmed (for the Supabase-Dashboard-backup
//     path where no local .dump file is produced).
//
// Usage:
//   node scripts/migrate-03-finalize.mjs                 # dry-run: print the exact SQL, run nothing
//   node scripts/migrate-03-finalize.mjs --live          # run inside a transaction (needs backup + 0-NULL pass)
//   node scripts/migrate-03-finalize.mjs --live --backup-confirmed   # backup was taken via Supabase Dashboard
//
// Exit: 0 = finalize committed (or dry-run printed). 1 = precondition failed / rolled back.
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.resolve(__dirname, '..', 'backups');

// Tables to SET NOT NULL — must match backfill-tenants.mjs minus the by-design nullable AdminUser.
const NOT_NULL_TABLES = [
  'Customer', 'Conversation', 'Message', 'Flow', 'FlowQuestion', 'CustomerAnswer',
  'Link', 'AnalyticsEvent', 'SuppressedNumber', 'BroadcastJob', 'OutboundSend', 'KnowledgeBase',
];
const GATED_FOR_NULLS = NOT_NULL_TABLES; // same set the 0-NULL gate must clear.

// The exact DDL, in order. Each is idempotent-or-guarded so a re-run after a
// partial manual attempt won't hard-error.
function buildStatements() {
  const stmts = [];
  for (const t of NOT_NULL_TABLES) {
    stmts.push(`ALTER TABLE "${t}" ALTER COLUMN "tenantId" SET NOT NULL;`);
  }
  // Drop the legacy global-phone unique constraint if it still exists.
  stmts.push(`ALTER TABLE "Customer" DROP CONSTRAINT IF EXISTS "Customer_phone_key";`);
  // New multi-tenant unique indexes (mirror schema.prisma @@unique blocks).
  stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS "Customer_tenantId_phone_key" ON "Customer" ("tenantId", "phone");`);
  stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS "SuppressedNumber_tenantId_phone_key" ON "SuppressedNumber" ("tenantId", "phone");`);
  stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS "Message_tenantId_waMessageId_key" ON "Message" ("tenantId", "waMessageId");`);
  return stmts;
}

const LIVE = process.argv.includes('--live');
const BACKUP_CONFIRMED = process.argv.includes('--backup-confirmed');
const directUrl = process.env.MIGRATION_DIRECT_URL || '';

function usingPooler(url) {
  return url.includes('pgbouncer=true') || url.includes(':6543');
}
function fail(msg) {
  console.error(`\n❌ FINALIZE ABORTED: ${msg}`);
  process.exit(1);
}
function backupPresent() {
  try {
    return fs.existsSync(BACKUP_DIR) && fs.readdirSync(BACKUP_DIR).some((f) => f.endsWith('.dump'));
  } catch {
    return false;
  }
}

async function main() {
  const stmts = buildStatements();
  console.log('🚧 STEP 3 — finalize (IRREVERSIBLE), wrapped in a single transaction\n');
  console.log('   SQL that will run, in order:\n');
  stmts.forEach((s, i) => console.log(`     ${String(i + 1).padStart(2)}. ${s}`));
  console.log('');

  if (!LIVE) {
    console.log('   DRY-RUN (no --live): printed the SQL above, connected to NOTHING, ran NOTHING.');
    console.log('   Re-run with --live once step 0 (backup) and the 0-NULL gate both pass.');
    return;
  }

  // --- preconditions for a live run ---
  if (!directUrl) fail('MIGRATION_DIRECT_URL is not set. Refusing to run against the app DATABASE_URL.');
  if (usingPooler(directUrl)) fail('MIGRATION_DIRECT_URL is a pooler (6543) URL. DDL needs the DIRECT (5432) URL.');
  if (!BACKUP_CONFIRMED && !backupPresent()) {
    fail('no backup found in backend/backups/*.dump and --backup-confirmed not passed. ' +
         'Take the preflight backup (migrate-01-backup.mjs --live, or the Supabase Dashboard) first.');
  }
  console.log(`   ✓ backup precondition satisfied (${BACKUP_CONFIRMED ? '--backup-confirmed' : 'local .dump present'})`);

  const prisma = new PrismaClient({ datasources: { db: { url: directUrl } }, log: ['error'] });
  try {
    // 0-NULL gate, inline — DDL must not open if any gated table still has NULLs.
    const offenders = [];
    for (const t of GATED_FOR_NULLS) {
      const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${t}" WHERE "tenantId" IS NULL`);
      const n = rows?.[0]?.n ?? 0;
      if (n > 0) offenders.push(`${t} (${n})`);
    }
    if (offenders.length > 0) {
      await prisma.$disconnect();
      fail(`0-NULL gate FAILED — still-NULL tables: ${offenders.join(', ')}. Re-run step 2.`);
    }
    console.log('   ✓ 0-NULL gate passed for all gated tables');

    // The whole DDL as one transaction: any failure rolls everything back.
    console.log('   → opening transaction and applying DDL…');
    await prisma.$transaction(
      stmts.map((sql) => prisma.$executeRawUnsafe(sql))
    );
    console.log('\n✅ FINALIZE COMMITTED — tenantId NOT NULL enforced, Customer_phone_key dropped, ' +
                'new per-tenant unique indexes added. Migration complete.');
  } catch (err) {
    console.error(`\n❌ TRANSACTION ROLLED BACK: ${err.message}`);
    console.error('   The schema is unchanged (all-or-nothing). Investigate, then re-run.');
    await prisma.$disconnect();
    process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
