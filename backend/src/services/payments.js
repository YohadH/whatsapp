import crypto from 'node:crypto';
import Stripe from 'stripe';
import config from '../config/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Payment provider abstraction for credit-pack top-ups AND the recurring ₪490/mo
// HeyIL subscription. Three modes:
//
//   'manual'  → a purchase is created 'pending'; a super-admin marks it paid by hand
//               (POST /api/admin/credit-purchases/:id/mark-paid), which grants credits.
//               Plan assignment for a subscription likewise falls back to a super-admin
//               setting Tenant.plan by hand (PUT /api/admin/tenants/:id).
//   'stripe'  → Stripe (LIVE provider, replaces PayPlus — 2026-07-29 owner decision).
//               createCheckout() opens a Stripe Checkout Session (mode:'payment') for a
//               credit pack; createSubscriptionCheckout() opens one in mode:'subscription'
//               for the HeyIL plan. Stripe POSTs signed webhook events to
//               /api/payments/stripe/webhook on completion/renewal, which flip
//               CreditPurchase.status → 'paid' (grants credits) or set the tenant's
//               subscription fields (grants the plan) automatically. See routes/payments.js.
//   'payplus' → PayPlus (Israeli card gateway). Kept wired as a secondary option, not
//               deleted — see the PayPlus section below. Same createCheckout() shape.
//
// Provider is chosen by config.payments.provider, but 'stripe'/'payplus' silently degrade
// to 'manual' unless their required creds are present (`.enabled`) — so a mis-set
// PAYMENTS_PROVIDER can never leave a tenant unable to pay.
// ─────────────────────────────────────────────────────────────────────────────

// Which provider is ACTUALLY usable right now. 'stripe'/'payplus' require their creds;
// otherwise we fall back to 'manual' so the top-up/subscribe flow always resolves to
// *something* real.
export function activeProvider() {
  const p = config.payments.provider;
  if (p === 'stripe' && !config.payments.stripe.enabled) return 'manual';
  if (p === 'payplus' && !config.payments.payplus.enabled) return 'manual';
  return p;
}

// Begin payment for a pending purchase. Returns either:
//   { mode: 'manual' }                         → the purchase is pending super-admin approval
//   { mode: 'redirect', url, providerRef }     → send the customer to the gateway's hosted page
//
// `providerRef` (Stripe Checkout Session id / PayPlus page_request_uid) is returned so the
// caller can persist it on the CreditPurchase row; the webhook later matches the callback
// back to this purchase by it.
export async function createCheckout({ purchase, tenant } = {}) {
  switch (activeProvider()) {
    case 'stripe':
      return stripeOneTimeCheckout({ purchase, tenant });
    case 'payplus':
      return payPlusCheckout({ purchase, tenant });
    case 'manual':
    default:
      return { mode: 'manual' };
  }
}

// Begin the RECURRING ₪490/mo HeyIL subscription checkout. Same return shape as
// createCheckout(). Only Stripe supports subscriptions today (PayPlus's recurring
// charge_method exists but is not wired here) — any other provider (including
// 'payplus') resolves to 'manual', i.e. the super-admin assigns the plan by hand.
export async function createSubscriptionCheckout({ tenant } = {}) {
  if (activeProvider() !== 'stripe') return { mode: 'manual' };
  return stripeSubscriptionCheckout({ tenant });
}

// ── Stripe: lazily-constructed singleton client. A module-scoped singleton (rather
// than a fresh `new Stripe()` per call) so tests can monkeypatch e.g.
// `stripeClient().checkout.sessions.create` to assert on the exact params sent,
// without a real network call — the same "mock the external boundary" approach the
// PayPlus tests use for `globalThis.fetch` (see scripts/payments.test.mjs).
let _stripe = null;
export function stripeClient() {
  if (_stripe) return _stripe;
  if (!config.payments.stripe.secretKey) return null;
  _stripe = new Stripe(config.payments.stripe.secretKey);
  return _stripe;
}

// ── Stripe: one-time Checkout Session for a credit pack (mode: 'payment') ────────
// client_reference_id carries our CreditPurchase.id so the webhook can match the
// completed session back to the row without trusting anything but our own id (mirrors
// PayPlus's more_info field). Amount/currency come from the SERVER-side purchase row
// (never the client), consistent with how the purchase was created in routes/credits.js.
async function stripeOneTimeCheckout({ purchase, tenant }) {
  const stripe = stripeClient();
  if (!stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  const base = config.publicBaseUrl.replace(/\/$/, '');
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: purchase.id,
    metadata: { purchaseId: purchase.id, kind: 'credit_pack' },
    line_items: [
      {
        price_data: {
          currency: 'ils',
          product_data: { name: purchase.packId },
          unit_amount: purchase.amountIls * 100, // Stripe amounts are in the minor unit (agorot)
        },
        quantity: 1,
      },
    ],
    success_url: `${base}/api/payments/return?status=success&purchase=${purchase.id}`,
    cancel_url: `${base}/api/payments/return?status=failure&purchase=${purchase.id}`,
  });
  return { mode: 'redirect', url: session.url, providerRef: session.id };
}

// ── Stripe: recurring Checkout Session for the HeyIL plan (mode: 'subscription') ──
// Uses a pre-created recurring Price (STRIPE_HEYIL_PRICE_ID) rather than inline
// price_data — a stable recurring Price is what makes this a real subscription (Stripe
// Billing) rather than a one-off charge. metadata.tenantId (set on both the session AND
// the subscription_data, so it also lands on the Subscription/Invoice objects) is how
// the webhook maps the completed checkout back to a tenant.
async function stripeSubscriptionCheckout({ tenant }) {
  const stripe = stripeClient();
  if (!stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  const priceId = config.payments.stripe.heyilPriceId;
  if (!priceId) throw new Error('Stripe is not configured (STRIPE_HEYIL_PRICE_ID missing)');
  const base = config.publicBaseUrl.replace(/\/$/, '');
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    ...(tenant?.stripeCustomerId ? { customer: tenant.stripeCustomerId } : {}),
    metadata: { tenantId: tenant.id, kind: 'subscription' },
    subscription_data: { metadata: { tenantId: tenant.id } },
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/api/payments/return?status=success&purchase=subscription`,
    cancel_url: `${base}/api/payments/return?status=failure&purchase=subscription`,
  });
  return { mode: 'redirect', url: session.url, providerRef: session.id };
}

// ── Stripe: verify + parse a webhook event. Fails CLOSED (returns null) when the
// client/secret isn't configured or the signature doesn't verify — same policy as
// PayPlus's verifyWebhookSignature(): a payment webhook that grants money/plan access
// must never accept an unverifiable call. `rawBody` MUST be the exact bytes Stripe
// sent (captured in app.js via express.json({ verify }) as req.rawBody) — Stripe's
// signature covers the raw payload; re-serializing req.body would break it.
export function verifyAndParseStripeEvent({ rawBody, sigHeader }) {
  const stripe = stripeClient();
  const secret = config.payments.stripe.webhookSecret;
  if (!stripe || !secret || !sigHeader || !rawBody) return null;
  try {
    return stripe.webhooks.constructEvent(rawBody, sigHeader, secret);
  } catch {
    return null; // bad signature / tampered body / wrong secret
  }
}

// ── PayPlus: create a hosted payment page for a pending purchase ────────────────
async function payPlusCheckout({ purchase, tenant }) {
  const pp = config.payments.payplus;
  const base = config.publicBaseUrl.replace(/\/$/, '');
  // more_info carries our own purchase id back on the callback so we can match the
  // transaction to the CreditPurchase row without trusting anything but our own id.
  const body = {
    payment_page_uid: pp.paymentPageUid,
    amount: purchase.amountIls, // whole shekels (PayPlus amount is in the currency's major unit)
    currency_code: 'ILS',
    charge_method: pp.chargeMethod,
    refURL_success: `${base}/api/payments/return?status=success&purchase=${purchase.id}`,
    refURL_failure: `${base}/api/payments/return?status=failure&purchase=${purchase.id}`,
    refURL_callback: `${base}/api/payments/payplus/webhook`,
    more_info: purchase.id,
    customer: {
      customer_name: tenant?.name || 'Tenant',
    },
    items: [
      {
        name: purchase.packId,
        quantity: 1,
        price: purchase.amountIls,
      },
    ],
  };

  const res = await fetch(`${pp.baseUrl.replace(/\/$/, '')}/PaymentPages/generateLink`, {
    method: 'POST',
    headers: {
      'api-key': pp.apiKey,
      'secret-key': pp.secretKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  const ok = res.ok && (json?.results?.status === 'success' || json?.data?.payment_page_link);
  const url = json?.data?.payment_page_link;
  if (!ok || !url) {
    const reason = json?.results?.message || json?.message || `HTTP ${res.status}`;
    const err = new Error(`PayPlus generateLink failed: ${reason}`);
    err.providerResponse = json;
    throw err;
  }
  return { mode: 'redirect', url, providerRef: json?.data?.page_request_uid || null };
}

// ── PayPlus: verify the callback `hash` header over the RAW request body ─────────
// PayPlus signs the callback with HMAC-SHA256 of the raw JSON body, keyed by the
// account's secret key, and puts the digest in the `hash` header. We compare in
// constant time. `rawBody` MUST be the exact bytes PayPlus sent (captured in app.js
// via express.json({ verify }) as req.rawBody) — re-serializing req.body would change
// key order/whitespace and break the comparison.
//
// Returns true only when a secret is configured AND the signature matches. If no secret
// is configured we FAIL CLOSED (return false) — unlike the WhatsApp webhook which is
// dev-permissive, a payment webhook that grants money must never accept an unsigned call.
export function verifyWebhookSignature({ rawBody, hashHeader }) {
  const secret = config.payments.payplus.secretKey;
  if (!secret) return false; // fail closed — never grant credits on an unverifiable call
  if (!hashHeader || !rawBody) return false;
  const enc = config.payments.payplus.hashEncoding === 'hex' ? 'hex' : 'base64';
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest(enc);
  const a = Buffer.from(String(hashHeader));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── PayPlus: normalize the callback body into { purchaseId, providerRef, paid } ──
// The callback shape carries the transaction result. A charge is successful when the
// transaction status is 'approved' (PayPlus uses status_code '000' for approved). We
// read our own purchase id back from more_info (what we put there in createCheckout).
export function parseWebhook(bodyRaw) {
  const body = bodyRaw && typeof bodyRaw === 'object' ? bodyRaw : {};
  const txn = body.transaction && typeof body.transaction === 'object' ? body.transaction : body;
  const statusCode = String(txn.status_code ?? body.status_code ?? '');
  const status = String(txn.status ?? body.status ?? '').toLowerCase();
  const paid = statusCode === '000' || status === 'approved' || status === 'success';
  return {
    // our CreditPurchase.id, echoed back via more_info (or its aliases)
    purchaseId: body.more_info ?? body.more_info_1 ?? txn.more_info ?? null,
    // PayPlus's own transaction/page reference, for the audit trail on providerRef
    providerRef: txn.transaction_uid ?? txn.uid ?? body.page_request_uid ?? null,
    paid,
    statusCode,
    status,
  };
}
