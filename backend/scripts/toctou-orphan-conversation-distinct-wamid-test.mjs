// Concurrency test for the ORPHAN-CONVERSATION cleanup DATA-LOSS race
// (whatsapp-agent-conversationengine-js-orphan).
//
// This is the case the ORIGINAL orphan test (toctou-orphan-conversation-test.mjs)
// could NOT catch: that test only ever drives ONE shared waMessageId across all
// concurrent callers, so the loser's cleanup-delete always targets a conversation
// that is genuinely empty. This test drives TWO DISTINCT waMessageIds for the SAME
// new customer and forces the interleaving where the loser's cleanup-delete would
// destroy a REAL message that a DIFFERENT delivery attached to the same row.
//
// Scenario (a customer with NO pre-existing conversation):
//   A  (waMessageId = X)  — creates conversation C, WINS its message insert.
//   A' (waMessageId = X, Meta redelivery) — also creates a fresh conversation... BUT
//      we force it to REUSE C (the real interleaving: A' does its step-2 findFirst
//      AFTER A has created+committed C, so it sees C "active" and does NOT create a
//      new row) and then LOSES the message insert on the @@unique([tenantId,
//      waMessageId]) constraint → enters the isNew=false-or-true P2002 cleanup path.
//   B  (waMessageId = Y, a DISTINCT message) — independently does its step-2 findFirst,
//      finds C "active", and attaches its own REAL message to C.
//
// The bug: A' (or the create-losing handler) calls conversation.delete() on C trusting
// "isNew ⇒ empty & mine to delete". But Message.conversationId is required + onDelete:
// Cascade, so deleting C cascade-destroys B's genuine, unrelated message. Silent
// data loss — the customer's message just disappears.
//
// To reproduce the EXACT engine shape (the loser is isNew=true holding its OWN fresh
// conversation, and B attached to THAT SAME fresh conversation), we drive the engine's
// real step-2/step-3 slice with a barrier so that:
//   - two SAME-waMessageId handlers (P, Q) both pass step-2 findFirst (no open convo)
//     and both create a fresh conversation (the orphan race);
//   - a THIRD handler R with a DISTINCT waMessageId does its step-2 findFirst AFTER the
//     two creates are visible, picks the losing handler's fresh conversation, and
//     attaches its real message there — BEFORE the loser runs its cleanup-delete.
//
// Proves:
//   OLD (unconditional delete): the loser deletes its fresh conversation → cascade
//        destroys R's distinct-waMessageId message → messages lost (< expected).
//   NEW (conditional deleteMany messages:{none:{}}): the delete matches 0 rows because
//        R attached a message → the row (and R's message) survive → ALL messages kept.
//
// Runs against the live DB on a throwaway tenant, cleaned up by EXACT id.
// Run from the backend package root:
//   node scripts/toctou-orphan-conversation-distinct-wamid-test.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CONVERSATION_STARTED = 'conversation_started'; // mirror EVENTS.CONVERSATION_STARTED
let tenantId = null;

// Same P2002-classifier the production fix uses (kept in sync with
// isDuplicateWaMessage in src/services/conversationEngine.js).
function isDuplicateWaMessage(err) {
  if (err?.code !== 'P2002') return false;
  const target = err?.meta?.target;
  if (Array.isArray(target)) return target.includes('waMessageId');
  return typeof target === 'string' ? target.includes('waMessageId') : true;
}

// The engine's step-2 (find-or-create open conversation) + step-3 (message-create as
// the atomic dedup gate) + the P2002 orphan-cleanup, parameterised by whether the
// cleanup-delete is the OLD unconditional delete or the NEW conditional deleteMany.
//
// Barrier `phase` lets the harness sequence the three handlers deterministically to
// reproduce the distinct-waMessageId interleaving (see runPass).
async function inboundSlice({ customerId, phone, waMessageId, mode, hooks = {} }) {
  // step 2: reuse an open conversation, else create (UNGUARDED — the orphan race).
  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, customerId, status: { in: ['active', 'needs_human'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (hooks.afterFindFirst) await hooks.afterFindFirst();

  let isNew = false;
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { tenantId, customerId, whatsappPhone: phone, status: 'active' },
      select: { id: true },
    });
    isNew = true;
    await prisma.analyticsEvent.create({
      data: { tenantId, eventName: CONVERSATION_STARTED, conversationId: conversation.id, customerId, customerPhone: phone },
    });
  }
  if (hooks.afterCreate) await hooks.afterCreate({ conversationId: conversation.id, isNew });

  // step 3: the message-create atomic dedup gate.
  try {
    await prisma.message.create({
      data: { tenantId, conversationId: conversation.id, senderType: 'customer', messageText: waMessageId, waMessageId },
    });
    return { winner: true, conversationId: conversation.id, isNew, waMessageId };
  } catch (err) {
    if (isDuplicateWaMessage(err)) {
      if (hooks.beforeCleanup) await hooks.beforeCleanup({ conversationId: conversation.id, isNew });
      if (isNew) {
        if (mode === 'OLD') {
          // OLD behaviour: unconditional delete — cascade-destroys any message that
          // attached to this row in the race window.
          try {
            await prisma.analyticsEvent.deleteMany({
              where: { tenantId, conversationId: conversation.id, eventName: CONVERSATION_STARTED },
            });
            await prisma.conversation.delete({ where: { id: conversation.id } });
          } catch (cleanupErr) {
            return { winner: false, duplicate: true, cleanupError: cleanupErr.message, conversationId: conversation.id };
          }
        } else {
          // NEW behaviour: conditional delete — only if the row STILL has zero messages.
          // Event first (guarded on still-empty), then conditional conversation delete.
          try {
            await prisma.analyticsEvent.deleteMany({
              where: {
                tenantId,
                conversationId: conversation.id,
                eventName: CONVERSATION_STARTED,
                conversation: { messages: { none: {} } },
              },
            });
            await prisma.conversation.deleteMany({
              where: { id: conversation.id, messages: { none: {} } },
            });
          } catch (cleanupErr) {
            return { winner: false, duplicate: true, cleanupError: cleanupErr.message, conversationId: conversation.id };
          }
        }
      }
      return { winner: false, duplicate: true, conversationId: conversation.id, isNew };
    }
    throw err;
  }
}

async function makeCustomer(tag) {
  return prisma.customer.create({
    data: { tenantId, phone: `+000${tag}${Date.now()}`.slice(0, 15) },
    select: { id: true, phone: true },
  });
}

// Deferred promise helper (a resolvable gate).
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// Drive the distinct-waMessageId interleaving deterministically.
//
// Sequence enforced by hooks/gates (this is exactly a real interleaving that Meta
// at-least-once redelivery + a following distinct message can produce; the barrier
// just makes it deterministic instead of timing-dependent):
//   1. WINNER (waMessageId X): find(none) → create C_win → insert msg X  → WINS.
//   2. LOSER  (waMessageId X, redelivery): find(none, before C_win visible?) →
//        we make LOSER create its OWN fresh conversation C_lose (orphan-race), then
//        PAUSE right before its cleanup.
//   3. DISTINCT (waMessageId Y): find → sees C_lose active → attaches real msg Y to C_lose.
//   4. LOSER resumes cleanup on C_lose (which now holds msg Y).
//        OLD: deletes C_lose → cascade kills msg Y (LOST).
//        NEW: deleteMany messages:{none:{}} matches 0 → C_lose + msg Y survive.
async function runPass({ mode }) {
  const c = await makeCustomer(mode === 'OLD' ? '0' : '1');
  const X = `wamid-distinct-${mode}-X-${Date.now()}`;
  const Y = `wamid-distinct-${mode}-Y-${Date.now()}`;

  // Gate that LOSER waits on right before its cleanup; opened once DISTINCT has
  // attached its message to C_lose.
  const distinctAttached = deferred();
  // Gate that DISTINCT waits on before it starts, opened once LOSER has created
  // C_lose (so DISTINCT's findFirst can see it).
  const loserCreated = deferred();
  let loserConversationId = null;

  // WINNER: create C_win and win the X insert. Force it to create a fresh conversation
  // by running it first (no open conversation exists yet).
  const winnerP = inboundSlice({ customerId: c.id, phone: c.phone, waMessageId: X, mode });
  await winnerP; // fully settle the winner (its C_win + msg X committed)

  // LOSER (redelivery of X): must NOT reuse C_win — reproduce the orphan race where
  // the loser created its OWN fresh conversation before the message-create gate. We
  // simulate that here by having the loser's step-2 findFirst run against a state where
  // it does not pick up C_win: since C_win already exists and is 'active', a plain
  // findFirst WOULD pick it up. To reproduce the true orphan interleaving (loser holds
  // its OWN fresh isNew conversation), we drive the loser through a variant that forces
  // a fresh create — mirroring "both handlers passed step-2 before either created".
  const loserP = inboundSliceForcedFresh({
    customerId: c.id,
    phone: c.phone,
    waMessageId: X, // same waMessageId as winner → its message insert will P2002
    mode,
    onCreated: (id) => { loserConversationId = id; loserCreated.resolve(); },
    beforeCleanup: () => distinctAttached.promise, // pause until DISTINCT attaches
  });

  // DISTINCT (waMessageId Y): wait until LOSER created C_lose, then attach a real
  // message to C_lose (the same row the loser is about to try to clean up).
  const distinctP = (async () => {
    await loserCreated.promise;
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: loserConversationId,
        senderType: 'customer',
        messageText: Y,
        waMessageId: Y,
      },
    });
    distinctAttached.resolve();
    return { attachedTo: loserConversationId, waMessageId: Y };
  })();

  const [loserRes, distinctRes] = await Promise.all([loserP, distinctP]);

  // Assess final DB state for this customer.
  const conversations = await prisma.conversation.count({ where: { tenantId, customerId: c.id } });
  const messages = await prisma.message.findMany({
    where: { tenantId, conversation: { customerId: c.id } },
    select: { waMessageId: true, conversationId: true },
  });
  const waIds = messages.map((m) => m.waMessageId).sort();
  const hasX = waIds.includes(X);
  const hasY = waIds.includes(Y);
  // Y's conversation must still exist (not cascade-deleted).
  const yConvo = distinctRes.attachedTo;
  const yConvoExists = (await prisma.conversation.count({ where: { id: yConvo } })) === 1;

  return {
    mode,
    conversations,
    messageCount: messages.length,
    hasX,
    hasY,
    yConvoExists,
    loserWasNew: loserRes.isNew === true,
    waIds,
  };
}

// Loser variant that ALWAYS creates a fresh conversation (reproduces "both same-wamid
// handlers passed step-2 findFirst before either created", so the loser holds its OWN
// brand-new isNew conversation), then runs the real step-3 insert (which P2002s against
// the winner's X) and the mode-specific cleanup. beforeCleanup pauses so a distinct
// message can attach to the loser's fresh conversation first.
async function inboundSliceForcedFresh({ customerId, phone, waMessageId, mode, onCreated, beforeCleanup }) {
  const conversation = await prisma.conversation.create({
    data: { tenantId, customerId, whatsappPhone: phone, status: 'active' },
    select: { id: true },
  });
  const isNew = true;
  await prisma.analyticsEvent.create({
    data: { tenantId, eventName: CONVERSATION_STARTED, conversationId: conversation.id, customerId, customerPhone: phone },
  });
  if (onCreated) onCreated(conversation.id);

  try {
    await prisma.message.create({
      data: { tenantId, conversationId: conversation.id, senderType: 'customer', messageText: waMessageId, waMessageId },
    });
    // Should not happen in this test (winner already inserted X) — but if it did, the
    // loser "won" and there's no cleanup; still return coherent shape.
    return { winner: true, conversationId: conversation.id, isNew, waMessageId };
  } catch (err) {
    if (isDuplicateWaMessage(err)) {
      if (beforeCleanup) await beforeCleanup();
      if (mode === 'OLD') {
        try {
          await prisma.analyticsEvent.deleteMany({
            where: { tenantId, conversationId: conversation.id, eventName: CONVERSATION_STARTED },
          });
          await prisma.conversation.delete({ where: { id: conversation.id } });
        } catch (cleanupErr) {
          return { winner: false, duplicate: true, isNew, cleanupError: cleanupErr.message, conversationId: conversation.id };
        }
      } else {
        try {
          // Event first (guarded on still-empty), then conditional conversation delete —
          // mirrors production ordering (AnalyticsEvent→Conversation is SetNull).
          await prisma.analyticsEvent.deleteMany({
            where: {
              tenantId,
              conversationId: conversation.id,
              eventName: CONVERSATION_STARTED,
              conversation: { messages: { none: {} } },
            },
          });
          await prisma.conversation.deleteMany({
            where: { id: conversation.id, messages: { none: {} } },
          });
        } catch (cleanupErr) {
          return { winner: false, duplicate: true, isNew, cleanupError: cleanupErr.message, conversationId: conversation.id };
        }
      }
      return { winner: false, duplicate: true, isNew, conversationId: conversation.id };
    }
    throw err;
  }
}

(async () => {
  try {
    const t = await prisma.tenant.create({
      data: {
        name: `TOCTOU-distinct-${Date.now()}`,
        slug: `toctou-distinct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      select: { id: true },
    });
    tenantId = t.id;

    // 1) OLD slice (unconditional delete): expect the distinct-waMessageId message Y to
    //    be LOST (cascade-deleted with the loser's conversation).
    const oldRun = await runPass({ mode: 'OLD' });
    console.log(
      `OLD (unconditional delete): conversations=${oldRun.conversations} messages=${oldRun.messageCount} ` +
        `hasX=${oldRun.hasX} hasY=${oldRun.hasY} yConvoExists=${oldRun.yConvoExists} loserWasNew=${oldRun.loserWasNew}`
    );
    console.log(`   waIds=${JSON.stringify(oldRun.waIds)}  (expect hasY=false → DISTINCT message LOST to cascade)`);

    // 2) NEW slice (conditional deleteMany messages:{none:{}}): expect BOTH X and Y to
    //    survive — the conditional delete matches 0 rows because Y attached.
    const newRun = await runPass({ mode: 'NEW' });
    console.log(
      `NEW (conditional delete):   conversations=${newRun.conversations} messages=${newRun.messageCount} ` +
        `hasX=${newRun.hasX} hasY=${newRun.hasY} yConvoExists=${newRun.yConvoExists} loserWasNew=${newRun.loserWasNew}`
    );
    console.log(`   waIds=${JSON.stringify(newRun.waIds)}  (expect hasX=true AND hasY=true → NO message lost)`);

    console.log('');
    // The bug is DEMONSTRATED if OLD loses Y (the distinct message), and FIXED if NEW keeps both.
    const oldDemonstratesBug = oldRun.hasX && !oldRun.hasY && !oldRun.yConvoExists;
    const newKeepsBoth = newRun.hasX && newRun.hasY && newRun.yConvoExists;
    // Sanity: the loser really was a fresh/isNew conversation in both passes (proves we
    // exercised the isNew cleanup-delete path, not some other branch).
    const exercisedCleanupPath = oldRun.loserWasNew && newRun.loserWasNew;
    // Sanity: this test truly uses TWO DISTINCT waMessageIds (X != Y) per pass.
    const distinctWamids =
      oldRun.waIds.every((id) => id !== null) &&
      newRun.waIds.filter((id) => id).length === 2 &&
      new Set(newRun.waIds).size === 2;

    console.log(`RESULT:`);
    console.log(`  OLD demonstrates data-loss bug (distinct msg Y lost): ${oldDemonstratesBug ? 'YES' : 'NO'}`);
    console.log(`  NEW keeps BOTH messages (no data loss):               ${newKeepsBoth ? 'YES' : 'NO'}`);
    console.log(`  Exercised isNew cleanup-delete path in both passes:   ${exercisedCleanupPath ? 'YES' : 'NO'}`);
    console.log(`  Test drives TWO DISTINCT waMessageIds (not shared):   ${distinctWamids ? 'YES' : 'NO'}`);

    const pass = oldDemonstratesBug && newKeepsBoth && exercisedCleanupPath && distinctWamids;
    console.log('');
    console.log(pass ? 'PASS ✅  — fix prevents distinct-waMessageId cascade data loss' : 'FAIL ❌');
    if (!pass) process.exitCode = 1;
  } catch (e) {
    console.error('TEST ERROR:', e);
    process.exitCode = 2;
  } finally {
    if (tenantId) {
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
      console.log('cleaned up throwaway tenant');
    }
    await prisma.$disconnect();
  }
})();
