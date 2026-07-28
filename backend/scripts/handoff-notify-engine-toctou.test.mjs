#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Concurrency test for the needsHuman handoff-notify TOCTOU fix on the
// conversationEngine INBOUND-MESSAGE path (AP-T72).
//
// Companion to handoff-notify-toctou.test.mjs (which covers the ADMIN route path,
// POST /api/conversations/:id/assign-human). This one covers the OTHER place a
// handoff-notify decision is made: when an inbound WhatsApp message arrives and the
// engine (conversationEngine.handleIncomingMessage) decides the conversation now
// needs a human and alerts the owner.
//
// THE RACE: a customer fires several messages in quick succession (WhatsApp does
// deliver bursts, and Meta re-delivers webhooks at-least-once), each of which the
// engine judges "needs a human". Before the fix, each call read needsHuman:false,
// then wrote true, then notified — so a burst double/triple-alerted the owner for a
// single handoff. The fix (conversationEngine.js §2.4) makes the false→true flip the
// gate: a single conditional updateMany({ where:{ needsHuman:false } }) — exactly ONE
// caller gets count===1 and notifies; the rest stay silent.
//
// TEST METHODOLOGY (whatsapp-agent-fix-test-methodology-duplicated-logic):
//   This DRIVES THE REAL engine. It imports and calls the real
//   handleIncomingMessage() against the live DB on a throwaway tenant, firing
//   genuinely-concurrent inbound messages (Promise.all) for the SAME conversation.
//   It does NOT re-implement the flip gate inline — reverting the real conditional
//   flip in conversationEngine.js must fail this test.
//
//   No OpenAI is called: the throwaway tenant has ZERO credits, so the engine takes
//   its own out-of-credits branch (generateAgentResponse(..., { allowAI:false })),
//   which forces the deterministic rule-based path. The inbound text is a Hebrew
//   "human agent" keyword ("נציג"), so ruleBasedResponse deterministically returns
//   needs_human:true — the real handoff decision, no LLM, no credit charge.
//   No WhatsApp is sent: the tenant has no WA creds, so sendWhatsAppMessage
//   self-simulates (logs, never hits Meta).
//
//   The ONLY mocked boundary is notifyOwnerHandoff() (the owner's WhatsApp alert),
//   stubbed to a global COUNTER via the shared ESM loader hook — so we can count how
//   many callers were allowed to notify. The conditional-flip gate that decides WHO
//   notifies runs for real.
//
// Run from backend/ WITH the loader:
//   node --import ./scripts/register-handoff-notify-loader.mjs ./scripts/handoff-notify-engine-toctou.test.mjs
// Exit 0 = single-winner confirmed on the engine path; non-zero = failure.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

const prisma = (await import('../src/lib/prisma.js')).default;
const { handleIncomingMessage } = await import('../src/services/conversationEngine.js');

// The loader stub replaces services/handoffNotify.js with a counter. If it wasn't
// registered, notifyOwnerHandoff would be the REAL (WhatsApp-sending) module and the
// counter would never move — fail loud rather than run a test that can't observe it.
const HANDOFF = (globalThis.__HANDOFF = globalThis.__HANDOFF || { notifyCount: 0, calls: [] });

const CONCURRENCY = 8;
const HUMAN_KEYWORD = 'נציג'; // triggers ruleBasedResponse → needs_human:true
let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

const created = { tenants: [] };

// A throwaway tenant with ZERO credits (so the engine forces the rule-based, no-LLM
// path) + no WhatsApp creds (so sends self-simulate). One customer, one already-open
// conversation so concurrent inbound messages RACE on the same conversation's flip.
async function makeOpenConversation(tag) {
  const stamp = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Explicit select (AP-T71): Tenant.waPin is in the Prisma schema but not applied on
  // the live DB (deliberate drift), so an implicit SELECT * RETURNING throws P2022.
  const tenant = await prisma.tenant.create({
    data: {
      name: `TOCTOU-engine-${stamp}`,
      slug: `toctou-engine-${stamp}`,
      monthlyMessageLimit: 0, // zero credits → engine takes allowAI:false branch (no OpenAI)
      purchasedCredits: 0,
    },
    select: { id: true, name: true, slug: true, monthlyMessageLimit: true, purchasedCredits: true },
  });
  created.tenants.push(tenant.id);
  const phone = `+9725${Math.floor(Math.random() * 1e7)}`;
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, name: 'Race Tester', phone },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: { tenantId: tenant.id, customerId: customer.id, whatsappPhone: phone, status: 'active', needsHuman: false },
    select: { id: true },
  });
  return { tenant, phone, conversationId: conversation.id };
}

async function main() {
  try {
    // ── Sanity: the loader stub is actually in place (else the counter is blind) ──
    check('setup — handoffNotify stub is registered (counter observable)', HANDOFF && typeof HANDOFF.notifyCount === 'number');

    // ── NEW atomic conditional via the REAL engine — expect EXACTLY ONE notifier ──
    const { tenant, phone, conversationId } = await makeOpenConversation('burst');
    const notifyBefore = HANDOFF.notifyCount;

    // Fire CONCURRENCY inbound "I want a human agent" messages at once, all for the
    // same open conversation. Each call independently judges needs_human:true and
    // races to flip needsHuman false→true. The atomic gate must let exactly one notify.
    const race = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        handleIncomingMessage({
          tenant,
          phone,
          text: HUMAN_KEYWORD,
          name: 'Race Tester',
          waMessageId: null, // null → idempotency guard is skipped; every message is processed (worst case for the race)
        }).catch((e) => ({ __err: e.message }))
      )
    );

    const errs = race.filter((r) => r && r.__err);
    check('NEW — all concurrent inbound messages processed without error', errs.length === 0, `errors=${errs.length}${errs.length ? ` first=${errs[0].__err}` : ''}`);

    // The engine drives notifyOwnerHandoff only for the caller that won the
    // false→true flip. Under the atomic gate that is EXACTLY ONE.
    const notified = HANDOFF.notifyCount - notifyBefore;
    check('NEW — REAL engine notified the owner exactly ONCE under an 8-way inbound race', notified === 1, `notifiers=${notified}`);

    const row = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { needsHuman: true, status: true },
    });
    check('NEW — conversation ended needsHuman=true / status=needs_human', row.needsHuman === true && row.status === 'needs_human', `needsHuman=${row.needsHuman} status=${row.status}`);

    // ── A late inbound "human" message on the already-flipped conversation must NOT
    //    notify again (needsHuman is already true → conditional flip matches 0 rows). ─
    const beforeLate = HANDOFF.notifyCount;
    const late = await handleIncomingMessage({ tenant, phone, text: HUMAN_KEYWORD, name: 'Race Tester', waMessageId: null }).catch((e) => ({ __err: e.message }));
    const lateNotified = HANDOFF.notifyCount - beforeLate;
    check('NEW — late inbound on already-needsHuman does NOT re-notify', !late.__err && lateNotified === 0, `${late.__err ? `err=${late.__err} ` : ''}lateNotifiers=${lateNotified}`);

    // ── Confirm the notify actually happened for the RIGHT conversation (not a
    //    silent no-op that trivially passes the "exactly once" count). ──────────────
    const forThisConv = HANDOFF.calls.filter((c) => c.conversationId === conversationId).length;
    check('NEW — the single notify was for THIS conversation', forThisConv === 1, `callsForConv=${forThisConv}`);
  } finally {
    if (created.tenants.length) {
      await prisma.tenant.deleteMany({ where: { id: { in: created.tenants } } }).catch((e) => console.log('cleanup warn:', e.message));
      console.log(`cleaned up ${created.tenants.length} throwaway tenant(s)`);
    }
    await prisma.$disconnect();
  }

  console.log(failed === 0 ? '\nALL CASES PASSED' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('TEST ERROR:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
