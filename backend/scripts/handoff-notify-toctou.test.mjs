// ─────────────────────────────────────────────────────────────────────────────
// Concurrency test for the needsHuman handoff-notify TOCTOU fix (AP-T72).
//
// The owner gets a WhatsApp alert the moment a conversation flips needsHuman
// false→true (handoffNotify.notifyOwnerHandoff). Two near-simultaneous triggers —
// a rapid customer message (conversationEngine) racing an admin assign-human, or
// two webhook deliveries, or two admin clicks — could BOTH read needsHuman:false
// before either wrote true, so BOTH fire the alert → the owner gets duplicate
// handoff notifications for a single handoff.
//
// This proves:
//   OLD  (read-then-write gate: read needsHuman, if false → update+notify)
//        → under a Promise.all race, MORE THAN ONE caller notifies (bug is real).
//   NEW  (atomic conditional: updateMany({ where: { needsHuman:false }, ... }),
//        notify only if count===1 — exactly what routes/conversations.js and
//        services/conversationEngine.js now do)
//        → EXACTLY ONE caller notifies, no matter the concurrency.
//   NEW late call on an already-flipped conversation → does NOT notify.
//
// Runs against the live DB on a throwaway tenant/customer/conversation, cleaned
// up by id. The WhatsApp send is NOT made — "notify" is a counted stub, because
// what's under test is the GATE (who is allowed to notify), not the transport.
//
// Run from the backend package root:  node scripts/handoff-notify-toctou.test.mjs
// Exit 0 = NEW single-winner confirmed; non-zero = failure.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CONCURRENCY = 8;
const created = { tenants: [] };

// OLD (buggy) gate — read-then-write, exactly as both call sites were before the fix.
// Returns true iff THIS caller would have sent the owner alert.
async function handoffGate_OLD(conversationId) {
  const existing = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { needsHuman: true },
  });
  // (the write always happens; the alert is gated on the pre-read value)
  await prisma.conversation
    .update({ where: { id: conversationId }, data: { needsHuman: true } })
    .catch(() => {});
  return !existing.needsHuman; // would notify?
}

// NEW atomic gate — the conditional flip IS the notify gate. Mirrors
// routes/conversations.js assign-human and conversationEngine.js exactly.
async function handoffGate_NEW(conversationId) {
  const flip = await prisma.conversation.updateMany({
    where: { id: conversationId, needsHuman: false },
    data: { needsHuman: true },
  });
  return flip.count === 1; // only the winner notifies
}

async function makeConversation(tag) {
  const stamp = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `TOCTOU-handoff-${stamp}`, slug: `toctou-handoff-${stamp}` },
    select: { id: true },
  });
  created.tenants.push(tenant.id);
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, name: 'Race Tester', phone: `+9725${Math.floor(Math.random() * 1e7)}` },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: { tenantId: tenant.id, customerId: customer.id, whatsappPhone: customer.id, needsHuman: false },
    select: { id: true },
  });
  return conversation.id;
}

async function race(fn, conversationId) {
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => fn(conversationId).catch((e) => ({ err: e.message })))
  );
  const notifiers = results.filter((r) => r === true).length;
  const errs = results.filter((r) => r && r.err).length;
  return { notifiers, errs };
}

(async () => {
  try {
    // 1) OLD pattern — expect MORE THAN ONE notifier (duplicate owner alerts).
    const oldId = await makeConversation('old');
    const oldRun = await race(handoffGate_OLD, oldId);
    console.log(`OLD read-then-write:   notifiers=${oldRun.notifiers} (errs=${oldRun.errs})  [duplicate alerts if >1]`);

    // 2) NEW atomic conditional — expect EXACTLY ONE notifier.
    const newId = await makeConversation('new');
    const newRun = await race(handoffGate_NEW, newId);
    const newRow = await prisma.conversation.findUnique({ where: { id: newId }, select: { needsHuman: true } });
    console.log(`NEW atomic updateMany:  notifiers=${newRun.notifiers} (errs=${newRun.errs})  needsHuman=${newRow.needsHuman}`);

    // 3) A late trigger on the already-flipped conversation must NOT notify again.
    const late = await handoffGate_NEW(newId);
    console.log(`NEW late trigger (already needsHuman): notified=${late} (expected false)`);

    const oldRaced = oldRun.notifiers > 1;
    const newSingle = newRun.notifiers === 1 && late === false && newRow.needsHuman === true;
    console.log('');
    console.log(`RESULT: OLD double-notified=${oldRaced ? 'YES (race is real)' : 'no (not reproduced this run)'}, NEW single-notifier=${newSingle ? 'YES' : 'NO'}`);
    console.log(newSingle ? 'ALL CASES PASSED' : 'FAILED — NEW gate did not yield exactly one notifier');
    if (!newSingle) process.exitCode = 1;
  } catch (e) {
    console.error('TEST ERROR:', e.message);
    process.exitCode = 2;
  } finally {
    if (created.tenants.length) {
      // Conversations + customers cascade-delete with the tenant.
      await prisma.tenant.deleteMany({ where: { id: { in: created.tenants } } }).catch((e) => console.log('cleanup warn:', e.message));
      console.log(`cleaned up ${created.tenants.length} throwaway tenant(s)`);
    }
    await prisma.$disconnect();
  }
})();
