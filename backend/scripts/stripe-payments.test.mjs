#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WA-DEV-STRIPE — verification harness for the Stripe payment integration
// (replaces PayPlus as the live gateway; PayPlus stays wired as a secondary option).
//
// Verifies the task's Testable criterion: Checkout in test-mode for both a credit-pack
// top-up AND the ₪490/mo HeyIL subscription close, the webhook flips CreditPurchase/
// tenant subscription to 'paid'/'active' AUTOMATICALLY (not by hand), and credits/plan
// are granted.
//
// TEST METHODOLOGY (mirrors scripts/payments.test.mjs, whatsapp-agent-fix-test-
// methodology-duplicated-logic): the state-transition cases DRIVE THE REAL webhook
// route — they boot the real Express app (src/app.js) and POST genuinely
// Stripe-signed events to the REAL POST /api/payments/stripe/webhook handler over
// HTTP, then assert on the committed live-DB state. The ONLY mocked boundary is
// Stripe's outbound network call for Checkout Session creation
// (stripeClient().checkout.sessions.create) — an external we can't hit without a real
// Stripe test-mode account (the owner's keys). Signature verification is NOT mocked:
// stripe.webhooks.constructEvent runs for real against a payload signed with
// stripe.webhooks.generateTestHeaderString (stripe-node's own testing helper — pure
// local HMAC, no network), so a tampered/unsigned/wrong-secret call is proven to be
// REJECTED by the real route, not just asserted by convention.
//
// WHAT IS PROVEN LIVE (real logic, real DB, real route):
//   A. activeProvider() resolves to 'stripe' when creds are present.
//   B. createCheckout('stripe') builds the correct one-time Checkout Session params
//      (mode:'payment', ils amount in agorot, client_reference_id) — Stripe HTTP
//      boundary mocked.
//   C. createSubscriptionCheckout() builds the correct recurring Checkout Session
//      params (mode:'subscription', configured Price id, tenantId metadata) — Stripe
//      HTTP boundary mocked.
//   D. verifyAndParseStripeEvent: a genuinely-signed payload verifies; a tampered
//      body / wrong secret / missing signature is rejected (fails closed).
//   E. REAL webhook route: checkout.session.completed (mode:'payment') flips a
//      pending CreditPurchase → paid and grants exactly the pack's credits.
//   F. Idempotency: a duplicate delivery of the same event does NOT double-credit.
//   G. Concurrency (AP-T72): two genuinely-concurrent deliveries credit exactly once.
//   H. Provider guard: a 'manual'-provider purchase is never flipped by the Stripe
//      webhook, even with a valid signature and a matching id.
//   I. REAL webhook route: checkout.session.completed (mode:'subscription') sets the
//      tenant's plan to 'heyil' (+ correct entitlements), stripeCustomerId,
//      stripeSubscriptionId, subscriptionStatus:'active'.
//   J. REAL webhook route: invoice.paid keeps subscriptionStatus:'active' in sync for
//      the tenant matched by stripeSubscriptionId.
//   K. An invalid signature is rejected with 403 by the real route (no state change).
//   L. REAL webhook route: invoice.payment_failed lapses the matched tenant to
//      subscriptionStatus:'past_due' (a declined renewal revokes the 'active' state).
//   M. REAL webhook route: customer.subscription.deleted sets the matched tenant to
//      subscriptionStatus:'canceled' (an ended/cancelled subscription is revoked).
//
// NOT verified here: a real call to Stripe's live/test-mode API (no account keys in
// this sandbox — the task is explicit that live activation needs the owner's Stripe
// keys, read from env, never hardcoded).
//
// Run from backend/:  node scripts/stripe-payments.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

import http from 'node:http';

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

// ── Set env BEFORE importing config/app so config picks it up (ESM imports are
//    hoisted+evaluated first — a static `import config` would cache pre-set values).
//    These are TEST-MODE-shaped values only, never real Stripe credentials.
process.env.PAYMENTS_PROVIDER = 'stripe';
process.env.STRIPE_SECRET_KEY = 'sk_test_51_do_not_use_in_prod_0000000000000000';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_do_not_use_in_prod_00000000000000';
process.env.STRIPE_HEYIL_PRICE_ID = 'price_test_heyil_490';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.example.test';

// Fail-closed prod-DB guard: refuse to run this destructive (create/delete tenant)
// harness unless DATABASE_URL points at a disposable/local test DB (never live prod).
const { assertTestDb } = await import('./lib/assert-test-db.mjs');
assertTestDb();

const prisma = (await import('../src/lib/prisma.js')).default;
const app = (await import('../src/app.js')).default;
const { planEntitlements } = await import('../src/lib/plans.js');
const {
  activeProvider,
  createCheckout,
  createSubscriptionCheckout,
  verifyAndParseStripeEvent,
  stripeClient,
} = await import('../src/services/payments.js');

function request(server, { method, path: p, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Sign a Stripe event payload the way the real gateway signs a webhook delivery
// (stripe-node's own testing helper — pure local HMAC, no network) and POST it to
// the REAL route.
function postStripeWebhook(server, eventObj, { secret = process.env.STRIPE_WEBHOOK_SECRET } = {}) {
  const payload = JSON.stringify(eventObj);
  const sig = stripeClient().webhooks.generateTestHeaderString({ payload, secret });
  return request(server, {
    method: 'POST',
    path: '/api/payments/stripe/webhook',
    body: payload,
    headers: { 'stripe-signature': sig },
  });
}

async function main() {
  // ── A: provider resolution ────────────────────────────────────────────────────
  check('A — activeProvider() resolves to stripe when creds present', activeProvider() === 'stripe');

  // ── B/C: createCheckout / createSubscriptionCheckout build correct params
  //    (Stripe HTTP boundary mocked on the module-scoped client singleton) ────────
  let captured = null;
  stripeClient().checkout.sessions.create = async (params) => {
    captured = params;
    return { id: 'cs_test_captured', url: 'https://checkout.stripe.test/pay/abc' };
  };

  const oneTime = await createCheckout({
    purchase: { id: 'PID77', packId: 'pack_500', credits: 500, amountIls: 250 },
    tenant: { id: 'ten_1', name: 'Acme' },
  });
  check('B — createCheckout returns the hosted Checkout URL', oneTime.mode === 'redirect' && oneTime.url === 'https://checkout.stripe.test/pay/abc');
  check('B — providerRef is the Checkout Session id', oneTime.providerRef === 'cs_test_captured');
  check('B — session mode is "payment"', captured.mode === 'payment');
  check('B — client_reference_id carries our purchase id', captured.client_reference_id === 'PID77');
  check(
    'B — amount is in agorot (ILS minor unit) with correct currency',
    captured.line_items[0].price_data.unit_amount === 25000 && captured.line_items[0].price_data.currency === 'ils'
  );
  check('B — success/cancel URLs point at our public callback', /\/api\/payments\/return\?status=success/.test(captured.success_url));

  const sub = await createSubscriptionCheckout({ tenant: { id: 'ten_1', name: 'Acme', stripeCustomerId: null } });
  check('C — createSubscriptionCheckout returns the hosted Checkout URL', sub.mode === 'redirect' && sub.url === 'https://checkout.stripe.test/pay/abc');
  check('C — session mode is "subscription"', captured.mode === 'subscription');
  check('C — uses the configured HeyIL recurring Price id', captured.line_items[0].price === 'price_test_heyil_490');
  check('C — tenantId flows into session + subscription metadata', captured.metadata.tenantId === 'ten_1' && captured.subscription_data.metadata.tenantId === 'ten_1');

  // ── D: signature verification (real crypto, no network) ──────────────────────
  const okEvt = { id: 'evt_x', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_x', mode: 'payment' } } };
  const okPayload = JSON.stringify(okEvt);
  const goodSig = stripeClient().webhooks.generateTestHeaderString({ payload: okPayload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const verified = verifyAndParseStripeEvent({ rawBody: Buffer.from(okPayload), sigHeader: goodSig });
  check('D — a genuinely-signed event verifies and parses', verified?.type === 'checkout.session.completed');
  const wrongSig = stripeClient().webhooks.generateTestHeaderString({ payload: okPayload, secret: 'whsec_totally_wrong' });
  check('D — wrong-secret signature is rejected', verifyAndParseStripeEvent({ rawBody: Buffer.from(okPayload), sigHeader: wrongSig }) === null);
  check('D — tampered body is rejected', verifyAndParseStripeEvent({ rawBody: Buffer.from(okPayload + ' '), sigHeader: goodSig }) === null);
  check('D — missing signature header is rejected', verifyAndParseStripeEvent({ rawBody: Buffer.from(okPayload), sigHeader: '' }) === null);

  // ── Boot the real app on an ephemeral port ───────────────────────────────────
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const TAG = `_wa-stripe-test-${Date.now()}`;
  const tenant = await prisma.tenant.create({
    data: { name: TAG, slug: TAG, monthlyMessageLimit: 0, creditsUsedThisPeriod: 0, purchasedCredits: 0 },
    select: { id: true },
  });
  try {
    // ── K: an invalid signature is rejected by the REAL route ──────────────────
    const bad = await request(server, {
      method: 'POST',
      path: '/api/payments/stripe/webhook',
      body: JSON.stringify({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } }),
      headers: { 'stripe-signature': 't=1,v1=not_a_real_signature' },
    });
    check('K — REAL route rejects an invalid signature with 403', bad.status === 403, `status=${bad.status}`);

    // ── E: checkout.session.completed (mode:'payment') flips pending→paid + grants,
    //    via the REAL route ──────────────────────────────────────────────────────
    const purchase = await prisma.creditPurchase.create({
      data: { tenantId: tenant.id, packId: 'pack_500', credits: 500, amountIls: 250, status: 'pending', provider: 'stripe' },
      select: { id: true },
    });
    const evt1 = {
      id: 'evt_pay_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_live_1', object: 'checkout.session', mode: 'payment', client_reference_id: purchase.id, customer: null, subscription: null } },
    };
    const r1 = await postStripeWebhook(server, evt1);
    check('E — REAL route acks 200 + credited:true', r1.status === 200 && r1.body?.credited === true, `status=${r1.status} body=${JSON.stringify(r1.body)}`);
    const afterPurchase = await prisma.creditPurchase.findUnique({ where: { id: purchase.id }, select: { status: true, providerRef: true } });
    check('E — CreditPurchase.status auto-flipped to paid', afterPurchase.status === 'paid', `status=${afterPurchase.status}`);
    check('E — providerRef recorded as the Checkout Session id', afterPurchase.providerRef === 'cs_live_1');
    const afterTenant = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('E — 500 credits landed in purchasedCredits', afterTenant.purchasedCredits === 500, `purchasedCredits=${afterTenant.purchasedCredits}`);
    check('E — exactly one topup ledger row', (await prisma.creditTransaction.count({ where: { tenantId: tenant.id, type: 'topup' } })) === 1);

    // ── F: idempotency — a DUPLICATE (retry) delivery of the SAME event must NOT
    //    double-credit ─────────────────────────────────────────────────────────
    const r2 = await postStripeWebhook(server, evt1);
    check('F — duplicate delivery acks 200 but credited:false', r2.status === 200 && r2.body?.credited === false, `body=${JSON.stringify(r2.body)}`);
    const tenant2 = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('F — purchasedCredits still 500 after the retry', tenant2.purchasedCredits === 500, `purchasedCredits=${tenant2.purchasedCredits}`);

    // ── G: concurrency — two simultaneous deliveries credit exactly once (AP-T72) ─
    const purchase2 = await prisma.creditPurchase.create({
      data: { tenantId: tenant.id, packId: 'pack_250', credits: 250, amountIls: 150, status: 'pending', provider: 'stripe' },
      select: { id: true },
    });
    const evt2 = {
      id: 'evt_pay_race',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_race', object: 'checkout.session', mode: 'payment', client_reference_id: purchase2.id, customer: null, subscription: null } },
    };
    const race = await Promise.all([postStripeWebhook(server, evt2), postStripeWebhook(server, evt2)]);
    const credited = race.filter((r) => r.status === 200 && r.body?.credited === true).length;
    check('G — two concurrent deliveries credit exactly once', credited === 1, `creditedWinners=${credited}`);
    const t3 = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('G — purchasedCredits is 750 (500 + one 250 grant)', t3.purchasedCredits === 750, `purchasedCredits=${t3.purchasedCredits}`);

    // ── H: provider guard — a 'manual' purchase must NEVER be flippable by the
    //    Stripe webhook, even with a valid signature and a matching id ───────────
    const manualPurchase = await prisma.creditPurchase.create({
      data: { tenantId: tenant.id, packId: 'pack_1000', credits: 1000, amountIls: 450, status: 'pending', provider: 'manual' },
      select: { id: true },
    });
    const evt3 = {
      id: 'evt_pay_spoof',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_spoof', object: 'checkout.session', mode: 'payment', client_reference_id: manualPurchase.id, customer: null, subscription: null } },
    };
    const rManual = await postStripeWebhook(server, evt3);
    check('H — stripe webhook does NOT credit a manual-provider purchase', rManual.status === 200 && rManual.body?.credited === false, `body=${JSON.stringify(rManual.body)}`);
    const afterManual = await prisma.creditPurchase.findUnique({ where: { id: manualPurchase.id }, select: { status: true } });
    check('H — the manual purchase stays pending (never flipped to paid)', afterManual.status === 'pending', `status=${afterManual.status}`);

    // ── I: checkout.session.completed (mode:'subscription') grants the HeyIL plan,
    //    via the REAL route ──────────────────────────────────────────────────────
    const evtSub = {
      id: 'evt_sub_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_sub_1',
          object: 'checkout.session',
          mode: 'subscription',
          metadata: { tenantId: tenant.id },
          customer: 'cus_test_1',
          subscription: 'sub_test_1',
        },
      },
    };
    const rSub = await postStripeWebhook(server, evtSub);
    check('I — REAL route acks 200 + subscribed:true', rSub.status === 200 && rSub.body?.subscribed === true, `body=${JSON.stringify(rSub.body)}`);
    const ent = planEntitlements('heyil');
    const afterSub = await prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { plan: true, dailyBroadcastCap: true, monthlyMessageLimit: true, stripeCustomerId: true, stripeSubscriptionId: true, subscriptionStatus: true },
    });
    check('I — tenant.plan is heyil', afterSub.plan === 'heyil', `plan=${afterSub.plan}`);
    check('I — entitlements match the HeyIL plan', afterSub.dailyBroadcastCap === ent.dailyBroadcastCap && afterSub.monthlyMessageLimit === ent.monthlyMessageLimit);
    check('I — stripeCustomerId recorded', afterSub.stripeCustomerId === 'cus_test_1');
    check('I — stripeSubscriptionId recorded', afterSub.stripeSubscriptionId === 'sub_test_1');
    check('I — subscriptionStatus is active', afterSub.subscriptionStatus === 'active');

    // ── J: invoice.paid keeps subscriptionStatus in sync on renewal ──────────────
    // Simulate a lapse first (as if a prior invoice.payment_failed had set it), then
    // confirm invoice.paid brings it back to 'active' for the matched tenant.
    // Explicit select (AP-T71): the live DB has the deliberate waPin drift (migration
    // 3_tenant_wa_pin unapplied); an implicit RETURNING * would P2022.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { subscriptionStatus: 'past_due' }, select: { id: true } });
    const evtInvoice = {
      id: 'evt_invoice_1',
      object: 'event',
      type: 'invoice.paid',
      data: { object: { id: 'in_test_1', object: 'invoice', subscription: 'sub_test_1' } },
    };
    const rInv = await postStripeWebhook(server, evtInvoice);
    check('J — REAL route acks 200 on invoice.paid', rInv.status === 200, `status=${rInv.status}`);
    const afterInvoice = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { subscriptionStatus: true } });
    check('J — subscriptionStatus back to active after renewal', afterInvoice.subscriptionStatus === 'active', `status=${afterInvoice.subscriptionStatus}`);

    // ── L: invoice.payment_failed lapses the tenant to past_due ──────────────────
    // Precondition: the tenant is 'active' (set by J above). A declined renewal must
    // revoke that. Matches by stripeSubscriptionId (sub_test_1, set in case I).
    const evtFailed = {
      id: 'evt_invoice_failed_1',
      object: 'event',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_test_failed_1', object: 'invoice', subscription: 'sub_test_1' } },
    };
    const rFailed = await postStripeWebhook(server, evtFailed);
    check('L — REAL route acks 200 on invoice.payment_failed', rFailed.status === 200, `status=${rFailed.status}`);
    const afterFailed = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { subscriptionStatus: true } });
    check('L — subscriptionStatus lapsed to past_due after a failed charge', afterFailed.subscriptionStatus === 'past_due', `status=${afterFailed.subscriptionStatus}`);

    // ── M: customer.subscription.deleted revokes the subscription (canceled) ─────
    // The event's data.object IS the subscription, so object.id is the stored
    // stripeSubscriptionId. Even starting from past_due (set by L), a cancellation
    // sets 'canceled'.
    const evtDeleted = {
      id: 'evt_sub_deleted_1',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_test_1', object: 'subscription', status: 'canceled' } },
    };
    const rDeleted = await postStripeWebhook(server, evtDeleted);
    check('M — REAL route acks 200 on customer.subscription.deleted', rDeleted.status === 200, `status=${rDeleted.status}`);
    const afterDeleted = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { subscriptionStatus: true } });
    check('M — subscriptionStatus set to canceled after subscription.deleted', afterDeleted.subscriptionStatus === 'canceled', `status=${afterDeleted.subscriptionStatus}`);
  } finally {
    await prisma.tenant.deleteMany({ where: { id: tenant.id } }).catch((e) => console.log('cleanup warn:', e.message));
    await new Promise((r) => server.close(r));
    await prisma.$disconnect();
  }

  console.log(failed === 0 ? '\nALL CASES PASSED' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('HARNESS ERROR:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
