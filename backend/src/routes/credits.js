import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { creditsState } from '../lib/credits.js';
import { CREDIT_PACKS, getPack } from '../lib/creditPacks.js';
import { createCheckout, activeProvider } from '../services/payments.js';

// Tenant-facing AI credit views (scoped to req.tenant by withTenant). Read-only:
// balance, usage this period, and the ledger history. Top-ups are performed by the
// super-admin for now (POST /api/admin/tenants/:id/credits) until the Israeli payment
// gateway is wired in Phase 3. See CREDITS_DESIGN.md.
const router = Router();

// GET /api/credits → current balance + this-period usage summary.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const t = req.tenant;
    const state = creditsState(t);
    const spent = await prisma.creditTransaction.aggregate({
      where: { tenantId: req.tenantId, type: 'debit', createdAt: { gte: t.periodStartedAt } },
      _sum: { amount: true },
    });
    res.json({
      ...state,
      spentThisPeriod: Math.abs(spent._sum.amount || 0),
      periodStartedAt: t.periodStartedAt,
      lowCredit: state.available <= 0,
    });
  })
);

// GET /api/credits/transactions → ledger history (most recent first).
router.get(
  '/transactions',
  asyncHandler(async (req, res) => {
    const txns = await prisma.creditTransaction.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, type: true, amount: true, reason: true, tokensIn: true, tokensOut: true, createdAt: true },
    });
    res.json(txns);
  })
);

// GET /api/credits/packs → the buyable packs (for the "buy credits" UI).
router.get(
  '/packs',
  asyncHandler(async (req, res) => {
    res.json({ packs: CREDIT_PACKS, currency: 'ILS' });
  })
);

// POST /api/credits/purchase → create a pending purchase for a pack and start payment.
// body: { packId } → { purchaseId, mode, url? }
router.post(
  '/purchase',
  asyncHandler(async (req, res) => {
    const pack = getPack(req.body?.packId);
    if (!pack) return res.status(400).json({ error: 'unknown pack' });

    // Record the purchase under the provider that will actually service it (payplus when
    // configured, else manual). Amount/credits are taken from the SERVER-side pack, never
    // from the client body, so a forged request can't buy more credits than it pays for.
    const provider = activeProvider();
    const purchase = await prisma.creditPurchase.create({
      data: {
        tenantId: req.tenantId,
        packId: pack.id,
        credits: pack.credits,
        amountIls: pack.amountIls,
        status: 'pending',
        provider,
      },
    });

    // createCheckout may return { mode:'redirect', url, providerRef } (PayPlus) — persist
    // the providerRef (page_request_uid) so the async callback can be cross-referenced.
    const checkout = await createCheckout({ purchase, tenant: req.tenant });
    if (checkout?.providerRef) {
      await prisma.creditPurchase.update({
        where: { id: purchase.id },
        data: { providerRef: checkout.providerRef },
      });
    }
    const { providerRef, ...clientCheckout } = checkout || {};
    res.status(201).json({ purchaseId: purchase.id, ...clientCheckout });
  })
);

// GET /api/credits/purchases → this tenant's purchase history.
router.get(
  '/purchases',
  asyncHandler(async (req, res) => {
    const purchases = await prisma.creditPurchase.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(purchases);
  })
);

export default router;
