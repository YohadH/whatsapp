#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION: "column present in schema.prisma but absent from the live DB"
//
// Reproduces the BUG-WA-002 failure class WITHOUT touching the live DB, then
// proves the explicit-select fix in middleware/tenant.js survives it by running
// the REAL withTenant() middleware against a stubbed Prisma client that behaves
// like a DB one migration BEHIND schema.prisma.
//
// HOW THE STUB IS INJECTED: this script MUST be run under the drift loader so
// that middleware/tenant.js's `import prisma from '../lib/prisma.js'` resolves to
// the stub instead of the real client:
//
//     cd backend
//     node --import ./scripts/register-drift-loader.mjs ./scripts/sim-tenant-select-drift.mjs
//
// The stub (scripts/prisma-drift-loader.mjs):
//   • findUnique WITHOUT an explicit `select` (implicit SELECT * — what the OLD
//     middleware did) → throws Prisma P2022 for the not-yet-migrated column,
//     exactly as real Postgres would → withTenant's catch → next(err) → 500.
//   • findUnique WITH `select: TENANT_SELECT` (omits the phantom column) →
//     returns the row → withTenant attaches req.tenant → next() → route works.
//
// Exit: 0 = fix verified (real withTenant survives the drift); 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────────
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // backend/

const results = [];
const record = (label, ok) => results.push([label, !!ok]);

async function run() {
  // Import the REAL middleware. Under the drift loader its prisma import is the
  // stub; without the loader it would hit the real client (and this sim would be
  // pointless), so we detect that and refuse.
  const mod = await import(
    pathToFileURL(path.join(ROOT, 'src', 'middleware', 'tenant.js')).href
  );
  const { withTenant, TENANT_SELECT } = mod;

  if (!TENANT_SELECT) {
    console.error('✖ TENANT_SELECT not exported from middleware/tenant.js');
    process.exit(1);
  }
  record('TENANT_SELECT is exported and is an object', typeof TENANT_SELECT === 'object');
  record('TENANT_SELECT does NOT list the phantom (unmigrated) column', !TENANT_SELECT.newlyAddedCol);

  // Confirm we're actually running under the drift stub (real client would not
  // throw a synthetic P2022 for a fake column). We import the (stubbed) prisma
  // the same way the middleware does.
  const prisma = (await import(pathToFileURL(path.join(ROOT, 'src', 'lib', 'prisma.js')).href)).default;
  let underStub = false;
  try {
    await prisma.tenant.findUnique({ where: { id: 'tnt_demo' } }); // SELECT * on stub → P2022
  } catch (err) {
    underStub = err.code === 'P2022';
  }
  if (!underStub) {
    console.error('✖ NOT running under the drift loader — the stub did not throw P2022 on SELECT *.');
    console.error('  Re-run as: cd backend && node --import ./scripts/register-drift-loader.mjs ./scripts/sim-tenant-select-drift.mjs');
    process.exit(1);
  }
  record('CONTROL: implicit SELECT * throws P2022 under simulated drift', underStub);

  // ── Run the REAL withTenant() as a tenant admin request under the drift. ──
  const req = {
    user: { tenantId: 'tnt_demo', role: 'agent' },
    header: () => null,
    query: {},
  };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let nextErr = 'not-called';
  const next = (err) => { nextErr = err || null; };

  await withTenant(req, res, next);

  record('withTenant() called next() (no error) — request proceeds, no 500', nextErr === null);
  record('withTenant() did NOT send an error HTTP status', res.statusCode === 200);
  record('req.tenant attached with correct id', !!req.tenant && req.tenant.id === 'tnt_demo');
  record('req.tenantId attached', req.tenantId === 'tnt_demo');
  record(
    'req.tenant carries every field downstream callers read',
    !!req.tenant &&
      ['id', 'status', 'waPhoneNumberId', 'waApiVersion', 'dailyBroadcastCap',
       'monthlyMessageLimit', 'creditsUsedThisPeriod', 'purchasedCredits',
       'periodStartedAt', 'lowCreditNotifiedAt', 'waTokenEnc', 'waBusinessAccountId']
        .every((k) => k in req.tenant)
  );

  // ── Negative sanity: prove that a SELECT-* middleware WOULD have 500'd, by
  //    directly issuing the old query shape against the same stub. ──
  let oldWouldThrow = false;
  try {
    await prisma.tenant.findUnique({ where: { id: 'tnt_demo' } });
  } catch (err) {
    oldWouldThrow = err.code === 'P2022';
  }
  record('the OLD select-all query shape still errors under the same drift (regression guard)', oldWouldThrow);

  console.log('\n=== Tenant select-drift simulation (REAL withTenant under stubbed drift) ===\n');
  let allPass = true;
  for (const [label, ok] of results) {
    console.log(`  ${ok ? '✓' : '✗'}  ${label}`);
    if (!ok) allPass = false;
  }
  console.log('');
  if (allPass) {
    console.log('RESULT: PASS — with the explicit select, the REAL withTenant() completes a');
    console.log('        tenant-scoped request even when schema.prisma declares a column that');
    console.log('        the live DB has not migrated yet; the old SELECT * shape 500s (proven).');
    process.exit(0);
  } else {
    console.log('RESULT: FAIL — withTenant() did not survive the simulated drift.');
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('simulation crashed:', e);
  process.exit(1);
});
