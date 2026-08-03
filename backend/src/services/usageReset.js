import prisma from '../lib/prisma.js';
import config from '../config/index.js';

// Reset each tenant's per-period counters once its usage window
// (config.usage.periodDays, default 30) has elapsed. Stamps a fresh period start and
// zeroes the message counter for EVERY elapsed tenant, but the AI-credit RE-GRANT
// (zeroing creditsUsedThisPeriod, which hands back the plan's monthly allotment) is
// WITHHELD from self-service trial tenants whose trial has expired without converting
// to a paid Stripe subscription. Otherwise every tenant — including a throwaway trial
// with an expired trialEndsAt and no subscription — would get ~500 free credits
// re-granted every period forever, letting anyone farm the platform's own OpenAI bill
// indefinitely (the cost-leak this guards). Safe to run often and idempotent.
//
// Split into two conditional updateMany calls because updateMany writes the SAME data
// to every matched row: one grants credits to the eligible cohort (not expired-unpaid),
// the other advances the period bookkeeping for expired-unpaid tenants WITHOUT the
// credit re-grant. "Expired-unpaid" is: trialEndsAt in the past AND subscriptionStatus
// is not 'active' (Stripe webhooks keep subscriptionStatus in sync — a converted or
// recovered subscriber is 'active'; a lapsed one is past_due/canceled and stays gated).
// Both selects reference only live-migrated columns (trialEndsAt=0_init,
// subscriptionStatus=9_stripe_billing) — drift-safe (AP-T71).
export async function resetElapsedPeriods(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.usage.periodDays * 24 * 60 * 60 * 1000);

  // Predicate: this tenant's trial has expired AND they have no active paid subscription.
  //
  // NULL-SAFETY (verified against the live DB, not assumed): subscriptionStatus is a
  // NULLABLE column and the overwhelming majority of expired trials have it NULL (they
  // never subscribed). Prisma's `NOT: { subscriptionStatus: 'active' }` / `{ not: 'active' }`
  // compile to SQL `subscriptionStatus <> 'active'`, which is UNKNOWN (not TRUE) for NULL
  // rows under SQL three-valued logic — so they MATCH ZERO null-sub tenants, silently
  // leaving the entire primary attack cohort in the credit-re-granting path. The explicit
  // `OR: [{ subscriptionStatus: null }, { not: 'active' }]` is the NULL-safe "no active sub".
  const noActiveSub = { OR: [{ subscriptionStatus: null }, { subscriptionStatus: { not: 'active' } }] };
  const expiredUnpaid = {
    trialEndsAt: { not: null, lt: now },
    ...noActiveSub,
  };

  // 1) Eligible tenants (NOT expired-unpaid) → full reset, credit allotment re-granted.
  const granted = await prisma.tenant.updateMany({
    where: { periodStartedAt: { lt: cutoff }, NOT: expiredUnpaid },
    data: { messagesThisPeriod: 0, creditsUsedThisPeriod: 0, lowCreditNotifiedAt: null, periodStartedAt: now },
  });

  // 2) Expired-unpaid trial tenants → advance the period + reset the message counter,
  //    but DO NOT zero creditsUsedThisPeriod (no credit re-grant). Their AI stays gated
  //    by hasCredits() until they convert to paid (which the Stripe grant path restores).
  const gated = await prisma.tenant.updateMany({
    where: { periodStartedAt: { lt: cutoff }, ...expiredUnpaid },
    data: { messagesThisPeriod: 0, periodStartedAt: now },
  });

  const count = granted.count + gated.count;
  if (count) {
    console.log(
      `[usage] reset period for ${count} tenant(s) — credits re-granted to ${granted.count}, ` +
        `withheld from ${gated.count} expired-unpaid trial(s)`
    );
  }
  return count;
}

// Run at boot and every `intervalHours` after. Returns the timer so callers can
// clear it (tests/shutdown). Failures are logged, never thrown.
export function startUsageResetScheduler(intervalHours = 6) {
  const tick = () => resetElapsedPeriods().catch((err) => console.error('[usage] reset failed:', err.message));
  tick();
  const timer = setInterval(tick, intervalHours * 60 * 60 * 1000);
  timer.unref?.(); // don't keep the process alive just for this
  return timer;
}
