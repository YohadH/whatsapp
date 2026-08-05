import crypto from 'node:crypto';
import { isSafeWebhookUrl } from './outboundWebhook.js';

// ─────────────────────────────────────────────────────────────────────────────
// External reply provider — the "escalation brain". When a tenant configures it,
// the conversation engine consults the owner's own agent (a local Claude reached
// over an HTTPS tunnel) exactly when the built-in bot is NOT ENOUGH (it would
// otherwise hand off to a human). The provider returns a reply; if it's down,
// slow, errors, or passes, we fall back to the normal human hand-off — a customer
// is never left without an answer. Best-effort: this never throws.
//
// Security: HTTPS-only, public host (SSRF-checked via isSafeWebhookUrl), body
// HMAC-signed (X-HeyIL-Signature) so the local agent can verify it's really HeyIL.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000; // 30s — only fires on hard/escalation cases

function sign(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

// Read + normalize a tenant's reply-provider config, or null if not usable.
export function replyProviderConfig(tenant) {
  const cfg = tenant?.integrationConfig && typeof tenant.integrationConfig === 'object' ? tenant.integrationConfig : {};
  const rp = cfg.replyProvider;
  if (!rp || !rp.enabled || !rp.url) return null;
  return {
    url: rp.url,
    secret: rp.secret || null,
    timeoutMs: Number.isInteger(rp.timeoutMs) ? rp.timeoutMs : DEFAULT_TIMEOUT_MS,
    consultOn: rp.consultOn === 'always' ? 'always' : 'escalation',
  };
}

// Build the rich reply.request payload the provider receives.
function buildPayload(tenant, ctx) {
  return {
    event: 'reply.request',
    tenant: { id: tenant.id, name: tenant.name || null, niche: tenant.niche || null },
    conversation: {
      id: ctx.conversation?.id || null,
      status: ctx.conversation?.status || null,
      currentFlowId: ctx.conversation?.currentFlowId ?? null,
      currentQuestionId: ctx.conversation?.currentQuestionId ?? null,
    },
    customer: { name: ctx.customer?.name || null, phone: ctx.phone || ctx.customer?.phone || null },
    message: { text: ctx.text },
    history: (ctx.history || []).map((m) => ({ role: m.senderType === 'customer' ? 'customer' : 'agent', text: m.text })),
    // Rich context (decision): full KB + flows every call, since the provider is only
    // consulted on hard/escalation cases (not every message).
    knowledgeBase: ctx.kb || null,
    flows: (ctx.flows || []).map((f) => ({
      id: f.id, name: f.name, triggerWords: f.triggerWords,
      questions: (f.questions || []).map((q) => ({ id: q.id, questionText: q.questionText, questionType: q.questionType, options: q.options })),
    })),
    ts: new Date().toISOString(),
  };
}

// POST a payload to the provider URL, returning the parsed JSON response or a
// structured failure. Never throws.
async function post(url, secret, payload, timeoutMs) {
  const body = JSON.stringify(payload);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'HeyIL-ReplyProvider/1' };
    if (secret) headers['X-HeyIL-Signature'] = sign(secret, body);
    // redirect:'manual' — never follow a 3xx to an unvalidated target (SSRF).
    const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: 'redirect_not_followed' };
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : err?.message || 'error' };
  } finally {
    clearTimeout(timer);
  }
}

// Normalize a provider response into an agentResponse-like object, or null if the
// provider passed / returned no usable reply.
function normalize(data) {
  if (!data || data.pass === true) return null;
  const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
  if (!reply) return null;
  return {
    reply,
    needs_human: data.needs_human === true,
    lead_score: Number.isInteger(data.lead_score) ? data.lead_score : undefined,
    conversation_status: typeof data.conversation_status === 'string' ? data.conversation_status : undefined,
    link_to_send: data.link_to_send ?? undefined,
    calendar_event: data.calendar_event ?? undefined,
  };
}

// Consult the tenant's reply provider. Returns the normalized reply object on
// success, or null to signal FALLBACK (not configured / unsafe / non-2xx /
// timeout / invalid / pass). Never throws.
export async function generateViaProvider(tenant, ctx, explicitCfg = null) {
  // explicitCfg lets the caller pass the EFFECTIVE provider (the tenant's own OR the
  // platform default pipeline). Falls back to the tenant's own config when omitted.
  const rp = explicitCfg || replyProviderConfig(tenant);
  if (!rp) return null;
  if (!(await isSafeWebhookUrl(rp.url))) {
    console.warn('[replyProvider] rejected unsafe/non-HTTPS url');
    return null;
  }
  const result = await post(rp.url, rp.secret, buildPayload(tenant, ctx), rp.timeoutMs);
  if (!result.ok) {
    console.warn(`[replyProvider ${tenant.id}] fallback:`, result.error || result.status);
    return null;
  }
  const normalized = normalize(result.data);
  if (!normalized) console.warn(`[replyProvider ${tenant.id}] fallback: provider passed / no reply`);
  return normalized;
}

// Test helper for the Settings "send test" button — sends a sample reply.request
// and reports what came back (status, latency, whether a valid reply was returned).
export async function testReplyProvider(tenant) {
  const rp = replyProviderConfig(tenant);
  if (!rp) return { ok: false, error: 'not_configured' };
  if (!(await isSafeWebhookUrl(rp.url))) return { ok: false, error: 'unsafe_or_invalid_url' };
  const sample = buildPayload(tenant, {
    conversation: { id: 'test', status: 'active' },
    customer: { name: 'לקוח לדוגמה', phone: '972500000001' },
    phone: '972500000001',
    text: 'זו הודעת בדיקה מ-HeyIL — נא להחזיר reply.',
    history: [],
    kb: null,
    flows: [],
  });
  const started = Date.now();
  const result = await post(rp.url, rp.secret, sample, rp.timeoutMs);
  const ms = Date.now() - started;
  if (!result.ok) return { ok: false, status: result.status || null, error: result.error || 'delivery_failed', ms };
  const normalized = normalize(result.data);
  return { ok: true, status: result.status, ms, reply: normalized?.reply || null, gotValidReply: !!normalized };
}
