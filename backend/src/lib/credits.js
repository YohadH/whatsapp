import prisma from './prisma.js';

// AI credits — 1 credit = 1 AI-answered message. A tenant's monthly allotment is
// `monthlyMessageLimit`, consumed via `creditsUsedThisPeriod` (reset each period by
// the usage scheduler). Beyond that, a non-resetting `purchasedCredits` balance is
// spent. Deterministic flow steps never cost a credit — only genuine LLM replies do.
// See CREDITS_DESIGN.md.

// Derive the credit position from a tenant row (or the minimal fields below).
export function creditsState(tenant) {
  const monthlyAllotment = tenant.monthlyMessageLimit ?? 0;
  const usedThisPeriod = tenant.creditsUsedThisPeriod ?? 0;
  const monthlyRemaining = Math.max(0, monthlyAllotment - usedThisPeriod);
  const purchased = tenant.purchasedCredits ?? 0;
  return {
    monthlyAllotment,
    usedThisPeriod,
    monthlyRemaining,
    purchased,
    available: monthlyRemaining + purchased,
  };
}

// Fast gate before calling the LLM. Reads the current tenant credit fields.
export async function hasCredits(tenantId) {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { monthlyMessageLimit: true, creditsUsedThisPeriod: true, purchasedCredits: true },
  });
  if (!t) return false;
  return creditsState(t).available > 0;
}

// Charge exactly one credit for an AI reply and record a ledger entry. Consumes the
// monthly allotment first, then the purchased balance. Returns the new credit state
// (or null if there was nothing to charge — the caller should have gated on hasCredits()).
//
// CONCURRENCY: the charge is a single atomic conditional UPDATE at the DB level, NOT a
// read-then-write. Under Postgres' default Read Committed isolation, two concurrent
// charges for the same tenant would otherwise both read "credits available" before
// either commits, and both would charge (overspend: creditsUsedThisPeriod can exceed
// monthlyMessageLimit, or purchasedCredits go negative). To close that race we do the
// balance check INSIDE the UPDATE's WHERE clause and let Postgres serialize the row
// writes: the conditional UPDATE only mutates the row (and returns 1 affected row) if
// there is still balance to spend on that branch. We try the monthly allotment first
// (WHERE "creditsUsedThisPeriod" < "monthlyMessageLimit"); if it affects 0 rows we try
// the purchased balance (WHERE "purchasedCredits" > 0). If both affect 0 rows there was
// nothing to charge → return null (no ledger row written). The ledger insert is tied to
// whichever branch actually charged, and both live in one transaction so the balance
// decrement and its ledger row are atomic.
export async function chargeAiCredit({ tenantId, messageId = null, tokensIn = null, tokensOut = null }) {
  return prisma.$transaction(async (tx) => {
    // 1) Try to spend the monthly allotment atomically. Column-to-column comparison
    //    (`creditsUsedThisPeriod < monthlyMessageLimit`) can't be expressed in a Prisma
    //    `where` filter, so this is raw SQL. Only ever increments by 1 when there is
    //    monthly room, so under concurrency it can never push used past the limit.
    let branch = null;
    const monthlyRows = await tx.$executeRaw`
      UPDATE "Tenant"
         SET "creditsUsedThisPeriod" = "creditsUsedThisPeriod" + 1
       WHERE "id" = ${tenantId}
         AND "creditsUsedThisPeriod" < "monthlyMessageLimit"`;
    if (monthlyRows === 1) {
      branch = 'monthly';
    } else {
      // 2) Monthly allotment exhausted (or tenant not found) → try the purchased balance.
      //    WHERE "purchasedCredits" > 0 guarantees it never goes negative under concurrency.
      const purchasedRows = await tx.$executeRaw`
        UPDATE "Tenant"
           SET "purchasedCredits" = "purchasedCredits" - 1
         WHERE "id" = ${tenantId}
           AND "purchasedCredits" > 0`;
      if (purchasedRows === 1) branch = 'purchased';
    }

    // Neither branch charged → no credits available (or tenant missing). Nothing to record.
    if (!branch) return null;

    // The charge committed on exactly one branch → record the paired ledger debit.
    await tx.creditTransaction.create({
      data: { tenantId, type: 'debit', amount: -1, reason: 'ai_reply', messageId, tokensIn, tokensOut },
    });

    // Return the fresh, post-charge credit state (read back the mutated row).
    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { monthlyMessageLimit: true, creditsUsedThisPeriod: true, purchasedCredits: true },
    });
    return creditsState(t);
  });
}

// Add credits to the non-resetting purchased balance (top-up / manual grant / adjust)
// and record a ledger entry. `amount` may be negative for a corrective adjustment.
export async function grantCredits({ tenantId, amount, type = 'grant', reason = null }) {
  const amt = Math.trunc(amount);
  if (!amt) return null;
  return prisma.$transaction(async (tx) => {
    const updated = await tx.tenant.update({
      where: { id: tenantId },
      data: { purchasedCredits: { increment: amt } },
      select: { monthlyMessageLimit: true, creditsUsedThisPeriod: true, purchasedCredits: true },
    });
    await tx.creditTransaction.create({
      data: { tenantId, type, amount: amt, reason },
    });
    return creditsState(updated);
  });
}

// Mark that we've nudged this tenant about being out of credits, so we do it once
// per low-balance episode (cleared on the next successful charge). Returns true if
// this call is the one that should surface the nudge.
export async function markLowCreditNudge(tenantId) {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { lowCreditNotifiedAt: true },
  });
  if (t?.lowCreditNotifiedAt) return false;
  await prisma.tenant
    .update({ where: { id: tenantId }, data: { lowCreditNotifiedAt: new Date() } })
    .catch(() => {});
  return true;
}
