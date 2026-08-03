#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// whatsapp-agent-fix-trial-trialendsat-never — behavioral test for the trial-expiry
// cost-leak fix.
//
// BUG (found by bug-reviewer at commit af6aaa9): Tenant.trialEndsAt was written on
// signup but never enforced. usageReset re-granted ~500 credits/period to EVERY tenant
// forever regardless of trial expiry, and POST /api/whatsapp/simulate ran the full
// AI-charging pipeline against the platform's own OpenAI key for any auth'd tenant with
// no real WhatsApp connection — letting anyone farm real OpenAI spend from throwaway
// trial signups indefinitely.
//
// WHAT IS PROVEN (drives the REAL code against the LIVE DB — not duplicated logic):
//   A. hasCredits() returns FALSE for a trial tenant past trialEndsAt with NO active
//      paid subscription — even though it still has credits available.
//   B. hasCredits() returns TRUE for the same balances when (b1) still inside the trial
//      window, or (b2) trial expired BUT subscriptionStatus:'active' (converted to paid).
//   C. resetElapsedPeriods() does NOT re-grant credits to an expired-unpaid trial (its
//      creditsUsedThisPeriod stays at the cap) while it DOES re-grant to an eligible
//      tenant (in-trial or active-sub) whose period elapsed.
//   D. POST /api/whatsapp/simulate is BLOCKED (403 whatsapp_not_connected) for a trial
//      tenant with no WhatsApp connection, and passes the connection gate once a tenant
//      has waPhoneNumberId + waTokenEnc.
//
// All fixtures are dedicated throwaway tenants deleted at the end, scoped to the EXACT
// created ids (AP-T79 — never a prefix/pattern match that could delete pre-existing rows).
// Explicit selects everywhere (the live DB has the deliberate waPin drift, migration
// 3_tenant_wa_pin unapplied — an implicit SELECT * on Tenant would P2022; AP-T71).
//
// Run from backend/:  node scripts/trial-expiry-enforcement.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

import http from 'node:http';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

const prisma = (await import('../src/lib/prisma.js')).default;
const { hasCredits } = await import('../src/lib/credits.js');
const { resetElapsedPeriods } = await import('../src/services/usageReset.js');
const app = (await import('../src/app.js')).default;
const { signToken } = await import('../src/middleware/auth.js');

const TAG = `_wa-trial-expiry-test-${Date.now()}`;
const createdTenantIds = []; // exact ids to clean up (AP-T79)
let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

const DAY = 24 * 60 * 60 * 1000;

// Create a throwaway tenant with a generous credit balance so hasCredits' balance test
// would pass on its own — isolating the trial-expiry gate as the ONLY reason for a false.
async function makeTenant(suffix, data) {
  const t = await prisma.tenant.create({
    data: {
      name: `${TAG}-${suffix}`,
      slug: `${TAG}-${suffix}`,
      monthlyMessageLimit: 500,
      creditsUsedThisPeriod: 0,
      purchasedCredits: 0,
      ...data,
    },
    select: { id: true },
  });
  createdTenantIds.push(t.id);
  return t;
}

// Fire a real HTTP request at the booted app; resolve { status, body }.
function request(server, { method, path: p, token, body }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: p,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

async function main() {
  const now = Date.now();

  // ── Fixtures ────────────────────────────────────────────────────────────────
  // expiredUnpaid: trial ended yesterday, no subscription → must be GATED.
  const expiredUnpaid = await makeTenant('expired', {
    plan: 'trial',
    status: 'trial',
    trialEndsAt: new Date(now - 1 * DAY),
    subscriptionStatus: null,
  });
  // inTrial: trial still has days left → must be SERVED.
  const inTrial = await makeTenant('intrial', {
    plan: 'trial',
    status: 'trial',
    trialEndsAt: new Date(now + 5 * DAY),
    subscriptionStatus: null,
  });
  // convertedPaid: trial ended long ago BUT converted to an active Stripe sub → SERVED.
  const convertedPaid = await makeTenant('paid', {
    plan: 'heyil',
    status: 'active',
    trialEndsAt: new Date(now - 30 * DAY),
    subscriptionStatus: 'active',
  });
  // lapsedPaid: WAS subscribed, card failed → reverted to trial + past_due → GATED
  // (this is the churn revenue-leak case: an old trialEndsAt + a non-active sub).
  const lapsedPaid = await makeTenant('lapsed', {
    plan: 'trial',
    status: 'trial',
    trialEndsAt: new Date(now - 30 * DAY),
    subscriptionStatus: 'past_due',
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    // ── A + B: hasCredits() honors trial expiry, ignores it for served cohorts ──
    check(
      'A — expired trial, no sub → hasCredits FALSE despite 500 credits available',
      (await hasCredits(expiredUnpaid.id)) === false
    );
    check(
      'B1 — still inside trial window → hasCredits TRUE',
      (await hasCredits(inTrial.id)) === true
    );
    check(
      'B2 — expired trial but active paid sub → hasCredits TRUE (converted)',
      (await hasCredits(convertedPaid.id)) === true
    );
    check(
      'A2 — lapsed subscriber (reverted to trial, past_due) → hasCredits FALSE',
      (await hasCredits(lapsedPaid.id)) === false
    );

    // ── C: resetElapsedPeriods() withholds the credit re-grant from expired-unpaid ──
    // Set every fixture to "used up its whole allotment" and a period start well past the
    // reset window, so a re-grant is the ONLY thing that could restore creditsUsedThisPeriod
    // to 0. periodDays default 30 → backdate 60 days.
    const longAgo = new Date(now - 60 * DAY);
    for (const t of [expiredUnpaid, inTrial, convertedPaid, lapsedPaid]) {
      await prisma.tenant.updateMany({
        where: { id: t.id },
        data: { creditsUsedThisPeriod: 500, periodStartedAt: longAgo, messagesThisPeriod: 42 },
      });
    }
    await resetElapsedPeriods(new Date(now));

    async function used(id) {
      const t = await prisma.tenant.findUnique({ where: { id }, select: { creditsUsedThisPeriod: true, messagesThisPeriod: true, periodStartedAt: true } });
      return t;
    }
    const expUsed = await used(expiredUnpaid.id);
    check(
      'C — expired-unpaid trial: credits NOT re-granted (creditsUsedThisPeriod stays 500)',
      expUsed.creditsUsedThisPeriod === 500,
      `used=${expUsed.creditsUsedThisPeriod}`
    );
    check(
      'C — expired-unpaid trial: period bookkeeping STILL advanced (messagesThisPeriod reset, period restamped)',
      expUsed.messagesThisPeriod === 0 && expUsed.periodStartedAt.getTime() > longAgo.getTime()
    );
    const inTrialUsed = await used(inTrial.id);
    check(
      'C — in-trial tenant: credits RE-GRANTED (creditsUsedThisPeriod reset to 0)',
      inTrialUsed.creditsUsedThisPeriod === 0,
      `used=${inTrialUsed.creditsUsedThisPeriod}`
    );
    const paidUsed = await used(convertedPaid.id);
    check(
      'C — active-sub tenant: credits RE-GRANTED (creditsUsedThisPeriod reset to 0)',
      paidUsed.creditsUsedThisPeriod === 0,
      `used=${paidUsed.creditsUsedThisPeriod}`
    );
    const lapsedUsed = await used(lapsedPaid.id);
    check(
      'C — lapsed subscriber: credits NOT re-granted (stays 500 — churn leak closed)',
      lapsedUsed.creditsUsedThisPeriod === 500,
      `used=${lapsedUsed.creditsUsedThisPeriod}`
    );

    // ── D: /simulate requires a real WhatsApp connection ────────────────────────
    // inTrial has NO waPhoneNumberId / waTokenEnc → must be blocked (403).
    const inTrialToken = signToken({ sub: `${TAG}-u-intrial`, email: 'intrial@test', role: 'admin', tenantId: inTrial.id });
    const rBlocked = await request(server, {
      method: 'POST',
      path: '/api/whatsapp/simulate',
      token: inTrialToken,
      body: { phone: '972500000001', text: 'שלום' },
    });
    check(
      'D — /simulate BLOCKED for a tenant with no WhatsApp connection (403 whatsapp_not_connected)',
      rBlocked.status === 403 && rBlocked.body?.code === 'whatsapp_not_connected',
      `status=${rBlocked.status} code=${rBlocked.body?.code}`
    );

    // A connected tenant (waPhoneNumberId + waTokenEnc set) passes the connection gate.
    // Use the expired-unpaid tenant + connect it: it should PASS the connection check
    // (so we get past the 403) — proving the gate is specifically the connection, not auth.
    const connected = await makeTenant('connected', {
      plan: 'trial',
      status: 'trial',
      trialEndsAt: new Date(now + 5 * DAY),
      waPhoneNumberId: `${TAG}-pn`,
      waTokenEnc: 'enc:dummy-not-a-real-token',
    });
    const connToken = signToken({ sub: `${TAG}-u-conn`, email: 'conn@test', role: 'admin', tenantId: connected.id });
    const rConn = await request(server, {
      method: 'POST',
      path: '/api/whatsapp/simulate',
      token: connToken,
      body: { phone: '972500000002', text: 'שלום' },
    });
    check(
      'D — /simulate PASSES the WhatsApp-connection gate for a connected tenant (not 403 whatsapp_not_connected)',
      !(rConn.status === 403 && rConn.body?.code === 'whatsapp_not_connected'),
      `status=${rConn.status} code=${rConn.body?.code || ''}`
    );
  } finally {
    server.close();
    // Cleanup — delete ONLY the exact ids we created (AP-T79). deleteMany avoids a
    // RETURNING * (which would P2022 on the waPin drift). Cascade removes child rows.
    for (const id of createdTenantIds) {
      await prisma.tenant.deleteMany({ where: { id } }).catch((e) => console.log('cleanup warn:', e.message));
    }
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
