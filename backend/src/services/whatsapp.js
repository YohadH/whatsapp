import crypto from 'node:crypto';
import config from '../config/index.js';

// ─────────────────────────────────────────────────────────────
// Multi-tenant WhatsApp Cloud API client.
//
// Every network call takes a `creds` object as its first argument:
//   { token, phoneNumberId, businessAccountId, apiVersion, enabled }
// so a single deployment can send on behalf of many businesses. Build it from a
// tenant with lib/tenantContext.js#tenantWhatsAppCreds, or use masterCreds()
// (the env-configured fallback) for CLI scripts and single-tenant setups.
//
// When creds.enabled is false the client runs in SIMULATOR mode: it logs the
// intended message and resolves, so the whole pipeline is demoable without
// real credentials.
// ─────────────────────────────────────────────────────────────

// Env-based credentials (the "master"/fallback account). Used by dev scripts
// and as the default when a caller doesn't pass tenant creds.
export function masterCreds() {
  return {
    token: config.whatsapp.token,
    phoneNumberId: config.whatsapp.phoneNumberId,
    businessAccountId: config.whatsapp.businessAccountId,
    apiVersion: config.whatsapp.apiVersion,
    enabled: config.whatsapp.enabled,
  };
}

function normalizeCreds(creds) {
  const c = creds || masterCreds();
  return { apiVersion: config.whatsapp.apiVersion, ...c };
}

function graphMessagesUrl(creds) {
  return `https://graph.facebook.com/${creds.apiVersion}/${creds.phoneNumberId}/messages`;
}

async function postMessage(creds, body, { errLabel, fallbackMsg }) {
  const res = await fetch(graphMessagesUrl(creds), {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`[whatsapp] ${errLabel} failed`, res.status, errText);
    throw metaError(res.status, errText, fallbackMsg);
  }
  return res.json();
}

/**
 * Send a plain text message. `creds` selects the sending account (falls back to
 * the env master creds). In simulator mode logs and resolves.
 */
export async function sendWhatsAppMessage(creds, toPhone, text) {
  const c = normalizeCreds(creds);
  if (!c.enabled) {
    console.log(`[whatsapp:simulated] → ${toPhone}: ${text}`);
    return { simulated: true };
  }
  return postMessage(
    c,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'text',
      text: { preview_url: true, body: text },
    },
    { errLabel: 'send', fallbackMsg: 'WhatsApp send failed' }
  );
}

// Build an Error carrying Meta's error code/subcode, so callers (e.g. the
// broadcast circuit breaker) can react to specific failures — a paused
// template or spam-rate block must stop a whole campaign, not just one send.
function metaError(status, errText, fallbackMsg) {
  let msg = fallbackMsg || `HTTP ${status}`;
  let code = null;
  let subcode = null;
  try {
    const e = JSON.parse(errText).error || {};
    msg = e.message || msg;
    code = e.code ?? null;
    subcode = e.error_subcode ?? null;
  } catch {}
  const err = new Error(msg);
  err.status = status;
  err.code = code;
  err.subcode = subcode;
  return err;
}

/**
 * Send a pre-recorded voice note / audio message. `link` must be a publicly
 * reachable HTTPS URL. .ogg/Opus renders as a WhatsApp voice note; other formats
 * as a playable audio attachment. Simulator mode logs.
 */
export async function sendWhatsAppAudio(creds, toPhone, link) {
  if (!link) return { skipped: true };
  const c = normalizeCreds(creds);
  if (!c.enabled) {
    console.log(`[whatsapp:simulated] → ${toPhone}: [audio] ${link}`);
    return { simulated: true };
  }
  return postMessage(
    c,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'audio',
      audio: { link },
    },
    { errLabel: 'audio send', fallbackMsg: 'WhatsApp audio send failed' }
  );
}

/**
 * Send an image message. `link` must be a publicly reachable HTTPS URL
 * (jpg/png). Optional caption. Simulator mode logs.
 */
export async function sendWhatsAppImage(creds, toPhone, link, caption) {
  if (!link) return { skipped: true };
  const c = normalizeCreds(creds);
  if (!c.enabled) {
    console.log(`[whatsapp:simulated] → ${toPhone}: [image] ${link}`);
    return { simulated: true };
  }
  return postMessage(
    c,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'image',
      image: { link, ...(caption ? { caption } : {}) },
    },
    { errLabel: 'image send', fallbackMsg: 'WhatsApp image send failed' }
  );
}

/**
 * List message templates for a WABA. Requires creds.businessAccountId. Returns
 * { configured, templates } where each has { name, language, status, category,
 * bodyText, variableCount, hasImageHeader }.
 */
export async function listMessageTemplates(creds) {
  const c = normalizeCreds(creds);
  if (!c.token || !c.businessAccountId) {
    return { configured: false, templates: [] };
  }
  const url = `https://graph.facebook.com/${c.apiVersion}/${c.businessAccountId}/message_templates?limit=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${c.token}` } });
  if (!res.ok) {
    const errText = await res.text();
    console.error('[whatsapp] list templates failed', res.status, errText);
    let detail = `HTTP ${res.status}`;
    try { detail = JSON.parse(errText).error?.message || detail; } catch { /* keep default */ }
    throw new Error(`list templates failed: ${detail}`);
  }
  const json = await res.json();
  const templates = (json.data || []).map((t) => {
    const comps = t.components || [];
    const body = comps.find((cc) => cc.type === 'BODY');
    const header = comps.find((cc) => cc.type === 'HEADER');
    const bodyText = body?.text || '';
    const variableCount = (bodyText.match(/\{\{\s*\d+\s*\}\}/g) || []).length;
    const hasImageHeader = header?.format === 'IMAGE';
    return { name: t.name, language: t.language, status: t.status, category: t.category, bodyText, variableCount, hasImageHeader };
  });
  return { configured: true, templates };
}

/**
 * Read-only check of an access token via Graph debug_token. Returns validity +
 * expiry + scopes (no message is sent).
 */
export async function checkToken(creds) {
  const c = normalizeCreds(creds);
  const t = c.token;
  if (!t) return { configured: false };
  try {
    const r = await fetch(
      `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(t)}&access_token=${encodeURIComponent(t)}`
    );
    const j = await r.json();
    if (j.error) return { configured: true, valid: false, error: j.error.message };
    const d = j.data || {};
    return {
      configured: true,
      valid: !!d.is_valid,
      expiresAt: d.expires_at || 0,
      neverExpires: d.expires_at === 0,
      expiresIso: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
      scopes: d.scopes || [],
      appId: d.app_id || null,
      type: d.type || null,
    };
  } catch (err) {
    return { configured: true, valid: false, error: err.message };
  }
}

// Register a phone number for Cloud API messaging — the final activation step. A
// number can only send/receive AFTER this (otherwise Graph returns #133010 "Account
// not registered"). Sets the 2-step-verification PIN.
//
// IMPORTANT: Meta requires the SAME PIN on every /register call for an
// already-registered number. So the PIN MUST be persisted and reused — never mint a
// fresh random PIN for a number that already has one, or re-registration fails. The
// caller passes the tenant's stored `pin` (when it has one); when it's the first
// registration we generate one and RETURN it so the caller can persist it.
//
// Best-effort: returns { ok, skipped?, error?, already?, pin? }, never throws.
// `pin` in the result is the PIN that was used — the caller should persist it onto
// the tenant if the tenant did not already have one stored.
export async function registerPhoneNumber(creds, pin) {
  const c = normalizeCreds(creds);
  if (!c.token || !c.phoneNumberId) return { ok: false, skipped: true };
  const usePin = pin || config.platformWaba?.pin || String(crypto.randomInt(100000, 999999));
  try {
    const res = await fetch(`https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin: usePin }),
    });
    const json = await res.json().catch(() => ({}));
    // "already registered" is a success for our purposes.
    if (res.ok && (json.success || !json.error)) return { ok: true, pin: usePin };
    if (json.error?.code === 133005 || /already/i.test(json.error?.message || ''))
      return { ok: true, already: true, pin: usePin };
    return { ok: false, error: json.error?.message || `HTTP ${res.status}`, pin: usePin };
  } catch (err) {
    return { ok: false, error: err.message, pin: usePin };
  }
}

// The full "connect a number" pipeline: register the number for Cloud API, then
// subscribe our app to its WABA's webhooks. This is what Embedded Signup does under
// the hood; calling it after a manual token save makes both paths identical — a
// connected tenant can send AND receive with no extra clicks. Best-effort per step.
//
// `opts.existingPin` is the tenant's already-stored 2-step PIN (if any). Pass it so
// re-registration reuses the same PIN Meta has on file. The returned
// `register.pin` is the PIN that was used — persist it on the tenant when it had none.
export async function finalizeWhatsAppConnection(creds, opts = {}) {
  const register = await registerPhoneNumber(creds, opts.existingPin);
  const subscribe = creds?.businessAccountId ? await subscribeAppToWaba(creds) : { ok: false, skipped: true };
  return { register, subscribe };
}

// Subscribe our app to a WABA's webhooks so inbound customer messages are delivered.
// Embedded Signup does this automatically; the manual token path calls it too so both
// connection methods behave the same. Idempotent — subscribing twice is a no-op.
// Returns { ok, skipped?, error? }; never throws (best-effort).
export async function subscribeAppToWaba(creds) {
  const c = normalizeCreds(creds);
  const wabaId = (c.businessAccountId || '').trim();
  if (!c.token || !wabaId) return { ok: false, skipped: true };
  try {
    const res = await fetch(`https://graph.facebook.com/${c.apiVersion}/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) return { ok: false, error: json.error?.message || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send an approved message template. `bodyParams` fills {{1}}, {{2}}… in order.
 * Throws a metaError on failure (so a broadcast loop can record/react per-recipient).
 */
export async function sendWhatsAppTemplate(
  creds,
  toPhone,
  templateName,
  languageCode,
  bodyParams = [],
  options = {}
) {
  const c = normalizeCreds(creds);
  const { headerImageLink, headerImageId } = options;

  if (!c.enabled) {
    console.log(
      `[whatsapp:simulated] → ${toPhone}: [template:${templateName}] body=${JSON.stringify(bodyParams)} image=${headerImageLink || headerImageId || ''}`
    );
    return { simulated: true };
  }

  const components = [];
  if (headerImageLink || headerImageId) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'image',
          image: headerImageId ? { id: String(headerImageId) } : { link: String(headerImageLink) },
        },
      ],
    });
  }
  if (bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((v) => ({ type: 'text', text: String(v ?? '') })),
    });
  }

  return postMessage(
    c,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode || 'he' },
        // Omit an empty components array (templates with no header/vars, e.g. hello_world).
        ...(components.length ? { components } : {}),
      },
    },
    { errLabel: 'template send' }
  );
}

/**
 * Extract the first inbound text message from a WhatsApp webhook payload.
 * Returns { phone, text, name, waMessageId, phoneNumberId, raw } or null.
 * `phoneNumberId` (from value.metadata) is how the webhook routes to a tenant.
 */
export function parseIncomingMessage(payload) {
  try {
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return null;

    const phone = message.from;
    const contact = value?.contacts?.[0];
    const name = contact?.profile?.name || null;
    const phoneNumberId = value?.metadata?.phone_number_id || null;

    let text = '';
    if (message.type === 'text') text = message.text?.body || '';
    else if (message.type === 'button') text = message.button?.text || '';
    else if (message.type === 'interactive') {
      text =
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title ||
        '';
    } else {
      text = `[${message.type}]`;
    }

    return { phone, text, name, waMessageId: message.id, phoneNumberId, raw: message };
  } catch (err) {
    console.error('[whatsapp] parse error', err.message);
    return null;
  }
}

/**
 * Extract per-conversation Meta PRICING info from a WhatsApp webhook payload.
 *
 * Meta delivers delivery/read receipts as `value.statuses[]` (NOT `value.messages[]`),
 * and it is on these status events that the `pricing` object and `conversation` object
 * ride — this is the ONLY place Meta tells you what a conversation cost category is.
 * The inbound-message parser above returns null for a status-only payload, so before
 * this these events were silently dropped (system-gap-analysis §2.7: "pricing data
 * present in the payload but unused").
 *
 * Shape of a status event (Cloud API):
 *   { id, status, timestamp, recipient_id,
 *     conversation: { id, origin: { type }, expiration_timestamp },
 *     pricing: { billable, pricing_model, category } }
 *
 * Returns { phoneNumberId, events: [{ waMessageId, status, recipientId, metaConversationId,
 *   conversationOrigin, category, billable, pricingModel }] } — one entry per status that
 * carries a pricing object. Empty events array (or null) when there is no pricing data.
 */
export function parseStatusEvents(payload) {
  try {
    const entry = payload?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const statuses = value?.statuses;
    if (!Array.isArray(statuses) || statuses.length === 0) return null;
    const phoneNumberId = value?.metadata?.phone_number_id || null;

    const events = [];
    for (const s of statuses) {
      const pricing = s?.pricing;
      // Only status events that carry a pricing object represent a billable Meta
      // conversation. A bare "delivered"/"read" with no pricing is not a cost event.
      if (!pricing || (pricing.category == null && pricing.billable == null)) continue;
      events.push({
        waMessageId: s.id || null,
        status: s.status || null,
        recipientId: s.recipient_id || null,
        metaConversationId: s.conversation?.id || null,
        conversationOrigin: s.conversation?.origin?.type || null,
        // Prefer the pricing category; fall back to the conversation origin type
        // (older payloads put business_initiated/user_initiated only on origin).
        category: pricing.category ?? s.conversation?.origin?.type ?? null,
        billable: pricing.billable ?? true,
        pricingModel: pricing.pricing_model || null,
      });
    }
    return { phoneNumberId, events };
  } catch (err) {
    console.error('[whatsapp] status parse error', err.message);
    return null;
  }
}
