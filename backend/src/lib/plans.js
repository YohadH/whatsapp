// Billing plans. Each plan sets the tenant's messaging limits. Real payment
// collection (Stripe etc.) is out of scope here — assigning a plan sets the
// entitlements the rest of the app enforces (broadcast cap + monthly message
// allowance). Wire a payment provider to flip `plan` on payment success.
export const PLANS = {
  trial: { label: 'Trial', dailyBroadcastCap: 100, monthlyMessageLimit: 500 },
  starter: { label: 'Starter', dailyBroadcastCap: 1000, monthlyMessageLimit: 5000 },
  pro: { label: 'Pro', dailyBroadcastCap: 10000, monthlyMessageLimit: 50000 },
};

export function isValidPlan(plan) {
  return Object.prototype.hasOwnProperty.call(PLANS, plan);
}

// Entitlements for a plan (falls back to trial).
export function planEntitlements(plan) {
  return PLANS[plan] || PLANS.trial;
}
