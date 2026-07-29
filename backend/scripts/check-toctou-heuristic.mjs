#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// TOCTOU static heuristic (read-then-write race guard — AP-T72 class)
//
// WARNS (does NOT hard-block — this is a heuristic, not a proof) when a changed
// file under backend/src contains, inside a short span, a `findUnique(`/`findFirst(`
// read that BINDS a variable, a guard that references that variable, then a bare
// `.update(` / `.updateMany(` / `.create(` write with NO intervening atomic-
// conditional guard (a WHERE-guarded `updateMany`, or a raw `UPDATE` in
// `$executeRaw`) and NOT wrapped in a try/catch that classifies a P2002 unique-
// constraint violation.
//
// This is the exact shape that recurred 5× in 8 days in this backend:
//   chargeAiCredit             cf4ceb5   (window-flip → atomic conditional UPDATE)
//   credit-purchases mark-paid 2d5b9b3   (status flip → conditional updateMany)
//   markLowCreditNudge         9b68f89   (null→ts flip → conditional updateMany)
//   needsHuman flip            acbe0c6
//   conversationEngine dedup   492d9b2   (create-is-the-gate + P2002 catch)
//
// A prose rule in developer.md (AP-T72) did NOT stop a brand-new feature from
// reintroducing it, so this is the mechanical backstop: it prints file:line for a
// human (developer / bug-reviewer) to confirm the write is either
//   (a) an atomic-conditional  updateMany({ where:{ id, <field>:<prior> } }) /
//       raw UPDATE ... WHERE ..., or
//   (b) a P2002-catch (try/catch that treats the unique violation as "already
//       done / duplicate")
// BEFORE committing.
//
// USAGE (all paths resolve from a git-root anchor — AP-T37, no hardcoded drive):
//   node backend/scripts/check-toctou-heuristic.mjs             # staged (pre-commit)
//   node backend/scripts/check-toctou-heuristic.mjs --working   # unstaged working tree
//   node backend/scripts/check-toctou-heuristic.mjs --range A..B   # a commit range (CI)
//   node backend/scripts/check-toctou-heuristic.mjs --file <path> [<path> ...]  # explicit files
//
// EXIT CODES: 0 = no suspicious read→gate→write shape in the changed files.
//             1 = at least one suspicious shape found → WARN (advisory).
//             2 = usage / git error.
//
// NOTE ON EXIT 1: it is a WARNING, not a hard block. The pre-commit hook invokes
// this WITHOUT `|| exit 1`, so the warning is printed but the commit still proceeds
// (unlike check-schema-migration-parity.mjs, which hard-blocks). The exit-1 lets a
// stricter CI job choose to fail on it if desired.
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

// Only scan JS/TS source under the backend app (where prisma calls live).
const SCAN_PREFIX = 'backend/src/';
const SCAN_EXT = /\.(js|mjs|cjs|ts)$/;

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

// Return the list of changed source paths (repo-root-relative, forward slashes)
// for the selected mode, filtered to backend/src JS/TS files (added or modified).
function changedSourceFiles({ mode, range }) {
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
    .filter((c) => c.status !== 'D') // deletions can't reintroduce the shape
    .filter((c) => c.file.startsWith(SCAN_PREFIX) && SCAN_EXT.test(c.file))
    .map((c) => c.file);
}

// ── DETECTION ────────────────────────────────────────────────────────────────
// The recurring TOCTOU bug shape in this backend is COMPACT and always the same:
//
//     const X = await prisma.MODEL.findUnique/findFirst({ ... });   // read
//     if (X.<field> ...) { ... }                                    // gate on X
//     await prisma.MODEL.update/create({ ... });                    // write
//
// i.e. a read that BINDS a variable, a guard that references that variable, then a
// bare write — all within a short span. We deliberately match ONLY that tight shape
// (read binds var → var referenced in a gate below → bare write below) rather than
// "any read anywhere + any write anywhere in the function", because the loose form
// produces a flood of false positives on ordinary sequential DB code. This keeps the
// heuristic PRECISE on the known 5 recurrences while staying quiet on benign code.
//
// A write is treated as SAFE (skipped) when it is:
//   (a) a WHERE-guarded updateMany  — the atomic conditional gate (mark-paid style), OR
//   (b) preceded (between the read and the write) by a raw parameterized UPDATE
//       ($executeRaw`UPDATE ... WHERE`) that is the real gate (chargeAiCredit window-
//       flip style — its sibling .create() ledger row is a paired effect, not a race), OR
//   (c) inside a try/catch that classifies a P2002 / duplicate error
//       (create-is-the-gate, conversationEngine dedup — commit 492d9b2).

const READ_BIND_RE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[\w.$]*\.(?:findUnique|findFirst)\s*\(/;
// The bare write must be a real prisma-style write CALL — require the model accessor
// before it (foo.update(, tx.tenant.create(, prisma.x.updateMany() so a `.update(` in
// a prose comment ("the primary tenant.update() at :287") is not matched as code.
const BARE_WRITE_RE = /\b\w+\.(?:update|updateMany|create)\s*\(/;
const ATOMIC_UPDATEMANY_RE = /\.updateMany\s*\(\s*\{[\s\S]*?\bwhere\s*:/;
const RAW_UPDATE_RE = /\$executeRaw|\bUPDATE\s+"/;
const P2002_SIGNAL_RE = /P2002|isDuplicate|unique.?constraint|ConstraintViolation/i;
// A `.create()` whose collision is a benign uniqueness pre-check (findFirst slug/email
// clash → create) is a different, DB-constraint-guarded class, not the AP-T72 money/
// state-flip TOCTOU. We ONLY want to flag WRITES, so uniqueness-clash create pre-checks
// where the guard var is named like a clash/existence probe are treated as SAFE noise.
const CLASH_VAR_RE = /^(clash|exists|existing|dupe|duplicate|taken|conflict)/i;

// A line that starts a NEW top-level function / route handler — used to STOP the
// read→write scan so proximity never crosses a function boundary. Matches this repo's
// styles: `export ... function`, `function name(`, `router.get/post/...(`,
// `async function`, and a bare `}` at column 0 (end of a top-level block).
//
// NOTE: this catches TOP-LEVEL (column-0) boundaries only. Indented class-method
// boundaries (`  async markPaid(id) {` and their `  }` close, which have no `function`
// keyword and are indented) are NOT matched here — those are handled structurally by
// the brace-depth tracker in findSuspiciousPairs (the `depth < 0` scan-stop). Using
// depth rather than another anchored regex is what keeps a read in one class method from
// pairing with a bare write in an unrelated SIBLING method, without a regex broad enough
// to also stop at a benign mid-body `}` (a nested `if`/object close).
const FUNC_BOUNDARY_RE =
  /^(export\s+)?(async\s+)?function\b|^router\.(get|post|put|patch|delete)\s*\(|^\}\s*\)?[;,]?\s*$/;

// A line that is ONLY a comment (// or * ... ) — never treat as code.
const COMMENT_ONLY_RE = /^\s*(\/\/|\*|\/\*)/;

// Net brace delta, counting only braces that are actual CODE — braces inside string
// literals, template literals, comments, and regex literals must NOT skew the count so
// that an unbalanced `{`/`}` inside such a construct cannot desync the running depth (a
// spurious `depth < 0` prematurely stops the proximity scan → a SILENT FALSE NEGATIVE:
// a real read→gate→write AP-T72 shape below the tricky construct goes unflagged).
//
// The naive per-line stripper (regex replace over ONE line) cannot handle constructs that
// span multiple lines: a multi-line template literal or a multi-line block comment carries
// state across line boundaries, and a regex literal (`/foo}bar/`) is not a string at all.
// So this is a small STATEFUL character scanner: `makeBraceScanner()` returns a per-line
// delta function that carries `inBlockComment` and `inTemplate` (backtick) state ACROSS
// calls, and resolves single/double strings, line comments, and (best-effort) regex
// literals WITHIN each line. It is still a heuristic, not a parser — it only needs to be
// correct enough to decide when the scan has left the read's OWN enclosing block.
//
// Template-literal `${ ... }` interpolation: the OUTER braces of an interpolation are real
// code delimiters, so we track a small stack of interpolation depths. A `${` inside a
// template opens a code context (its `}` closes it); braces in the literal TEXT around it
// are ignored. This keeps ordinary `` `hi ${x}` `` from being mis-counted while still not
// counting a stray brace in the literal text.
function makeBraceScanner() {
  const state = {
    inBlockComment: false,
    inTemplate: false,
    // Stack of `${` interpolation brace-depths (one entry per active `${`); when the
    // matching `}` for a `${` is reached the entry is popped and we resume template text.
    interpStack: [],
  };

  // A `/` starts a regex (rather than a division operator) only in "operator position":
  // when the previous significant code char is one that cannot end a value. This is the
  // standard best-effort JS-lexer heuristic — it will not treat `a / b` as a regex, and
  // treats `= /re/`, `(/re/`, `,/re/`, `return /re/` (prev char `n`→ handled below) as regex.
  const REGEX_ALLOWED_PREV = new Set([
    '', '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '~',
    '^', '<', '>',
  ]);

  const scan = function scan(line) {
    let d = 0;
    let prevSignificant = ''; // last non-space CODE char seen (for regex disambiguation)
    let i = 0;
    const n = line.length;

    while (i < n) {
      const ch = line[i];

      // ── inside a multi-line block comment: consume until closing */ ─────────────
      if (state.inBlockComment) {
        if (ch === '*' && line[i + 1] === '/') {
          state.inBlockComment = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }

      // ── inside a template literal (not currently in a `${...}` code context) ─────
      if (state.inTemplate && state.interpStack.length === 0) {
        if (ch === '\\') { i += 2; continue; } // escaped char in template text
        if (ch === '`') { state.inTemplate = false; i++; continue; }
        if (ch === '$' && line[i + 1] === '{') {
          state.interpStack.push(0); // entering interpolation code; this `${` brace is code-structural but balanced by its own `}`
          i += 2;
          continue;
        }
        i++; // ordinary template text (braces here are literal text → ignored)
        continue;
      }

      // ── normal code (or inside a `${ ... }` interpolation code context) ─────────
      // Line comment: rest of the line is a comment.
      if (ch === '/' && line[i + 1] === '/') break;

      // Block comment start.
      if (ch === '/' && line[i + 1] === '*') {
        state.inBlockComment = true;
        i += 2;
        continue;
      }

      // Single / double quoted string — consume to its closing quote (same line; JS
      // string literals do not span raw newlines, so any unterminated one ends at EOL).
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i++;
        while (i < n) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === quote) { i++; break; }
          i++;
        }
        prevSignificant = quote; // a string is a value → next `/` is division, not regex
        continue;
      }

      // Backtick — enter template-literal state (may span multiple lines).
      if (ch === '`') {
        state.inTemplate = true;
        prevSignificant = '`';
        i++;
        continue;
      }

      // Regex literal — best-effort. Only when `/` is in operator position.
      if (ch === '/' && REGEX_ALLOWED_PREV.has(prevSignificant)) {
        let j = i + 1;
        let inClass = false; // inside a [ ... ] char class, where / is literal
        let closed = false;
        while (j < n) {
          const c = line[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) { closed = true; j++; break; }
          j++;
        }
        if (closed) {
          // Skip regex flags (a-z) after the closing slash.
          while (j < n && /[a-z]/i.test(line[j])) j++;
          i = j;
          prevSignificant = '/'; // a regex is a value
          continue;
        }
        // Not a real regex (no closing slash on this line) → treat `/` as ordinary char.
      }

      // Real code character.
      if (ch === '{') {
        d++;
        if (state.interpStack.length > 0) {
          state.interpStack[state.interpStack.length - 1]++;
        }
      } else if (ch === '}') {
        if (state.interpStack.length > 0) {
          const top = state.interpStack[state.interpStack.length - 1];
          if (top === 0) {
            // This `}` closes the `${` interpolation → back to template text. It is NOT
            // a code brace (its opening `${` was not counted either), so no delta change.
            state.interpStack.pop();
            prevSignificant = '}';
            i++;
            continue;
          }
          state.interpStack[state.interpStack.length - 1]--;
        }
        d--;
      }

      if (ch !== ' ' && ch !== '\t') prevSignificant = ch;
      i++;
    }
    return d;
  };
  // Expose the mutable state so callers can tell when a line is (still) being consumed by
  // a multi-line template literal or block comment (i.e. it is TEXT, not code).
  scan.state = state;
  return scan;
}

// True when the scanner is currently inside a multi-line template literal (in its literal
// TEXT, not a `${...}` code interpolation) or a block comment — i.e. the current line's
// remaining content is string/comment TEXT, not code, and must not be matched as a guard
// or write, nor treated as a function boundary.
function braceScanInTrickyState(scan) {
  const s = scan.state;
  return s.inBlockComment || (s.inTemplate && s.interpStack.length === 0);
}

// How far below a read we still consider a write "gated by" that read, if no function
// boundary intervenes first. The real bugs span ~10–40 lines (read → guard → update).
const PROXIMITY_LINES = 60;

// A write is SAFE (skip) if it is an atomic-conditional, a raw-UPDATE-gated sibling,
// or inside a P2002/duplicate try-catch.
function isSafeWrite(lines, writeIdx, readIdx) {
  const line = lines[writeIdx];

  // (a) WHERE-guarded updateMany spanning this + the next few lines.
  const windowBelow = lines.slice(writeIdx, Math.min(lines.length, writeIdx + 8)).join('\n');
  if (/\.updateMany\s*\(/.test(line) && ATOMIC_UPDATEMANY_RE.test(windowBelow)) return true;

  // (b) A raw parameterized UPDATE appears BETWEEN the read and the write (it is the
  //     real atomic gate; a bare .create() below it is the paired ledger effect).
  const between = lines.slice(readIdx, writeIdx + 1).join('\n');
  if (RAW_UPDATE_RE.test(between)) return true;

  // (c) The write sits inside a try{}...catch that references a P2002/duplicate signal.
  if (inP2002TryCatch(lines, writeIdx)) return true;

  return false;
}

// True when the write at writeIdx is inside a try/catch whose catch (or a helper it
// calls, e.g. isDuplicateWaMessage) references a P2002 / unique-constraint signal.
function inP2002TryCatch(lines, writeIdx) {
  const lo = Math.max(0, writeIdx - 20);
  const hi = Math.min(lines.length, writeIdx + 25);
  const around = lines.slice(lo, hi);
  const hasTry = around.some((l) => /\btry\s*\{/.test(l));
  const hasCatch = around.some((l) => /\}\s*catch\b/.test(l) || /\bcatch\s*\(/.test(l));
  const hasSignal = around.some((l) => P2002_SIGNAL_RE.test(l));
  return hasTry && hasCatch && hasSignal;
}

// Find suspicious read→gate→write triples. For each variable-binding read, scan the
// next PROXIMITY_LINES for (1) a guard that references the bound variable and (2) a
// bare write after that guard. Emit a hit only when the write is not SAFE.
function findSuspiciousPairs(lines) {
  const hits = [];
  for (let r = 0; r < lines.length; r++) {
    if (COMMENT_ONLY_RE.test(lines[r])) continue;
    const m = lines[r].match(READ_BIND_RE);
    if (!m) continue;
    const varName = m[1];
    // Uniqueness pre-check clash/existence probes are a different (DB-constraint-guarded)
    // class than the AP-T72 money/state-flip TOCTOU — skip to keep the signal tight.
    if (CLASH_VAR_RE.test(varName)) continue;
    // A FIELD-VALUE gate on the bound variable — `varName.<field>` used in a guard.
    // This is the discriminator between the racy AP-T72 shape (gate on a MUTABLE FIELD
    // that the write then flips: `if (purchase.status !== 'paid') ... update status`)
    // and a benign EXISTENCE check (`if (!tenant) return 404` → update), which is NOT
    // a TOCTOU on a state field and must NOT trip the guard.
    const varFieldRef = new RegExp(`\\b${varName}\\.[A-Za-z_$]`);

    const end = Math.min(lines.length, r + 1 + PROXIMITY_LINES);
    let sawGuard = false;
    // Brace-depth tracker scoped from the read line. Seed with the read line's own net
    // braces so a multi-line read (`... findFirst({` … `});`) starts at its true nesting
    // baseline; then accumulate per scanned line. The moment cumulative depth drops BELOW
    // zero we have exited the read's OWN enclosing block (its function OR class method),
    // so any write beyond that point lives in an unrelated later scope — stop the scan.
    // A benign mid-body `}` (nested `if`/object close) only returns depth toward zero,
    // never below, so this does NOT stop the scan inside the read's own method (which
    // would create a false NEGATIVE). This is the structural complement to FUNC_BOUNDARY_RE
    // that closes the indented-class-method sibling gap.
    //
    // The scanner is STATEFUL (carries multi-line template-literal / block-comment state),
    // so we build ONE per read and feed it every scanned line IN ORDER starting from the
    // read line — this is what lets an unbalanced brace inside a multi-line template
    // literal, a multi-line block comment, or a regex literal NOT desync `depth` and
    // spuriously stop the scan (the false-negative class this guard fixes).
    const braceScan = makeBraceScanner();
    let depth = braceScan(lines[r]);
    for (let w = r + 1; w < end; w++) {
      const line = lines[w];
      // STOP at a top-level function/handler boundary so a read is never paired with a
      // write in an unrelated later function (the #1 false-positive source). Only honor
      // this boundary in NORMAL code state — a `}` or `function`-looking token inside a
      // multi-line template literal / block comment is TEXT, not a real boundary.
      const inTricky = braceScanInTrickyState(braceScan);
      if (!inTricky && FUNC_BOUNDARY_RE.test(line)) break;
      // STOP when we have structurally left the read's enclosing block/method. Evaluate
      // AFTER the boundary regex but BEFORE matching this line as code: a line that closes
      // the enclosing method (its `}`) must not itself be a candidate write/guard.
      const wasTricky = inTricky;
      depth += braceScan(line);
      if (depth < 0) break;
      // A line consumed ENTIRELY by a still-open template literal / block comment is not
      // code — never match a guard or write inside it.
      if (wasTricky && braceScanInTrickyState(braceScan)) continue;
      if (COMMENT_ONLY_RE.test(line)) continue; // never match code inside a comment
      // A qualifying guard = a conditional (if/ternary/early-return/comparison) that
      // reads a FIELD of the bound var (varName.field). A pure existence/truthiness
      // check (`if (!var)`, `if (var)`) does NOT qualify — that's a 404/absence guard,
      // not a state-flip-on-read-value race.
      if (
        !sawGuard &&
        /\b(if|return)\b|\?|&&|\|\||===|!==|==|!=/.test(line) &&
        varFieldRef.test(line)
      ) {
        sawGuard = true;
      }
      if (BARE_WRITE_RE.test(line) && sawGuard) {
        if (isSafeWrite(lines, w, r)) continue; // known-good pattern → skip
        hits.push({
          readLine: r + 1,
          varName,
          writeLine: w + 1,
          writeText: line.trim(),
        });
      }
    }
  }
  return hits;
}

function readFileLines(absPath) {
  return fs.readFileSync(absPath, 'utf8').split(/\r?\n/);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let files;
  if (args.mode === 'file') {
    files = args.files.map((f) => (path.isAbsolute(f) ? f : path.resolve(ROOT, f)));
  } else {
    try {
      const rel = changedSourceFiles(args);
      files = rel.map((f) => path.resolve(ROOT, f));
    } catch (err) {
      console.error('✖ git diff failed:', err.message);
      process.exit(2);
    }
  }

  if (files.length === 0) {
    console.log(`✓ TOCTOU heuristic: no changed ${SCAN_PREFIX}*.{js,mjs,cjs,ts} files in this diff (${args.mode}) — nothing to scan.`);
    process.exit(0);
  }

  const allHits = [];
  for (const abs of files) {
    let lines;
    try {
      lines = readFileLines(abs);
    } catch (e) {
      console.error(`  ⚠ could not read ${abs}: ${e.message}`);
      continue;
    }
    const hits = findSuspiciousPairs(lines);
    const relDisplay = path.relative(ROOT, abs).replace(/\\/g, '/');
    for (const h of hits) allHits.push({ file: relDisplay, ...h });
  }

  if (allHits.length === 0) {
    console.log('✓ TOCTOU heuristic: no un-guarded read→gate→write shape found in the scanned files.');
    process.exit(0);
  }

  console.warn('');
  console.warn('⚠ TOCTOU HEURISTIC WARNING (advisory — commit NOT blocked)');
  console.warn('  A findUnique()/findFirst() read binds a variable that is then used in a guard,');
  console.warn('  followed by a bare .update()/.updateMany()/.create() with no atomic-conditional');
  console.warn('  guard and no P2002-catch. This is the AP-T72 read-then-write race shape (5× recurred).');
  console.warn('');
  for (const h of allHits) {
    console.warn(`  ${h.file}:${h.writeLine}  (read "${h.varName}" at line ${h.readLine})`);
    console.warn(`      ${h.writeText}`);
  }
  console.warn('');
  console.warn('  CONFIRM before committing that each write above is either:');
  console.warn('    (a) an atomic-conditional  updateMany({ where:{ id, <field>:<prior-value> } })');
  console.warn('        / raw UPDATE ... WHERE ...  (exactly one concurrent caller wins), OR');
  console.warn('    (b) inside a try/catch that treats a P2002 unique-constraint violation as');
  console.warn('        "already done / duplicate"  (create-is-the-gate, cf. commit 492d9b2).');
  console.warn('  If it is neither, collapse read+gate+write into ONE atomic statement (AP-T72).');
  console.warn('  If it IS one of those (heuristic false positive), commit normally.');
  console.warn('');
  process.exit(1);
}

main();
