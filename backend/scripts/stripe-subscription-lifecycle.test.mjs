#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// whatsapp-agent-fix-stripe-plan-never-revoked — verification harness.
//
// BUG (P1, revenue leak): Tenant.plan / dailyBroadcastCap / monthlyMessageLimit were
// NEVER reverted when a Stripe subscription lapsed. invoice.payment_failed and
// customer.subscription.deleted only wrote subscriptionStatus, leaving a churned tenant
// with plan:'heyil' + the paid caps forever — and the enforcement paths
// (broadcastRunner.js reads dailyBroadcastCap; lib/credits.js reads monthlyMessageLimit)
// read those fields, NOT subscriptionStatus, so a status-only flip changed nothing they
// see. Fix: the revert path (payments.js) now downgrades plan+caps to the free/default
// (trial) tier on past_due/canceled, and invoice.paid RE-APPLIES the heyil entitlements
// on recovery.
//
// TEST METHODOLOGY (drives the REAL route, does NOT re-implement it):
//   Boots the REAL Express app (src/app.js) and POSTs REAL, signature-signed Stripe
//   webhook events to the REAL POST /api/payments/stripe/webhook, then asserts on the
//   committed live-DB tenant row. The signature is produced with the Stripe SDK's own
//   stripe.webhooks.generateTestHeaderString() (no network, no real keys) so the route's
//   verifyAndParseStripeEvent() runs for real — reverting the revert logic in
//   routes/payments.js makes these cases fail.
//
// WHAT IS PROVEN LIVE (real logic, real DB, real route):
//   G. A paid heyil tenant, on invoice.payment_failed → plan reverts to 'trial',
//      dailyBroadcastCap/monthlyMessageLimit drop to the trial entitlements, and
//      subscriptionStatus becomes 'past_due'.
//   H. A paid heyil tenant, on customer.subscription.deleted → same revert, status 'canceled'.
//   I. Recovery: after a past_due revert, invoice.paid RE-GRANTS plan:'heyil' + the heyil
//      caps and sets subscriptionStatus 'active' (the round-trip is symmetric).
//   J. Idempotency: a duplicate payment_failed delivery leaves the tenant at the same
//      reverted values (idempotent field SET).
//   K. Signature guard: an event with a bad/unsigned header is rejected 403 and mutates
//      nothing (fail-closed).
//   L. Scoping: the revert matches by stripeSubscriptionId only — an UNRELATED heyil tenant
//      with a different subscription id is untouched by another tenant's lapse.
//   M1-M3. Admin override preservation: a super-admin who re-plans a still-subscribed tenant to
//      'pro' is not clobbered by a later renewal / lapse / cancel.
//   M4. Admin-downgrade-to-TRIAL override survives invoice.paid — the reviewer's live repro:
//      plan:'trial' + subscriptionStatus:'active' (admin goodwill downgrade of a live-subscribed
//      tenant) is NOT re-granted heyil, because the trial→heyil recovery gate now also requires a
//      LAPSE subscriptionStatus. This is the whatsapp-agent-fix-stripe-trial-override-clobber fix.
//   M5. Regression guard: a REAL lapse-created trial (subscriptionStatus 'past_due' OR 'canceled')
//      IS still re-granted heyil on the recovering invoice.paid — the M4 fix did NOT break the
//      legitimate lapse→recover round-trip.
//
// Run from backend/:  node scripts/stripe-subscription-lifecycle.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
// Load backend/.env by ABSOLUTE path (anchored on this file), so the harness works whether
// it is run from backend/ (`node scripts/…`) OR from the repo root (`node backend/scripts/…`).
// A bare dotenv.config() only reads .env from the CWD, which breaks the repo-root invocation
// with "Environment variable not found: DATABASE_URL". (AP-T37 — no hardcoded absolute path.)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import http from 'node:http';

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

// ── Set Stripe env BEFORE importing config/app so config picks it up (ESM imports are
//    hoisted+evaluated first → a static `import config` would cache the pre-set values).
//    TEST values only — never real credentials. A real STRIPE_SECRET_KEY isn't needed:
//    the webhook route only constructs a Stripe client to VERIFY the signature (offline),
//    and generateTestHeaderString signs with the SAME webhook secret below.
const TEST_WEBHOOK_SECRET = 'whsec_test_DO_NOT_USE_IN_PROD_0123456789abcdef';
process.env.PAYMENTS_PROVIDER = 'stripe';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_for_offline_signature_verify';
process.env.STRIPE_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.example.test';

const prisma = (await import('../src/lib/prisma.js')).default;
const app = (await import('../src/app.js')).default;
const { planEntitlements } = await import('../src/lib/plans.js');
const Stripe = (await import('stripe')).default;

const HEYIL = planEntitlements('heyil');
const TRIAL = planEntitlements('trial');

// A bare Stripe client just to reuse its offline signature helper (no network / no key needed).
const stripeSigner = new Stripe('sk_test_signer_offline');
function stripeSig(rawBody) {
  return stripeSigner.webhooks.generateTestHeaderString({ payload: rawBody, secret: TEST_WEBHOOK_SECRET });
}

// Minimal Stripe Event envelope for the event types the route handles.
function makeEvent(type, object) {
  return { id: `evt_${Math.random().toString(36).slice(2)}`, type, data: { object } };
}

// Fire a real HTTP request at the booted app; resolve { status, body }.
function request(server, { method, path: p, body, sig }) {
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
          ...(sig ? { 'stripe-signature': sig } : {}),
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

// POST a Stripe event to the REAL webhook route, signed with a REAL Stripe signature over
// the exact raw bytes the route re-reads as req.rawBody.
function postEvent(server, type, object, { sig } = {}) {
  const raw = JSON.stringify(makeEvent(type, object));
  return request(server, { method: 'POST', path: '/api/payments/stripe/webhook', body: raw, sig: sig ?? stripeSig(raw) });
}

// Create a throwaway tenant that already holds PAID heyil entitlements + a subscription id.
async function makePaidTenant(subId) {
  const TAG = `_wa-stripe-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return prisma.tenant.create({
    data: {
      name: TAG,
      slug: TAG,
      plan: 'heyil',
      dailyBroadcastCap: HEYIL.dailyBroadcastCap,
      monthlyMessageLimit: HEYIL.monthlyMessageLimit,
      subscriptionStatus: 'active',
      stripeCustomerId: `cus_${TAG}`,
      stripeSubscriptionId: subId,
    },
    select: { id: true },
  });
}

async function readTenant(id) {
  return prisma.tenant.findUnique({
    where: { id },
    select: { plan: true, dailyBroadcastCap: true, monthlyMessageLimit: true, subscriptionStatus: true },
  });
}

function isTrialRevert(t, expectedStatus) {
  return (
    t.plan === 'trial' &&
    t.dailyBroadcastCap === TRIAL.dailyBroadcastCap &&
    t.monthlyMessageLimit === TRIAL.monthlyMessageLimit &&
    t.subscriptionStatus === expectedStatus
  );
}
function isHeyilGrant(t, expectedStatus) {
  return (
    t.plan === 'heyil' &&
    t.dailyBroadcastCap === HEYIL.dailyBroadcastCap &&
    t.monthlyMessageLimit === HEYIL.monthlyMessageLimit &&
    t.subscriptionStatus === expectedStatus
  );
}

async function main() {
  // Sanity: trial and heyil entitlements must actually differ, else the test can't discriminate.
  check(
    'setup — heyil and trial entitlements differ (test is discriminating)',
    HEYIL.dailyBroadcastCap !== TRIAL.dailyBroadcastCap || HEYIL.monthlyMessageLimit !== TRIAL.monthlyMessageLimit,
    `heyil=${JSON.stringify(HEYIL)} trial=${JSON.stringify(TRIAL)}`
  );

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const created = [];
  try {
    // ── G: invoice.payment_failed reverts a paid heyil tenant to the free tier ──
    {
      const subId = `sub_G_${Date.now()}`;
      const t = await makePaidTenant(subId);
      created.push(t.id);
      const r = await postEvent(server, 'invoice.payment_failed', { subscription: subId });
      check('G — REAL route acks 200 on invoice.payment_failed', r.status === 200, `status=${r.status}`);
      const after = await readTenant(t.id);
      check('G — plan+caps reverted to trial, status past_due', isTrialRevert(after, 'past_due'), JSON.stringify(after));
    }

    // ── H: customer.subscription.deleted reverts + status canceled ──
    {
      const subId = `sub_H_${Date.now()}`;
      const t = await makePaidTenant(subId);
      created.push(t.id);
      // data.object IS the subscription; its `id` is the stored stripeSubscriptionId.
      const r = await postEvent(server, 'customer.subscription.deleted', { id: subId });
      check('H — REAL route acks 200 on customer.subscription.deleted', r.status === 200, `status=${r.status}`);
      const after = await readTenant(t.id);
      check('H — plan+caps reverted to trial, status canceled', isTrialRevert(after, 'canceled'), JSON.stringify(after));
    }

    // ── I: recovery — invoice.paid after a past_due revert RE-GRANTS heyil ──
    {
      const subId = `sub_I_${Date.now()}`;
      const t = await makePaidTenant(subId);
      created.push(t.id);
      await postEvent(server, 'invoice.payment_failed', { subscription: subId });
      const lapsed = await readTenant(t.id);
      check('I — precondition: tenant is reverted to trial after failed charge', isTrialRevert(lapsed, 'past_due'), JSON.stringify(lapsed));
      const r = await postEvent(server, 'invoice.paid', { subscription: subId });
      check('I — REAL route acks 200 on invoice.paid recovery', r.status === 200, `status=${r.status}`);
      const recovered = await readTenant(t.id);
      check('I — plan+caps re-granted to heyil, status active', isHeyilGrant(recovered, 'active'), JSON.stringify(recovered));
    }

    // ── J: idempotency — a duplicate payment_failed leaves the same reverted state ──
    {
      const subId = `sub_J_${Date.now()}`;
      const t = await makePaidTenant(subId);
      created.push(t.id);
      await postEvent(server, 'invoice.payment_failed', { subscription: subId });
      await postEvent(server, 'invoice.payment_failed', { subscription: subId }); // duplicate delivery
      const after = await readTenant(t.id);
      check('J — duplicate payment_failed is idempotent (still trial/past_due)', isTrialRevert(after, 'past_due'), JSON.stringify(after));
    }

    // ── K: signature guard — a bad/unsigned event is rejected 403 and mutates nothing ──
    {
      const subId = `sub_K_${Date.now()}`;
      const t = await makePaidTenant(subId);
      created.push(t.id);
      const r = await postEvent(server, 'customer.subscription.deleted', { id: subId }, { sig: 't=1,v1=deadbeef' });
      check('K — REAL route rejects an invalid signature with 403', r.status === 403, `status=${r.status}`);
      const after = await readTenant(t.id);
      check('K — tenant still fully paid heyil after the rejected call', isHeyilGrant(after, 'active'), JSON.stringify(after));
    }

    // ── L: scoping — a lapse on ONE subscription must not touch another tenant ──
    {
      const subVictim = `sub_L_victim_${Date.now()}`;
      const subBystander = `sub_L_bystander_${Date.now()}`;
      const victim = await makePaidTenant(subVictim);
      const bystander = await makePaidTenant(subBystander);
      created.push(victim.id, bystander.id);
      await postEvent(server, 'customer.subscription.deleted', { id: subVictim });
      const v = await readTenant(victim.id);
      const b = await readTenant(bystander.id);
      check('L — the lapsed tenant is reverted', isTrialRevert(v, 'canceled'), JSON.stringify(v));
      check('L — the unrelated tenant is UNTOUCHED (still heyil/active)', isHeyilGrant(b, 'active'), JSON.stringify(b));
    }

    // ── M: admin-override preservation (the regression the adversarial review found) ──
    //    A super-admin manually re-plans a STILL-subscribed tenant to 'pro' (PUT
    //    /api/admin/tenants/:id). The tenant keeps its live stripeSubscriptionId. A later
    //    Stripe event (renewal, lapse, or cancel) must NOT clobber the admin's 'pro' choice
    //    back to heyil/trial — the plan guard in each handler's WHERE preserves the override.
    const PRO = planEntitlements('pro');
    async function makeProOverriddenTenant(subId) {
      const TAG = `_wa-stripe-lifecycle-pro-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return prisma.tenant.create({
        data: {
          name: TAG,
          slug: TAG,
          plan: 'pro',
          dailyBroadcastCap: PRO.dailyBroadcastCap,
          monthlyMessageLimit: PRO.monthlyMessageLimit,
          subscriptionStatus: 'active',
          stripeCustomerId: `cus_${TAG}`,
          stripeSubscriptionId: subId,
        },
        select: { id: true },
      });
    }
    function isProUntouched(t) {
      return (
        t.plan === 'pro' &&
        t.dailyBroadcastCap === PRO.dailyBroadcastCap &&
        t.monthlyMessageLimit === PRO.monthlyMessageLimit
      );
    }
    check('M — setup: pro entitlements differ from heyil AND trial (test discriminates)',
      isProUntouched({ plan: 'pro', dailyBroadcastCap: PRO.dailyBroadcastCap, monthlyMessageLimit: PRO.monthlyMessageLimit }) &&
      (PRO.dailyBroadcastCap !== HEYIL.dailyBroadcastCap || PRO.monthlyMessageLimit !== HEYIL.monthlyMessageLimit) &&
      (PRO.dailyBroadcastCap !== TRIAL.dailyBroadcastCap || PRO.monthlyMessageLimit !== TRIAL.monthlyMessageLimit),
      `pro=${JSON.stringify(PRO)}`);
    {
      // M1: a lapse (payment_failed) must NOT revert an admin-overridden 'pro' tenant.
      const subId = `sub_M1_${Date.now()}`;
      const t = await makeProOverriddenTenant(subId);
      created.push(t.id);
      await postEvent(server, 'invoice.payment_failed', { subscription: subId });
      const after = await readTenant(t.id);
      check('M1 — admin-overridden pro tenant is NOT reverted on payment_failed', isProUntouched(after), JSON.stringify(after));
    }
    {
      // M2: a cancel (subscription.deleted) must NOT revert an admin-overridden 'pro' tenant.
      const subId = `sub_M2_${Date.now()}`;
      const t = await makeProOverriddenTenant(subId);
      created.push(t.id);
      await postEvent(server, 'customer.subscription.deleted', { id: subId });
      const after = await readTenant(t.id);
      check('M2 — admin-overridden pro tenant is NOT reverted on subscription.deleted', isProUntouched(after), JSON.stringify(after));
    }
    {
      // M3: a renewal (invoice.paid) must NOT re-grant heyil over an admin-overridden 'pro' tenant.
      const subId = `sub_M3_${Date.now()}`;
      const t = await makeProOverriddenTenant(subId);
      created.push(t.id);
      await postEvent(server, 'invoice.paid', { subscription: subId });
      const after = await readTenant(t.id);
      check('M3 — admin-overridden pro tenant is NOT re-granted heyil on invoice.paid', isProUntouched(after), JSON.stringify(after));
    }

    // ── M4: admin-downgraded-to-TRIAL override survives invoice.paid (the reviewer's live repro) ──
    //    An admin deliberately downgrades a STILL-Stripe-subscribed tenant to 'trial' (e.g. a
    //    billing-dispute goodwill downgrade). That leaves plan:'trial' + subscriptionStatus:'active'
    //    (the admin plan-change path never writes subscriptionStatus) + a live stripeSubscriptionId.
    //    The plain plan-VALUE guard ('trial' is Stripe-managed) could not tell this apart from a
    //    lapse-created trial and silently re-granted heyil on the next invoice.paid — the exact
    //    override-clobber bug. The fix gates the trial→heyil recovery on subscriptionStatus being a
    //    LAPSE status ('past_due'/'canceled'), so an 'active' admin-trial is NOT re-granted.
    async function makeAdminTrialTenant(subId) {
      const TAG = `_wa-stripe-lifecycle-admintrial-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return prisma.tenant.create({
        data: {
          name: TAG,
          slug: TAG,
          plan: 'trial', // admin manually downgraded a live-subscribed tenant to trial
          dailyBroadcastCap: TRIAL.dailyBroadcastCap,
          monthlyMessageLimit: TRIAL.monthlyMessageLimit,
          subscriptionStatus: 'active', // still an ACTIVE subscription — NOT a lapse
          stripeCustomerId: `cus_${TAG}`,
          stripeSubscriptionId: subId,
        },
        select: { id: true },
      });
    }
    function isAdminTrialUntouched(t) {
      // The override must be honored: plan stays trial, caps stay trial, status stays active.
      return (
        t.plan === 'trial' &&
        t.dailyBroadcastCap === TRIAL.dailyBroadcastCap &&
        t.monthlyMessageLimit === TRIAL.monthlyMessageLimit &&
        t.subscriptionStatus === 'active'
      );
    }
    {
      const subId = `sub_M4_${Date.now()}`;
      const t = await makeAdminTrialTenant(subId);
      created.push(t.id);
      const r = await postEvent(server, 'invoice.paid', { subscription: subId });
      check('M4 — REAL route acks 200 on invoice.paid for admin-trial tenant', r.status === 200, `status=${r.status}`);
      const after = await readTenant(t.id);
      check(
        'M4 — admin-downgraded trial tenant STAYS trial (override NOT clobbered to heyil)',
        isAdminTrialUntouched(after),
        JSON.stringify(after)
      );
    }

    // ── M5: regression guard — a REAL lapse recovery MUST still re-grant heyil ──
    //    The M4 fix must NOT break legitimate recovery: a tenant reverted to trial by a REAL
    //    Stripe lapse (subscriptionStatus 'past_due' or 'canceled') must still be re-granted heyil
    //    on the recovering invoice.paid. This is the key regression risk of the M4 gate change:
    //    if we over-tightened, recovery would silently stop working. Assert BOTH lapse statuses.
    for (const lapseStatus of ['past_due', 'canceled']) {
      const subId = `sub_M5_${lapseStatus}_${Date.now()}`;
      const TAG = `_wa-stripe-lifecycle-lapsetrial-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const t = await prisma.tenant.create({
        data: {
          name: TAG,
          slug: TAG,
          plan: 'trial', // reverted to trial by a real lapse (as our revert paths do)
          dailyBroadcastCap: TRIAL.dailyBroadcastCap,
          monthlyMessageLimit: TRIAL.monthlyMessageLimit,
          subscriptionStatus: lapseStatus, // the lapse marker our revert paths stamp
          stripeCustomerId: `cus_${TAG}`,
          stripeSubscriptionId: subId,
        },
        select: { id: true },
      });
      created.push(t.id);
      const r = await postEvent(server, 'invoice.paid', { subscription: subId });
      check(`M5/${lapseStatus} — REAL route acks 200 on invoice.paid recovery`, r.status === 200, `status=${r.status}`);
      const after = await readTenant(t.id);
      check(
        `M5/${lapseStatus} — lapse-created trial IS re-granted heyil on recovery (recovery not broken)`,
        isHeyilGrant(after, 'active'),
        JSON.stringify(after)
      );
    }

    // ── N: payment_failed → subscription.deleted on the SAME subscription reaches 'canceled' ──
    //    The whatsapp-agent-fix-stripe-subscription-deleted bug: when invoice.payment_failed fires
    //    FIRST (reverting the tenant to plan:'trial' + subscriptionStatus:'past_due'), the later
    //    customer.subscription.deleted for the SAME subscription used to no-op — its WHERE
    //    plan:'heyil' matched 0 rows on the already-reverted tenant — leaving subscriptionStatus
    //    stuck at 'past_due' forever, never reaching the authoritative 'canceled'. The broadened
    //    WHERE (plan:'heyil' OR plan:'trial'+LAPSE status) now finishes the cancel. Reverting the
    //    fix in routes/payments.js makes the second assertion below fail (status stays 'past_due').
    {
      const subId = `sub_N_${Date.now()}`;
      const t = await makePaidTenant(subId);
      created.push(t.id);
      // Step 1: a failed renewal reverts the tenant to trial/past_due.
      await postEvent(server, 'invoice.payment_failed', { subscription: subId });
      const lapsed = await readTenant(t.id);
      check('N — precondition: payment_failed reverted the tenant to trial/past_due', isTrialRevert(lapsed, 'past_due'), JSON.stringify(lapsed));
      // Step 2: Stripe later cancels the SAME subscription (e.g. after exhausting dunning retries).
      const r = await postEvent(server, 'customer.subscription.deleted', { id: subId });
      check('N — REAL route acks 200 on the follow-up subscription.deleted', r.status === 200, `status=${r.status}`);
      const canceled = await readTenant(t.id);
      // plan+caps stay at the trial values (already reverted); subscriptionStatus MUST reach 'canceled'.
      check(
        'N — payment_failed→subscription.deleted reaches status canceled (bug fix; was stuck past_due)',
        isTrialRevert(canceled, 'canceled'),
        JSON.stringify(canceled)
      );
    }

    // ── N2: admin-downgraded-to-TRIAL override survives subscription.deleted too ──
    //    Same override the broadened WHERE must NOT clobber: an admin deliberately downgraded a
    //    still-Stripe-subscribed tenant to 'trial' while subscriptionStatus stayed 'active' (the
    //    admin plan-change path never writes subscriptionStatus). Because branch (b) of the new
    //    WHERE requires a LAPSE status ('past_due'/'canceled'), an 'active' admin-trial matches
    //    neither branch and is left intact. M2 proves the 'pro' override for subscription.deleted;
    //    M4 proves the active-trial override for invoice.paid — this closes the remaining corner:
    //    active-trial override × subscription.deleted (the handler the broadened WHERE touches).
    {
      const subId = `sub_N2_${Date.now()}`;
      const t = await makeAdminTrialTenant(subId); // plan:'trial', subscriptionStatus:'active'
      created.push(t.id);
      const r = await postEvent(server, 'customer.subscription.deleted', { id: subId });
      check('N2 — REAL route acks 200 on subscription.deleted for admin-trial tenant', r.status === 200, `status=${r.status}`);
      const after = await readTenant(t.id);
      check(
        'N2 — admin-downgraded active-trial tenant is NOT touched by subscription.deleted (status stays active)',
        isAdminTrialUntouched(after),
        JSON.stringify(after)
      );
    }
  } finally {
    for (const id of created) {
      await prisma.tenant.deleteMany({ where: { id } }).catch((e) => console.log('cleanup warn:', e.message));
    }
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
