#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WA-DEV-CREDIT-UNIT — behavioral test for the 24h conversation-window credit unit.
//
// Verifies the acceptance criteria of the new billing model (1 credit = one handled
// CONVERSATION within a 24-hour window, NOT 1 credit per AI message):
//
//   CASE 1  5 AI replies inside ONE 24h window charge EXACTLY 1 credit total.
//   CASE 2  An AI reply AFTER the window expires opens a NEW window → +1 credit
//           (2 total across the two windows).
//   CASE 3  CONCURRENCY (AP-T72): 5 near-simultaneous first replies on a fresh
//           conversation charge EXACTLY 1 credit (only one caller wins the window flip).
//   CASE 4  Out-of-credits: when the balance is 0, a would-be new window charges
//           nothing, opens NO window (rolled back), and reports out-of-credits.
//
// Runs the REAL chargeAiCredit() from src/lib/credits.js against the live DB, using a
// dedicated throwaway tenant/customer/conversation that is fully deleted at the end
// (onDelete: Cascade wipes the ledger + conversation). No production rows are touched.
// Requires the 4_conversation_credit_window migration applied (window cols on Conversation).
//
// Run from backend/:  node scripts/credit-window.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import prisma from '../src/lib/prisma.js';
import { chargeAiCredit, CONVERSATION_WINDOW_MS } from '../src/lib/credits.js';

const TAG = `_wa-credit-window-test-${Date.now()}`;
let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

// Count debit ledger rows written for a tenant (each = one charged window).
async function debits(tenantId) {
  return prisma.creditTransaction.count({ where: { tenantId, type: 'debit', reason: 'ai_reply' } });
}

async function main() {
  // ── Fixture: a tenant with a generous monthly allotment + a fresh conversation ──
  // NOTE: explicit selects everywhere — the live DB has the deliberate waPin drift
  // (migration 3_tenant_wa_pin unapplied), so an implicit SELECT * on Tenant would P2022.
  const tenant = await prisma.tenant.create({
    data: { name: TAG, slug: TAG, monthlyMessageLimit: 100, creditsUsedThisPeriod: 0, purchasedCredits: 0 },
    select: { id: true },
  });
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, phone: `${TAG}-phone` },
    select: { id: true },
  });
  const conv = await prisma.conversation.create({
    data: { tenantId: tenant.id, customerId: customer.id, whatsappPhone: `${TAG}-phone`, status: 'active' },
    select: { id: true },
  });

  try {
    // ── CASE 1: 5 sequential replies in ONE window → exactly 1 credit ──────────
    const t0 = new Date('2026-07-28T09:00:00.000Z');
    const results = [];
    for (let i = 0; i < 5; i++) {
      // Each message is minutes apart but well within the 24h window.
      const now = new Date(t0.getTime() + i * 5 * 60 * 1000);
      results.push(await chargeAiCredit({ conversationId: conv.id, tenantId: tenant.id, now }));
    }
    const charged1 = results.filter((r) => r.charged).length;
    check('CASE 1 — 5 replies in one 24h window charge exactly 1 credit', charged1 === 1, `charged=${charged1}`);
    check('CASE 1 — first reply charged, the other four were free', results[0].charged === true && results.slice(1).every((r) => r.charged === false));
    const d1 = await debits(tenant.id);
    check('CASE 1 — exactly one debit ledger row', d1 === 1, `debits=${d1}`);
    const afterCase1 = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { creditsUsedThisPeriod: true } });
    check('CASE 1 — tenant used exactly 1 monthly credit', afterCase1.creditsUsedThisPeriod === 1, `used=${afterCase1.creditsUsedThisPeriod}`);

    // ── CASE 2: a reply AFTER the window expires → +1 credit (2 total) ──────────
    const afterExpiry = new Date(t0.getTime() + CONVERSATION_WINDOW_MS + 60 * 1000); // 24h + 1min later
    const r6 = await chargeAiCredit({ conversationId: conv.id, tenantId: tenant.id, now: afterExpiry });
    check('CASE 2 — reply after window expiry opens a new window and charges', r6.charged === true && r6.windowOpen === true);
    const d2 = await debits(tenant.id);
    check('CASE 2 — 2 debit rows total across the two windows', d2 === 2, `debits=${d2}`);
    // A follow-up inside the SECOND window is free again.
    const r7 = await chargeAiCredit({ conversationId: conv.id, tenantId: tenant.id, now: new Date(afterExpiry.getTime() + 60 * 1000) });
    check('CASE 2 — follow-up inside the second window is free', r7.charged === false && r7.windowOpen === true);
    check('CASE 2 — still exactly 2 debits after the free follow-up', (await debits(tenant.id)) === 2);

    // ── CASE 3: concurrency — 5 simultaneous first replies on a FRESH conversation ──
    const conv2 = await prisma.conversation.create({
      data: { tenantId: tenant.id, customerId: customer.id, whatsappPhone: `${TAG}-phone2`, status: 'active' },
      select: { id: true },
    });
    const beforeC3 = await debits(tenant.id);
    const raceNow = new Date('2026-07-28T20:00:00.000Z');
    const raceResults = await Promise.all(
      Array.from({ length: 5 }, () => chargeAiCredit({ conversationId: conv2.id, tenantId: tenant.id, now: raceNow }))
    );
    const raceCharged = raceResults.filter((r) => r.charged).length;
    check('CASE 3 — 5 concurrent first replies charge exactly 1 credit (single window winner)', raceCharged === 1, `charged=${raceCharged}`);
    const deltaC3 = (await debits(tenant.id)) - beforeC3;
    check('CASE 3 — exactly one NEW debit row from the race', deltaC3 === 1, `newDebits=${deltaC3}`);

    // ── CASE 4: out of credits — no charge, no window opened, reports out-of-credits ──
    // Drain the tenant to zero available credits.
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { monthlyMessageLimit: 0, creditsUsedThisPeriod: 0, purchasedCredits: 0 },
      select: { id: true },
    });
    const conv3 = await prisma.conversation.create({
      data: { tenantId: tenant.id, customerId: customer.id, whatsappPhone: `${TAG}-phone3`, status: 'active' },
      select: { id: true },
    });
    const beforeC4 = await debits(tenant.id);
    const r8 = await chargeAiCredit({ conversationId: conv3.id, tenantId: tenant.id, now: new Date('2026-07-29T09:00:00.000Z') });
    check('CASE 4 — out of credits: charged=false, windowOpen=false, state=null', r8.charged === false && r8.windowOpen === false && r8.state === null);
    check('CASE 4 — no debit row written when out of credits', (await debits(tenant.id)) === beforeC4);
    // Critical: the window flip must have ROLLED BACK — no free window left open.
    const conv3row = await prisma.conversation.findUnique({ where: { id: conv3.id }, select: { windowExpiresAt: true } });
    check('CASE 4 — no free window opened for an out-of-credits tenant (rolled back)', conv3row.windowExpiresAt === null, `windowExpiresAt=${conv3row.windowExpiresAt}`);
    // And after a top-up, the next reply legitimately opens the window + charges.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { purchasedCredits: 10 }, select: { id: true } });
    const r9 = await chargeAiCredit({ conversationId: conv3.id, tenantId: tenant.id, now: new Date('2026-07-29T09:05:00.000Z') });
    check('CASE 4 — after top-up the same conversation charges once', r9.charged === true);
    check('CASE 4 — one new debit after top-up', (await debits(tenant.id)) === beforeC4 + 1);
  } finally {
    // Full cleanup — cascade removes conversation + ledger rows.
    // deleteMany avoids a RETURNING * (which would P2022 on the waPin drift). Cascade
    // removes the conversation + ledger rows for this throwaway tenant.
    await prisma.tenant.deleteMany({ where: { id: tenant.id } }).catch((e) => console.log('cleanup warn:', e.message));
    await prisma.$disconnect();
  }

  console.log(failed === 0 ? '\nALL CASES PASSED' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('HARNESS ERROR:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
