// Concurrency test for the inbound-waMessageId TOCTOU dedup fix
// (whatsapp-agent-non-blocking-follow-up-from-bug / AP-T72).
//
// Proves the OLD pattern (findUnique dedup check → separate message.create with no
// atomic guard) lets N truly-concurrent deliveries of the SAME waMessageId BOTH pass
// the check and BOTH insert a customer message row (→ double reply + double LLM
// charge), while the NEW pattern (create is the atomic gate; a P2002 unique-constraint
// violation on Message.@@unique([tenantId, waMessageId]) is treated as "duplicate,
// skip") yields exactly ONE inserted row + exactly ONE winner regardless of N.
//
// Runs against the live DB on a throwaway tenant/customer/conversation, cleaned up by
// id. This exercises the exact DB race the fix closes (the constraint + the P2002
// classification isDuplicateWaMessage uses), without calling OpenAI or Meta.
//
// Run from the backend package root:  node scripts/toctou-inbound-dedup-test.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CONCURRENCY = 10;
let tenantId = null;

// Same P2002-classifier the production fix uses (kept in sync with
// isDuplicateWaMessage in src/services/conversationEngine.js).
function isDuplicateWaMessage(err) {
  if (err?.code !== 'P2002') return false;
  const target = err?.meta?.target;
  if (Array.isArray(target)) return target.includes('waMessageId');
  return typeof target === 'string' ? target.includes('waMessageId') : true;
}

// OLD (buggy) inbound handler slice: check-then-create with NO atomic guard —
// exactly the pre-fix shape (findUnique at step 0, then a bare message.create()).
async function inbound_OLD({ conversationId, waMessageId }) {
  const seen = await prisma.message.findUnique({
    where: { tenantId_waMessageId: { tenantId, waMessageId } },
    select: { id: true },
  });
  if (seen) return { duplicate: true, created: false };
  // Nudge the interleave so both concurrent callers pass the check before either
  // inserts — the classic TOCTOU window (Read Committed can't serialize this).
  await new Promise((r) => setTimeout(r, 5));
  await prisma.message.create({
    data: { tenantId, conversationId, senderType: 'customer', messageText: 'hi', waMessageId },
  });
  return { duplicate: false, created: true };
}

// NEW inbound handler slice: the create IS the atomic dedup gate; a P2002 on the
// waMessageId unique index → duplicate, skip (no reply). Mirrors the production fix.
async function inbound_NEW({ conversationId, waMessageId }) {
  const seen = await prisma.message.findUnique({
    where: { tenantId_waMessageId: { tenantId, waMessageId } },
    select: { id: true },
  });
  if (seen) return { duplicate: true, created: false };
  await new Promise((r) => setTimeout(r, 5));
  try {
    await prisma.message.create({
      data: { tenantId, conversationId, senderType: 'customer', messageText: 'hi', waMessageId },
    });
    return { duplicate: false, created: true };
  } catch (err) {
    if (isDuplicateWaMessage(err)) return { duplicate: true, created: false };
    throw err;
  }
}

async function rowCount(waMessageId) {
  return prisma.message.count({ where: { tenantId, waMessageId } });
}

async function run(fn, waMessageId, conversationId) {
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      fn({ conversationId, waMessageId }).catch((e) => ({ err: e.code || e.message }))
    )
  );
  const created = results.filter((r) => r && r.created).length;
  const errs = results.filter((r) => r && r.err).length;
  const rows = await rowCount(waMessageId);
  return { created, errs, rows, results };
}

(async () => {
  try {
    const t = await prisma.tenant.create({
      data: {
        name: `TOCTOU-inbound-${Date.now()}`,
        slug: `toctou-inbound-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      select: { id: true },
    });
    tenantId = t.id;
    const customer = await prisma.customer.create({
      data: { tenantId, phone: `+000${Date.now()}`.slice(0, 15) },
      select: { id: true },
    });
    const conv = await prisma.conversation.create({
      data: { tenantId, customerId: customer.id, whatsappPhone: '+000', status: 'active' },
      select: { id: true },
    });

    // 1) OLD pattern — same waMessageId, N concurrent → expect >1 insert (race real).
    const oldWa = `wamid-OLD-${Date.now()}`;
    const oldRun = await run(inbound_OLD, oldWa, conv.id);
    console.log(
      `OLD check-then-create:  created=${oldRun.created}  rows=${oldRun.rows}  errs=${oldRun.errs}  (expect created>1, rows>1 → race)`
    );

    // 2) NEW pattern — same waMessageId, N concurrent → expect exactly 1 insert.
    const newWa = `wamid-NEW-${Date.now()}`;
    const newRun = await run(inbound_NEW, newWa, conv.id);
    console.log(
      `NEW create-is-the-gate:  created=${newRun.created}  rows=${newRun.rows}  errs=${newRun.errs}  (expect created=1, rows=1)`
    );

    // 3) A late redelivery on the already-stored NEW waMessageId → duplicate, no insert.
    const late = await inbound_NEW({ conversationId: conv.id, waMessageId: newWa });
    console.log(`NEW late redelivery: duplicate=${late.duplicate} created=${late.created} (expect duplicate=true, created=false)`);
    const lateRows = await rowCount(newWa);

    // The OLD path is DEFECTIVE under a concurrent redelivery in one of two ways,
    // both of which the harness surfaces: either it double-inserts (rows>1, if the
    // two writes don't collide) OR the losing concurrent write throws an UNCAUGHT
    // P2002 (errs>0) that bubbles out of handleIncomingMessage — after it already
    // ran customer.upsert / created a duplicate conversation. Either is a bug.
    // The NEW path must be perfectly clean: exactly one row, zero uncaught errors,
    // and a P2002 loser converted into a graceful duplicate:true (no reply).
    const oldDefective = oldRun.rows > 1 || oldRun.errs > 0;
    const newClean =
      newRun.created === 1 &&
      newRun.rows === 1 &&
      newRun.errs === 0 &&
      late.duplicate === true &&
      late.created === false &&
      lateRows === 1;
    console.log('');
    console.log(
      `RESULT: OLD defective under race=${oldDefective ? `YES (rows=${oldRun.rows}, uncaught-errs=${oldRun.errs})` : 'no (not reproduced this run)'}, ` +
        `NEW clean single-row=${newClean ? 'YES' : 'NO'}`
    );
    if (!newClean || !oldDefective) process.exitCode = 1;
  } catch (e) {
    console.error('TEST ERROR:', e);
    process.exitCode = 2;
  } finally {
    if (tenantId) {
      // Cascade deletes messages/customers/conversations under this tenant.
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
      console.log('cleaned up throwaway tenant');
    }
    await prisma.$disconnect();
  }
})();
