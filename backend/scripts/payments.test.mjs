#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WA-DEV-PAYMENTS — verification harness for the PayPlus payment integration.
//
// Verifies the acceptance criterion (§2.5 / plan item 5): a top-up completes via a
// real gateway checkout + signed webhook; CreditPurchase.status flips to 'paid'
// AUTOMATICALLY (not by hand); credits land in purchasedCredits.
//
// TEST METHODOLOGY (whatsapp-agent-fix-test-methodology-duplicated-logic):
//   The state-transition cases below DRIVE THE REAL webhook route — they boot the
//   real Express app (src/app.js) and POST signature-signed callbacks to the REAL
//   POST /api/payments/payplus/webhook handler over HTTP, then assert on the
//   committed live-DB state. They do NOT re-implement the flip/grant transaction
//   inline (the previous version did, which meant reverting the real provider
//   filter in routes/payments.js did not fail the test — the anti-pattern this
//   rewrite removes). The ONLY mocked boundary is PayPlus's outbound HTTP call
//   (globalThis.fetch) for createCheckout — an external we can't hit without real
//   sandbox credentials (AP-T73: proxy-verified, not live-sandbox-verified).
//
// WHAT IS PROVEN LIVE (real logic, real DB, real route):
//   A. Webhook HMAC signature verification (verifyWebhookSignature) — a payload signed
//      with the secret key VERIFIES; a tampered body / wrong key / missing secret REJECTS.
//   B. parseWebhook maps a real PayPlus-shaped callback → { purchaseId, paid, providerRef }.
//   C. REAL webhook route: a signed callback flips a pending purchase → paid and
//      increments purchasedCredits by exactly the pack credits, against the live DB.
//   D. Idempotency / TOCTOU (AP-T72): a DUPLICATE (webhook-retry) callback grants ONCE,
//      including two GENUINELY-CONCURRENT deliveries to the real route.
//   E. createCheckout('payplus') builds the correct generateLink request and reads
//      data.payment_page_link back — the PayPlus HTTP boundary is MOCKED (globalThis.fetch).
//   F. Provider guard: the REAL webhook route must NEVER flip a 'manual'-provider
//      purchase, even with a valid signature + matching id (the provider:'payplus'
//      filter in the route's WHERE). Reverting that filter makes THIS case fail.
//
// NOT verified here: a real call to PayPlus's live/sandbox host (no test credentials).
//
// Run from backend/:  node scripts/payments.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

import http from 'node:http';
import crypto from 'node:crypto';

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

// ── A/B/E/C/D/F rely on config.payments.payplus.* — set env BEFORE importing config/app
//    so config picks it up. These are TEST values only, never real credentials.
//    (ESM imports are hoisted+evaluated first, so config/app MUST be dynamic-imported
//    AFTER these assignments — a static `import config` caches the pre-set values.)
const TEST_SECRET = 'test-secret-key-payplus-DO-NOT-USE-IN-PROD';
process.env.PAYMENTS_PROVIDER = 'payplus';
process.env.PAYPLUS_API_KEY = 'test-api-key';
process.env.PAYPLUS_SECRET_KEY = TEST_SECRET;
process.env.PAYPLUS_PAYMENT_PAGE_UID = 'test-page-uid';
process.env.PAYPLUS_HASH_ENCODING = 'base64';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://app.example.test';

// Fail-closed prod-DB guard: refuse to run this destructive (create/delete tenant)
// harness unless DATABASE_URL points at a disposable/local test DB (never live prod).
const { assertTestDb } = await import('./lib/assert-test-db.mjs');
assertTestDb();

const prisma = (await import('../src/lib/prisma.js')).default;
const app = (await import('../src/app.js')).default;
const { verifyWebhookSignature, parseWebhook, createCheckout, activeProvider } = await import(
  '../src/services/payments.js'
);

// Helper: sign a raw body the way PayPlus signs a callback (HMAC-SHA256, base64).
function sign(rawBody) {
  return crypto.createHmac('sha256', TEST_SECRET).update(rawBody).digest('base64');
}

// Fire a real HTTP request at the booted app; resolve { status, body }. `hash` is
// the PayPlus signature header the webhook route reads via req.get('hash').
function request(server, { method, path: p, body, hash }) {
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
          ...(hash ? { hash } : {}),
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

// POST a PayPlus callback body (as the REAL gateway would) to the REAL route. We
// sign the EXACT raw JSON bytes the route re-reads as req.rawBody, so signature
// verification runs for real (no weakened guard).
function postWebhook(server, callbackObj) {
  const raw = JSON.stringify(callbackObj);
  return request(server, { method: 'POST', path: '/api/payments/payplus/webhook', body: raw, hash: sign(raw) });
}

async function main() {
  // ── A: signature verification (real exported fn) ─────────────────────────────
  check('A — activeProvider() resolves to payplus when creds present', activeProvider() === 'payplus');
  const goodBody = JSON.stringify({ transaction: { status_code: '000', uid: 'txn_123' }, more_info: 'PID' });
  const goodRaw = Buffer.from(goodBody);
  check('A — valid PayPlus signature verifies', verifyWebhookSignature({ rawBody: goodRaw, hashHeader: sign(goodBody) }) === true);
  check('A — tampered body is rejected', verifyWebhookSignature({ rawBody: Buffer.from(goodBody + ' '), hashHeader: sign(goodBody) }) === false);
  check('A — wrong signature is rejected', verifyWebhookSignature({ rawBody: goodRaw, hashHeader: sign('other') }) === false);
  check('A — missing hash header is rejected', verifyWebhookSignature({ rawBody: goodRaw, hashHeader: '' }) === false);

  // ── B: parseWebhook mapping (real exported fn) ───────────────────────────────
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

  // ── Boot the real app on an ephemeral port ───────────────────────────────────
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ── C/D/F: state transition through the REAL webhook route (throwaway tenant) ─
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

    // ── C: an unsigned / wrong-signature callback is rejected by the REAL route ──
    const bad = await request(server, {
      method: 'POST', path: '/api/payments/payplus/webhook',
      body: JSON.stringify({ transaction: { status_code: '000', uid: 'txn_bad' }, more_info: purchase.id }),
      hash: 'not-a-valid-hash',
    });
    check('C — REAL route rejects an invalid signature with 403', bad.status === 403, `status=${bad.status}`);
    const afterBad = await prisma.creditPurchase.findUnique({ where: { id: purchase.id }, select: { status: true } });
    check('C — the purchase is still pending after the rejected call', afterBad.status === 'pending', `status=${afterBad.status}`);

    // ── C: a valid signed callback flips pending→paid + grants, via the REAL route ──
    const r1 = await postWebhook(server, { transaction: { status_code: '000', uid: 'txn_live_1' }, more_info: purchase.id });
    check('C — REAL route acks 200 + credited:true', r1.status === 200 && r1.body?.credited === true, `status=${r1.status} body=${JSON.stringify(r1.body)}`);

    const afterPurchase = await prisma.creditPurchase.findUnique({ where: { id: purchase.id }, select: { status: true, providerRef: true } });
    check('C — CreditPurchase.status auto-flipped to paid', afterPurchase.status === 'paid', `status=${afterPurchase.status}`);
    check('C — providerRef recorded from the callback', afterPurchase.providerRef === 'txn_live_1');
    const afterTenant = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('C — 500 credits landed in purchasedCredits', afterTenant.purchasedCredits === 500, `purchasedCredits=${afterTenant.purchasedCredits}`);
    const topupRows = await prisma.creditTransaction.count({ where: { tenantId: tenant.id, type: 'topup' } });
    check('C — exactly one topup ledger row', topupRows === 1, `topups=${topupRows}`);

    // ── D: idempotency — a DUPLICATE (retry) callback must NOT double-credit ──────
    const r2 = await postWebhook(server, { transaction: { status_code: '000', uid: 'txn_live_1' }, more_info: purchase.id });
    check('D — duplicate callback acks 200 but credited:false', r2.status === 200 && r2.body?.credited === false, `body=${JSON.stringify(r2.body)}`);
    const tenant2 = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('D — purchasedCredits still 500 after the retry', tenant2.purchasedCredits === 500, `purchasedCredits=${tenant2.purchasedCredits}`);
    check('D — still exactly one topup ledger row', (await prisma.creditTransaction.count({ where: { tenantId: tenant.id, type: 'topup' } })) === 1);

    // ── D2: concurrency — two simultaneous callbacks to the REAL route grant once ─
    const purchase2 = await prisma.creditPurchase.create({
      data: { tenantId: tenant.id, packId: 'pack_250', credits: 250, amountIls: 150, status: 'pending', provider: 'payplus' },
      select: { id: true },
    });
    const race = await Promise.all([
      postWebhook(server, { transaction: { status_code: '000', uid: 'txn_race' }, more_info: purchase2.id }),
      postWebhook(server, { transaction: { status_code: '000', uid: 'txn_race' }, more_info: purchase2.id }),
    ]);
    const credited = race.filter((r) => r.status === 200 && r.body?.credited === true).length;
    check('D2 — two concurrent callbacks credit exactly once', credited === 1, `creditedWinners=${credited}`);
    const t3 = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('D2 — purchasedCredits is 750 (500 + one 250 grant)', t3.purchasedCredits === 750, `purchasedCredits=${t3.purchasedCredits}`);

    // ── F: provider guard — a 'manual' purchase must NEVER be flippable by the
    //    automatic payplus webhook route, even when the callback is signature-verified
    //    and carries a matching id. The route's WHERE filters provider:'payplus', so
    //    the manual purchase's updateMany matches 0 rows → no flip, no credit, no ledger.
    //    Reverting that provider filter in routes/payments.js makes THIS case fail.
    const manualPurchase = await prisma.creditPurchase.create({
      data: { tenantId: tenant.id, packId: 'pack_1000', credits: 1000, amountIls: 500, status: 'pending', provider: 'manual' },
      select: { id: true },
    });
    const beforeManual = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    const rManual = await postWebhook(server, { transaction: { status_code: '000', uid: 'txn_manual_spoof' }, more_info: manualPurchase.id });
    check('F — payplus webhook does NOT credit a manual-provider purchase', rManual.status === 200 && rManual.body?.credited === false, `body=${JSON.stringify(rManual.body)}`);
    const afterManual = await prisma.creditPurchase.findUnique({ where: { id: manualPurchase.id }, select: { status: true } });
    check('F — the manual purchase stays pending (never flipped to paid)', afterManual.status === 'pending', `status=${afterManual.status}`);
    const tManual = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { purchasedCredits: true } });
    check('F — purchasedCredits unchanged by the spoofed manual flip attempt', tManual.purchasedCredits === beforeManual.purchasedCredits, `before=${beforeManual.purchasedCredits} after=${tManual.purchasedCredits}`);
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
