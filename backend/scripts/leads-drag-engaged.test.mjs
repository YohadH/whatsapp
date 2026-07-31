// Behavioral verification for the Leads-pipeline "drag to בטיפול (engaged)" fix
// (board task whatsapp-agent-leads-kanban-engaged-drag-sets).
//
// The bug (found by QA via Playwright): dragging a lead card into the "engaged" column
// returned HTTP 200 but was a structural no-op — the DB row was unchanged, so on reload
// the card snapped back to "new". Root cause: frontend stageAction() sent
// PUT /status { status:'active' }, but a "new" card is ALREADY status:'active', and
// stageOf() classifies "engaged" from linkSent || leadScore>=40 || flow — none of which
// that write set. So nothing changed.
//
// The FIRST (partial) fix overloaded linkSent:true to force the classification. That was
// WRONG: linkSent is a truthful "a real trackable link was dispatched" signal — it adds
// +10 to leadScore (services/leadScore.js) and drives the "נשלח קישור: כן" row on
// ConversationDetail. Overloading it inflated the score and lied about a link being sent.
//
// The CORRECT fix (this test): a DISTINCT engaged marker — the reserved tag
// ENGAGED_TAG ('pipeline:engaged') in the already-migrated `tags` JSON column. The drag
// handler now sends { status:'active', engaged:true } (or engaged:false when dragged back
// out), the backend toggles ENGAGED_TAG in `tags` (preserving any other tags), and
// stageOf() reads the tag. linkSent and leadScore are never touched by a manual drag.
//
// This proves it against the REAL Express app + REAL DB:
//   1. seed a throwaway tenant + customer + one "new"-state conversation
//      (status:'active', linkSent:false, leadScore:0, tags:[], no flow → stageOf === 'new'),
//   2. boot the real app, authenticate as that tenant,
//   3. reproduce the OLD no-op: PUT { status:'active' } → DB unchanged → still 'new',
//   4. apply the FIX payload: PUT { status:'active', engaged:true } → HTTP 200,
//   5. read the row back FROM THE DB (Prisma) and assert:
//        - tags now contains ENGAGED_TAG (the engaged marker PERSISTED),
//        - linkSent is STILL false (not overloaded — no false "link sent"),
//        - leadScore is STILL 0 (not inflated by +10),
//        - stageOf(row) === 'engaged' (the card sticks on reload),
//   6. drag back to "new": PUT { status:'active', engaged:false } → ENGAGED_TAG removed,
//      other tags preserved, stageOf === 'new' again,
//   7. guard: a non-boolean `engaged` is ignored (no accidental coercion),
//   8. clean up EXACTLY the ids created (never a prefix/pattern delete).
//
// Run:  node scripts/leads-drag-engaged.test.mjs   (from backend/ — a workspace package)

import http from 'node:http';
import prisma from '../src/lib/prisma.js';
import app from '../src/app.js';
import { signToken } from '../src/middleware/auth.js';
import { ENGAGED_TAG } from '../src/routes/conversations.js';

// stageOf() copied verbatim from frontend/src/pages/Leads.jsx — the single source of truth
// for how a conversation row is classified into a pipeline stage. Kept in sync by hand;
// if the frontend derivation changes, this must too. (currentFlowId here mirrors the
// frontend's `c.flow` — the list route hydrates a `flow` relation from currentFlowId.)
function stageOf(c) {
  if (c.status === 'completed') return 'won';
  if (c.status === 'abandoned') return 'lost';
  if (c.needsHuman || c.status === 'needs_human') return 'qualified';
  const tags = Array.isArray(c.tags) ? c.tags : [];
  if (tags.includes(ENGAGED_TAG) || c.linkSent || (c.leadScore || 0) >= 40 || c.currentFlowId) return 'engaged';
  return 'new';
}

const RUN_TAG = `dragtest-${Date.now()}`;
const OTHER_TAG = 'keepme:unrelated'; // an unrelated tag that must survive engaged toggling
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

  // A pristine "new" lead: active, no link sent, low score, no flow, one unrelated tag
  // (to prove the engaged toggle preserves existing tags rather than clobbering them).
  const conv = await prisma.conversation.create({
    data: {
      tenantId,
      customerId,
      whatsappPhone: customer.phone,
      status: 'active',
      linkSent: false,
      leadScore: 0,
      tags: [OTHER_TAG],
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
      select: { id: true, status: true, needsHuman: true, linkSent: true, leadScore: true, currentFlowId: true, tags: true },
    });
  }
  const hasEngagedTag = (row) => Array.isArray(row.tags) && row.tags.includes(ENGAGED_TAG);
  const hasOtherTag = (row) => Array.isArray(row.tags) && row.tags.includes(OTHER_TAG);

  try {
    // ── 3. Reproduce the OLD no-op: PUT { status:'active' } changes nothing meaningful ──
    console.log('\n— OLD behavior (what the engaged drop used to send): PUT { status:"active" }');
    const before = await dbRow();
    const oldRes = await apiPut(`/api/conversations/${conv.id}/status`, { status: 'active' });
    assert(oldRes.status === 200, `old payload returns HTTP 200 (got ${oldRes.status})`);
    const afterOld = await dbRow();
    assert(!hasEngagedTag(afterOld), `no ENGAGED_TAG after old payload — DB unchanged (the no-op bug)`);
    assert(stageOf(afterOld) === 'new', `card still classifies as "new" after old payload (stageOf=${stageOf(afterOld)}) → snaps back on reload`);

    // ── 4. Apply the FIX payload the fixed Leads.jsx now sends ──
    console.log('\n— NEW behavior (the fix): PUT { status:"active", engaged:true }');
    const fixRes = await apiPut(`/api/conversations/${conv.id}/status`, { status: 'active', engaged: true });
    assert(fixRes.status === 200, `fix payload returns HTTP 200 (got ${fixRes.status})`);

    // ── 5. Read back FROM THE DB and assert the engaged marker persisted WITHOUT side effects ──
    const afterFix = await dbRow();
    assert(hasEngagedTag(afterFix), `tags now contains ENGAGED_TAG in the DB — the engaged move PERSISTED`);
    assert(hasOtherTag(afterFix), `the pre-existing unrelated tag survived the toggle (tags not clobbered)`);
    assert(afterFix.linkSent === false, `linkSent STILL false — a manual engaged move did NOT overload it (no false "נשלח קישור")`);
    assert(afterFix.leadScore === 0, `leadScore STILL 0 — a manual engaged move did NOT inflate it by +10`);
    assert(stageOf(afterFix) === 'engaged', `card now classifies as "engaged" (stageOf=${stageOf(afterFix)}) → sticks on reload`);

    // ── 6. Drag back OUT to "new": PUT { status:'active', engaged:false } removes the marker ──
    console.log('\n— Drag back to "new": PUT { status:"active", engaged:false }');
    const backRes = await apiPut(`/api/conversations/${conv.id}/status`, { status: 'active', engaged: false });
    assert(backRes.status === 200, `engaged:false payload returns HTTP 200 (got ${backRes.status})`);
    const afterBack = await dbRow();
    assert(!hasEngagedTag(afterBack), `ENGAGED_TAG removed after engaged:false — card can leave "בטיפול"`);
    assert(hasOtherTag(afterBack), `the unrelated tag STILL survives after removing the engaged marker`);
    assert(stageOf(afterBack) === 'new', `card classifies as "new" again (stageOf=${stageOf(afterBack)})`);

    // ── 7. Guard: a non-boolean `engaged` is ignored (no accidental coercion) ──
    console.log('\n— Guard: endpoint accepts only an explicit boolean engaged');
    // First set it true so we can prove a bad value neither adds nor removes the marker.
    await apiPut(`/api/conversations/${conv.id}/status`, { status: 'active', engaged: true });
    assert(hasEngagedTag(await dbRow()), `precondition: ENGAGED_TAG set before the guard check`);
    const badRes = await apiPut(`/api/conversations/${conv.id}/status`, { status: 'active', engaged: 'yes' });
    assert(badRes.status === 200, `non-boolean engaged still returns 200 (ignored, not 400) (got ${badRes.status})`);
    const afterBad = await dbRow();
    assert(hasEngagedTag(afterBad), `ENGAGED_TAG unchanged by non-boolean value (string 'yes' was ignored, not treated as truthy/falsy)`);

    console.log('\n✅ ALL ASSERTIONS PASSED — dragging a card to "בטיפול" now persists a distinct engaged marker (ENGAGED_TAG in tags) without touching linkSent/leadScore; the card sticks on reload and can be dragged back out.');
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
