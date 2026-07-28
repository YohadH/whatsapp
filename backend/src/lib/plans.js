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

// Entitlements for a plan (falls back to trial).
export function planEntitlements(plan) {
  return PLANS[plan] || PLANS.trial;
}
