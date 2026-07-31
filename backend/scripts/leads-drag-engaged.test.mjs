// Behavioral verification for the Leads-pipeline "drag to בטיפול (engaged)" fix
// (board task whatsapp-agent-leads-kanban-dragging-card-to).
//
// The bug (found by QA via Playwright): dragging a lead card into the "engaged" column
// returned HTTP 200 but was a structural no-op — the DB row was unchanged, so on reload
// the card snapped back to "new". Root cause: frontend stageAction() sent
// PUT /status { status:'active' }, but a "new" card is ALREADY status:'active', and
// stageOf() classifies "engaged" from linkSent || leadScore>=40 || flow — none of which
// that write set. So nothing changed.
//
// The fix: the engaged drop now sends { status:'active', linkSent:true }, and the backend
// PUT /:id/status endpoint now accepts an explicit boolean linkSent. This proves it against
// the REAL Express app + REAL DB:
//   1. seed a throwaway tenant + customer + one conversation in a "new" state
//      (status:'active', linkSent:false, leadScore:0, no flow → stageOf === 'new'),
//   2. boot the real app, authenticate as that tenant,
//   3. reproduce the OLD no-op: PUT { status:'active' } → DB linkSent still false → still 'new',
//   4. apply the FIX payload: PUT { status:'active', linkSent:true } → HTTP 200,
//   5. read the row back FROM THE DB (Prisma) and assert linkSent === true (persisted),
//   6. assert stageOf(row) === 'engaged' (the card now correctly classifies as engaged),
//   7. clean up EXACTLY the ids created (never a prefix/pattern delete).
//
// Run:  node scripts/leads-drag-engaged.test.mjs   (from backend/ — a workspace package)

import http from 'node:http';
import prisma from '../src/lib/prisma.js';
import app from '../src/app.js';
import { signToken } from '../src/middleware/auth.js';

// stageOf() copied verbatim from frontend/src/pages/Leads.jsx — the single source of truth
// for how a conversation row is classified into a pipeline stage. Kept in sync by hand;
// if the frontend derivation changes, this must too.
function stageOf(c) {
  if (c.status === 'completed') return 'won';
  if (c.status === 'abandoned') return 'lost';
  if (c.needsHuman || c.status === 'needs_human') return 'qualified';
  if (c.linkSent || (c.leadScore || 0) >= 40 || c.currentFlowId) return 'engaged';
  return 'new';
}

const RUN_TAG = `dragtest-${Date.now()}`;
const createdConversationIds = [];
let tenantId = null;
let customerId = null;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  console.log(`\n▶ Leads drag-to-engaged test (${RUN_TAG})…`);

  // ── 1. Seed throwaway tenant + customer + one "new"-state conversation ──
  // Tenant.waPin drift (AP-T71): insert tenant via raw SQL (live-safe columns only) to
  // avoid the implicit RETURNING * that throws P2022 on the un-migrated waPin column.
  tenantId = `dragtest_${RUN_TAG.replace(/[^a-z0-9]/gi, '')}`;
  await prisma.$executeRaw`
    INSERT INTO "Tenant" ("id", "name", "slug", "plan", "createdAt", "updatedAt")
    VALUES (${tenantId}, ${`DragTest ${RUN_TAG}`}, ${RUN_TAG}, 'trial', now(), now())
  `;

  const customer = await prisma.customer.create({
    data: { tenantId, phone: `+99998${Date.now() % 100000}`, name: `DragTest Customer ${RUN_TAG}` },
  });
  customerId = customer.id;

  // A pristine "new" lead: active, no link sent, low score, no flow.
  const conv = await prisma.conversation.create({
    data: {
      tenantId,
      customerId,
      whatsappPhone: customer.phone,
      status: 'active',
      linkSent: false,
      leadScore: 0,
      lastMessage: `${RUN_TAG} hello`,
    },
  });
  createdConversationIds.push(conv.id);
  assert(stageOf(conv) === 'new', `seed conversation classifies as "new" (stageOf=${stageOf(conv)})`);

  // ── 2. Boot the real app + auth as this tenant ──
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const token = signToken({ sub: `dragtest-admin-${RUN_TAG}`, role: 'admin', tenantId });

  function apiPut(path, bodyObj) {
    const body = JSON.stringify(bodyObj);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, path, method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode, body: b }));
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async function dbRow() {
    return prisma.conversation.findUnique({
      where: { id: conv.id },
      select: { id: true, status: true, needsHuman: true, linkSent: true, leadScore: true, currentFlowId: true },
    });
  }

  try {
    // ── 3. Reproduce the OLD no-op: PUT { status:'active' } changes nothing meaningful ──
    console.log('\n— OLD behavior (what the engaged drop used to send): PUT { status:"active" }');
    const before = await dbRow();
    const oldRes = await apiPut(`/api/conversations/${conv.id}/status`, { status: 'active' });
    assert(oldRes.status === 200, `old payload returns HTTP 200 (got ${oldRes.status})`);
    const afterOld = await dbRow();
    assert(afterOld.linkSent === false, `linkSent still false after old payload — DB unchanged (the no-op bug)`);
    assert(stageOf(afterOld) === 'new', `card still classifies as "new" after old payload (stageOf=${stageOf(afterOld)}) → snaps back on reload`);
    assert(before.linkSent === afterOld.linkSent, `old payload is a structural no-op on the engaged signal`);

    // ── 4. Apply the FIX payload the fixed Leads.jsx now sends ──
    console.log('\n— NEW behavior (the fix): PUT { status:"active", linkSent:true }');
    const fixRes = await apiPut(`/api/conversations/${conv.id}/status`, { status: 'active', linkSent: true });
    assert(fixRes.status === 200, `fix payload returns HTTP 200 (got ${fixRes.status})`);

    // ── 5. Read back FROM THE DB and assert it actually persisted ──
    const afterFix = await dbRow();
    assert(afterFix.linkSent === true, `linkSent === true in the DB after fix payload — the write PERSISTED`);

    // ── 6. The card now correctly classifies as engaged ──
    assert(stageOf(afterFix) === 'engaged', `card now classifies as "engaged" (stageOf=${stageOf(afterFix)}) → sticks on reload`);

    // ── Guard: non-boolean linkSent is ignored (no accidental coercion) ──
    console.log('\n— Guard: endpoint accepts only an explicit boolean linkSent');
    const badRes = await apiPut(`/api/conversations/${conv.id}/status`, { status: 'active', linkSent: 'yes' });
    assert(badRes.status === 200, `non-boolean linkSent still returns 200 (ignored, not 400) (got ${badRes.status})`);
    const afterBad = await dbRow();
    assert(afterBad.linkSent === true, `linkSent unchanged by non-boolean value (still true — string 'yes' was ignored)`);

    console.log('\n✅ ALL ASSERTIONS PASSED — dragging a card to "בטיפול" now persists linkSent and the card stays engaged on reload.');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function cleanup() {
  try {
    if (createdConversationIds.length) {
      const del = await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
      console.log(`\n🧹 deleted ${del.count} test conversation(s) (by exact id list)`);
    }
    if (customerId) {
      await prisma.customer.delete({ where: { id: customerId } });
      console.log(`🧹 deleted test customer ${customerId}`);
    }
    if (tenantId) {
      await prisma.$executeRaw`DELETE FROM "Tenant" WHERE "id" = ${tenantId}`;
      console.log(`🧹 deleted test tenant ${tenantId}`);
    }
  } catch (e) {
    console.error('CLEANUP ERROR (manual removal may be needed for the ids above):', e.message);
    throw e;
  }
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error('\n❌ TEST FAILED:', e.message);
} finally {
  await cleanup();
  await prisma.$disconnect();
}
process.exit(failed ? 1 : 0);
