#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Schema ⇄ migration parity gate  (schema-drift hardening — BUG-WA-002 class)
//
// FAILS (exit 1) when a change modifies `backend/prisma/schema.prisma` but adds
// NO new migration directory under `backend/prisma/migrations/`. This is the
// structural counterpart to the explicit `select` in middleware/tenant.js: the
// select stops a not-yet-migrated column from 500ing every tenant route at
// runtime; this gate stops the schema/DB from drifting apart in the first place
// by refusing a schema edit that ships without its migration.
//
// See decisions/lessons-learned.md AP-T58 (2026-07-16): "a schema-migration
// commit is not done until the migration is actually applied" — a schema.prisma
// edit with no migration file is the earliest, cheapest place to catch that.
//
// USAGE (all resolve paths from a reliable git-root anchor, AP-T37):
//   node backend/scripts/check-schema-migration-parity.mjs            # staged (pre-commit)
//   node backend/scripts/check-schema-migration-parity.mjs --range A..B   # a commit range (CI)
//   node backend/scripts/check-schema-migration-parity.mjs --working   # unstaged working tree
//
// Default (no flag) inspects the STAGED diff (git diff --cached), which is what a
// pre-commit hook or a `HEAD~1..HEAD` CI check would gate. Wire it into CI as a
// required step; it needs only git + node, no DB and no network.
//
// EXIT CODES: 0 = parity OK (or schema untouched — nothing to gate).
//             1 = schema.prisma changed but no new migration dir → BLOCK.
//             2 = usage / git error.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the git repo root from this script's own location (never a hardcoded
// absolute path — this script lives at <repo>/backend/scripts/).
function gitRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: __dirname,
      encoding: 'utf8',
    }).trim();
  } catch {
    // Fallback: <repo>/backend/scripts → repo root is two levels up.
    return path.resolve(__dirname, '..', '..');
  }
}

const ROOT = gitRoot();
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// Paths are matched relative to the repo root, forward-slash normalised.
const SCHEMA_PATH = 'backend/prisma/schema.prisma';
const MIGRATIONS_DIR = 'backend/prisma/migrations/';

function parseArgs(argv) {
  const args = { mode: 'staged', range: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--working') args.mode = 'working';
    else if (a === '--staged') args.mode = 'staged';
    else if (a === '--range') {
      args.mode = 'range';
      args.range = argv[++i];
      if (!args.range) {
        console.error('✖ --range requires a value, e.g. --range HEAD~1..HEAD');
        process.exit(2);
      }
    } else {
      console.error(`✖ unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// Return the list of changed paths (repo-root-relative, forward slashes) for the
// selected mode, with each path's git status letter (A/M/D/R...).
function changedFiles({ mode, range }) {
  let raw;
  if (mode === 'range') raw = git(['diff', '--name-status', range]);
  else if (mode === 'working') raw = git(['diff', '--name-status']);
  else raw = git(['diff', '--cached', '--name-status']); // staged (default)

  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0][0]; // R100 → 'R', A → 'A', etc.
      // For renames git prints old\tnew; take the new (last) path.
      const file = parts[parts.length - 1].replace(/\\/g, '/');
      return { status, file };
    });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let changes;
  try {
    changes = changedFiles(args);
  } catch (err) {
    console.error('✖ git diff failed:', err.message);
    process.exit(2);
  }

  const schemaChanged = changes.some(
    (c) => c.file === SCHEMA_PATH && (c.status === 'M' || c.status === 'A' || c.status === 'R')
  );

  if (!schemaChanged) {
    console.log(`✓ schema-migration parity: ${SCHEMA_PATH} not changed in this diff (${args.mode}) — nothing to gate.`);
    process.exit(0);
  }

  // A "new migration" = a newly ADDED file inside a migrations subdirectory
  // (i.e. a new migration folder's migration.sql, or any added file under it).
  const newMigrationFiles = changes.filter(
    (c) => c.status === 'A' && c.file.startsWith(MIGRATIONS_DIR) && c.file !== `${MIGRATIONS_DIR}migration_lock.toml`
  );

  if (newMigrationFiles.length === 0) {
    console.error('');
    console.error('✖ SCHEMA-MIGRATION PARITY VIOLATION');
    console.error(`  ${SCHEMA_PATH} was modified, but no new migration file was added`);
    console.error(`  under ${MIGRATIONS_DIR}.`);
    console.error('');
    console.error('  A schema.prisma change without a migration silently drifts the live DB');
    console.error('  from the code (BUG-WA-002 class — 500s every tenant route once a declared');
    console.error('  column is missing on the live DB). Generate the migration before committing:');
    console.error('');
    console.error('    cd backend && npx prisma migrate dev --name <describe_change>');
    console.error('');
    console.error('  Then re-run this check. (AP-T58: a schema-migration commit is not done');
    console.error('  until the migration exists AND is applied to the live DB.)');
    console.error('');
    process.exit(1);
  }

  console.log('✓ schema-migration parity OK:');
  console.log(`  ${SCHEMA_PATH} changed AND ${newMigrationFiles.length} new migration file(s) added:`);
  for (const m of newMigrationFiles) console.log(`    + ${m.file}`);
  process.exit(0);
}

main();
