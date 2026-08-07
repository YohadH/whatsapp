import config from '../config/index.js';
import { decryptSecret } from '../lib/crypto.js';

// Meta Messenger Platform — Facebook Messenger + Instagram Direct. Both ride the same
// Graph API and Page access token; the only real difference is the webhook `object`
// and which business id the events arrive under. WhatsApp has its own service
// (whatsapp.js); this one covers the two Page-based channels.
const GRAPH = 'https://graph.facebook.com';
const DEFAULT_API_VERSION = config.whatsapp?.apiVersion || 'v21.0';

// A tenant's Messenger/Instagram connection, stored (encrypted) under
// tenant.integrations.meta = { pageId, igAccountId?, pageTokenEnc, apiVersion? }.
// Connected in routes/settings (Phase 2). Returns null until connected.
export function tenantMessengerCreds(tenant) {
  const meta = tenant?.integrations && typeof tenant.integrations === 'object' ? tenant.integrations.meta : null;
  if (!meta || !meta.pageId || !meta.pageTokenEnc) return null;
  let token = null;
  try { token = decryptSecret(meta.pageTokenEnc); } catch { return null; }
  return { pageId: meta.pageId, igAccountId: meta.igAccountId || null, token, apiVersion: meta.apiVersion || DEFAULT_API_VERSION };
}

// Send a TEXT message on Messenger or Instagram. `recipientId` is the PSID (Messenger)
// or IGSID (Instagram). messaging_type RESPONSE = a reply inside the 24-hour window
// (the only automated-send allowed off WhatsApp). Both post to the Page id.
export async function sendMessengerMessage(creds, recipientId, text) {
  if (!creds?.token) throw new Error('messenger_not_connected');
  const url = `${GRAPH}/${creds.apiVersion}/${creds.pageId}/messages?access_token=${encodeURIComponent(creds.token)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`meta_send_${res.status}: ${data?.error?.message || ''}`);
  return { id: data.message_id || null, simulated: false };
}

// Normalize a Messenger/Instagram webhook body into per-message events the engine can
// consume. Skips echoes, delivery/read receipts, and non-text events (attachments and
// story replies are handled in a later phase). Each event carries `recipientId` — the
// Page/IG business id the message arrived under — so the caller can route to the tenant.
export function parseMetaMessagingWebhook(body) {
  const channel = body?.object === 'instagram' ? 'instagram' : 'messenger';
  const events = [];
  for (const entry of body?.entry || []) {
    const recipientId = entry.id; // Page id (Messenger) or IG business id (Instagram)
    for (const m of entry.messaging || []) {
      const senderId = m.sender?.id;
      const msg = m.message;
      if (!senderId || !msg || msg.is_echo) continue;
      const text = msg.text || m.postback?.title || null;
      if (!text) continue;
      events.push({ channel, recipientId, externalId: senderId, text, messageId: msg.mid || null });
    }
  }
  return events;
}
