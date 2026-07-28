#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WA-DEV-META-COST — verification harness for per-tenant Meta conversation-cost
// tracking + the super-admin margin aggregation (system-gap-analysis §2.7 + §4).
//
// WHAT IS PROVEN LIVE (drives the REAL webhook handler + REAL admin route over HTTP,
// against the LIVE DB — NOT a hand-duplicated copy of the logic, per
// whatsapp-agent-fix-test-methodology-duplicated-logic / AP reference test style):
//   A. parseStatusEvents() extracts pricing.category/billable from a real Meta
//      `statuses[]` webhook payload (the surface Meta puts pricing on — NOT messages[]).
//   B. estimateCostCents()/normalizeCategory() map a category → config rate card, and
//      correctly flag placeholder=true when the rate card is uncalibrated (real number
//      when a rate is set).
//   C. POSTing a real status webhook to the REAL POST /api/whatsapp/webhook handler
//      creates a MetaCostEntry attributed to the RIGHT tenant with the RIGHT category.
//   D. A non-billable status event does NOT create a cost row.
//   E. The REAL GET /api/admin/margin route (super_admin) aggregates Meta cost per
//      tenant per month with correct sums across MULTIPLE entries, and reports the
//      OpenAI-cost gap honestly (openAiCostTracked:false).
//   F. Recording is additive — it never touches the credit ledger.
//
// Run from backend/:  node scripts/meta-cost.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

import http from 'node:http';
import crypto from 'node:crypto';

// Set a KNOWN rate card BEFORE importing config/app, so we can assert a real (non-0)
// cost for one category and a placeholder (0) for another. These are TEST values only.
// NOTE: ESM `import` is hoisted+evaluated before any top-level statement, so the app
// modules (which read config at load time) MUST be loaded via dynamic import AFTER these
// assignments — otherwise config caches the pre-set (default 0) rate card.
process.env.META_PRICING_PLACEHOLDER = 'false'; // treat the set rate as calibrated for this run
process.env.META_PRICING_CURRENCY = 'USD';
process.env.META_RATE_SERVICE_CENTS = '88'; // user_initiated → service → 88¢ (test value)
process.env.META_RATE_MARKETING_CENTS = '0'; // leave marketing at 0 → still placeholder for that row
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

const config = (await import('../src/config/index.js')).default;
const prisma = (await import('../src/lib/prisma.js')).default;
const app = (await import('../src/app.js')).default;
const { signToken } = await import('../src/middleware/auth.js');
const { parseStatusEvents } = await import('../src/services/whatsapp.js');
const { normalizeCategory, estimateCostCents } = await import('../src/services/metaCost.js');

// The inbound webhook enforces X-Hub-Signature-256 when WHATSAPP_APP_SECRET is set (it is,
// in this repo's .env). Sign the exact raw JSON body the way Meta does so the REAL handler
// accepts our test payloads (rather than weakening the guard).
const APP_SECRET = config.whatsapp.appSecret || '';
function signBody(raw) {
  if (!APP_SECRET) return null;
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
}

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

// Build a realistic Meta WhatsApp Cloud API status webhook payload.
function statusWebhook({ phoneNumberId, messageId, recipient, category, billable = true, metaConvId, model = 'CBP' }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
              statuses: [
                {
                  id: messageId,
                  status: 'delivered',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: recipient,
                  conversation: { id: metaConvId, origin: { type: category }, expiration_timestamp: '0' },
                  pricing: { billable, pricing_model: model, category },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

// Fire a real HTTP request at the booted app; resolve { status, body }.
function request(server, { method, path: p, token, body, sign }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const sig = sign && payload ? signBody(payload) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(sig ? { 'X-Hub-Signature-256': sig } : {}),
      } },
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

async function main() {
  // ── A: parseStatusEvents pulls pricing off statuses[] ────────────────────────
  const sample = statusWebhook({ phoneNumberId: 'PN_A', messageId: 'wamid.A1', recipient: '972500000001', category: 'user_initiated', metaConvId: 'metaconv_1' });
  const sp = parseStatusEvents(sample);
  check('A — parseStatusEvents returns 1 pricing event', sp && sp.events.length === 1, `events=${sp?.events?.length}`);
  check('A — event carries category + billable + model', sp.events[0].category === 'user_initiated' && sp.events[0].billable === true && sp.events[0].pricingModel === 'CBP');
  check('A — a messages[] (no statuses) payload yields no status events',
    parseStatusEvents({ entry: [{ changes: [{ value: { messages: [{ id: 'x', type: 'text', text: { body: 'hi' } }] } }] }] }) === null);

  // ── B: rate-card estimate + normalization ────────────────────────────────────
  check('B — user_initiated normalizes to service', normalizeCategory('user_initiated') === 'service');
  check('B — referral_conversion normalizes to marketing', normalizeCategory('referral_conversion') === 'marketing');
  const estService = estimateCostCents('service');
  check('B — service rate = 88¢ and NOT placeholder (rate set)', estService.costEstimateCents === 88 && estService.placeholder === false, `cents=${estService.costEstimateCents} ph=${estService.placeholder}`);
  const estMarketing = estimateCostCents('marketing');
  check('B — marketing rate = 0 → placeholder true (uncalibrated)', estMarketing.costEstimateCents === 0 && estMarketing.placeholder === true);

  // ── Boot the real app on an ephemeral port ───────────────────────────────────
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const TAG = `_wa-metacost-test-${Date.now()}`;
  const pnA = `PN_A_${Date.now()}`;
  const pnB = `PN_B_${Date.now()}`;
  const tenantA = await prisma.tenant.create({
    data: { name: `${TAG}-A`, slug: `${TAG}-a`, waPhoneNumberId: pnA, monthlyMessageLimit: 0, purchasedCredits: 0 },
    select: { id: true },
  });
  const tenantB = await prisma.tenant.create({
    data: { name: `${TAG}-B`, slug: `${TAG}-b`, waPhoneNumberId: pnB, monthlyMessageLimit: 0, purchasedCredits: 0 },
    select: { id: true },
  });

  const superToken = signToken({ sub: 'test-super', email: 'super@test', role: 'super_admin', tenantId: null });

  try {
    // Baseline credit-ledger count for tenant A (prove F: recording never writes a debit).
    const ledgerBefore = await prisma.creditTransaction.count({ where: { tenantId: tenantA.id } });

    // ── C: real webhook POST creates a MetaCostEntry for the right tenant/category ──
    // Tenant A: 2 billable user_initiated (service) conversations = 2 x 88¢.
    const r1 = await request(server, { method: 'POST', path: '/api/whatsapp/webhook', body: statusWebhook({ phoneNumberId: pnA, messageId: 'wamid.A1', recipient: '972500000001', category: 'user_initiated', metaConvId: 'mc_A1' }), sign: true });
    check('C — webhook acks 200', r1.status === 200, `status=${r1.status}`);
    const r2 = await request(server, { method: 'POST', path: '/api/whatsapp/webhook', body: statusWebhook({ phoneNumberId: pnA, messageId: 'wamid.A2', recipient: '972500000002', category: 'user_initiated', metaConvId: 'mc_A2' }), sign: true });
    check('C — second webhook acks 200', r2.status === 200);
    // Tenant B: 1 billable marketing conversation (rate 0 → placeholder).
    await request(server, { method: 'POST', path: '/api/whatsapp/webhook', body: statusWebhook({ phoneNumberId: pnB, messageId: 'wamid.B1', recipient: '972500000009', category: 'marketing', metaConvId: 'mc_B1' }), sign: true });
    // ── D: a NON-billable status event must NOT create a cost row. ────────────────
    await request(server, { method: 'POST', path: '/api/whatsapp/webhook', body: statusWebhook({ phoneNumberId: pnA, messageId: 'wamid.A3', recipient: '972500000003', category: 'user_initiated', billable: false, metaConvId: 'mc_A3' }), sign: true });

    // The webhook acks 200 THEN processes inline (async after send). Poll until the
    // expected rows land (or timeout) so we assert on committed state, not a race.
    async function waitForRows(tenantId, want, ms = 4000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const n = await prisma.metaCostEntry.count({ where: { tenantId } });
        if (n >= want) return n;
        await new Promise((r) => setTimeout(r, 100));
      }
      return prisma.metaCostEntry.count({ where: { tenantId } });
    }
    const aRows = await waitForRows(tenantA.id, 2);
    check('C — tenant A has exactly 2 cost rows (2 billable, non-billable skipped)', aRows === 2, `rows=${aRows}`);
    const aEntries = await prisma.metaCostEntry.findMany({ where: { tenantId: tenantA.id }, select: { category: true, rawCategory: true, costEstimateCents: true, placeholder: true, billable: true } });
    check('C — category normalized to service, rawCategory preserved', aEntries.every((e) => e.category === 'service' && e.rawCategory === 'user_initiated'));
    check('C — each service row costed at 88¢ (real rate)', aEntries.every((e) => e.costEstimateCents === 88 && e.placeholder === false));
    const bRows = await waitForRows(tenantB.id, 1);
    check('C — tenant B has 1 cost row attributed to B (isolation)', bRows === 1, `rows=${bRows}`);
    const bEntry = await prisma.metaCostEntry.findFirst({ where: { tenantId: tenantB.id } });
    check('D/B — tenant B marketing row costed 0¢ + placeholder (rate uncalibrated)', bEntry.costEstimateCents === 0 && bEntry.placeholder === true && bEntry.category === 'marketing');
    check('D — non-billable event created NO extra row for tenant A', aRows === 2);

    // ── F: recording is additive — no credit-ledger rows were written. ───────────
    const ledgerAfter = await prisma.creditTransaction.count({ where: { tenantId: tenantA.id } });
    check('F — Meta-cost recording did NOT write to the credit ledger', ledgerAfter === ledgerBefore, `before=${ledgerBefore} after=${ledgerAfter}`);

    // ── E: the REAL margin route aggregates correctly ────────────────────────────
    const unauth = await request(server, { method: 'GET', path: '/api/admin/margin' });
    check('E — /api/admin/margin requires auth (401 without token)', unauth.status === 401, `status=${unauth.status}`);

    const margin = await request(server, { method: 'GET', path: '/api/admin/margin', token: superToken });
    check('E — margin route returns 200 for super_admin', margin.status === 200, `status=${margin.status}`);
    const body = margin.body || {};
    check('E — metaCostTracked true (table migrated live)', body.metaCostTracked === true);
    check('E — openAiCostTracked reported false (honest gap, not fabricated)', body.openAiCostTracked === false);
    const rowA = (body.rows || []).find((r) => r.tenantId === tenantA.id);
    const rowB = (body.rows || []).find((r) => r.tenantId === tenantB.id);
    check('E — tenant A margin row present', !!rowA);
    check('E — tenant A Meta cost = 176¢ (2 × 88¢) summed correctly', rowA && rowA.metaCostCents === 176, `metaCostCents=${rowA?.metaCostCents}`);
    check('E — tenant A metaEvents = 2', rowA && rowA.metaEvents === 2, `metaEvents=${rowA?.metaEvents}`);
    check('E — tenant A NOT flagged placeholder (real rate)', rowA && rowA.metaCostPlaceholder === false);
    check('E — tenant B Meta cost = 0¢ and flagged placeholder', rowB && rowB.metaCostCents === 0 && rowB.metaCostPlaceholder === true, `cents=${rowB?.metaCostCents} ph=${rowB?.metaCostPlaceholder}`);
    check('E — tenant A openAiCostCents is null (no cost table) not a fake number', rowA && rowA.openAiCostCents === null);
    // Totals include at least our two tenants' Meta cost (other live tenants may add more).
    check('E — totals.metaCostCents ≥ 176 (includes our test tenants)', (body.totals?.metaCostCents || 0) >= 176, `total=${body.totals?.metaCostCents}`);

    // Month filter: an explicitly empty past month yields 0 for our fresh rows.
    const pastMonth = await request(server, { method: 'GET', path: '/api/admin/margin?month=2000-01', token: superToken });
    const pastRowA = (pastMonth.body?.rows || []).find((r) => r.tenantId === tenantA.id);
    check('E — month filter works (2000-01 shows 0 for our new rows)', pastRowA && pastRowA.metaCostCents === 0, `cents=${pastRowA?.metaCostCents}`);

    // ── G/H: idempotency — Meta redelivers status webhooks AT-LEAST-ONCE. A repeat of
    // the SAME (waMessageId, category) must NOT create a second cost row, but a
    // genuinely-DIFFERENT category for the same waMessageId still records a distinct row
    // (the category is part of the @@unique key). Drives the REAL webhook handler — no
    // hand-duplicated recorder logic (whatsapp-agent-fix-test-methodology-duplicated-logic).
    const DUP_MSG = 'wamid.DUP1';
    // First delivery: user_initiated (→ service).
    const g1 = await request(server, { method: 'POST', path: '/api/whatsapp/webhook', body: statusWebhook({ phoneNumberId: pnA, messageId: DUP_MSG, recipient: '972500000010', category: 'user_initiated', metaConvId: 'mc_DUP' }), sign: true });
    check('G — first (new-message) webhook acks 200', g1.status === 200, `status=${g1.status}`);
    await waitForRows(tenantA.id, 3); // A had 2; this adds a 3rd (new waMessageId).
    const afterFirst = await prisma.metaCostEntry.count({ where: { tenantId: tenantA.id, waMessageId: DUP_MSG } });
    check('G — first delivery created exactly 1 row for the new waMessageId', afterFirst === 1, `rows=${afterFirst}`);

    // REDELIVERY: byte-identical (same waMessageId + same category). Must be a no-op.
    const g2 = await request(server, { method: 'POST', path: '/api/whatsapp/webhook', body: statusWebhook({ phoneNumberId: pnA, messageId: DUP_MSG, recipient: '972500000010', category: 'user_initiated', metaConvId: 'mc_DUP' }), sign: true });
    check('G — redelivered (duplicate) webhook still acks 200 (no throw)', g2.status === 200, `status=${g2.status}`);
    // Give the async recorder a moment; then assert the count did NOT increase.
    await new Promise((r) => setTimeout(r, 600));
    const afterDup = await prisma.metaCostEntry.count({ where: { tenantId: tenantA.id, waMessageId: DUP_MSG } });
    check('G — REDELIVERED duplicate did NOT create a 2nd row (still exactly 1)', afterDup === 1, `rows=${afterDup}`);

    // Different category for the SAME waMessageId → a legitimately distinct billable
    // event → a second row is allowed (category is part of the uniqueness key).
    const h1 = await request(server, { method: 'POST', path: '/api/whatsapp/webhook', body: statusWebhook({ phoneNumberId: pnA, messageId: DUP_MSG, recipient: '972500000010', category: 'marketing', metaConvId: 'mc_DUP' }), sign: true });
    check('H — same-msg-different-category webhook acks 200', h1.status === 200, `status=${h1.status}`);
    // Poll until the 2nd (marketing) row for DUP_MSG lands.
    async function waitForMsgRows(want, ms = 4000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const n = await prisma.metaCostEntry.count({ where: { tenantId: tenantA.id, waMessageId: DUP_MSG } });
        if (n >= want) return n;
        await new Promise((r) => setTimeout(r, 100));
      }
      return prisma.metaCostEntry.count({ where: { tenantId: tenantA.id, waMessageId: DUP_MSG } });
    }
    const afterDiffCat = await waitForMsgRows(2);
    check('H — different category for same waMessageId DID create a 2nd row (not over-constrained)', afterDiffCat === 2, `rows=${afterDiffCat}`);
    const dupCats = await prisma.metaCostEntry.findMany({ where: { tenantId: tenantA.id, waMessageId: DUP_MSG }, select: { category: true } });
    const catSet = new Set(dupCats.map((r) => r.category));
    check('H — the 2 rows are service + marketing (distinct categories, no dupes)', catSet.size === 2 && catSet.has('service') && catSet.has('marketing'), `cats=${[...catSet].join(',')}`);
  } finally {
    // Cascade deletes the MetaCostEntry rows with the tenant.
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } }).catch((e) => console.log('cleanup warn:', e.message));
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
