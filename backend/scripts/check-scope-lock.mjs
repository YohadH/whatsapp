#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Scope-lock gate  (day-one-EXCLUDED surface guard — whatsapp-agent-wa-scope-lock-gate)
//
// WARNS (does NOT hard-block by default — advisory, like check-toctou-heuristic.mjs)
// when a STAGED file matches a path glob declared in backend/scope-lock.json AND the
// decision-log (D:/AgentsTeam/decisions/decision-log.md) carries NO matching
// `SCOPE-UNLOCK: <area>` line for that glob's area. It prints file:path for a human
// (developer / bug-reviewer / owner) to confirm the surface is genuinely in-scope.
//
// WHY: the Instagram/Messenger channel adapter + channel-aware engine (commits
// dfde910 d338561 6316157 518ac21 b1b6cd4 07c5c23 cbbedd3) were built AHEAD of an
// explicit owner go-ahead. A prose "don't expand scope" rule does not stop a later
// commit from piling more onto those surfaces, so this is the mechanical backstop —
// the same shape as the schema-parity and TOCTOU pre-commit checks already in this
// repo. The owner unlocks an area by adding a decision-log line containing
// `SCOPE-UNLOCK: <area>` (e.g. `- [2026-08-08] SCOPE-UNLOCK: ig-messenger — approved`).
//
// A manifest area may set `hardBlock: true` to escalate that area from a WARNING to a
// HARD BLOCK (non-zero exit → the pre-commit hook aborts the commit) until it is
// unlocked. By default every area is advisory (`hardBlock: false`).
//
// EMERGENCY BYPASS (any gate in this repo):  git commit --no-verify
//
// DEFENSIVE: every path in this check is wrapped so that ANY internal error (missing
// manifest, unreadable decision-log, bad JSON, git failure) is SWALLOWED and the check
// exits 0 — a broken check must NEVER block a commit. Same posture as the existing
// TOCTOU / schema-parity checks.
//
// USAGE (all paths resolve from a git-root anchor — AP-T37, no hardcoded drive):
//   node backend/scripts/check-scope-lock.mjs                 # staged (pre-commit)
//   node backend/scripts/check-scope-lock.mjs --working       # unstaged working tree
//   node backend/scripts/check-scope-lock.mjs --range A..B     # a commit range (CI)
//   node backend/scripts/check-scope-lock.mjs --file <path> ... # explicit file list (tests)
//
// TEST ISOLATION (mirrors how check-toctou-heuristic.test.mjs drives the real tool):
//   SCOPE_LOCK_MANIFEST=<path>      override backend/scope-lock.json (a scratch manifest)
//   SCOPE_LOCK_DECISION_LOG=<path>  override the decision-log (a scratch copy with/without
//                                   a SCOPE-UNLOCK line) so a test never touches the real one
//   --file <paths...>              feed an explicit "staged" file list without git
//
// EXIT CODES: 0 = no locked staged file (or all locked files unlocked / advisory-warn only).
//             1 = at least one staged file hit a HARD-BLOCK area with no SCOPE-UNLOCK → BLOCK.
//   (Advisory warnings alone still exit 0 so the pre-commit hook — which calls this without
//    `|| exit 1` — prints the warning but lets the commit proceed, exactly like TOCTOU. A
//    hard-block area is the only thing that returns 1.)
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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

// The committed manifest (env-overridable for tests).
const MANIFEST_PATH =
  process.env.SCOPE_LOCK_MANIFEST || path.resolve(ROOT, 'backend', 'scope-lock.json');

// The decision-log lives in the SIBLING control-panel repo (D:/AgentsTeam), not this
// product repo — resolve it relative to the repo root (../AgentsTeam/...) so there is no
// hardcoded drive letter (AP-T37), and allow an env override for test isolation.
const DECISION_LOG_PATH =
  process.env.SCOPE_LOCK_DECISION_LOG ||
  path.resolve(ROOT, '..', 'AgentsTeam', 'decisions', 'decision-log.md');

function parseArgs(argv) {
  const args = { mode: 'staged', range: null, files: null };
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
    } else if (a === '--file') {
      // Explicit file list (used for self-test / ad-hoc scans). Consumes the rest.
      args.mode = 'file';
      args.files = argv.slice(i + 1);
      if (args.files.length === 0) {
        console.error('✖ --file requires at least one path');
        process.exit(2);
      }
      break;
    } else {
      console.error(`✖ unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// Return the list of changed paths (repo-root-relative, forward slashes) for the
// selected mode. Deletions are dropped — deleting a locked file does not "expand" scope.
function changedFiles({ mode, range, files }) {
  if (mode === 'file') {
    // Normalise explicit paths to repo-root-relative, forward-slash form.
    return files.map((f) => {
      const abs = path.isAbsolute(f) ? f : path.resolve(ROOT, f);
      return path.relative(ROOT, abs).replace(/\\/g, '/');
    });
  }
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
      const file = parts[parts.length - 1].replace(/\\/g, '/');
      return { status, file };
    })
    .filter((c) => c.status !== 'D') // a deletion can't expand scope
    .map((c) => c.file);
}

// Load and validate the manifest. Returns { areas: [...] } or null if unusable.
function loadManifest() {
  let text;
  try {
    text = fs.readFileSync(MANIFEST_PATH, 'utf8');
  } catch {
    return null; // no manifest → nothing to gate
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.warn(`⚠ scope-lock: could not parse ${MANIFEST_PATH} (${e.message}) — skipping gate.`);
    return null;
  }
  if (!json || !Array.isArray(json.areas)) return null;
  return json;
}

// Translate a scope-lock glob into a RegExp. Supported wildcards (repo-root-relative,
// forward-slash paths): `**` = any path segments, `*` = anything except a path
// separator, `?` = a single non-separator char. Everything else is matched literally.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` (optionally followed by `/`) → any run of characters incl. separators.
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*'; // single `*` → within one path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // escape regex metachars
    }
  }
  return new RegExp('^' + re + '$');
}

// Does a decision-log carry a `SCOPE-UNLOCK: <area>` marker for this area? Matches a
// line CONTAINING `SCOPE-UNLOCK:` followed by the area name as a DISCRETE token
// (case-insensitive on the keyword; the area token is matched exactly, allowing
// surrounding whitespace).
//
// The area token must NOT be immediately followed by a word char, `-`, `.`, or `_` —
// otherwise a narrower/differently-scoped note like `SCOPE-UNLOCK: ig-messenger-DOCS-ONLY`
// or `SCOPE-UNLOCK: ig-messenger.disabled` would accidentally unlock the WHOLE plain
// `ig-messenger` area. A bare `\b` boundary is insufficient because `-` and `.` are
// non-word chars, so `\b` fires right after the token regardless of a `-`/`.` continuation.
// A `(?![\w.-])` negative lookahead requires a genuine end-of-token (whitespace, EOL,
// `—`, `:`, `,`, `)`, …) while rejecting identifier-continuation suffixes.
function isAreaUnlocked(decisionLogText, area) {
  if (!decisionLogText) return false;
  // e.g. "- [2026-08-08] SCOPE-UNLOCK: ig-messenger — owner approved …"
  const re = new RegExp(
    'SCOPE-UNLOCK:\\s*' + area.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.-])',
    'i'
  );
  return re.test(decisionLogText);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const manifest = loadManifest();
  if (!manifest) {
    console.log('✓ scope-lock: no usable manifest — nothing to gate.');
    process.exit(0);
  }

  let staged;
  try {
    staged = changedFiles(args);
  } catch (err) {
    console.warn(`⚠ scope-lock: git diff failed (${err.message}) — skipping gate.`);
    process.exit(0);
  }

  if (staged.length === 0) {
    console.log(`✓ scope-lock: no changed files in this diff (${args.mode}) — nothing to gate.`);
    process.exit(0);
  }

  let decisionLogText = '';
  try {
    decisionLogText = fs.readFileSync(DECISION_LOG_PATH, 'utf8');
  } catch {
    // A missing decision-log means NOTHING is unlocked (fail-closed on unlock, but the
    // default is advisory-warn so this still won't block a commit unless hardBlock).
    console.warn(`⚠ scope-lock: decision-log not readable at ${DECISION_LOG_PATH} — treating all areas as LOCKED.`);
  }

  // Pre-compile each area's globs + unlock status.
  const areas = manifest.areas
    .filter((a) => a && typeof a.area === 'string' && Array.isArray(a.globs))
    .map((a) => ({
      area: a.area,
      hardBlock: a.hardBlock === true,
      matchers: a.globs.map((g) => ({ glob: g, re: globToRegExp(g) })),
      unlocked: isAreaUnlocked(decisionLogText, a.area),
    }));

  const warnings = []; // { file, area }
  const blocks = []; // { file, area }

  for (const file of staged) {
    for (const a of areas) {
      if (a.unlocked) continue; // area explicitly opened by the owner → allowed
      const hit = a.matchers.find((m) => m.re.test(file));
      if (!hit) continue;
      (a.hardBlock ? blocks : warnings).push({ file, area: a.area, glob: hit.glob });
    }
  }

  if (warnings.length === 0 && blocks.length === 0) {
    console.log('✓ scope-lock: no staged file touches a locked (day-one-excluded) surface.');
    process.exit(0);
  }

  // Print warnings (advisory) first.
  if (warnings.length > 0) {
    console.warn('');
    console.warn('⚠ SCOPE-LOCK WARNING (advisory — commit NOT blocked)');
    console.warn('  A staged file touches a day-one-EXCLUDED surface with no SCOPE-UNLOCK entry');
    console.warn(`  in the decision-log (${DECISION_LOG_PATH}):`);
    console.warn('');
    for (const w of warnings) {
      console.warn(`  file:${w.file}   (area "${w.area}", glob "${w.glob}")`);
    }
    console.warn('');
    console.warn('  If the owner has approved building this area, add a decision-log line:');
    console.warn('      - [YYYY-MM-DD] SCOPE-UNLOCK: <area> — <why> — scope');
    console.warn('  Otherwise this is out-of-scope creep (do exactly the assigned task).');
    console.warn('');
  }

  // Print hard blocks and fail if any.
  if (blocks.length > 0) {
    console.error('');
    console.error('✖ SCOPE-LOCK VIOLATION (HARD BLOCK — commit refused)');
    console.error('  A staged file touches a HARD-BLOCKED day-one-excluded surface with no');
    console.error(`  SCOPE-UNLOCK entry in the decision-log (${DECISION_LOG_PATH}):`);
    console.error('');
    for (const b of blocks) {
      console.error(`  file:${b.file}   (area "${b.area}", glob "${b.glob}")`);
    }
    console.error('');
    console.error('  To proceed, EITHER get the owner to add a decision-log line:');
    console.error('      - [YYYY-MM-DD] SCOPE-UNLOCK: <area> — <why> — scope');
    console.error('  OR, in a genuine emergency, bypass ALL commit hooks:');
    console.error('      git commit --no-verify');
    console.error('');
    process.exit(1);
  }

  process.exit(0);
}

// DEFENSIVE OUTER GUARD: a broken check must never block a commit. Any unexpected
// throw is swallowed and we exit 0 — same posture as the TOCTOU / schema-parity checks.
try {
  main();
} catch (err) {
  console.warn(`⚠ scope-lock: internal error, skipping gate (commit not blocked): ${err && err.message}`);
  process.exit(0);
}
