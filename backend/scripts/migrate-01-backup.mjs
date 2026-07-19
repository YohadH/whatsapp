// STEP 0 of the tenant migration — PREFLIGHT BACKUP.
//
// Purpose: produce a verified, restorable backup of the live database BEFORE
// the irreversible step-3 DDL (SET NOT NULL, DROP CONSTRAINT) ever runs. If
// this script cannot produce a real backup file, it exits NON-ZERO so the
// runbook stops here — step 3 must never proceed without a confirmed backup.
//
// This script does NOT read the live `DATABASE_URL` (the pgBouncer pooler on
// 6543). A backup must run against the DIRECT connection (5432). To avoid ever
// pointing pg_dump at the wrong endpoint, the URL is taken from an EXPLICIT,
// separate env var — never the app's DATABASE_URL.
//
//   MIGRATION_DIRECT_URL   the direct (5432) Postgres/Supabase connection URL
//                          used ONLY for backup + migration. Keep this out of
//                          the app's .env; pass it inline for the one run.
//
// Usage:
//   node scripts/migrate-01-backup.mjs            # dry-run: validate only, no dump
//   node scripts/migrate-01-backup.mjs --live     # actually run pg_dump
//
// Output: backend/backups/whatsapp-YYYYMMDD-HHMMSS.dump  (custom format, -Fc)
// Verify: the file exists, is > MIN_BYTES, and `pg_restore --list` parses it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = path.resolve(__dirname, '..', 'backups');
const MIN_BYTES = 1024; // a real dump of an 18k-row DB is far larger; catch empty/failed dumps.

const LIVE = process.argv.includes('--live');
const directUrl = process.env.MIGRATION_DIRECT_URL || '';

function die(msg) {
  console.error(`\n❌ BACKUP FAILED: ${msg}`);
  console.error('   Step 3 (SET NOT NULL / DROP CONSTRAINT) MUST NOT proceed without a verified backup.');
  process.exit(1);
}

function haveBinary(bin) {
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

function main() {
  console.log('🗄  Preflight backup — step 0 of the tenant migration\n');

  // Guardrail 1: never let this run against the app's pooler URL.
  if (directUrl.includes('pgbouncer=true') || directUrl.includes(':6543')) {
    die('MIGRATION_DIRECT_URL points at the pgBouncer POOLER (6543). Backups + migrations ' +
        'need the DIRECT connection (5432). Refusing to continue.');
  }

  if (!LIVE) {
    console.log('   DRY-RUN (no --live): validating environment only, NOT connecting to any DB.');
    console.log(`   • pg_dump available:   ${haveBinary('pg_dump') ? 'yes' : 'NO'}`);
    console.log(`   • pg_restore available: ${haveBinary('pg_restore') ? 'yes' : 'NO'}`);
    console.log(`   • MIGRATION_DIRECT_URL set: ${directUrl ? 'yes (5432/direct — good)' : 'NO'}`);
    console.log(`   • backup dir:          ${BACKUP_DIR}`);
    console.log('\n   To actually take the backup, re-run with --live and MIGRATION_DIRECT_URL set.');
    console.log('   If pg_dump is unavailable, use the Supabase Dashboard backup instead');
    console.log('   (Project → Database → Backups → "Download backup" / enable PITR), and record');
    console.log('   the backup id/time in MIGRATION-RUNBOOK.md before proceeding to step 2/3.');
    return;
  }

  // --- LIVE path ---
  if (!directUrl) die('MIGRATION_DIRECT_URL is not set. Refusing to guess the connection URL.');
  if (!haveBinary('pg_dump')) {
    die('pg_dump is not installed in this environment. Take the backup via the Supabase ' +
        'Dashboard (Project → Database → Backups) instead, record its id in the runbook, ' +
        'then skip this script and continue to step 2.');
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15); // YYYYMMDDHHMMSS-ish
  const outFile = path.join(BACKUP_DIR, `whatsapp-${stamp}.dump`);

  console.log(`   Running pg_dump (custom format) → ${outFile}`);
  const dump = spawnSync('pg_dump', ['-Fc', '--no-owner', '--no-privileges', '-f', outFile, directUrl], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (dump.status !== 0) die(`pg_dump exited ${dump.status}. No usable backup produced.`);

  // Verify: file exists and is non-trivial.
  if (!fs.existsSync(outFile)) die('pg_dump reported success but the output file is missing.');
  const size = fs.statSync(outFile).size;
  if (size < MIN_BYTES) die(`backup file is only ${size} bytes (< ${MIN_BYTES}); treating as failed.`);

  // Verify: the dump is a parseable archive (pg_restore --list must succeed).
  if (haveBinary('pg_restore')) {
    const listing = spawnSync('pg_restore', ['--list', outFile], { encoding: 'utf8' });
    if (listing.status !== 0) die('pg_restore --list could not parse the dump — it is corrupt.');
    const tocLines = (listing.stdout || '').split('\n').filter((l) => l.includes('TABLE DATA')).length;
    console.log(`   ✓ pg_restore parsed the archive (${tocLines} TABLE DATA entries in the TOC)`);
  } else {
    console.warn('   ⚠ pg_restore not available — could not verify archive integrity beyond size.');
  }

  console.log(`\n✅ BACKUP OK: ${outFile} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  console.log('   Record this path/time in MIGRATION-RUNBOOK.md, then proceed to step 2 (backfill).');
}

main();
