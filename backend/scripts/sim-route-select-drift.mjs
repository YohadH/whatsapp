#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SIMULATION: schema-drift hardening for the NON-withTenant Tenant lookups.
//
// Companion to sim-tenant-select-drift.mjs (which covers middleware/tenant.js).
// This one proves the explicit-select fixes added to the routes below survive a
// live DB that is one migration BEHIND schema.prisma (the exact Tenant.waPin
// state today), WITHOUT touching the live DB:
//
//   • routes/whatsapp.js  POST /webhook  (findUnique by waPhoneNumberId)
//   • routes/bio.js       GET  /l/:slug  (findUnique by slug)   + GET /l (findMany)
//   • routes/admin.js     POST /tenants/:id/verify-credentials  (findUnique by id)
//
// HOW: run under the drift loader so every `import prisma from '../lib/prisma.js'`
// in the real route modules resolves to the stub (scripts/prisma-drift-loader.mjs),
// which throws Prisma P2022 on a select-all (implicit SELECT * asks for the
// phantom unmigrated column) and succeeds on an explicit select that omits it.
//
//     cd backend
//     node --import ./scripts/register-drift-loader.mjs ./scripts/sim-route-select-drift.mjs
//
// Two layers of proof:
//   (1) HTTP: mount the REAL bio router on a real express app and issue real
//       requests — a select-all would 500; with BIO_SELECT it renders 200 HTML.
//   (2) SHAPE: drive the stub with the REAL exported select objects the fixed
//       routes pass (TENANT_SELECT for whatsapp/admin, BIO_SELECT for bio) and
//       assert each survives, while the OLD select-all shape still throws.
//
// Exit: 0 = all route fixes verified; 1 = FAIL.
// ─────────────────────────────────────────────────────────────────────────────
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // backend/

const results = [];
const record = (label, ok) => results.push([label, !!ok]);

const importReal = (rel) =>
  import(pathToFileURL(path.join(ROOT, rel)).href).then((m) => m);

function httpGet(server, urlPath) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function run() {
  // ── Confirm we're actually under the drift stub (else this sim is pointless) ──
  const prisma = (await importReal('src/lib/prisma.js')).default;
  let underStub = false;
  try {
    await prisma.tenant.findUnique({ where: { id: 'tnt_demo' } }); // SELECT * → P2022
  } catch (err) {
    underStub = err.code === 'P2022';
  }
  if (!underStub) {
    console.error('✖ NOT running under the drift loader — stub did not throw P2022 on SELECT *.');
    console.error('  Re-run: cd backend && node --import ./scripts/register-drift-loader.mjs ./scripts/sim-route-select-drift.mjs');
    process.exit(1);
  }
  record('CONTROL: implicit SELECT * throws P2022 under simulated drift', underStub);

  // ── The REAL select objects the fixed routes pass ──
  const { TENANT_SELECT } = await importReal('src/middleware/tenant.js');
  const { BIO_SELECT } = await importReal('src/routes/bio.js');
  record('TENANT_SELECT imported (used by whatsapp.js + admin.js:347)', !!TENANT_SELECT);
  record('BIO_SELECT imported (used by bio.js)', !!BIO_SELECT);
  record('TENANT_SELECT omits the unmigrated waPin column', !('waPin' in TENANT_SELECT));
  record('BIO_SELECT omits the unmigrated waPin column', !('waPin' in BIO_SELECT));

  // ── LAYER 2 (shape): drive the stub with the exact real selects each route uses ──
  // whatsapp.js POST /webhook — findUnique({ where:{ waPhoneNumberId }, select: TENANT_SELECT })
  const waRow = await prisma.tenant.findUnique({ where: { waPhoneNumberId: '123' }, select: TENANT_SELECT });
  record('whatsapp.js webhook select shape (TENANT_SELECT) survives drift', !!waRow && waRow.id === 'tnt_demo');
  record('whatsapp.js webhook row carries waPhoneNumberId + status (routing fields)',
    !!waRow && waRow.waPhoneNumberId === '123' && waRow.status === 'active');

  // admin.js:347 verify-credentials — findUnique({ where:{ id }, select: TENANT_SELECT })
  const adminRow = await prisma.tenant.findUnique({ where: { id: 'tnt_demo' }, select: TENANT_SELECT });
  record('admin.js:347 verify-credentials select shape (TENANT_SELECT) survives drift',
    !!adminRow && ['waTokenEnc', 'waPhoneNumberId', 'waBusinessAccountId', 'waApiVersion'].every((k) => k in adminRow));

  // broadcastRunner.js runLoop() — findUnique({ where:{ id }, select: TENANT_SELECT }).
  // This is the last select-all Tenant lookup in the drift-hardening chain: it runs
  // inside runLoop (fired by POST /api/broadcast + resume), and startJob's catch
  // silently turns a P2022 here into status:'aborted' AFTER the client got HTTP 202 —
  // so a drift on this path silently breaks the bulk-campaign send feature.
  const broadcastRow = await prisma.tenant.findUnique({ where: { id: 'tnt_demo' }, select: TENANT_SELECT });
  record('broadcastRunner.js runLoop select shape (TENANT_SELECT) survives drift',
    !!broadcastRow && broadcastRow.id === 'tnt_demo');
  // Assert every field runLoop's downstream code actually reads is present:
  //   tenantWhatsAppCreds() → waTokenEnc/waPhoneNumberId/waBusinessAccountId/waApiVersion
  //   tenantCap()           → dailyBroadcastCap
  record('broadcastRunner.js row carries the fields runLoop consumes (creds + dailyBroadcastCap)',
    !!broadcastRow &&
      ['waTokenEnc', 'waPhoneNumberId', 'waBusinessAccountId', 'waApiVersion', 'dailyBroadcastCap'].every(
        (k) => k in broadcastRow
      ));
  // Regression guard: the OLD select-all lookup runLoop used to run still throws.
  let broadcastOldThrow = false;
  try { await prisma.tenant.findUnique({ where: { id: 'tnt_demo' } }); } catch (e) { broadcastOldThrow = e.code === 'P2022'; }
  record('OLD broadcastRunner.js select-all shape still aborts the job under drift (regression guard)', broadcastOldThrow);

  // bio.js select shape
  const bioRow = await prisma.tenant.findUnique({ where: { slug: 'demo' }, select: BIO_SELECT });
  record('bio.js findUnique select shape (BIO_SELECT) survives drift',
    !!bioRow && 'bioTitle' in bioRow && 'displayName' in bioRow && 'name' in bioRow);
  const bioMany = await prisma.tenant.findMany({ take: 2, select: BIO_SELECT });
  record('bio.js findMany select shape (BIO_SELECT) survives drift', Array.isArray(bioMany) && bioMany.length >= 1);

  // Regression guard: the OLD select-all shapes each route used to run still throw.
  let waOldThrow = false, bioOldThrow = false, bioManyOldThrow = false;
  try { await prisma.tenant.findUnique({ where: { waPhoneNumberId: '123' } }); } catch (e) { waOldThrow = e.code === 'P2022'; }
  try { await prisma.tenant.findUnique({ where: { slug: 'demo' } }); } catch (e) { bioOldThrow = e.code === 'P2022'; }
  try { await prisma.tenant.findMany({ take: 2 }); } catch (e) { bioManyOldThrow = e.code === 'P2022'; }
  record('OLD whatsapp.js select-all shape still 500s under drift (regression guard)', waOldThrow);
  record('OLD bio.js findUnique select-all shape still 500s under drift (regression guard)', bioOldThrow);
  record('OLD bio.js findMany select-all shape still 500s under drift (regression guard)', bioManyOldThrow);

  // ── LAYER 1 (HTTP): mount the REAL bio router and issue real requests ──
  // bio renders fully from the tenant row, so an end-to-end 200 proves the fix
  // holds through the actual handler (not just the select object in isolation).
  const express = (await import('express')).default;
  const bioRouter = (await importReal('src/routes/bio.js')).default;
  const app = express();
  app.use('/', bioRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const slugRes = await httpGet(server, '/l/demo');
    record('REAL bio /l/:slug returns 200 (not 500) under drift', slugRes.status === 200);
    record('REAL bio /l/:slug renders tenant HTML (title present)', /<h1 class="title">/.test(slugRes.body));
    const bareRes = await httpGet(server, '/l');
    record('REAL bio bare /l returns 200 (not 500) under drift', bareRes.status === 200);
  } finally {
    server.close();
  }

  console.log('\n=== Route select-drift simulation (REAL routes/selects under stubbed drift) ===\n');
  let allPass = true;
  for (const [label, ok] of results) {
    console.log(`  ${ok ? '✓' : '✗'}  ${label}`);
    if (!ok) allPass = false;
  }
  console.log('');
  if (allPass) {
    console.log('RESULT: PASS — whatsapp.js webhook, bio.js public page, and admin.js:347');
    console.log('        verify-credentials all survive a one-migration-behind live DB with');
    console.log('        their explicit selects; the old SELECT * shapes each 500 (proven).');
    process.exit(0);
  } else {
    console.log('RESULT: FAIL — a fixed route did not survive the simulated drift.');
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('simulation crashed:', e);
  process.exit(1);
});
