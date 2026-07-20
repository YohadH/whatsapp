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

// Stale-backup guard: a `.dump` from days ago is NOT a valid safety net for an
// irreversible migration — the DB will have drifted since. Reject any dump older
// than this. Override with MIGRATION_MAX_BACKUP_AGE_HOURS if a longer window is
// genuinely intended (must be a positive number).
const MAX_BACKUP_AGE_HOURS = (() => {
  const raw = process.env.MIGRATION_MAX_BACKUP_AGE_HOURS;
  const n = raw != null ? Number(raw) : 12;
  return Number.isFinite(n) && n > 0 ? n : 12;
})();
const MAX_BACKUP_AGE_MS = MAX_BACKUP_AGE_HOURS * 3600 * 1000;

// Transaction / lock timeouts (ms) so DDL against live Supabase can never hang
// indefinitely waiting on a lock, and the whole batch has a hard ceiling.
const TXN_TIMEOUT_MS = Number(process.env.MIGRATION_TXN_TIMEOUT_MS) || 120000; // 2 min hard cap on the txn
const TXN_MAX_WAIT_MS = Number(process.env.MIGRATION_TXN_MAX_WAIT_MS) || 10000; // wait to acquire a txn slot
const LOCK_TIMEOUT_MS = Number(process.env.MIGRATION_LOCK_TIMEOUT_MS) || 15000; // fail if a table lock isn't grabbed
const STMT_TIMEOUT_MS = Number(process.env.MIGRATION_STMT_TIMEOUT_MS) || 110000; // per-statement ceiling (< txn)

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
// For the Supabase-Dashboard-backup path there is no local .dump to age-check,
// so the operator must state WHEN that backup was taken so freshness is still
// enforced: --backup-taken-at=2026-07-20T09:00:00Z (ISO 8601).
const backupTakenAtArg = (process.argv.find((a) => a.startsWith('--backup-taken-at=')) || '').split('=')[1] || '';
const directUrl = process.env.MIGRATION_DIRECT_URL || '';

function usingPooler(url) {
  return url.includes('pgbouncer=true') || url.includes(':6543');
}
function fail(msg) {
  console.error(`\n❌ FINALIZE ABORTED: ${msg}`);
  process.exit(1);
}
// Returns the FRESHEST local .dump, or null. A dump older than MAX_BACKUP_AGE_MS
// is treated as absent — a stale backup is not a valid rollback net for an
// irreversible migration (stale-backup guard).
function freshestBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return null;
    const dumps = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.dump'))
      .map((f) => {
        const full = path.join(BACKUP_DIR, f);
        return { file: f, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return dumps[0] || null;
  } catch {
    return null;
  }
}

// { ok, reason, ageHours, file } — ok=true only if a .dump exists AND is fresh.
function backupState() {
  const newest = freshestBackup();
  if (!newest) return { ok: false, reason: 'no .dump file present' };
  const ageMs = Date.now() - newest.mtimeMs;
  const ageHours = ageMs / 3600 / 1000;
  if (ageMs > MAX_BACKUP_AGE_MS) {
    return {
      ok: false,
      ageHours,
      file: newest.file,
      reason: `newest backup ${newest.file} is ${ageHours.toFixed(1)}h old (> ${MAX_BACKUP_AGE_HOURS}h max) — STALE`,
    };
  }
  return { ok: true, ageHours, file: newest.file };
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

  // Backup precondition — with a STALE-BACKUP guard (finding 3). A .dump must
  // exist AND be fresh; an old dump is not a valid rollback net.
  if (BACKUP_CONFIRMED) {
    // Dashboard-backup path: no local .dump to age-check, so the operator must
    // state when it was taken, and we age-check THAT.
    if (!backupTakenAtArg) {
      fail('--backup-confirmed requires --backup-taken-at=<ISO8601> so backup freshness can be verified ' +
           `(must be within ${MAX_BACKUP_AGE_HOURS}h). Example: --backup-taken-at=2026-07-20T09:00:00Z`);
    }
    const takenMs = Date.parse(backupTakenAtArg);
    if (Number.isNaN(takenMs)) fail(`--backup-taken-at is not a valid ISO 8601 timestamp: "${backupTakenAtArg}".`);
    const ageMs = Date.now() - takenMs;
    if (ageMs < 0) fail(`--backup-taken-at is in the future ("${backupTakenAtArg}"). Refusing.`);
    if (ageMs > MAX_BACKUP_AGE_MS) {
      fail(`confirmed backup is ${(ageMs / 3600000).toFixed(1)}h old (> ${MAX_BACKUP_AGE_HOURS}h max) — STALE. ` +
           'Take a fresh backup before this irreversible step.');
    }
    console.log(`   ✓ backup precondition satisfied (--backup-confirmed, ${(ageMs / 3600000).toFixed(1)}h old)`);
  } else {
    const b = backupState();
    if (!b.ok) {
      fail(`backup precondition failed — ${b.reason}. Take a fresh preflight backup ` +
           '(migrate-01-backup.mjs --live, or the Supabase Dashboard + --backup-confirmed --backup-taken-at=<ISO>).');
    }
    console.log(`   ✓ backup precondition satisfied (local ${b.file}, ${b.ageHours.toFixed(1)}h old — fresh)`);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: directUrl } }, log: ['error'] });
  try {
    // TOCTOU FIX (finding 4): the 0-NULL check and the SET NOT NULL DDL must be
    // ONE atomic unit. If we counted NULLs, then ran the DDL in a separate step,
    // the live app (still serving traffic) could INSERT a NULL-tenantId row in
    // the gap — the count would be stale and the DDL could fail mid-way. So the
    // gate runs INSIDE the same interactive transaction, immediately before the
    // DDL. Within the txn we first set lock_timeout + statement_timeout (finding
    // 2): the SET NOT NULL takes an ACCESS EXCLUSIVE lock, so any concurrent
    // writer is either blocked behind our lock (its NULL insert can't sneak in
    // before validation) or our lock acquisition fails fast instead of hanging.
    console.log('   → opening transaction (0-NULL gate + DDL, atomic)…');
    await prisma.$transaction(
      async (tx) => {
        // Bound every statement in this session so nothing hangs on live Supabase.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${STMT_TIMEOUT_MS}ms'`);

        // 0-NULL gate — INSIDE the txn, so it is time-of-use consistent with the DDL.
        const offenders = [];
        for (const t of GATED_FOR_NULLS) {
          const rows = await tx.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${t}" WHERE "tenantId" IS NULL`);
          const n = rows?.[0]?.n ?? 0;
          if (n > 0) offenders.push(`${t} (${n})`);
        }
        if (offenders.length > 0) {
          // Throwing rolls the txn back (no DDL applied) and is caught below.
          throw new Error(`0-NULL gate FAILED inside txn — still-NULL tables: ${offenders.join(', ')}. Re-run step 2.`);
        }
        console.log('   ✓ 0-NULL gate passed (inside txn) for all gated tables');

        console.log('   → applying DDL…');
        for (const sql of stmts) {
          await tx.$executeRawUnsafe(sql);
        }
      },
      { timeout: TXN_TIMEOUT_MS, maxWait: TXN_MAX_WAIT_MS }
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
