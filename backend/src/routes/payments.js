import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { verifyWebhookSignature, parseWebhook, verifyAndParseStripeEvent } from '../services/payments.js';
import { planEntitlements } from '../lib/plans.js';
import config from '../config/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC payment routes — mounted WITHOUT auth/withTenant (the gateways call these,
// not a logged-in admin). Endpoints:
//
//   POST /api/payments/stripe/webhook   → Stripe's server-to-server event delivery.
//        Signature-verified (stripe-signature header), then handles:
//          - checkout.session.completed (mode:'payment')      → flips the matched
//            CreditPurchase pending→paid and grants the credits (TOCTOU-safe, AP-T72,
//            same pattern as the PayPlus webhook below).
//          - checkout.session.completed (mode:'subscription') → sets the tenant's
//            plan to 'heyil' + records stripeCustomerId/stripeSubscriptionId. This is
//            an idempotent field SET (not a counter/balance mutation), so a duplicate
//            delivery just re-writes the same values — no atomic-conditional gate needed.
//          - invoice.paid                                     → keeps subscriptionStatus
//            in sync ('active') on each renewal charge.
//          - invoice.payment_failed                           → a declined renewal
//            lapses the tenant to subscriptionStatus:'past_due'.
//          - customer.subscription.deleted                    → an ended/cancelled
//            subscription sets subscriptionStatus:'canceled'. Without these two the
//            status is stuck 'active' forever once a tenant subscribes.
//   POST /api/payments/payplus/webhook  → PayPlus's server-to-server callback (IPN).
//        Signature-verified, then flips the matched CreditPurchase pending→paid and
//        grants the credits — kept wired as a secondary provider option (not deleted).
//        Idempotent + TOCTOU-safe (AP-T72).
//   GET  /api/payments/return           → where the CUSTOMER's browser lands after the
//        hosted page (success/failure). Cosmetic only — never grants credits/plan (the
//        webhook is the source of truth); a browser redirect is spoofable.
// ─────────────────────────────────────────────────────────────────────────────
const router = Router();

// POST /api/payments/stripe/webhook
router.post(
  '/stripe/webhook',
  asyncHandler(async (req, res) => {
    // 1) Verify the signature over the RAW body (captured in app.js as req.rawBody).
    //    Fail CLOSED — a payment webhook that grants money/plan access must never
    //    accept an unverifiable call (verifyAndParseStripeEvent returns null when no
    //    secret is configured or the signature doesn't match).
    const event = verifyAndParseStripeEvent({ rawBody: req.rawBody, sigHeader: req.get('stripe-signature') });
    if (!event) {
      console.warn('[payments] Stripe webhook signature verification failed — rejecting');
      return res.sendStatus(403);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // ── One-time credit-pack purchase (mode:'payment') ──
      if (session.mode === 'payment') {
        const purchaseId = session.client_reference_id;
        if (!purchaseId) return res.status(200).json({ received: true, credited: false });

        // Atomic flip pending→paid + grant, in ONE transaction (AP-T72). Mirrors the
        // PayPlus webhook: the status flip IS the concurrency gate, so a webhook retry
        // / duplicate event can never double-credit. Re-assert provider:'stripe' on the
        // WHERE so a 'manual'/'payplus' purchase can't be flipped by this route.
        const outcome = await prisma.$transaction(async (tx) => {
          const flip = await tx.creditPurchase.updateMany({
            where: { id: purchaseId, provider: 'stripe', status: { not: 'paid' } },
            data: { status: 'paid', paidAt: new Date(), providerRef: session.id },
          });
          if (flip.count !== 1) {
            const existing = await tx.creditPurchase.findUnique({
              where: { id: purchaseId },
              select: { id: true, status: true },
            });
            return { credited: false, reason: existing ? 'already_paid' : 'not_found' };
          }
          const purchase = await tx.creditPurchase.findUnique({
            where: { id: purchaseId },
            select: { tenantId: true, credits: true, packId: true },
          });
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
      }

      // ── Recurring HeyIL subscription (mode:'subscription') ──
      if (session.mode === 'subscription') {
        const tenantId = session.metadata?.tenantId;
        if (!tenantId) return res.status(200).json({ received: true, subscribed: false });

        const ent = planEntitlements('heyil');
        const flip = await prisma.tenant.updateMany({
          where: { id: tenantId },
          data: {
            plan: 'heyil',
            dailyBroadcastCap: ent.dailyBroadcastCap,
            monthlyMessageLimit: ent.monthlyMessageLimit,
            stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
            stripeSubscriptionId:
              typeof session.subscription === 'string' ? session.subscription : session.subscription?.id || null,
            subscriptionStatus: 'active',
          },
        });
        return res.status(200).json({ received: true, subscribed: flip.count === 1 });
      }

      return res.status(200).json({ received: true });
    }

    // ── Subscription renewal confirmation ──
    if (event.type === 'invoice.paid') {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
      if (subscriptionId) {
        await prisma.tenant.updateMany({
          where: { stripeSubscriptionId: subscriptionId },
          data: { subscriptionStatus: 'active' },
        });
      }
      return res.status(200).json({ received: true });
    }

    // ── Failed renewal charge — the subscription lapses into a non-paying state. ──
    // Stripe fires invoice.payment_failed when a recurring charge is declined (card
    // expired, insufficient funds, etc.). Mark the tenant past_due so paid entitlements
    // stop reflecting a paid subscription (matches the schema's documented convention:
    // active | past_due | canceled | incomplete). We match by stripeSubscriptionId, the
    // same way invoice.paid does. Idempotent field SET — a retry just re-writes past_due.
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const subscriptionId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
      if (subscriptionId) {
        await prisma.tenant.updateMany({
          where: { stripeSubscriptionId: subscriptionId },
          data: { subscriptionStatus: 'past_due' },
        });
      }
      return res.status(200).json({ received: true });
    }

    // ── Subscription ended/cancelled — explicit revocation of the paid subscription. ──
    // Stripe fires customer.subscription.deleted when a subscription is cancelled (by the
    // customer, by us, or after Stripe exhausts its dunning retries on repeated payment
    // failures). Without this handler a cancelled tenant would keep subscriptionStatus
    // stuck at 'active' forever. The event's data.object IS the subscription, so its `id`
    // is the stripeSubscriptionId we stored. Idempotent field SET.
    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object;
      const subscriptionId = typeof subscription.id === 'string' ? subscription.id : null;
      if (subscriptionId) {
        await prisma.tenant.updateMany({
          where: { stripeSubscriptionId: subscriptionId },
          data: { subscriptionStatus: 'canceled' },
        });
      }
      return res.status(200).json({ received: true });
    }

    // Unhandled event types are ack'd 200 so Stripe doesn't retry forever.
    return res.status(200).json({ received: true, ignored: event.type });
  })
);

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
        where: { id: parsed.purchaseId, provider: 'payplus', status: { not: 'paid' } },
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
