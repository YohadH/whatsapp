import crypto from 'node:crypto';
import config from '../config/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Payment provider abstraction for credit-pack top-ups (and, later, the ₪490/mo
// subscription). Two modes:
//
//   'manual'  → a purchase is created 'pending'; a super-admin marks it paid by hand
//               (POST /api/admin/credit-purchases/:id/mark-paid), which grants credits.
//   'payplus' → PayPlus (Israeli card gateway). createCheckout() opens a real hosted
//               payment page; PayPlus POSTs a signed callback to /api/payments/payplus/
//               webhook on success, which flips CreditPurchase.status → 'paid' and grants
//               the credits automatically (see routes/payments.js).
//
// Provider is chosen by config.payments.provider, but 'payplus' silently degrades to
// 'manual' unless the api-key/secret-key/page-uid trio is present (payplus.enabled) — so
// a mis-set PAYMENTS_PROVIDER can never leave a tenant unable to top up.
//
// PayPlus API shape (docs.payplus.co.il):
//   POST {baseUrl}/PaymentPages/generateLink
//     headers: api-key, secret-key, Content-Type: application/json
//     body: { payment_page_uid, amount, currency_code, charge_method,
//             refURL_success, refURL_failure, refURL_callback, customer, items, more_info }
//     200 → { results:{status:'success'}, data:{ payment_page_link, page_request_uid } }
//   Callback: PayPlus POSTs the transaction result + a `hash` header =
//     HMAC-SHA256(rawBody, secretKey) (base64 by default). See verifyWebhookSignature().
// ─────────────────────────────────────────────────────────────────────────────

// Which provider is ACTUALLY usable right now. 'payplus' requires its creds; otherwise
// we fall back to 'manual' so the top-up flow always resolves to *something* real.
export function activeProvider() {
  const p = config.payments.provider;
  if (p === 'payplus' && !config.payments.payplus.enabled) return 'manual';
  return p;
}

// Begin payment for a pending purchase. Returns either:
//   { mode: 'manual' }                         → the purchase is pending super-admin approval
//   { mode: 'redirect', url, providerRef }     → send the customer to the gateway's hosted page
//
// `providerRef` (PayPlus page_request_uid) is returned so the caller can persist it on the
// CreditPurchase row; the webhook later matches the callback back to this purchase by it.
export async function createCheckout({ purchase, tenant } = {}) {
  switch (activeProvider()) {
    case 'payplus':
      return payPlusCheckout({ purchase, tenant });
    case 'manual':
    default:
      return { mode: 'manual' };
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
