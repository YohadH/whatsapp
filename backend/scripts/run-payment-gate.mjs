#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// run-payment-gate — the automated money-path test GATE.
//
// Runs the 3 payment-path verification harnesses in sequence against a DISPOSABLE
// test DB and exits non-zero if ANY of them fails. This is the single entry point
// wired into `npm run test` / `npm run test:payments` and the CI workflow.
//
//   1. scripts/payments.test.mjs                       (PayPlus webhook + credit grant)
//   2. scripts/stripe-payments.test.mjs                (Stripe checkout/webhook + credits/subscription)
//   3. scripts/stripe-subscription-lifecycle.test.mjs  (Stripe plan revert/re-grant on churn)
//
// DB TARGET (never prod):
//   The harnesses read DATABASE_URL. backend/.env's DATABASE_URL points at LIVE prod
//   Supabase, so this runner OVERRIDES it from TEST_DATABASE_URL for the child
//   processes. Each harness ALSO calls assertTestDb() (scripts/lib/assert-test-db.mjs),
//   a fail-closed guard that hard-refuses any prod-looking DB URL — defense in depth.
//
//   TEST_DATABASE_URL must be a disposable/local Postgres already synced to the Prisma
//   schema (e.g. `docker run -p 55433:5432 postgres:15` then `prisma db push`). See the
//   CI workflow (.github/workflows/payment-gate.yml) for the canonical setup.
//
// USAGE:
//   TEST_DATABASE_URL=postgresql://postgres:pass@127.0.0.1:55433/wa_test \
//     node scripts/run-payment-gate.mjs
//   (or just `npm run test` after exporting TEST_DATABASE_URL)
//
// Exit 0 = all 3 harnesses passed; exit 1 = at least one failed (or misconfig).
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testDbUrl = process.env.TEST_DATABASE_URL;
if (!testDbUrl) {
  console.error(
    '\n[payment-gate] TEST_DATABASE_URL is not set.\n' +
      '  This gate must run against a DISPOSABLE/local Postgres, never the live prod DB.\n' +
      '  Set TEST_DATABASE_URL, e.g.:\n' +
      '    export TEST_DATABASE_URL="postgresql://postgres:pass@127.0.0.1:55433/wa_test"\n' +
      '  (spin up a throwaway Postgres + `prisma db push` first — see\n' +
      '   .github/workflows/payment-gate.yml for the canonical setup).\n'
  );
  process.exit(1);
}

const HARNESSES = [
  'payments.test.mjs',
  'stripe-payments.test.mjs',
  'stripe-subscription-lifecycle.test.mjs',
];

// Child env: force DATABASE_URL to the disposable test DB so the harnesses' internal
// dotenv.config() (which loads the prod .env) does NOT override it — dotenv never
// overwrites an already-set process.env var, so this wins.
const childEnv = { ...process.env, DATABASE_URL: testDbUrl };

let anyFailed = false;
for (const h of HARNESSES) {
  const script = path.join(__dirname, h);
  console.log(`\n${'═'.repeat(78)}\n▶  PAYMENT GATE — ${h}\n${'═'.repeat(78)}`);
  const res = spawnSync(process.execPath, [script], {
    env: childEnv,
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'), // backend/
  });
  const code = res.status;
  console.log(`\n◀  ${h} exited ${code}`);
  if (code !== 0) anyFailed = true;
}

console.log(`\n${'═'.repeat(78)}`);
if (anyFailed) {
  console.log('PAYMENT GATE: FAILED — at least one money-path harness did not pass.');
  process.exit(1);
}
console.log('PAYMENT GATE: PASSED — all 3 money-path harnesses green.');
process.exit(0);
