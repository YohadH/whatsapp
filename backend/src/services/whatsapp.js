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
