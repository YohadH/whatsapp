// ESM loader hook for the non-BYO platform-OpenAI fallback regression test
// (board task whatsapp-agent-bug-non-byo-tenants-lose-all).
//
// It substitutes exactly ONE module so the test drives the REAL conversationEngine
// resolution chain while mocking ONLY the true external boundary (the LLM provider):
//
//   `../services/llm.js` → a stub whose:
//     • aiConfigured(tenant)  returns TRUE iff the tenant is NON-BYO — i.e. it
//       simulates "a platform OpenAI key is configured" WITHOUT a real key/network
//       call. (For a BYO tenant it still returns true, matching the real resolver.)
//     • chatJson(...)         returns a canned, valid JSON agent response with a
//       DISTINCTIVE reply string (STUB_AI_REPLY) and source:'platform' — so the test
//       can assert the visible reply came from the platform-OpenAI path, NOT the
//       rule-based fallback (which produces a different, fixed Hebrew string).
//
// Everything else — the engine's BYO/pipeline/platform-OpenAI priority chain, the
// credit/quota metering (consumeDailyFreeReply → spendOneCredit), lib/prisma.js, the
// WhatsApp send (self-simulates with no creds) — runs FOR REAL against the live DB on
// a throwaway tenant. Reverting the fix (allowAI = aiOn && !!byoKey with no platform
// fallback) makes the non-BYO reply fall to rules → STUB_AI_REPLY never appears →
// the test fails.
//
// Registered via:
//   node --import ./scripts/register-non-byo-fallback-loader.mjs <script>

const LLM_STUB = `
// Distinctive marker the rule-based path can NEVER produce.
globalThis.__STUB_AI_REPLY = globalThis.__STUB_AI_REPLY || 'PLATFORM_OPENAI_STUB_REPLY_✓';
globalThis.__LLM_CALLS = globalThis.__LLM_CALLS || { chatJson: 0, byUsed: [] };

function isByo(tenant) {
  return !!(tenant && (tenant.aiProvider === 'anthropic' || tenant.aiProvider === 'openai') && tenant.aiApiKeyEnc);
}

// Mirrors the real resolver's truth table WITHOUT a network/key: a usable provider
// exists for a BYO tenant (its own key) OR for any tenant when a platform key is set.
// In this test we simulate "platform key present", so aiConfigured is TRUE for a
// non-BYO tenant — exactly the case the regression broke.
export function resolveProvider(tenant) {
  if (isByo(tenant)) return { provider: tenant.aiProvider, key: 'stub', model: 'stub', source: 'tenant' };
  return { provider: 'openai', key: 'stub-platform', model: 'stub', source: 'platform' };
}

export function aiConfigured(tenant) {
  return resolveProvider(tenant) !== null;
}

// Canned platform-OpenAI JSON response — a plain KB-style answer (no flow start),
// source:'platform' so the engine treats it as billable (charges via the uniform meter).
export async function chatJson({ tenant }) {
  globalThis.__LLM_CALLS.chatJson += 1;
  const src = isByo(tenant) ? 'tenant' : 'platform';
  globalThis.__LLM_CALLS.byUsed.push(src);
  const payload = {
    reply: globalThis.__STUB_AI_REPLY,
    intent: 'general_question',
    next_action: 'answer_question',
    flow_id: null,
    current_question_id: null,
    collected_answers: [],
    link_to_send: null,
    conversation_status: 'active',
    lead_score: 42,
    needs_human: false,
    reset_answers: false,
    calendar_event: null,
  };
  return { text: JSON.stringify(payload), tokensIn: 10, tokensOut: 20, source: src };
}

export default { resolveProvider, aiConfigured, chatJson };
`;

function isLlmModule(url) {
  return url.endsWith('/services/llm.js') || url.endsWith('\\services\\llm.js');
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (isLlmModule(resolved.url)) {
    return { url: 'llm-stub:platform', shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url === 'llm-stub:platform') return { format: 'module', source: LLM_STUB, shortCircuit: true };
  return nextLoad(url, context);
}
