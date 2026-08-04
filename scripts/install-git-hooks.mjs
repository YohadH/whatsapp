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

// pre-push hook body. POLICY: agents commit LOCALLY ONLY — the human reviews and
// pushes. Nothing else in this repo technically enforced that (there was a
// pre-commit hook but NO pre-push), which is how commit 2c7d116 reached
// origin/master without a review gate. This hook makes the standing policy a HARD
// technical block instead of a prompt-only instruction.
//
// Git invokes:  pre-push <remote-name> <remote-url>
// with one line per pushed ref on stdin:  <localref> <localsha> <remoteref> <remotesha>
// We block outright (any remote, any ref). A human who genuinely intends to push
// uses the documented escape hatch:  git push --no-verify
const PRE_PUSH_HOOK = `#!/bin/sh
# Auto-installed by scripts/install-git-hooks.mjs.
# HARD BLOCK: this repo's policy is "agents commit locally only; the human reviews
# and pushes." Agents must NEVER 'git push'. This hook enforces that policy so a
# push can't reach origin silently (root cause of the unreviewed 2c7d116 push).
#
# HUMAN ESCAPE HATCH: when YOU (a human) have reviewed the commits and intend to
# push, bypass this hook explicitly:   git push --no-verify
remote_name="$1"
echo "" >&2
echo "✋ pre-push BLOCKED: pushing to '$remote_name' is disabled by repo policy." >&2
echo "   Agents commit LOCALLY ONLY — the human reviews and pushes." >&2
echo "   (This is why commit 2c7d116 reaching origin/master without review was a defect.)" >&2
echo "" >&2
echo "   If you are a human who has reviewed these commits and want to push:" >&2
echo "       git push --no-verify" >&2
echo "" >&2
exit 1
`;

// commit-msg hook body. WARN ONLY — never blocks (always exit 0), matching the
// existing pre-commit TOCTOU advisory pattern (deliberately not '|| exit 1'). It
// nudges toward linking each commit to a board card: if the commit SUBJECT carries
// no board-id-shaped token (an UPPERCASE hyphen-joined token like WA-DEV-STRIPE /
// BUG-WA-002 / AP-T72), it prints a reminder to add a board id or a `Board:` trailer.
//
// WHY warn-only and not a hard gate (CTO decision 2026-08-04,
// whatsapp-agent-wa-process-gate-board-commit-link): docs/memory/hook commits
// legitimately have no card, and a hard block just trains agents to `--no-verify`.
// The real safety net is the board⇄git reconciliation job in D:/AgentsTeam
// (scripts/reconcile-board-commits.mjs), which auto-files a review card for any
// orphan CODE commit after the fact. This nudge is the cheap preventive complement.
//
// Git invokes:  commit-msg <path-to-commit-message-file>
const COMMIT_MSG_HOOK = `#!/bin/sh
# Auto-installed by scripts/install-git-hooks.mjs.
# WARN ONLY board-id nudge — NEVER blocks (always exits 0). A commit whose subject
# has no board-id token gets a reminder, not a rejection. The board⇄git reconcile
# job (D:/AgentsTeam scripts/reconcile-board-commits.mjs) is the real backstop.
msg_file="$1"
[ -f "$msg_file" ] || exit 0
subject="$(sed -n '1p' "$msg_file")"
# Skip merge/revert/fixup subjects — they inherit their linkage from the target.
case "$subject" in
  Merge*|Revert*|"fixup!"*|"squash!"*) exit 0 ;;
esac
# A board-id token: 2+ uppercase, at least one internal hyphen (WA-DEV-STRIPE, AP-T72).
# Also accept an explicit 'Board:' trailer anywhere in the message.
if printf '%s' "$subject" | grep -Eq '[A-Z]{2,}[A-Z0-9]*(-[A-Z0-9]+)+'; then
  exit 0
fi
if grep -Eiq '^board:' "$msg_file"; then
  exit 0
fi
echo "" >&2
echo "ℹ commit-msg: no board-id token in the subject (advisory — commit NOT blocked)." >&2
echo "  Consider naming the board card, e.g.  fix(x): … (WA-DEV-FOO)  or add a trailer:" >&2
echo "      Board: whatsapp-agent-<card-id>" >&2
echo "  Docs/memory/chore commits legitimately have no card — ignore this if so." >&2
echo "" >&2
exit 0
`;

// Install one hook idempotently. `foreignMarker` is a substring that identifies
// OUR managed hook; if an existing hook lacks it, we refuse to clobber a
// human/foreign hook and print manual instructions instead.
function installHook(hooksDir, name, body, foreignMarker, manualHint) {
  const hookPath = path.join(hooksDir, name);
  const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, 'utf8') : null;
  if (existing === body) {
    console.log(`✓ install-git-hooks: ${name} already up to date (${hookPath}).`);
    return;
  }
  if (existing && !existing.includes(foreignMarker)) {
    console.warn(`⚠ install-git-hooks: a DIFFERENT ${name} hook already exists at`);
    console.warn(`  ${hookPath}`);
    console.warn('  Not overwriting. ' + manualHint);
    return;
  }
  fs.writeFileSync(hookPath, body, { mode: 0o755 });
  try {
    fs.chmodSync(hookPath, 0o755); // no-op on Windows, needed on *nix/CI
  } catch {
    /* chmod may be unsupported — the shebang + git still run it */
  }
  console.log(`✓ install-git-hooks: installed ${name} → ${hookPath}`);
}

function main() {
  const gd = gitDir();
  if (!gd || !fs.existsSync(gd)) {
    // Not a git checkout (e.g. an extracted tarball) — nothing to install.
    console.log('• install-git-hooks: no .git directory found — skipping hook install.');
    process.exit(0);
  }
  const hooksDir = path.join(gd, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  installHook(
    hooksDir,
    'pre-commit',
    HOOK,
    'check-schema-migration-parity',
    'Add this line to it manually to enable the parity gate:\n' +
      '    node backend/scripts/check-schema-migration-parity.mjs || exit 1',
  );

  installHook(
    hooksDir,
    'pre-push',
    PRE_PUSH_HOOK,
    'pre-push BLOCKED',
    'To enforce the "commit locally only" policy, make it: exit 1 on push\n' +
      '  (human bypass: git push --no-verify).',
  );

  installHook(
    hooksDir,
    'commit-msg',
    COMMIT_MSG_HOOK,
    'commit-msg: no board-id token',
    'Add a warn-only board-id nudge (never blocks) to it manually, or see\n' +
      '  COMMIT_MSG_HOOK in this file.',
  );

  process.exit(0);
}

main();
