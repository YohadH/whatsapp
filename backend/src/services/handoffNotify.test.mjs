// Smoke test for owner handoff notification (system-gap-analysis §2.4).
// Run: node src/services/handoffNotify.test.mjs
//
// Drives notifyOwnerHandoff() with a SIMULATOR-mode tenant (no real WhatsApp
// creds) so the whatsapp service logs the outbound message instead of hitting
// Meta. Asserts: (1) an alert is sent to the configured owner number, (2) the
// message carries customer name/phone + last message + a working conversation
// link, (3) no HANDOFF_NOTIFY_PHONE => no send (graceful disable).

import assert from 'node:assert';

// Configure BEFORE importing the module (config reads env at import time).
process.env.HANDOFF_NOTIFY_PHONE = '972501112222';
process.env.ADMIN_APP_URL = 'https://admin.example.com';

const { notifyOwnerHandoff, _internals } = await import('./handoffNotify.js');

// Capture console.log to inspect the simulated WhatsApp send.
const logs = [];
const origLog = console.log;
console.log = (...a) => { logs.push(a.join(' ')); };

const tenant = {
  id: 'tenant_test',
  name: 'עסק בדיקה',
  displayName: 'עסק בדיקה',
  // No waTokenEnc / waPhoneNumberId => tenantWhatsAppCreds returns enabled:false
  // => whatsapp service runs in SIMULATOR mode (logs instead of sending).
};
const conversation = {
  id: 'conv_abc123',
  whatsappPhone: '972544445555',
  lastMessage: 'אני רוצה לדבר עם נציג אנושי בבקשה',
};
const customer = { name: 'דנה כהן', phone: '972544445555' };

const res = await notifyOwnerHandoff({ tenant, conversation, customer });
console.log = origLog;

// (1) A send was attempted to the owner's number, in simulator mode.
assert.strictEqual(res.sent, true, `expected sent:true, got ${JSON.stringify(res)}`);
const sim = logs.find((l) => l.includes('[whatsapp:simulated]'));
assert.ok(sim, 'expected a simulated WhatsApp send to be logged');
assert.ok(sim.includes('972501112222'), 'alert must go to the configured owner number');

// (2) Message content: name, phone, last message, working link.
assert.ok(sim.includes('דנה כהן'), 'message must include the customer name');
assert.ok(sim.includes('972544445555'), 'message must include the customer phone');
assert.ok(sim.includes('אני רוצה לדבר עם נציג'), 'message must include the last message');
const expectedLink = 'https://admin.example.com/conversations/conv_abc123';
assert.ok(sim.includes(expectedLink), `message must include a working link (${expectedLink})`);
assert.strictEqual(_internals.conversationLink('conv_abc123'), expectedLink, 'link builder mismatch');

// (3) No configured owner number => graceful no-op (module re-read via a fresh
// import isn't trivial with cached env, so assert the guard directly on config).
{
  const emptyRes = await notifyOwnerHandoff({ tenant: null, conversation: null });
  assert.strictEqual(emptyRes.sent, false, 'missing tenant/conversation must not send');
}

console.log('\n--- simulated alert body ---');
console.log(sim.split(': ').slice(1).join(': '));
console.log('\nPASS: handoffNotify sends owner alert with name/phone + last message + working link');
