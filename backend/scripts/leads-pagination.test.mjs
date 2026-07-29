// Behavioral verification for the Leads-pipeline pagination fix
// (board task whatsapp-agent-leads-pipeline-frontend-src).
//
// The frontend bug: frontend/src/pages/Leads.jsx fetched a single ?pageSize=100 page and
// rendered only res.data.items — but the backend caps pageSize at 100, so any tenant with
// >100 conversations silently lost the overflow (the stale/cooling leads, since results are
// ordered by lastActivityAt desc). The fix pages through the { total, page, pageSize, items }
// envelope until all `total` rows are collected.
//
// This script proves the API + the new client-side paging loop behavior end-to-end against
// the REAL Express app and the REAL DB:
//   1. seed a throwaway tenant + customer + N (>100) conversations,
//   2. boot the real app, authenticate as that tenant,
//   3. assert a single ?pageSize=100 call returns ONLY 100 (reproduces the bug),
//   4. run the SAME paging loop the fixed Leads.jsx uses and assert it returns ALL N,
//   5. assert no lastActivityAt-ordered rows were dropped (the stale leads survive),
//   6. clean up EXACTLY the ids created (never a prefix/pattern delete).
//
// Run:  node scripts/leads-pagination.test.mjs
// (from backend/ — it's a workspace package with prisma access)

import http from 'node:http';
import prisma from '../src/lib/prisma.js';
import app from '../src/app.js';
import { signToken } from '../src/middleware/auth.js';

const N = 137; // > 100 → spans 2 pages (100 + 37). The number the old code silently dropped: 37.
const PAGE_SIZE = 100;
const RUN_TAG = `leadstest-${Date.now()}`; // unique marker for THIS run only.

// Exact ids we create — cleanup deletes ONLY these, never a pattern/prefix match.
const createdConversationIds = [];
let tenantId = null;
let customerId = null;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// The exact paging loop the fixed Leads.jsx uses, expressed against a base http request fn.
async function fetchAllConversations(getPage) {
  const all = [];
  let page = 1;
  let total = Infinity;
  const MAX_PAGES = 500;
  while (all.length < total && page <= MAX_PAGES) {
    const data = await getPage(page);
    const batch = data.items || [];
    all.push(...batch);
    total = Number.isFinite(data.total) ? data.total : (batch.length < PAGE_SIZE ? all.length : Infinity);
    if (batch.length === 0) break;
    page += 1;
  }
  return all;
}

async function main() {
  console.log(`\n▶ Leads pagination test (${RUN_TAG}) — seeding ${N} conversations…`);

  // ── 1. Seed throwaway tenant + customer + N conversations ──
  // NOTE: Tenant.waPin is declared in schema.prisma but NOT yet migrated live (pre-existing
  // schema drift documented in memory/developer-notes.md / AP-T71). A normal
  // prisma.tenant.create() does an implicit RETURNING * and throws P2022 on the missing
  // column — unrelated to this task's fix. We insert the tenant via raw SQL (only live-safe
  // columns) and read it back with an explicit select to sidestep that drift.
  tenantId = `leadstest_${RUN_TAG.replace(/[^a-z0-9]/gi, '')}`;
  await prisma.$executeRaw`
    INSERT INTO "Tenant" ("id", "name", "slug", "plan", "createdAt", "updatedAt")
    VALUES (${tenantId}, ${`LeadsTest ${RUN_TAG}`}, ${RUN_TAG}, 'trial', now(), now())
  `;

  const customer = await prisma.customer.create({
    data: { tenantId, phone: `+99999${Date.now() % 100000}`, name: `LeadsTest Customer ${RUN_TAG}` },
  });
  customerId = customer.id;

  // Spread lastActivityAt so ordering (desc) is meaningful: conversation i is i minutes older.
  const base = Date.now();
  for (let i = 0; i < N; i++) {
    const conv = await prisma.conversation.create({
      data: {
        tenantId,
        customerId,
        whatsappPhone: customer.phone,
        status: 'active',
        lastMessage: `${RUN_TAG} msg #${i}`,
        leadScore: i % 100,
        lastActivityAt: new Date(base - i * 60_000), // i=0 newest, i=N-1 oldest (staleest).
      },
    });
    createdConversationIds.push(conv.id);
  }
  console.log(`  seeded tenant=${tenantId} customer=${customerId} conversations=${createdConversationIds.length}`);

  // ── 2. Boot the real app + auth as this tenant ──
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const token = signToken({ sub: `leadstest-admin-${RUN_TAG}`, role: 'admin', tenantId });

  function apiGet(path) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  try {
    // ── 3. Reproduce the OLD bug: single pageSize=100 call drops the overflow ──
    console.log('\n— OLD behavior (single ?pageSize=100 call, what Leads.jsx used to do):');
    const single = await apiGet('/api/conversations?pageSize=100');
    assert(single.total === N, `server reports total=${N} (actual=${single.total})`);
    assert(single.items.length === 100, `single page returns only 100 items (got ${single.items.length}) — the API hard-caps pageSize at 100`);
    assert(single.items.length < single.total, `single page (${single.items.length}) < total (${single.total}) → ${single.total - single.items.length} leads silently dropped by the old code`);

    // ── 4. NEW behavior: the paging loop from the fixed Leads.jsx retrieves ALL rows ──
    console.log('\n— NEW behavior (fetchAllConversations paging loop, the fix):');
    const all = await fetchAllConversations((page) => apiGet(`/api/conversations?page=${page}&pageSize=${PAGE_SIZE}`));
    assert(all.length === N, `paging loop retrieves ALL ${N} conversations (got ${all.length})`);

    // Only our seeded rows (isolated tenant), and no duplicates from paging.
    const ids = new Set(all.map((c) => c.id));
    assert(ids.size === N, `no duplicate conversations across pages (unique ids=${ids.size})`);
    for (const id of createdConversationIds) {
      assert(ids.has(id), `seeded conversation ${id.slice(0, 8)}… present in the full set`);
      break; // spot-check one loudly; full-set check below covers the rest silently.
    }
    const missing = createdConversationIds.filter((id) => !ids.has(id));
    assert(missing.length === 0, `every one of the ${N} seeded conversations is in the paged result (missing=${missing.length})`);

    // ── 5. The dropped-by-old-code rows ARE the stale ones, and they now survive ──
    // Server orders by lastActivityAt desc; the OLD first-100 window is the newest 100,
    // so the 37 the old code dropped are the OLDEST (staleest) — exactly the follow-up leads.
    const firstPageIds = new Set(single.items.map((c) => c.id));
    const droppedByOldCode = createdConversationIds.filter((id) => !firstPageIds.has(id));
    assert(droppedByOldCode.length === N - 100, `old code dropped exactly ${N - 100} rows (the overflow past 100)`);
    const allNowHasDropped = droppedByOldCode.every((id) => ids.has(id));
    assert(allNowHasDropped, `all ${droppedByOldCode.length} previously-dropped (stale/cooling) leads are now present in the pipeline`);

    // Confirm the dropped ones really are the oldest by activity (the stale follow-up leads).
    const oldest = all
      .slice()
      .sort((a, b) => new Date(a.lastActivityAt) - new Date(b.lastActivityAt))
      .slice(0, N - 100)
      .map((c) => c.id);
    const droppedSet = new Set(droppedByOldCode);
    assert(oldest.every((id) => droppedSet.has(id)), `the leads the old code dropped are precisely the ${N - 100} OLDEST-by-activity (stale) leads`);

    console.log('\n✅ ALL ASSERTIONS PASSED — pagination fix retrieves the full lead pipeline.');
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function cleanup() {
  // Scope every delete to EXACTLY the ids created in THIS run — never a prefix/pattern match.
  try {
    if (createdConversationIds.length) {
      const del = await prisma.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
      console.log(`\n🧹 deleted ${del.count} test conversations (by exact id list)`);
    }
    if (customerId) {
      await prisma.customer.delete({ where: { id: customerId } });
      console.log(`🧹 deleted test customer ${customerId}`);
    }
    if (tenantId) {
      // Raw delete (not prisma.tenant.delete) to avoid the waPin RETURNING * drift (see seed note).
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
