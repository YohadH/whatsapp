// Concurrency test for the ORPHAN-CONVERSATION race
// (whatsapp-agent-fix-orphan-conversation-race-in — data-hygiene follow-up to the
// inbound waMessageId TOCTOU dedup fix in commit 492d9b2).
//
// Scenario: a customer with NO existing open conversation gets N truly-concurrent
// inbound deliveries of the SAME waMessageId (Meta at-least-once redelivery under
// load). In handleIncomingMessage, step 2's conversation.create() is NOT atomically
// deduped, so BOTH concurrent handlers create a fresh Conversation before either
// reaches the step-3 message-create gate. Only ONE wins the message insert (the
// Message @@unique([tenantId, waMessageId]) constraint); the loser is left holding a
// brand-new, EMPTY status:'active' Conversation + a stray CONVERSATION_STARTED
// analytics event that pollute the dashboard/analytics active-conversation lists.
//
// Proves:
//   OLD slice (no cleanup): N concurrent → N conversations created, N-1 orphaned
//                           (empty active rows) + N-1 stray CONVERSATION_STARTED events.
//   NEW slice (orphan cleanup in the P2002 catch): N concurrent → exactly ONE
//                           conversation survives with the ONE message; every losing
//                           handler deletes its own empty conversation + stray event.
//
// Runs against the live DB on a throwaway tenant/customer, cleaned up by EXACT id
// (the throwaway tenant cascade-deletes everything under it — never a prefix/pattern
// query that could catch pre-existing rows; per the 2026-07-21 cleanup lesson).
//
// Run from the backend package root:  node scripts/toctou-orphan-conversation-test.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CONCURRENCY = 10;
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

// Shared step 2+3 slice for a customer with NO open conversation, parameterised by
// whether the P2002 catch cleans up the orphan conversation it created (NEW) or not
// (OLD). Mirrors handleIncomingMessage step 2 (create-if-none) + step 3 (message
// create as the atomic dedup gate) exactly.
//
// `arrive` is an optional countdown-barrier function: EVERY concurrent caller does
// its step-2 findFirst (all see NO open conversation), then calls arrive() and waits
// on the returned gate; the gate opens for everyone only once all callers have
// arrived, so all proceed to create together. This deterministically reproduces the
// orphan window (both callers passed the "is there an open conversation?" check
// before either created one) rather than relying on timing luck — under real Meta
// redelivery load this window opens on its own.
async function inboundNoOpenConversation({ customerId, phone, waMessageId, cleanupOrphan, arrive }) {
  // step 2: reuse an open conversation, else create one (UNGUARDED — the race).
  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, customerId, status: { in: ['active', 'needs_human'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  // Hold here until ALL concurrent callers have finished their findFirst above.
  if (arrive) await arrive();
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

  // step 3: the message-create atomic dedup gate.
  await new Promise((r) => setTimeout(r, 5));
  try {
    await prisma.message.create({
      data: { tenantId, conversationId: conversation.id, senderType: 'customer', messageText: 'hi', waMessageId },
    });
    return { winner: true, conversationId: conversation.id, isNew };
  } catch (err) {
    if (isDuplicateWaMessage(err)) {
      if (cleanupOrphan && isNew) {
        // NEW behaviour: clean up the orphan conversation + stray event this handler made.
        try {
          await prisma.analyticsEvent.deleteMany({
            where: { tenantId, conversationId: conversation.id, eventName: CONVERSATION_STARTED },
          });
          await prisma.conversation.delete({ where: { id: conversation.id } });
        } catch (cleanupErr) {
          return { winner: false, duplicate: true, cleanupError: cleanupErr.message };
        }
      }
      return { winner: false, duplicate: true };
    }
    throw err;
  }
}

// Fresh throwaway customer per pass, so the two passes don't influence each other.
async function makeCustomer(tag) {
  return prisma.customer.create({
    data: { tenantId, phone: `+000${tag}${Date.now()}`.slice(0, 15) },
    select: { id: true, phone: true },
  });
}

// A countdown barrier: N callers each `arrive()`; the returned `gate` promise
// resolves for everyone only once all N have arrived. Guarantees all step-2
// findFirsts complete (all seeing no open conversation) before any create runs.
function makeBarrier(n) {
  let arrived = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const arrive = () => {
    if (++arrived >= n) release();
    return gate;
  };
  return { arrive };
}

async function runPass({ cleanupOrphan, waMessageId }) {
  const c = await makeCustomer(cleanupOrphan ? '1' : '0');
  const { arrive } = makeBarrier(CONCURRENCY);
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      inboundNoOpenConversation({
        customerId: c.id,
        phone: c.phone,
        waMessageId,
        cleanupOrphan,
        arrive,
      }).catch((e) => ({ err: e.code || e.message })),
    ),
  );
  const winners = results.filter((r) => r && r.winner).length;
  const errs = results.filter((r) => r && r.err).length;
  const state = await prisma.conversation.count({ where: { tenantId, customerId: c.id } });
  const active = await prisma.conversation.count({ where: { tenantId, customerId: c.id, status: 'active' } });
  const started = await prisma.analyticsEvent.count({
    where: { tenantId, customerId: c.id, eventName: CONVERSATION_STARTED },
  });
  const messages = await prisma.message.count({ where: { tenantId, conversation: { customerId: c.id } } });
  return { winners, errs, conversations: state, activeConversations: active, startedEvents: started, messages };
}

(async () => {
  try {
    const t = await prisma.tenant.create({
      data: {
        name: `TOCTOU-orphan-${Date.now()}`,
        slug: `toctou-orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
      select: { id: true },
    });
    tenantId = t.id;

    // 1) OLD slice (no orphan cleanup): expect N conversations, N-1 orphaned actives,
    //    N-1 stray CONVERSATION_STARTED events, exactly 1 message.
    const oldRun = await runPass({ cleanupOrphan: false, waMessageId: `wamid-orphan-OLD-${Date.now()}` });
    console.log(
      `OLD (no cleanup):  winners=${oldRun.winners}  conversations=${oldRun.conversations}  ` +
        `active=${oldRun.activeConversations}  started_events=${oldRun.startedEvents}  messages=${oldRun.messages}  ` +
        `(expect winners=1, conversations>1 → orphans, messages=1)`
    );

    // 2) NEW slice (orphan cleanup in P2002 catch): expect exactly 1 conversation,
    //    1 active, 1 CONVERSATION_STARTED event, 1 message.
    const newRun = await runPass({ cleanupOrphan: true, waMessageId: `wamid-orphan-NEW-${Date.now()}` });
    console.log(
      `NEW (with cleanup): winners=${newRun.winners}  conversations=${newRun.conversations}  ` +
        `active=${newRun.activeConversations}  started_events=${newRun.startedEvents}  messages=${newRun.messages}  ` +
        `(expect winners=1, conversations=1, active=1, started_events=1, messages=1)`
    );

    const oldDefective = oldRun.conversations > 1; // orphan(s) created and left behind
    const newClean =
      newRun.winners === 1 &&
      newRun.conversations === 1 &&
      newRun.activeConversations === 1 &&
      newRun.startedEvents === 1 &&
      newRun.messages === 1 &&
      newRun.errs === 0;

    console.log('');
    console.log(
      `RESULT: OLD leaves orphans=${oldDefective ? `YES (${oldRun.conversations} conversations, ${oldRun.conversations - 1} orphaned)` : 'no (race not reproduced this run)'}, ` +
        `NEW single-conversation clean=${newClean ? 'YES' : 'NO'}`
    );
    if (!newClean || !oldDefective) process.exitCode = 1;
  } catch (e) {
    console.error('TEST ERROR:', e);
    process.exitCode = 2;
  } finally {
    if (tenantId) {
      // Cascade-deletes conversations/messages/customers/events under this throwaway
      // tenant only. EXACT-id scoped (never a prefix/pattern query) per the
      // 2026-07-21 cleanup lesson.
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
      console.log('cleaned up throwaway tenant');
    }
    await prisma.$disconnect();
  }
})();
