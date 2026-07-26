import config from '../config/index.js';

// Payment provider abstraction for credit-pack top-ups. Today only 'manual' mode is
// wired: a purchase is created 'pending' and a super-admin marks it paid (which grants
// the credits). An Israeli card gateway (PayPlus / Meshulam-Grow / Cardcom) plugs in
// here later behind the same interface — createCheckout returns a redirect URL and the
// gateway's webhook flips the purchase to 'paid'. Requires a merchant account (which
// needs the registered business). See CREDITS_DESIGN.md.

export function activeProvider() {
  return config.payments.provider; // 'manual' until a gateway is configured
}

// Begin payment for a pending purchase. Returns either:
//   { mode: 'manual' }                 → tell the customer their request is pending approval
//   { mode: 'redirect', url }          → send the customer to the gateway's hosted page
export async function createCheckout(/* { purchase, tenant } */) {
  switch (activeProvider()) {
    // case 'payplus':  return payPlusCheckout(...)
    // case 'meshulam': return meshulamCheckout(...)
    // case 'cardcom':  return cardcomCheckout(...)
    case 'manual':
    default:
      return { mode: 'manual' };
  }
}
