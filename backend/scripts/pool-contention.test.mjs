#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WA-DEV-POOL-CONTENTION — the REAL fix for the pgbouncer connection_limit=1 bug.
//
// Board task whatsapp-agent-pgbouncer-connection-limit-1-is: connection_limit=1 on the
// Supabase pgbouncer transaction pooler was undersized APP-WIDE. Every interactive
// prisma.$transaction() in the app (chargeAiCredit + grantCredits in lib/credits.js, the
// payment webhook flip+grant in routes/payments.js, admin mark-paid in routes/admin.js,
// the flows reorder in routes/flows.js) shares ONE Prisma client pool. With size 1, while
// any ONE txn holds the sole connection, every OTHER site queues for it and — with Prisma's
// DEFAULT ~2s maxWait — throws P2028 ("Unable to start a transaction in the given time")
// and drops a payment/admin/message. Commit 87b7c8c only made chargeAiCredit's OWN txn
// more patient (maxWait 15s); that is a stopgap, not capacity, and can itself starve the
// other sites. The fix is POOL SIZE: connection_limit is raised in DATABASE_URL.
//
// This harness proves the fix WITHOUT anyone hand-editing .env:
//   GATE   — reads the SAME real DATABASE_URL the app uses and asserts connection_limit>=5,
//            so a regressed/undersized pool fails LOUDLY instead of silently starving.
//   PROOF  — 1 slow txn pins a connection for ~3s while 4 sibling txns (each with Prisma's
//            DEFAULT maxWait, i.e. exactly the other call sites' behavior) run concurrently.
//            With an adequate pool all 4 siblings get their own connection and succeed
//            (0 starved). At connection_limit=1 this same shape starves 4/4 (P2028) — that
//            is the bug this test locks in as fixed.
//
// Uses only trivial SELECTs — touches NO application rows. Run from backend/:
//   node scripts/pool-contention.test.mjs
// Exit 0 = pass; exit 1 = fail (pool too small, or siblings starved).
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import prisma from '../src/lib/prisma.js';

// The minimum pool the app's realistic worst-case concurrent-transaction demand needs.
// Reviewer's evidence run used 5 successfully; the shipped value is 10 (headroom for
// several concurrent tenant AI-reply charges + a payment webhook + an admin action at
// once, still well under Supabase's default 15-conn pooler ceiling per instance).
const MIN_CONNECTION_LIMIT = 5;

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

async function main() {
  const url = process.env.DATABASE_URL || '';
  const m = url.match(/[?&]connection_limit=(\d+)/);
  const limit = m ? Number(m[1]) : null;
  console.log(`DATABASE_URL connection_limit = ${limit ?? '(unset → Prisma default)'}`);

  // ── GATE: the real config must carry an adequately-sized pool ────────────────
  // (unset would inherit Prisma's default, which for a pgbouncer URL is NOT safe to
  //  assume; we require it explicit and >= MIN so the config is self-documenting.)
  check(
    `GATE — DATABASE_URL connection_limit is set and >= ${MIN_CONNECTION_LIMIT}`,
    limit !== null && limit >= MIN_CONNECTION_LIMIT,
    `connection_limit=${limit ?? 'unset'}`
  );

  // ── PROOF: sibling transactions do NOT starve while one txn holds a connection ──
  // holder pins ONE connection ~3s (elevated opts, like a slow charge could be); the 4
  // siblings use DEFAULT options — exactly what payments/admin/flows sites use today.
  const holder = prisma
    .$transaction(async (tx) => { await tx.$executeRaw`SELECT pg_sleep(3)`; return 'held'; },
      { timeout: 10000, maxWait: 10000 })
    .then((v) => ({ ok: true, v }))
    .catch((e) => ({ ok: false, code: e?.code, msg: String(e?.message).split('\n')[0] }));

  // Let the holder grab a connection first so the siblings genuinely contend for the pool.
  await new Promise((r) => setTimeout(r, 150));

  const siblings = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      prisma
        .$transaction(async (tx) => { await tx.$executeRaw`SELECT 1`; return `ok-${i}`; }) // DEFAULT maxWait
        .then((v) => ({ ok: true, v }))
        .catch((e) => ({ ok: false, code: e?.code, msg: String(e?.message).split('\n')[0] }))
    )
  );
  const h = await holder;

  const starved = siblings.filter((s) => !s.ok).length;
  check('PROOF — the slow holder transaction completed', h.ok === true, h.ok ? '' : `code=${h.code}`);
  check(
    'PROOF — all 4 sibling (default-maxWait) transactions completed, none starved',
    starved === 0,
    `starved=${starved}/4${starved ? ' — pool too small: head-of-line blocking (P2028)' : ''}`
  );

  await prisma.$disconnect();
  console.log(failed === 0 ? '\nALL CASES PASSED' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('HARNESS ERROR:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
