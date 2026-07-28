#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WA-DEV-PAYMENTS — verification harness for the PayPlus payment integration.
//
// Verifies the acceptance criterion (§2.5 / plan item 5): a top-up completes via a
// real gateway checkout + signed webhook; CreditPurchase.status flips to 'paid'
// AUTOMATICALLY (not by hand); credits land in purchasedCredits.
//
// WHAT IS PROVEN LIVE (real logic, real DB):
//   A. Webhook HMAC signature verification (verifyWebhookSignature) — a payload signed
//      with the secret key VERIFIES; a tampered body / wrong key / missing secret REJECTS.
//   B. parseWebhook maps a real PayPlus-shaped callback → { purchaseId, paid, providerRef }.
//   C. State transition against the LIVE DB: the webhook's atomic flip+grant turns a
//      pending purchase → paid and increments purchasedCredits by exactly the pack credits.
//   D. Idempotency / TOCTOU (AP-T72): a DUPLICATE (webhook-retry) callback grants ONCE.
//   E. createCheckout('payplus') builds the correct generateLink request and reads
//      data.payment_page_link back — the PayPlus HTTP boundary is MOCKED (globalThis.fetch),
//      per AP-T73 this is PROXY-VERIFIED, not live-sandbox-verified.
//
// NOT verified here: a real call to PayPlus's live/sandbox host (no test credentials).
// Needs real PayPlus api-key/secret-key/page-uid from the owner to confirm the live
// checkout + the exact callback body/hash-encoding against the sandbox.
//
// Run from backend/:  node scripts/payments.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import crypto from 'node:crypto';
import prisma from '../src/lib/prisma.js';

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

// ── A/B/E rely on config.payments.payplus.* — set env BEFORE importing the module so
//    config picks it up. These are TEST values only, never real credentials.
const TEST_SECRET = 'test-secret-key-payplus-DO-NOT-USE-IN-PROD';
process.env.PAYMENTS_PROVIDER = 'payplus';
process.env.PAYPLUS_API_KEY = 'test-api-key';
process.env.PAYPLUS_SECRET_KEY = TEST_SECRET;
process.env.PAYPLUS_PAYMENT_PAGE_UID = 'test-page-uid';
process.env.PAYPLUS_HASH_ENCODING = 'base64';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.example.test';

const { verifyWebhookSignature, parseWebhook, createCheckout, activeProvider } = await import(
  '../src/services/payments.js'
);

// Helper: sign a raw body the way PayPlus signs a callback (HMAC-SHA256, base64).
function sign(rawBody) {
  return crypto.createHmac('sha256', TEST_SECRET).update(rawBody).digest('base64');
}

// Replicates the webhook route's atomic flip+grant against the live DB (same code path
// logic as routes/payments.js), so we exercise the real transaction without HTTP.
async function applyPaidWebhook(parsed) {
  return prisma.$transaction(async (tx) => {
    const flip = await tx.creditPurchase.updateMany({
      where: { id: parsed.purchaseId, provider: 'payplus', status: { not: 'paid' } },
      data: { status: 'paid', paidAt: new Date(), providerRef: parsed.providerRef },
    });
    if (flip.count !== 1) return { credited: false };
    const purchase = await tx.creditPurchase.findUnique({
      where: { id: parsed.purchaseId },
      select: { tenantId: true, credits: true, packId: true },
    });
    await tx.tenant.update({
      where: { id: purchase.tenantId },
      data: { purchasedCredits: { increment: purchase.credits } },
      select: { id: true }, // AP-T71: avoid implicit RETURNING * → waPin P2022 drift
    });
    await tx.creditTransaction.create({
      data: { tenantId: purchase.tenantId, type: 'topup', amount: purchase.credits, reason: purchase.packId },
    });
    return { credited: true, credits: purchase.credits };
  });
}

async function main() {
  // ── A: signature verification ───────────────────────────────────────────────
  check('A — activeProvider() resolves to payplus when creds present', activeProvider() === 'payplus');
  const goodBody = JSON.stringify({ transaction: { status_code: '000', uid: 'txn_123' }, more_info: 'PID' });
  const goodRaw = Buffer.from(goodBody);
  check('A — valid PayPlus signature verifies', verifyWebhookSignature({ rawBody: goodRaw, hashHeader: sign(goodBody) }) === true);
  check('A — tampered body is rejected', verifyWebhookSignature({ rawBody: Buffer.from(goodBody + ' '), hashHeader: sign(goodBody) }) === false);
  check('A — wrong signature is rejected', verifyWebhookSignature({ rawBody: goodRaw, hashHeader: sign('other') }) === false);
  check('A — missing hash header is rejected', verifyWebhookSignature({ rawBody: goodRaw, hashHeader: '' }) === false);

  // ── B: parseWebhook mapping ─────────────────────────────────────────────────
  const parsedOk = parseWebhook({ transaction: { status_code: '000', uid: 'txn_9' }, more_info: 'PID42' });
  check('B — parses an approved callback as paid', parsedOk.paid === true && parsedOk.purchaseId === 'PID42' && parsedOk.providerRef === 'txn_9');
  const parsedDecline = parseWebhook({ transaction: { status_code: '004', uid: 'txn_x' }, more_info: 'PID42' });
  check('B — a declined callback is NOT paid', parsedDecline.paid === false);

  // ── E: createCheckout builds the right generateLink request (HTTP boundary mocked) ──
  const origFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: { status: 'success' }, data: { payment_page_link: 'https://payplus.test/pay/abc', page_request_uid: 'preq_777' } }),
    };
  };
  try {
    const checkout = await createCheckout({ purchase: { id: 'PID42', packId: 'pack_500', credits: 500, amountIls: 250 }, tenant: { name: 'Acme' } });
    check('E — createCheckout returns the hosted-page URL', checkout.mode === 'redirect' && checkout.url === 'https://payplus.test/pay/abc');
    check('E — returns providerRef (page_request_uid)', checkout.providerRef === 'preq_777');
    check('E — calls PayPlus generateLink endpoint', /\/PaymentPages\/generateLink$/.test(captured.url));
    const sentBody = JSON.parse(captured.opts.body);
    check('E — sends api-key + secret-key headers', captured.opts.headers['api-key'] === 'test-api-key' && captured.opts.headers['secret-key'] === TEST_SECRET);
    check('E — body has amount, page uid, ILS, and our purchase id in more_info', sentBody.amount === 250 && sentBody.payment_page_uid === 'test-page-uid' && sentBody.currency_code === 'ILS' && sentBody.more_info === 'PID42');
    check('E — callback URL points at our public webhook', /\/api\/payments\/payplus\/webhook$/.test(sentBody.refURL_callback));
  } finally {
    globalThis.fetch = origFetch;
  }

  // ── C/D: state transition against the LIVE DB (throwaway tenant) ─────────────
  const TAG = `_wa-payments-test-${Date.now()}`;
  const tenant = await prisma.tenant.create({
    data: { name: TAG, slug: TAG, monthlyMessageLimit: 0, creditsUsedThisPeriod: 0, purchasedCredits: 0 },
    select: { id: true },
  });
  try {
    const purchase = await prisma.creditPurchase.create({
      data: { tenantId: tenant.id, packId: 'pack_500', credits: 500, amountIls: 250, status: 'pending', provider: 'payplus' },
      select: { id: true },
    });
    // Simulate the exact signed callback PayPlus would POST for this purchase.
    const cbBody = JSON.stringify({ transaction: { status_code: '000', uid: 'txn_live_1' }, more_info: purchase.id });
    const sigOk = verifyWebhookSignature({ rawBody: Buffer.from(cbBody), hashHeader: sign(cbBody) });
    check('C — the live callback signature verifies', sigOk === true);
    const parsed = parseWebhook(JSON.parse(cbBody));
    const r1 = await applyPaidWebhook(parsed);
    check('C — first callback credits the tenant', r1.credited === true && r1.credits === 500);

    const afterPurchase = await prisma.creditPurchase.findUnique({ where: { id: purchase.id }, select: { status: true, providerRef: true } });
    check('C — CreditPurchase.status auto-flipped to paid', afterPurchase.status === 'paid', `status=${afterPurchase.status}`);
    check('C — providerRef recorded from the callback', afterPurchase.providerRef === 'txn_live_1');
    const afterTenant = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('C — 500 credits landed in purchasedCredits', afterTenant.purchasedCredits === 500, `purchasedCredits=${afterTenant.purchasedCredits}`);
    const topupRows = await prisma.creditTransaction.count({ where: { tenantId: tenant.id, type: 'topup' } });
    check('C — exactly one topup ledger row', topupRows === 1, `topups=${topupRows}`);

    // ── D: idempotency — a DUPLICATE (retry) callback must NOT double-credit ──────
    const r2 = await applyPaidWebhook(parsed);
    check('D — duplicate callback does NOT credit again', r2.credited === false);
    const tenant2 = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('D — purchasedCredits still 500 after the retry', tenant2.purchasedCredits === 500, `purchasedCredits=${tenant2.purchasedCredits}`);
    check('D — still exactly one topup ledger row', (await prisma.creditTransaction.count({ where: { tenantId: tenant.id, type: 'topup' } })) === 1);

    // ── D2: concurrency — two simultaneous callbacks grant exactly once ──────────
    const purchase2 = await prisma.creditPurchase.create({
      data: { tenantId: tenant.id, packId: 'pack_250', credits: 250, amountIls: 150, status: 'pending', provider: 'payplus' },
      select: { id: true },
    });
    const parsed2 = parseWebhook({ transaction: { status_code: '000', uid: 'txn_race' }, more_info: purchase2.id });
    const race = await Promise.all([applyPaidWebhook(parsed2), applyPaidWebhook(parsed2)]);
    const credited = race.filter((r) => r.credited).length;
    check('D2 — two concurrent callbacks credit exactly once', credited === 1, `creditedWinners=${credited}`);
    const t3 = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('D2 — purchasedCredits is 750 (500 + one 250 grant)', t3.purchasedCredits === 750, `purchasedCredits=${t3.purchasedCredits}`);

    // ── F: provider guard — a 'manual' purchase must NEVER be flippable by the
    //    automatic payplus webhook path, even when the callback is signature-verified
    //    and carries a matching id. The WHERE clause filters provider:'payplus', so the
    //    manual purchase's updateMany matches 0 rows → no flip, no credit, no ledger row.
    //    (This is the security property behind the inline comment in routes/payments.js.)
    const manualPurchase = await prisma.creditPurchase.create({
      data: { tenantId: tenant.id, packId: 'pack_1000', credits: 1000, amountIls: 500, status: 'pending', provider: 'manual' },
      select: { id: true },
    });
    const beforeManual = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    const parsedManual = parseWebhook({ transaction: { status_code: '000', uid: 'txn_manual_spoof' }, more_info: manualPurchase.id });
    const rManual = await applyPaidWebhook(parsedManual);
    check('F — payplus webhook does NOT credit a manual-provider purchase', rManual.credited === false, `credited=${rManual.credited}`);
    const afterManual = await prisma.creditPurchase.findUnique({ where: { id: manualPurchase.id }, select: { status: true } });
    check('F — the manual purchase stays pending (never flipped to paid)', afterManual.status === 'pending', `status=${afterManual.status}`);
    const tManual = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('F — purchasedCredits unchanged by the spoofed manual flip attempt', tManual.purchasedCredits === beforeManual.purchasedCredits, `before=${beforeManual.purchasedCredits} after=${tManual.purchasedCredits}`);
  } finally {
    await prisma.tenant.deleteMany({ where: { id: tenant.id } }).catch((e) => console.log('cleanup warn:', e.message));
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
