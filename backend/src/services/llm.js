import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import config from '../config/index.js';
import { decryptSecret } from '../lib/crypto.js';

// ─────────────────────────────────────────────────────────────
// LLM provider abstraction (Phase 3.1 — BYO AI key).
//
// The conversation agent calls chatJson() with a system + user prompt and gets
// back parsed JSON + token counts. Which provider runs is resolved PER TENANT:
//
//   • tenant.aiProvider === 'anthropic' + aiApiKeyEnc  → Claude on the tenant's key
//   • tenant.aiProvider === 'openai'    + aiApiKeyEnc  → OpenAI on the tenant's key
//   • otherwise                                        → platform OpenAI key + credits
//
// DORMANT BY DEFAULT: with no tenant AI config and a valid platform OPENAI_API_KEY,
// behavior is identical to before — the Claude path only activates once a tenant
// sets aiProvider='anthropic'. The Claude call is written now so enabling it later
// is a settings toggle, not a code change.
// ─────────────────────────────────────────────────────────────

// Platform OpenAI client (shared) — the credits-backed default.
const platformOpenai = config.openai.enabled ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

const DEFAULT_MODELS = {
  openai: config.openai.model, // gpt-4o-mini
  anthropic: 'claude-opus-5',
};

// Decrypt a tenant's stored AI key (same AES-256-GCM helper as waTokenEnc).
function tenantAiKey(tenant) {
  try {
    return decryptSecret(tenant.aiApiKeyEnc) || null;
  } catch (err) {
    console.error(`[llm] failed to decrypt AI key for tenant ${tenant?.id}:`, err.message);
    return null;
  }
}

// Resolve the effective provider for a tenant. Returns null when no usable
// provider exists (no tenant key AND no platform key) — caller falls back to rules.
export function resolveProvider(tenant) {
  const provider = tenant?.aiProvider;
  if ((provider === 'anthropic' || provider === 'openai') && tenant?.aiApiKeyEnc) {
    const key = tenantAiKey(tenant);
    if (key) {
      return {
        provider,
        key,
        model: tenant.aiModel || DEFAULT_MODELS[provider],
        source: 'tenant', // BYO key → do NOT charge platform credits
      };
    }
  }
  if (platformOpenai) {
    return { provider: 'openai', key: config.openai.apiKey, model: config.openai.model, source: 'platform' };
  }
  return null;
}

export function aiConfigured(tenant) {
  return resolveProvider(tenant) !== null;
}

// Run one JSON-mode chat completion. Returns { text, tokensIn, tokensOut, source }.
// `text` is the raw model output (caller parses/validates). Throws on transport error.
export async function chatJson({ tenant, system, user, temperature = 0.3 }) {
  const cfg = resolveProvider(tenant);
  if (!cfg) {
    const err = new Error('No AI provider configured');
    err.code = 'no_provider';
    throw err;
  }

  if (cfg.provider === 'anthropic') {
    const anthropic = new Anthropic({ apiKey: cfg.key });
    const msg = await anthropic.messages.create({
      model: cfg.model,
      max_tokens: 1024,
      system: `${system}\n\nהחזר JSON תקין בלבד — ללא טקסט נוסף לפני או אחרי.`,
      messages: [{ role: 'user', content: user }],
    });
    // Concatenate text blocks; strip a ```json fence if the model added one.
    const text = (msg.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .replace(/^```(?:json)?\s*|\s*```$/g, '')
      .trim();
    return {
      text,
      tokensIn: msg.usage?.input_tokens ?? null,
      tokensOut: msg.usage?.output_tokens ?? null,
      source: cfg.source,
    };
  }

  // OpenAI (tenant key or platform key)
  const client = cfg.source === 'platform' ? platformOpenai : new OpenAI({ apiKey: cfg.key });
  const completion = await client.chat.completions.create({
    model: cfg.model,
    temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return {
    text: completion.choices?.[0]?.message?.content || '{}',
    tokensIn: completion.usage?.prompt_tokens ?? null,
    tokensOut: completion.usage?.completion_tokens ?? null,
    source: cfg.source,
  };
}
