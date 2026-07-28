import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { verifyWebhookSignature, parseWebhook } from '../services/payments.js';
import config from '../config/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC payment routes — mounted WITHOUT auth/withTenant (PayPlus calls these,
// not a logged-in admin). Two endpoints:
//
//   POST /api/payments/payplus/webhook  → PayPlus's server-to-server callback (IPN).
//        Signature-verified, then flips the matched CreditPurchase pending→paid and
//        grants the credits — the *only* automatic paid-flip path (manual mode still
//        uses the super-admin route). Idempotent + TOCTOU-safe (AP-T72).
//   GET  /api/payments/return           → where the CUSTOMER's browser lands after the
//        hosted page (success/failure). Cosmetic only — never grants credits (the
//        webhook is the source of truth); a browser redirect is spoofable.
// ─────────────────────────────────────────────────────────────────────────────
const router = Router();

// POST /api/payments/payplus/webhook
router.post(
  '/payplus/webhook',
  asyncHandler(async (req, res) => {
    // 1) Verify the signature over the RAW body (captured in app.js as req.rawBody).
    //    Fail CLOSED — a payment webhook that grants money must never accept an
    //    unverifiable call (verifyWebhookSignature returns false when no secret set).
    const ok = verifyWebhookSignature({
      rawBody: req.rawBody,
      hashHeader: req.get('hash'),
    });
    if (!ok) {
      console.warn('[payments] PayPlus webhook signature verification failed — rejecting');
      return res.sendStatus(403);
    }

    // 2) Parse the callback. Ack fast regardless of outcome so PayPlus doesn't retry a
    //    non-charge event forever; only a successful charge grants credits.
    const parsed = parseWebhook(req.body);
    if (!parsed.paid || !parsed.purchaseId) {
      return res.status(200).json({ received: true, credited: false });
    }

    // 3) Atomic flip pending→paid + grant, in ONE transaction (AP-T72). Mirrors the
    //    admin mark-paid route: the status flip IS the concurrency gate, so a webhook
    //    retry / duplicate callback can never double-credit. We ALSO re-assert the
    //    provider on the WHERE so a 'manual' purchase can't be flipped by a spoofed
    //    (but here signature-verified) call for a mismatched id.
    const outcome = await prisma.$transaction(async (tx) => {
      const flip = await tx.creditPurchase.updateMany({
        where: { id: parsed.purchaseId, status: { not: 'paid' } },
        data: { status: 'paid', paidAt: new Date(), providerRef: parsed.providerRef },
      });
      if (flip.count !== 1) {
        // 0 rows: unknown id, or already paid (a prior/duplicate callback won). Never
        // grant twice; distinguish only for the log.
        const existing = await tx.creditPurchase.findUnique({
          where: { id: parsed.purchaseId },
          select: { id: true, status: true },
        });
        return { credited: false, reason: existing ? 'already_paid' : 'not_found' };
      }
      // Won the flip → grant the credits in the SAME transaction (balance increment +
      // ledger row atomic with the status flip, so a crash can't leave paid-but-not-
      // credited). Read the just-flipped row for its tenantId/credits/packId.
      const purchase = await tx.creditPurchase.findUnique({
        where: { id: parsed.purchaseId },
        select: { tenantId: true, credits: true, packId: true },
      });
      // Explicit select (AP-T71): the live DB has the deliberate waPin drift (migration
      // 3_tenant_wa_pin unapplied); an implicit RETURNING * on Tenant would P2022. We only
      // need to write the increment, so return the minimal id.
      await tx.tenant.update({
        where: { id: purchase.tenantId },
        data: { purchasedCredits: { increment: purchase.credits } },
        select: { id: true },
      });
      await tx.creditTransaction.create({
        data: { tenantId: purchase.tenantId, type: 'topup', amount: purchase.credits, reason: purchase.packId },
      });
      return { credited: true, credits: purchase.credits };
    });

    return res.status(200).json({ received: true, ...outcome });
  })
);

// GET /api/payments/return — customer browser lands here after the hosted page.
// Cosmetic redirect back into the admin SPA; grants nothing.
router.get(
  '/return',
  asyncHandler(async (req, res) => {
    const status = req.query.status === 'success' ? 'success' : 'failure';
    const appBase = (config.corsOrigins && config.corsOrigins[0]) || config.publicBaseUrl;
    return res.redirect(`${appBase.replace(/\/$/, '')}/credits?payment=${status}`);
  })
);

export default router;
