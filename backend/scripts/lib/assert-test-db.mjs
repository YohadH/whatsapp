// ─────────────────────────────────────────────────────────────────────────────
// assert-test-db — fail-closed prod-DB guard for the payment test harnesses.
//
// WHY: the 3 payment harnesses (payments / stripe-payments / stripe-subscription-
// lifecycle .test.mjs) CREATE and DELETE throwaway Tenant rows against whatever
// DATABASE_URL resolves to. backend/.env's DATABASE_URL points at the LIVE prod
// Supabase pooler, so a bare `node scripts/…test.mjs` (or the `test` script) would
// mutate PRODUCTION — the exact "a cleanup query nearly deleted the seed tenant"
// risk. This guard makes the harnesses REFUSE to run unless the DB target is an
// explicit disposable/local test DB, and HARD-BLOCKS anything that looks like prod.
//
// USAGE (top of each harness, immediately after dotenv.config()):
//   import { assertTestDb } from './lib/assert-test-db.mjs';
//   assertTestDb();   // process.exit(1) with a loud message if the target is unsafe
//
// CONTRACT: the payment gate must be run with DATABASE_URL pointed at a disposable DB
// (the runner scripts/run-payment-gate.mjs / npm run test:payments set it from
// TEST_DATABASE_URL). This guard is defense-in-depth on top of that wiring.
// ─────────────────────────────────────────────────────────────────────────────

// Substrings that mark a LIVE / production Postgres target. If the resolved
// DATABASE_URL contains any of these, we fail closed — never run the destructive
// create/delete harness against it.
const PROD_MARKERS = [
  'supabase.com',        // Supabase-hosted prod (pooler.supabase.com / db.<ref>.supabase.co)
  'supabase.co',
  'pooler.supabase',
  'rds.amazonaws.com',   // AWS RDS
  'render.com',          // Render-hosted PG
  'neon.tech',           // Neon
  'azure.com',
];

// Host substrings that are considered SAFE (local / disposable / CI service DB).
const LOCAL_MARKERS = ['127.0.0.1', 'localhost', '::1', 'postgres:5432', 'db:5432'];

/**
 * Resolve the DB URL the harness will actually use and refuse to proceed unless it
 * is a disposable/local test DB. Exits the process (code 1) on any unsafe target.
 *
 * Safe iff: URL is set AND (it explicitly matches a LOCAL_MARKER) AND (it does NOT
 * match any PROD_MARKER). We require an affirmative local match — an unknown host
 * fails closed rather than defaulting to "probably fine".
 */
export function assertTestDb() {
  const url = process.env.DATABASE_URL || '';

  if (!url) {
    console.error(
      '\n[assert-test-db] REFUSING TO RUN: DATABASE_URL is empty.\n' +
        '  The payment harnesses need a DISPOSABLE test DB. Set TEST_DATABASE_URL and run\n' +
        '  via `npm run test:payments` (or `node scripts/run-payment-gate.mjs`).\n'
    );
    process.exit(1);
  }

  const lower = url.toLowerCase();
  const prodHit = PROD_MARKERS.find((m) => lower.includes(m));
  if (prodHit) {
    console.error(
      `\n[assert-test-db] REFUSING TO RUN AGAINST PRODUCTION.\n` +
        `  DATABASE_URL looks like a live/hosted DB (matched "${prodHit}").\n` +
        `  These harnesses CREATE + DELETE tenant rows — never point them at prod.\n` +
        `  Point DATABASE_URL/TEST_DATABASE_URL at a disposable local Postgres and retry.\n`
    );
    process.exit(1);
  }

  const localHit = LOCAL_MARKERS.find((m) => lower.includes(m));
  if (!localHit) {
    console.error(
      `\n[assert-test-db] REFUSING TO RUN: DATABASE_URL host is not a recognized\n` +
        `  local/disposable target (expected one of ${LOCAL_MARKERS.join(', ')}).\n` +
        `  Fail-closed: unknown DB hosts are treated as unsafe. Use a disposable local\n` +
        `  Postgres for the payment gate.\n`
    );
    process.exit(1);
  }

  console.log(`[assert-test-db] OK — running against disposable test DB (${localHit}).`);
}
