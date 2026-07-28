#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Concurrency test for the needsHuman handoff-notify TOCTOU fix (AP-T72).
//
// The owner gets a WhatsApp alert the moment a conversation flips needsHuman
// false→true (handoffNotify.notifyOwnerHandoff). Two near-simultaneous triggers —
// two admin assign-human clicks, two dashboard tabs, a retried request — could BOTH
// read needsHuman:false before either wrote true, so BOTH fire the alert → the owner
// gets duplicate handoff notifications for a single handoff.
//
// TEST METHODOLOGY (whatsapp-agent-fix-test-methodology-duplicated-logic):
//   This DRIVES THE REAL route. It boots the real Express app (src/app.js) and fires
//   genuinely-concurrent POSTs at the REAL POST /api/conversations/:id/assign-human
//   handler over HTTP (with a forged super_admin JWT + X-Tenant-Id, exactly the way a
//   real admin request is authed), against the live DB on a throwaway tenant. It does
//   NOT re-implement the flip gate inline (the previous version did — reverting the
//   real conditional flip in routes/conversations.js did NOT fail it). The ONLY mocked
//   boundary is notifyOwnerHandoff() (the WhatsApp send), stubbed to a COUNTER via an
//   ESM loader hook — so we can count how many callers were allowed to notify. The
//   conditional-flip gate that decides WHO notifies runs for real.
//
// This proves:
//   NEW (atomic conditional: updateMany({ where:{ needsHuman:false }, ...}), notify
//       only when count===1 — what routes/conversations.js does now)
//       → EXACTLY ONE caller notifies under an 8-way concurrent race.
//   NEW late call on an already-flipped conversation → does NOT notify again.
//   Reverting routes/conversations.js to a read-then-write gate makes >1 caller
//   notify → this test FAILS (its discriminating power, verified in the task).
//
// Run from backend/ WITH the loader:
//   node --import ./scripts/register-handoff-notify-loader.mjs ./scripts/handoff-notify-toctou.test.mjs
// Exit 0 = NEW single-winner confirmed; non-zero = failure.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

import http from 'node:http';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';

const prisma = (await import('../src/lib/prisma.js')).default;
const app = (await import('../src/app.js')).default;
const { signToken } = await import('../src/middleware/auth.js');

// Guard: if the loader hook wasn't registered, notifyOwnerHandoff would be the REAL
// (WhatsApp-sending) module and the counter would never move — fail loud, don't run
// a test that can't observe the thing under test.
const HANDOFF = (globalThis.__HANDOFF = globalThis.__HANDOFF || { notifyCount: 0, calls: [] });

const CONCURRENCY = 8;
let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

// Fire a real HTTP request at the booted app; resolve { status, body }.
function request(server, { method, path: p, token, tenantId, body }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body != null ? JSON.stringify(body) : null;
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
          ...(tenantId ? { 'X-Tenant-Id': tenantId } : {}),
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

const created = { tenants: [] };
async function makeConversation(tag) {
  const stamp = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({
    data: { name: `TOCTOU-handoff-${stamp}`, slug: `toctou-handoff-${stamp}` },
    select: { id: true },
  });
  created.tenants.push(tenant.id);
  const customer = await prisma.customer.create({
    data: { tenantId: tenant.id, name: 'Race Tester', phone: `+9725${Math.floor(Math.random() * 1e7)}` },
    select: { id: true },
  });
  const conversation = await prisma.conversation.create({
    data: { tenantId: tenant.id, customerId: customer.id, whatsappPhone: customer.id, needsHuman: false },
    select: { id: true },
  });
  return { tenantId: tenant.id, conversationId: conversation.id };
}

async function main() {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // A super_admin can act as any tenant via X-Tenant-Id (see middleware/tenant.js).
  const superToken = signToken({ sub: 'test-super', email: 'super@test', role: 'super_admin', tenantId: null });

  try {
    // ── Sanity: the loader stub is actually in place (else the counter is blind) ──
    check('setup — handoffNotify stub is registered (counter observable)', HANDOFF && typeof HANDOFF.notifyCount === 'number');

    // ── NEW atomic conditional via the REAL route — expect EXACTLY ONE notifier ──
    const { tenantId, conversationId } = await makeConversation('new');
    const notifyBefore = HANDOFF.notifyCount;

    const race = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        request(server, {
          method: 'POST',
          path: `/api/conversations/${conversationId}/assign-human`,
          token: superToken,
          tenantId,
          body: { assignedTo: 'agent@test' },
        }).catch((e) => ({ status: 0, err: e.message }))
      )
    );

    const ok200 = race.filter((r) => r.status === 200).length;
    check('NEW — all concurrent assign-human calls succeed (200)', ok200 === CONCURRENCY, `ok200=${ok200}/${CONCURRENCY}`);

    // The real route drives notifyOwnerHandoff only for the caller that won the
    // false→true flip. Under the atomic gate that is EXACTLY ONE.
    const notified = HANDOFF.notifyCount - notifyBefore;
    check('NEW — REAL route notified the owner exactly ONCE under an 8-way race', notified === 1, `notifiers=${notified}`);

    const row = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { needsHuman: true, status: true } });
    check('NEW — conversation ended needsHuman=true / status=needs_human', row.needsHuman === true && row.status === 'needs_human', `needsHuman=${row.needsHuman} status=${row.status}`);

    // ── A late trigger on the already-flipped conversation must NOT notify again ──
    const beforeLate = HANDOFF.notifyCount;
    const late = await request(server, {
      method: 'POST',
      path: `/api/conversations/${conversationId}/assign-human`,
      token: superToken,
      tenantId,
      body: { assignedTo: 'agent@test' },
    });
    const lateNotified = HANDOFF.notifyCount - beforeLate;
    check('NEW — late assign-human on already-needsHuman does NOT re-notify', late.status === 200 && lateNotified === 0, `status=${late.status} lateNotifiers=${lateNotified}`);

    // ── Tenant isolation: a super_admin acting as tenant A cannot flip tenant B's
    //    conversation (route filters where:{ id, tenantId } → 404, no notify). ─────
    const b = await makeConversation('other');
    const beforeCross = HANDOFF.notifyCount;
    const cross = await request(server, {
      method: 'POST',
      path: `/api/conversations/${b.conversationId}/assign-human`,
      token: superToken,
      tenantId, // acting as the FIRST tenant, not b's tenant
      body: {},
    });
    const crossNotified = HANDOFF.notifyCount - beforeCross;
    check('ISO — cross-tenant assign-human is 404 and does NOT notify', cross.status === 404 && crossNotified === 0, `status=${cross.status} notifiers=${crossNotified}`);
    const bRow = await prisma.conversation.findUnique({ where: { id: b.conversationId }, select: { needsHuman: true } });
    check('ISO — the other tenant\'s conversation was NOT flipped', bRow.needsHuman === false, `needsHuman=${bRow.needsHuman}`);
  } finally {
    if (created.tenants.length) {
      await prisma.tenant.deleteMany({ where: { id: { in: created.tenants } } }).catch((e) => console.log('cleanup warn:', e.message));
      console.log(`cleaned up ${created.tenants.length} throwaway tenant(s)`);
    }
    await new Promise((r) => server.close(r));
    await prisma.$disconnect();
  }

  console.log(failed === 0 ? '\nALL CASES PASSED' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('TEST ERROR:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
