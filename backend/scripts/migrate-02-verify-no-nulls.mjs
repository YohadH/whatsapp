// STEP 2.5 of the tenant migration — "0-NULL VERIFY" GATE.
//
// Runs AFTER backfill-tenants.mjs (step 2) and BEFORE the irreversible step-3
// DDL (SET NOT NULL / DROP CONSTRAINT). For every table that gained a tenantId
// column it counts the rows where `tenantId IS NULL`. If ANY table has even one
// NULL, this exits NON-ZERO and names the offending table(s) — because running
// `ALTER ... SET NOT NULL` while a NULL exists would fail (or, worse, a partial
// migration would leave the schema half-applied). This is the safety gate the
// owner asked for: step 3 must not run unless every table reports 0 NULLs.
//
// Same connection discipline as the backup script: it uses an EXPLICIT
// MIGRATION_DIRECT_URL (the direct 5432 URL), NEVER the app's pooler
// DATABASE_URL, and refuses a pooler URL. Default is a dry-run that only lists
// the tables it WOULD check; pass --live to actually query the DB.
//
// Usage:
//   node scripts/migrate-02-verify-no-nulls.mjs          # dry-run: list tables, no query
//   node scripts/migrate-02-verify-no-nulls.mjs --live   # query each table's NULL count
//
// Exit code: 0 = all tables have 0 NULL tenantId (safe to run step 3).
//            1 = at least one table still has NULLs, OR a query/connection error.
import { PrismaClient } from '@prisma/client';

// Must stay in sync with the TABLES list in backfill-tenants.mjs.
const TABLES = [
  'AdminUser',
  'Customer',
  'Conversation',
  'Message',
  'Flow',
  'FlowQuestion',
  'CustomerAnswer',
  'Link',
  'AnalyticsEvent',
  'SuppressedNumber',
  'BroadcastJob',
  'OutboundSend',
  'KnowledgeBase',
];

// AdminUser.tenantId is intentionally NULLABLE forever: a super_admin (platform
// owner) has tenantId = null by design (schema.prisma model AdminUser). So it is
// NOT eligible for SET NOT NULL and NULLs there are expected — exclude it from
// the gate. Every OTHER table must be fully backfilled.
const NULLABLE_BY_DESIGN = new Set(['AdminUser']);

const LIVE = process.argv.includes('--live');
const directUrl = process.env.MIGRATION_DIRECT_URL || '';

function usingPooler(url) {
  return url.includes('pgbouncer=true') || url.includes(':6543');
}

async function main() {
  console.log('🔎 0-NULL verify gate — must pass before step 3 (SET NOT NULL / DROP CONSTRAINT)\n');
  const gated = TABLES.filter((t) => !NULLABLE_BY_DESIGN.has(t));
  console.log(`   Tables gated for 0 NULL tenantId (${gated.length}): ${gated.join(', ')}`);
  console.log(`   Excluded (nullable by design): ${[...NULLABLE_BY_DESIGN].join(', ')}\n`);

  if (!LIVE) {
    console.log('   DRY-RUN (no --live): not connecting to any DB. Re-run with --live to query counts.');
    return;
  }

  if (!directUrl) {
    console.error('❌ MIGRATION_DIRECT_URL is not set. Refusing to run against the app DATABASE_URL.');
    process.exit(1);
  }
  if (usingPooler(directUrl)) {
    console.error('❌ MIGRATION_DIRECT_URL points at the pgBouncer POOLER (6543). Use the DIRECT (5432) URL.');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: directUrl } }, log: ['error'] });
  const offenders = [];
  try {
    for (const table of gated) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "tenantId" IS NULL`
      );
      const n = rows?.[0]?.n ?? 0;
      const mark = n === 0 ? '✓' : '✗';
      console.log(`   ${mark} ${table}: ${n} NULL tenantId row(s)`);
      if (n > 0) offenders.push(`${table} (${n})`);
    }
  } catch (err) {
    console.error(`\n❌ VERIFY ERROR while querying: ${err.message}`);
    await prisma.$disconnect();
    process.exit(1);
  }
  await prisma.$disconnect();

  if (offenders.length > 0) {
    console.error(`\n❌ 0-NULL GATE FAILED. Still-NULL tables: ${offenders.join(', ')}.`);
    console.error('   Re-run step 2 (backfill-tenants.mjs) and investigate before touching step 3.');
    process.exit(1);
  }
  console.log('\n✅ 0-NULL GATE PASSED — every gated table has 0 NULL tenantId. Safe to run step 3.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
