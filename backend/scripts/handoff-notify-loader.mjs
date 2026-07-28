// ESM loader hook for the handoff-notify TOCTOU behavioral test. It substitutes a
// SINGLE module so the test exercises the REAL route + REAL atomic-flip gate while
// mocking ONLY the true external boundary (the owner's WhatsApp alert):
//
//   `../services/handoffNotify.js` → a stub whose notifyOwnerHandoff() does NOT
//   send WhatsApp; it just increments a global counter. The WhatsApp send is the
//   ONLY thing under this seam we can't/shouldn't hit in a test. Everything the
//   real route does AROUND the notify — the `updateMany({ where:{ needsHuman:false }})`
//   conditional flip that IS the notify gate (AP-T72), the wonFlip=count===1 branch,
//   the analytics event, the follow-up status/assignedTo update — runs for real.
//
// The counter lets the test PROVE the gate: under a Promise.all race of N callers,
// exactly ONE must win the flip and call notifyOwnerHandoff. Reverting the route's
// conditional flip back to read-then-write makes >1 caller notify → the test fails.
//
// Everything else (lib/prisma.js, the express app, auth/tenant middleware) is the
// REAL module, running against the live DB on a throwaway tenant.
//
// Registered via:  node --import ./scripts/register-handoff-notify-loader.mjs <script>

const HANDOFF_STUB = `
globalThis.__HANDOFF = globalThis.__HANDOFF || { notifyCount: 0, calls: [] };

// Real signature: notifyOwnerHandoff({ tenant, conversation, customer }) → best-effort,
// never throws. The real one WhatsApps the owner; here we only count that it fired,
// so the test can assert exactly-one-notify under concurrency (the gate under test).
export async function notifyOwnerHandoff(args) {
  globalThis.__HANDOFF.notifyCount += 1;
  globalThis.__HANDOFF.calls.push({ conversationId: args?.conversation?.id || null });
  return { sent: false, stubbed: true };
}
export default { notifyOwnerHandoff };
`;

function isHandoffModule(url) {
  return url.endsWith('/services/handoffNotify.js') || url.endsWith('\\services\\handoffNotify.js');
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (isHandoffModule(resolved.url)) {
    return { url: 'handoff-stub:notify', shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url === 'handoff-stub:notify') return { format: 'module', source: HANDOFF_STUB, shortCircuit: true };
  return nextLoad(url, context);
}
