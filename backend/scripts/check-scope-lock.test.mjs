#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Regression test for backend/scripts/check-scope-lock.mjs
//
// Guards the FAIL-OPEN contract of the scope-lock gate (whatsapp-agent-add-backend-
// scripts-check-scope). The check's header promises that ANY condition under which it
// cannot RELIABLY determine lock status must fail open (exit 0 — never block a commit):
//   • no manifest / unreadable manifest              → nothing to gate
//   • malformed manifest JSON                        → skip gate
//   • manifest with no valid `areas` array           → nothing to gate
//   • git diff / file enumeration failure            → skip gate  (indirectly: empty diff)
//   • decision-log UNREADABLE while a hardBlock area  → INDETERMINATE unlock status →
//     is hit                                            downgrade hard block to advisory
//                                                        WARNING → still exit 0
//   • area explicitly SCOPE-UNLOCK'd in the log      → allowed
//   • no changed files in the diff                   → nothing to gate
//
// It ALSO asserts a POSITIVE CONTROL so the suite is discriminating, not trivially green
// (AP-T13/AP-T36): a hardBlock area hit with a READABLE decision-log carrying NO matching
// SCOPE-UNLOCK line MUST exit 1 (a real block). If that case ever went green the whole
// fail-open suite would be meaningless — the branches would "pass" only because the tool
// never blocks anything.
//
// Drives the REAL tool via env-override isolation (SCOPE_LOCK_MANIFEST /
// SCOPE_LOCK_DECISION_LOG) + `--file <path>` — the exact test-isolation hooks documented
// in check-scope-lock.mjs's header — so it never touches git, the real backend/scope-lock.json,
// or the real decision-log. All scratch files live in the OS temp dir and are removed after
// each case; nothing is left in the repo tree.
//
// Run from backend/:  node scripts/check-scope-lock.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(__dirname, 'check-scope-lock.mjs');

// A repo-root-relative path that matches a hardBlock area's glob in the scratch manifests
// below. (It need not exist on disk — --file mode normalises paths without reading them.)
const LOCKED_FILE = 'backend/src/services/metaMessaging.js';

// A scratch manifest with ONE hardBlock area whose single glob matches LOCKED_FILE.
const HARDBLOCK_MANIFEST = JSON.stringify({
  areas: [
    { area: 'ig-messenger', hardBlock: true, globs: [LOCKED_FILE] },
  ],
});

// Run the REAL tool against an explicit --file list under env overrides; return exit code.
// 0 = allowed / advisory-only (fail-open); 1 = hard block. Any other code (2 = usage, or a
// genuine crash) is surfaced as a test failure by the caller.
function runTool({ manifest, decisionLog, files }) {
  const env = { ...process.env };
  if (manifest !== undefined) env.SCOPE_LOCK_MANIFEST = manifest;
  if (decisionLog !== undefined) env.SCOPE_LOCK_DECISION_LOG = decisionLog;
  const argv = files ? ['--file', ...files] : [];
  try {
    execFileSync('node', [TOOL, ...argv], { encoding: 'utf8', stdio: 'pipe', env });
    return 0;
  } catch (err) {
    if (typeof err.status === 'number') return err.status;
    throw err; // a real spawn/crash failure — let it surface
  }
}

// Materialise a scratch dir with optional manifest.json and log.md files, run the tool,
// assert the exit code, and clean up. `manifestText`/`logText` of null means "do NOT create
// that file" (so its env override points at a nonexistent path → the unreadable branch).
let failures = 0;
function check(name, { manifestText, logText, files }, expectedExit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scopelock-test-'));
  let manifestPath;
  let logPath;
  if (manifestText !== null) {
    manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, manifestText, 'utf8');
  } else {
    manifestPath = path.join(dir, 'missing-manifest.json'); // deliberately never created
  }
  if (logText !== null) {
    logPath = path.join(dir, 'log.md');
    fs.writeFileSync(logPath, logText, 'utf8');
  } else {
    logPath = path.join(dir, 'missing-log.md'); // deliberately never created
  }
  let got;
  try {
    got = runTool({ manifest: manifestPath, decisionLog: logPath, files });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ok = got === expectedExit;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✖'} ${name} — expected exit ${expectedExit}, got ${got}`);
}

console.log('check-scope-lock fail-open regression:');

// POSITIVE CONTROL (must block) — proves the suite is discriminating. A hardBlock area is
// hit AND the decision-log is readable AND carries NO matching SCOPE-UNLOCK → real block.
check(
  'POSITIVE CONTROL: hardBlock hit + readable log + no unlock → HARD BLOCK (exit 1)',
  {
    manifestText: HARDBLOCK_MANIFEST,
    logText: '# decision log\n- [2026-08-10] some unrelated note, no unlock here\n',
    files: [LOCKED_FILE],
  },
  1
);

// FAIL-OPEN 1 — decision-log UNREADABLE (nonexistent path) while a hardBlock area is hit.
// unlock status is INDETERMINATE → the tool must DOWNGRADE the hard block to an advisory
// warning and exit 0. This is the sharpest fail-open branch (a hard block with no readable
// log would otherwise wedge every commit on a machine without the sibling repo checked out).
check(
  'decision-log unreadable + hardBlock hit → fail open (advisory warn, exit 0)',
  {
    manifestText: HARDBLOCK_MANIFEST,
    logText: null, // → SCOPE_LOCK_DECISION_LOG points at a file that does not exist
    files: [LOCKED_FILE],
  },
  0
);

// FAIL-OPEN 2 — malformed manifest JSON → loadManifest() catches the parse error, warns,
// and returns null → "no usable manifest" → exit 0.
check(
  'malformed manifest JSON → fail open (exit 0)',
  {
    manifestText: '{ this is : not valid json,,, ',
    logText: '# decision log, no unlock\n',
    files: [LOCKED_FILE],
  },
  0
);

// FAIL-OPEN 3 — manifest is missing entirely (env points at a nonexistent path) → the
// readFileSync ENOENT branch returns null → "no usable manifest" → exit 0.
check(
  'manifest file missing → fail open (exit 0)',
  {
    manifestText: null, // → SCOPE_LOCK_MANIFEST points at a file that does not exist
    logText: '# decision log, no unlock\n',
    files: [LOCKED_FILE],
  },
  0
);

// FAIL-OPEN 4 — manifest is valid JSON but has NO `areas` array (wrong shape) → loadManifest
// returns null → "no usable manifest" → exit 0.
check(
  'manifest with no areas[] array → fail open (exit 0)',
  {
    manifestText: '{ "notAreas": [] }',
    logText: '# decision log, no unlock\n',
    files: [LOCKED_FILE],
  },
  0
);

// UNLOCK PATH — the area IS explicitly opened by the owner in the decision-log
// (`SCOPE-UNLOCK: ig-messenger`) → the locked file is allowed → exit 0. Confirms the read
// side of the unlock parser (the same code path the fail-open branch bypasses when the log
// is unreadable) works when the log IS readable.
check(
  'area explicitly SCOPE-UNLOCK-ed in a readable log → allowed (exit 0)',
  {
    manifestText: HARDBLOCK_MANIFEST,
    logText: '- [2026-08-10] SCOPE-UNLOCK: ig-messenger — owner approved — scope\n',
    files: [LOCKED_FILE],
  },
  0
);

// NO MATCH — a valid hardBlock manifest, readable no-unlock log, but the changed file does
// NOT match any locked glob → nothing to gate → exit 0. (Guards that the block path is
// reached ONLY on a genuine glob hit, so the positive control above is meaningful.)
check(
  'changed file matches no locked glob → nothing to gate (exit 0)',
  {
    manifestText: HARDBLOCK_MANIFEST,
    logText: '# decision log, no unlock\n',
    files: ['backend/src/routes/health.js'], // not in any area's globs
  },
  0
);

if (failures === 0) {
  console.log('✓ all cases pass');
  process.exit(0);
}
console.error(`✖ ${failures} case(s) failed`);
process.exit(1);
