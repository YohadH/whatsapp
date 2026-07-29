#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Regression test for backend/scripts/check-toctou-heuristic.mjs
//
// Guards the class-method boundary fix (whatsapp-agent-fix-toctou-heuristic-false):
// the read→gate→write proximity scan must NOT cross from a read in one class METHOD
// into a bare write in an UNRELATED SIBLING method (a previously-real false positive),
// yet must STILL flag a genuine read→gate→bare-write anti-pattern that lives inside a
// single function OR a single class method (no false negative).
//
// ALSO guards the brace-tracker false-negative fix (whatsapp-agent-fix-toctou-heuristic-false-2):
// an unbalanced brace inside a MULTI-LINE template literal, a MULTI-LINE block comment, or
// a regex literal must NOT desync the brace-depth tracker and prematurely stop the scan —
// which would SILENTLY MISS a real anti-pattern positioned AFTER such a construct (cases
// 5-7). And the stateful scanner must not introduce NEW false positives: a real method-
// close brace after a template literal still stops the scan, and ordinary division is not
// read as a regex (cases 8-9).
//
// Drives the REAL tool via `node check-toctou-heuristic.mjs --file <fixture>` (the same
// entry point the pre-commit hook uses), asserting on its EXIT CODE (0 = clean,
// 1 = suspicious shape found). Fixtures are written to the OS temp dir and deleted after
// each case — nothing is left in the repo tree.
//
// Run from backend/:  node scripts/check-toctou-heuristic.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(__dirname, 'check-toctou-heuristic.mjs');

// Run the tool against one fixture file; return its exit code (0 clean / 1 warned).
function runToolExitCode(fixturePath) {
  try {
    execFileSync('node', [TOOL, '--file', fixturePath], { encoding: 'utf8', stdio: 'pipe' });
    return 0; // exit 0 → no suspicious shape
  } catch (err) {
    if (typeof err.status === 'number') return err.status; // 1 → warned
    throw err; // a real crash (e.g. exit 2 usage error) is a test failure
  }
}

let failures = 0;
function check(name, fixtureName, source, expectedExit) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'toctou-test-')), fixtureName);
  fs.writeFileSync(p, source, 'utf8');
  let got;
  try {
    got = runToolExitCode(p);
  } finally {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
  const ok = got === expectedExit;
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✖'} ${name} — expected exit ${expectedExit}, got ${got}`);
}

console.log('check-toctou-heuristic regression:');

// CASE 1 (the fixed false positive): read+guard in class method A, bare write in an
// UNRELATED sibling method B. The scan must STOP at A's method-close → NOT flagged.
check(
  'sibling class methods are NOT paired (false-positive fix)',
  'sibling.js',
  `export class BillingService {
  async markPaid(id) {
    const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
    if (purchase.status === 'paid') {
      return { alreadyPaid: true };
    }
    return { ok: true };
  }

  async recordUsage(tenantId, amount) {
    await prisma.usageLog.create({ data: { tenantId, amount } });
    return { logged: true };
  }
}
`,
  0
);

// CASE 2 (no false negative — top-level function): a real same-FUNCTION
// read→guard→bare-write anti-pattern must STILL be flagged.
check(
  'same top-level function anti-pattern IS flagged',
  'samefunc.js',
  `export async function markPaid(id) {
  const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
  if (purchase.status !== 'paid') {
    await prisma.creditPurchase.update({ where: { id }, data: { status: 'paid' } });
  }
  return { ok: true };
}
`,
  1
);

// CASE 3 (no false negative — class method, with a benign nested block between read and
// write): the brace tracker must not stop the scan inside the read's OWN method. The
// anti-pattern in markPaid IS flagged; the sibling recordUsage is NOT the paired write.
check(
  'same class-method anti-pattern IS flagged (nested block does not stop scan)',
  'classmethod.js',
  `export class BillingService {
  helper() {
    return 1;
  }

  async markPaid(id) {
    const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
    if (purchase.status !== 'paid') {
      if (purchase.amount > 0) {
        console.log('charging');
      }
      await prisma.creditPurchase.update({ where: { id }, data: { status: 'paid' } });
    }
    return { ok: true };
  }

  async recordUsage(tenantId, amount) {
    await prisma.usageLog.create({ data: { tenantId, amount } });
  }
}
`,
  1
);

// CASE 4 (robustness): unbalanced braces inside STRING literals between read and write
// must not skew the brace tracker (braceDelta strips string bodies) → still flagged.
check(
  'unbalanced braces in strings do not break detection',
  'tricky.js',
  `export async function markPaid(id) {
  const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
  const a = 'status: }}}';
  const b = "prefix { only";
  if (purchase.status !== 'paid') {
    await prisma.creditPurchase.update({ where: { id }, data: { status: 'paid' } });
  }
  return { ok: true };
}
`,
  1
);

// CASE 5 (false-negative fix — multi-line template literal): an unbalanced CLOSE brace
// inside a backtick string that SPANS multiple lines must NOT push the brace-depth tracker
// below zero (which would prematurely stop the scan and MISS the real anti-pattern below).
// The read→gate→bare-write shape after the template literal must STILL be flagged.
check(
  'unbalanced close brace in a MULTI-LINE template literal does not hide the anti-pattern',
  'multiline-template.js',
  `export async function markPaid(id) {
  const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
  const msg = \`Payment status }
    a multi-line template literal whose text contains an unbalanced close brace
  \`;
  if (purchase.status !== 'paid') {
    await prisma.creditPurchase.update({ where: { id }, data: { status: 'paid' } });
  }
  return { ok: true };
}
`,
  1
);

// CASE 6 (false-negative fix — multi-line block comment): an unbalanced CLOSE brace inside
// a /* ... */ block comment that spans multiple lines must NOT desync the brace tracker.
// The real anti-pattern after the comment must STILL be flagged.
check(
  'unbalanced close brace in a MULTI-LINE block comment does not hide the anti-pattern',
  'multiline-block-comment.js',
  `export async function markPaid(id) {
  const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
  /* block comment with an unbalanced close brace }
     spanning multiple lines, still inside markPaid */
  if (purchase.status !== 'paid') {
    await prisma.creditPurchase.update({ where: { id }, data: { status: 'paid' } });
  }
  return { ok: true };
}
`,
  1
);

// CASE 7 (false-negative fix — regex literal): a brace inside a /.../ regex literal is not
// a code brace and must NOT be counted. The anti-pattern after it must STILL be flagged.
check(
  'brace inside a REGEX literal does not hide the anti-pattern',
  'regex-brace.js',
  `export async function markPaid(id) {
  const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
  const re = /foo}bar/;
  if (purchase.status !== 'paid') {
    await prisma.creditPurchase.update({ where: { id }, data: { status: 'paid' } });
  }
  return { ok: true };
}
`,
  1
);

// CASE 8 (no NEW false positive — a real method-close `}` after a template literal must
// still stop the scan): read+guard in method A (which contains a template literal), bare
// write in an UNRELATED sibling method B. The scan must STILL stop at A's real close brace
// → NOT flagged. Guards that the tricky-state handling did not swallow a real boundary.
check(
  'sibling methods still NOT paired even when method A contains a template literal',
  'sibling-with-template.js',
  `export class BillingService {
  async markPaid(id) {
    const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
    const note = \`paid { status\`;
    if (purchase.status === 'paid') {
      return { alreadyPaid: true };
    }
    return { ok: true };
  }

  async recordUsage(tenantId, amount) {
    await prisma.usageLog.create({ data: { tenantId, amount } });
    return { logged: true };
  }
}
`,
  0
);

// CASE 9 (no NEW false positive — ordinary division is not a regex): `a / b` between the
// read and the write must be treated as division, not a regex literal (which would let a
// later brace be mis-consumed). The genuine anti-pattern must STILL be flagged.
check(
  'ordinary division operator is not mistaken for a regex literal',
  'division.js',
  `export async function markPaid(id) {
  const purchase = await prisma.creditPurchase.findFirst({ where: { id } });
  const ratio = purchase.amount / purchase.count;
  if (purchase.status !== 'paid') {
    await prisma.creditPurchase.update({ where: { id }, data: { status: 'paid' } });
  }
  return { ok: true };
}
`,
  1
);

if (failures === 0) {
  console.log('✓ all cases pass');
  process.exit(0);
}
console.error(`✖ ${failures} case(s) failed`);
process.exit(1);
