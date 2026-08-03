// Billing plans. Each plan sets the tenant's messaging limits. Real payment
// collection (Stripe etc.) is out of scope here — assigning a plan sets the
// entitlements the rest of the app enforces (broadcast cap + monthly message
// allowance). Wire a payment provider to flip `plan` on payment success.
//
// UNIT NOTE: `monthlyMessageLimit` is the tenant's monthly CREDIT allotment. Since
// the credit unit is now "1 credit = 1 handled conversation in a 24h window"
// (see lib/credits.js + CREDITS_DESIGN.md), that number is a count of *handled
// conversations*, not raw messages. `priceIls` is the monthly price in whole
// shekels (null = internal/not-sold plans like trial). The one-time ₪990 setup
// fee is intentionally NOT modeled here — it is a one-off service sold outside
// the app; see CREDITS_DESIGN.md §10.
export const PLANS = {
  // Locked HeyIL commercial plan — ₪490/mo, 500 handled conversations. This is a
  // NEW plan, deliberately separate from `trial` (do not repurpose trial). Keep the
  // `heyil` id stable: it is stored on Tenant.plan.
  heyil: { label: 'HeyIL', priceIls: 490, dailyBroadcastCap: 1000, monthlyMessageLimit: 500 },
  trial: { label: 'Trial', priceIls: null, dailyBroadcastCap: 100, monthlyMessageLimit: 500 },
  starter: { label: 'Starter', priceIls: null, dailyBroadcastCap: 1000, monthlyMessageLimit: 5000 },
  pro: { label: 'Pro', priceIls: null, dailyBroadcastCap: 10000, monthlyMessageLimit: 50000 },
};

export function isValidPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLANS, plan);
}

// A tenant with an ACTIVE paid Stripe subscription. This is the single source of
// truth for "is currently paying". `subscriptionStatus` is Stripe's own value
// (active | past_due | canceled | incomplete), kept in sync by the Stripe webhooks
// (routes/payments.js): checkout.session.completed / invoice.paid set 'active';
// invoice.payment_failed → 'past_due'; customer.subscription.deleted → 'canceled'.
// A lapsed subscriber is reverted to plan:'trial' by those same webhooks but keeps
// a non-'active' subscriptionStatus, so this predicate correctly stops treating them
// as paying. Column is migration 9_stripe_billing (live-applied — payment webhooks
// read/write it in prod). Only pass a tenant row that explicitly selected the field.
export function hasActivePaidSubscription(tenant) {
  return tenant?.subscriptionStatus === 'active';
}

// TRUE when this is a self-service trial tenant whose 14-day trial has ELAPSED and
// who has NOT converted to a paid subscription. Such a tenant must NOT be granted or
// re-granted platform AI credits (that would let anyone farm the platform's own
// OpenAI bill indefinitely from a throwaway trial signup — the cost-leak this guards).
//
//   - trialEndsAt is null → NOT a self-service trial (admin-provisioned / paid): never
//     "expired" by this check. Unaffected.
//   - trialEndsAt in the FUTURE → still inside the trial window. Unaffected.
//   - trialEndsAt in the PAST + active paid sub → converted; keep serving. Unaffected.
//   - trialEndsAt in the PAST + NO active paid sub → expired & unpaid → true (gate).
//
// DRIFT SAFETY (AP-T71): reads only trialEndsAt (0_init) + subscriptionStatus
// (9_stripe_billing) — both live-migrated. Pass a tenant row whose `select` includes
// both; a row missing them reads undefined and this returns false (fail-open on the
// benign side, i.e. never wrongly locks out a tenant on a partial projection).
export function isTrialExpiredUnpaid(tenant, now = new Date()) {
  if (!tenant) return false;
  const ends = tenant.trialEndsAt;
  if (!ends) return false; // not a self-service trial → never expires here
  if (hasActivePaidSubscription(tenant)) return false; // converted to paid
  return new Date(ends).getTime() < now.getTime();
}

// Entitlements for a plan (falls back to trial).
export function planEntitlements(plan) {
  return PLANS[plan] || PLANS.trial;
}
