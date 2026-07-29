import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { createSubscriptionCheckout, activeProvider } from '../services/payments.js';

// Tenant-facing subscription checkout for the recurring ₪490/mo HeyIL plan. Mounted
// with requireAuth + withTenant (see app.js) — a logged-in tenant admin starts their
// own subscription; the Stripe webhook (routes/payments.js) is what actually grants
// the plan once the checkout completes, never this route.
const router = Router();

// POST /api/billing/subscribe → start a Stripe Checkout Session (mode:'subscription')
// for the HeyIL plan. Returns { mode:'redirect', url } when Stripe is the live
// provider, or { mode:'manual' } otherwise (a super-admin assigns the plan by hand,
// same fallback as the credit-pack flow in routes/credits.js).
router.post(
  '/subscribe',
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: { id: true, name: true, stripeCustomerId: true },
    });
    const checkout = await createSubscriptionCheckout({ tenant });
    const { providerRef, ...clientCheckout } = checkout || {};
    res.status(201).json({ provider: activeProvider(), ...clientCheckout });
  })
);

export default router;
