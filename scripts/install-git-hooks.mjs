#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Installs this repo's git hooks (schema-drift hardening — BUG-WA-002 class).
//
// WHY a self-installing hook (not husky): this repo has no husky / lint-staged /
// pre-existing hook framework and follows a plain-npm-scripts convention (see the
// `postinstall`/`build` scripts in the root + backend package.json). Rather than
// add a new dependency, this mirrors what husky does under the hood: a `prepare`
// npm script (runs automatically on `npm install`) invokes this installer, which
// writes .git/hooks/pre-commit. It is idempotent and safe to run repeatedly.
//
// The installed pre-commit hook runs the STAGED-diff schema⇄migration parity
// gate (backend/scripts/check-schema-migration-parity.mjs). If a commit stages a
// change to backend/prisma/schema.prisma without a new migration directory, the
// commit is BLOCKED — the earliest, cheapest place to stop schema/DB drift.
//
// Manual use:   node scripts/install-git-hooks.mjs
// Auto (npm):   runs on `npm install` via the root `prepare` script.
//
// Exit: 0 = installed (or skipped cleanly when not a git checkout); non-zero on
//       a real write failure.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function gitDir() {
  // Resolve the real .git directory (handles worktrees, where .git is a file).
  try {
    const out = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: __dirname,
      encoding: 'utf8',
    }).trim();
    return path.resolve(__dirname, '..', out);
  } catch {
    return null;
  }
}

// The hook body. `#!/bin/sh` so it runs under Git's bundled sh on Windows too.
// It calls the parity check in default (staged) mode; a non-zero exit aborts the
// commit. Node must be on PATH (it is, in every dev/CI environment that commits).
const HOOK = `#!/bin/sh
# Auto-installed by scripts/install-git-hooks.mjs.
# 1) schema⇄migration parity gate — HARD BLOCK: a commit that changes
#    backend/prisma/schema.prisma without a migration is refused.
# 2) TOCTOU heuristic — WARN ONLY (advisory, does NOT block): prints file:line for
#    any findUnique/findFirst read → field-gate → bare update/create that lacks an
#    atomic-conditional guard or P2002 catch (AP-T72 read-then-write race shape).
# To bypass the hard block in an emergency: git commit --no-verify
node backend/scripts/check-schema-migration-parity.mjs || exit 1
# Advisory only — deliberately NOT gated with '|| exit 1' so the commit proceeds; a
# human (developer/bug-reviewer) confirms each warning is an atomic-conditional or a
# P2002-catch pattern. Any error inside the check is swallowed so it never blocks.
node backend/scripts/check-toctou-heuristic.mjs || true
`;

function main() {
  const gd = gitDir();
  if (!gd || !fs.existsSync(gd)) {
    // Not a git checkout (e.g. an extracted tarball) — nothing to install.
    console.log('• install-git-hooks: no .git directory found — skipping hook install.');
    process.exit(0);
  }
  const hooksDir = path.join(gd, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, 'pre-commit');

  // Idempotent: only rewrite when content differs, so repeated `npm install`s
  // (which fire `prepare`) don't thrash the file.
  const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : null;
  if (existing === HOOK) {
    console.log(`✓ install-git-hooks: pre-commit already up to date (${hookPath}).`);
    process.exit(0);
  }
  if (existing && !existing.includes('check-schema-migration-parity')) {
    // A different pre-commit hook already exists — do NOT clobber it silently.
    console.warn('⚠ install-git-hooks: a DIFFERENT pre-commit hook already exists at');
    console.warn(`  ${hookPath}`);
    console.warn('  Not overwriting. Add this line to it manually to enable the parity gate:');
    console.warn('    node backend/scripts/check-schema-migration-parity.mjs || exit 1');
    process.exit(0);
  }

  fs.writeFileSync(hookPath, HOOK, { mode: 0o755 });
  try {
    fs.chmodSync(hookPath, 0o755); // no-op on Windows, needed on *nix/CI
  } catch {
    /* chmod may be unsupported — the shebang + git still run it */
  }
  console.log(`✓ install-git-hooks: installed pre-commit schema-parity gate → ${hookPath}`);
  process.exit(0);
}

main();
