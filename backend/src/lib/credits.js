import prisma from './prisma.js';
import { isTrialExpiredUnpaid } from './plans.js';

// AI credits — 1 credit = one handled CONVERSATION within a rolling 24-HOUR WINDOW
// (NOT one credit per AI message). The FIRST AI-answered message that opens a new
// window costs 1 credit; every later AI message inside that still-open window is
// free. Once the window expires (24h after it opened), the next AI-answered message
// starts a NEW window and costs a new credit. This mirrors WhatsApp's own 24-hour
// conversation-session billing and makes cost predictable per customer/day.
//
// A tenant's monthly allotment is `monthlyMessageLimit`, consumed via
// `creditsUsedThisPeriod` (reset each period by the usage scheduler). Beyond that, a
// non-resetting `purchasedCredits` balance is spent. Deterministic flow steps never
// cost a credit — only genuine LLM replies do, and only the one that opens a window.
// See CREDITS_DESIGN.md.

// The conversation-credit window length (24 hours) in milliseconds.
export const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;

// Internal sentinel: thrown inside chargeAiCredit()'s transaction to roll back the
// window-open flip when there is no credit to spend, so an out-of-credits tenant never
// gets a free 24h window opened on their behalf. Caught in the outer .catch().
class OutOfCreditsError extends Error {
  constructor() {
    super('out_of_credits');
    this.name = 'OutOfCreditsError';
  }
}

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
//
// TRIAL ENFORCEMENT (cost-leak fix): a self-service trial tenant whose 14-day trial
// has elapsed WITHOUT converting to a paid Stripe subscription gets NO platform AI —
// isTrialExpiredUnpaid() short-circuits to `false` BEFORE the balance check, so the
// caller (conversationEngine's platform-key branch, reached by BOTH the real webhook
// and /simulate) falls back to the rule-based reply and never spends an OpenAI call
// on the platform's own bill. Without this, resetElapsedPeriods() re-grants ~500
// credits/period to every tenant forever regardless of trial expiry, letting anyone
// register throwaway trials and farm real OpenAI spend indefinitely. BYO-key tenants
// never reach here (they bypass hasCredits and pay their own provider), so their
// trial state is intentionally irrelevant to platform cost.
export async function hasCredits(tenantId) {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    // trialEndsAt (0_init) + subscriptionStatus (9_stripe_billing) are both live —
    // explicit select keeps this drift-safe (AP-T71).
    select: {
      monthlyMessageLimit: true,
      creditsUsedThisPeriod: true,
      purchasedCredits: true,
      trialEndsAt: true,
      subscriptionStatus: true,
    },
  });
  if (!t) return false;
  if (isTrialExpiredUnpaid(t)) return false;
  return creditsState(t).available > 0;
}

// Charge (at most) one credit for a handled conversation and record a ledger entry.
// The unit is a 24-HOUR CONVERSATION WINDOW, not a single message: a credit is spent
// only when this AI reply OPENS A NEW WINDOW on the conversation. If the conversation
// already has an open (non-expired) window, this is a free follow-up reply — no charge,
// no ledger row — and we return { charged: false, windowOpen: true, ... }.
//
// Return shape (the `windowOpen` key is consistent across ALL branches):
//   { charged: true,  windowOpen: true,  state }  — a new window opened and 1 credit spent
//   { charged: false, windowOpen: true,  state }  — inside an already-open window, free
//   { charged: false, windowOpen: false, state: null } — a window WOULD open but there were
//                                                            no credits to spend (caller gated
//                                                            on hasCredits(); treat as out-of-credits)
//
// CONCURRENCY (AP-T72 — this is the whole point of the design):
//   Two near-simultaneous inbound messages for the SAME conversation (WhatsApp webhook
//   retries / a customer double-tapping send) must NOT both charge. We make the WINDOW
//   FLIP the atomic gate, exactly like markLowCreditNudge()/mark-paid: a single
//   conditional UPDATE opens the window ONLY when it is currently null or expired —
//   `WHERE "windowExpiresAt" IS NULL OR "windowExpiresAt" <= now`. Under Postgres Read
//   Committed the row write is serialized, so of N concurrent callers EXACTLY ONE sees
//   1 affected row ("won the window") and proceeds to charge; every other sees 0 and
//   returns free. The balance decrement itself is ALSO a conditional UPDATE (monthly
//   allotment first, then purchased balance) so it can never overspend. The window flip,
//   the balance decrement, and the ledger insert all live in ONE transaction: if there
//   is genuinely no credit to spend we roll back the window flip too, so a future retry
//   (or the message after a top-up) can still open the window and charge — we never
//   "open a window for free" on an out-of-credits tenant.
//
// DRIFT SAFETY (AP-T71): windowStartedAt/windowExpiresAt may not be migrated on the live
// DB yet (migration 4_conversation_credit_window is additive but pending live-apply — see
// developer-notes). All window access here is raw parameterized SQL naming ONLY those two
// columns (never an implicit SELECT * that would request the whole Conversation row and
// P2022 on the unmigrated columns). If the columns are genuinely absent live, the window
// UPDATE throws 42703/P2022 and we fall through the try/catch to a SAFE degrade: charge
// once per call (old per-message behavior) rather than break message handling.
export async function chargeAiCredit({
  conversationId = null,
  tenantId,
  messageId = null,
  tokensIn = null,
  tokensOut = null,
  now = new Date(),
}) {
  return prisma.$transaction(async (tx) => {
    // ── 1) Atomically decide whether THIS call opens a new 24h window ──────────────
    // (see the explicit maxWait/timeout on the $transaction call below for why the
    //  window-flip UPDATE is safe to run under a small connection pool)
    // Only proceed to charge when the window is newly opened by this very UPDATE.
    // If conversationId is missing (shouldn't happen on the live path) we can't do the
    // per-conversation window; fall back to charging this call (fail-safe, never silent-free).
    let windowOpened = true; // default for the no-conversation / drift-degrade path
    const windowExpiresAt = new Date(now.getTime() + CONVERSATION_WINDOW_MS);
    if (conversationId) {
      try {
        const rows = await tx.$executeRaw`
          UPDATE "Conversation"
             SET "windowStartedAt" = ${now},
                 "windowExpiresAt" = ${windowExpiresAt}
           WHERE "id" = ${conversationId}
             AND ("windowExpiresAt" IS NULL OR "windowExpiresAt" <= ${now})`;
        windowOpened = rows === 1;
      } catch (e) {
        // Columns not migrated live yet (P2022 / 42703) → degrade to per-call charge so
        // message handling never breaks. Any other error should still abort the txn.
        const code = e?.code || e?.meta?.code;
        if (code !== 'P2022' && code !== '42703') throw e;
        windowOpened = true;
      }
    }

    // Inside an already-open window → free follow-up. No charge, no ledger row.
    if (!windowOpened) {
      const t = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { monthlyMessageLimit: true, creditsUsedThisPeriod: true, purchasedCredits: true },
      });
      return { charged: false, windowOpen: true, state: t ? creditsState(t) : null };
    }

    // ── 2) A new window opened → charge exactly one credit ─────────────────────────
    // Monthly allotment first (column-to-column compare needs raw SQL), then purchased.
    // Each is a conditional UPDATE so it can never overspend under concurrency.
    let branch = null;
    const monthlyRows = await tx.$executeRaw`
      UPDATE "Tenant"
         SET "creditsUsedThisPeriod" = "creditsUsedThisPeriod" + 1
       WHERE "id" = ${tenantId}
         AND "creditsUsedThisPeriod" < "monthlyMessageLimit"`;
    if (monthlyRows === 1) {
      branch = 'monthly';
    } else {
      const purchasedRows = await tx.$executeRaw`
        UPDATE "Tenant"
           SET "purchasedCredits" = "purchasedCredits" - 1
         WHERE "id" = ${tenantId}
           AND "purchasedCredits" > 0`;
      if (purchasedRows === 1) branch = 'purchased';
    }

    if (!branch) {
      // No credit to spend, but we just flipped the window open above. Throw to roll the
      // WHOLE transaction back (window flip included) so we never "open a window for free"
      // — a retry after a top-up can then legitimately open + charge. The caller gated on
      // hasCredits(); reaching here means credits ran out between the gate and the charge.
      throw new OutOfCreditsError();
    }

    // The charge committed on exactly one branch → record the paired ledger debit.
    await tx.creditTransaction.create({
      data: { tenantId, type: 'debit', amount: -1, reason: 'ai_reply', messageId, tokensIn, tokensOut },
    });

    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { monthlyMessageLimit: true, creditsUsedThisPeriod: true, purchasedCredits: true },
    });
    return { charged: true, windowOpen: true, state: creditsState(t) };
  }, {
    // POOL/CONTENTION SAFETY (defense-in-depth). The REAL fix for pool starvation is the
    // pool SIZE: DATABASE_URL now carries connection_limit=10 (was 1), so distinct
    // $transaction call sites across the app (this charge, the payment webhook, admin
    // mark-paid, flows reorder) each get their OWN pooled connection and no longer
    // head-of-line-block each other. See scripts/pool-contention.test.mjs, which proves
    // 1 slow holder starved 4/4 sibling txns at connection_limit=1 and 0/4 at 10.
    // These per-transaction options are a MODEST cushion ON TOP of that correctly-sized
    // pool — not a substitute for it: maxWait gives a little burst tolerance above
    // Prisma's 2s default if the pool is momentarily saturated (>10 concurrent txns),
    // and timeout caps a pathologically wedged statement so it can't pin a connection.
    // They are deliberately right-sized (not the old 15s/20s band-aid from commit 87b7c8c,
    // which — with a size-1 pool — could itself hold the sole connection for up to 20s and
    // starve every other site). This changes NOTHING about the atomic window-flip
    // semantics — of N concurrent callers exactly one wins the window and charges.
    maxWait: 5000,
    timeout: 10000,
  }).catch((e) => {
    // OutOfCreditsError = a window would have opened but there were no credits. The txn
    // (including the window flip) rolled back. Signal out-of-credits to the caller.
    if (e instanceof OutOfCreditsError) return { charged: false, windowOpen: false, state: null };
    throw e;
  });
}

// Spend EXACTLY ONE credit for a single AI reply (used by the local-Claude pipeline
// once a tenant is over its daily free quota — 1 credit per reply, which is priced
// above the per-reply model cost so credit usage is revenue-positive). Unlike
// chargeAiCredit this is NOT window-based: every over-cap reply costs one credit.
// Monthly allotment first, then purchased; each an atomic conditional UPDATE so it can
// never overspend under concurrency. Returns { charged, state }.
export async function spendOneCredit({ tenantId, reason = 'ai_reply', messageId = null }) {
  return prisma.$transaction(async (tx) => {
    let branch = null;
    const monthlyRows = await tx.$executeRaw`
      UPDATE "Tenant"
         SET "creditsUsedThisPeriod" = "creditsUsedThisPeriod" + 1
       WHERE "id" = ${tenantId}
         AND "creditsUsedThisPeriod" < "monthlyMessageLimit"`;
    if (monthlyRows === 1) {
      branch = 'monthly';
    } else {
      const purchasedRows = await tx.$executeRaw`
        UPDATE "Tenant"
           SET "purchasedCredits" = "purchasedCredits" - 1
         WHERE "id" = ${tenantId}
           AND "purchasedCredits" > 0`;
      if (purchasedRows === 1) branch = 'purchased';
    }
    if (!branch) return { charged: false, state: null };
    await tx.creditTransaction.create({ data: { tenantId, type: 'debit', amount: -1, reason, messageId } });
    const t = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { monthlyMessageLimit: true, creditsUsedThisPeriod: true, purchasedCredits: true },
    });
    return { charged: true, state: creditsState(t) };
  }, { maxWait: 5000, timeout: 10000 });
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
//
// CONCURRENCY (TOCTOU, see AP-T72): two back-to-back inbound messages for a tenant
// that just hit zero both run this. The old code did read-then-write
// (findUnique -> gate on lowCreditNotifiedAt==null -> update), so under Postgres
// Read Committed both could read null, both pass the guard, and both return true —
// violating the "surface the nudge exactly once per low-balance episode" contract.
// Fix mirrors chargeAiCredit()/mark-paid (commits cf4ceb5 / 2d5b9b3): make the
// null->timestamp flip the atomic gate. A single conditional updateMany WHERE
// lowCreditNotifiedAt IS NULL lets Postgres serialize the row write — exactly one
// concurrent caller sees count===1 (return true, "won the flip"), every other sees
// count===0 (return false), so the nudge fires once even under a race.
export async function markLowCreditNudge(tenantId) {
  try {
    const { count } = await prisma.tenant.updateMany({
      where: { id: tenantId, lowCreditNotifiedAt: null },
      data: { lowCreditNotifiedAt: new Date() },
    });
    return count === 1;
  } catch {
    // Best-effort like the prior read-then-write (which swallowed update errors):
    // never let a nudge-bookkeeping failure break message processing.
    return false;
  }
}
