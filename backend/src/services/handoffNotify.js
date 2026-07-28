import config from '../config/index.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';

// ─────────────────────────────────────────────────────────────
// Handoff-to-owner notification (system-gap-analysis §2.4).
//
// `Conversation.needsHuman` is a DB flag surfaced in the dashboard, but nothing
// pushes it to the business owner — a DFY owner who isn't staring at the panel
// won't see a handoff until they happen to check. This module fires the cheapest,
// most on-brand alert: it WhatsApps the owner's own number (the bot already has
// send capability) with the handoff context — customer name/phone, the last
// message, and a working link to the conversation.
//
// Trigger it exactly on the FALSE→TRUE edge of needsHuman (see callers), so the
// owner gets one alert per handoff, not one per message afterwards.
//
// Best-effort: never throws. A failed notification must not break the reply
// pipeline or the /assign-human request — it's logged and swallowed.
// ─────────────────────────────────────────────────────────────

// Where to build the "open conversation" link for the owner. Prefer an explicit
// admin-app URL; fall back to the first configured CORS origin (the admin SPA).
function adminBaseUrl() {
  return (config.handoff.adminBaseUrl || config.corsOrigins?.[0] || '').replace(/\/+$/, '');
}

function conversationLink(conversationId) {
  const base = adminBaseUrl();
  if (!base || !conversationId) return null;
  return `${base}/conversations/${conversationId}`;
}

// Build the Hebrew handoff message. `customer` may be a full Customer row or a
// lightweight { name, phone }. Keeps it short — it lands as a WhatsApp text.
function buildMessage({ tenant, conversation, customer }) {
  const name = customer?.name?.trim() || 'לקוח';
  const phone = customer?.phone || conversation?.whatsappPhone || '—';
  const last = (conversation?.lastMessage || '').trim();
  const lastLine = last ? `\n💬 "${last.length > 200 ? `${last.slice(0, 200)}…` : last}"` : '';
  const link = conversationLink(conversation?.id);
  const linkLine = link ? `\n🔗 ${link}` : '';
  const biz = tenant?.displayName || tenant?.name || '';
  const header = biz ? `🙋 העברה לנציג — ${biz}` : '🙋 העברה לנציג אנושי';
  return `${header}\n👤 ${name} (${phone})${lastLine}${linkLine}`;
}

/**
 * Notify the business owner (their own WhatsApp number) that a conversation now
 * needs a human. Call ONLY on the false→true transition of needsHuman.
 *
 * @param {object} args
 * @param {object} args.tenant       full Tenant row (its WhatsApp creds send the alert)
 * @param {object} args.conversation the conversation that flipped (needs id, lastMessage, whatsappPhone)
 * @param {object} [args.customer]   { name, phone } (or a full Customer row)
 * @returns {Promise<{sent:boolean, skipped?:string}>}  never rejects
 */
export async function notifyOwnerHandoff({ tenant, conversation, customer } = {}) {
  try {
    const to = config.handoff.notifyPhone;
    if (!to) return { sent: false, skipped: 'no HANDOFF_NOTIFY_PHONE configured' };
    if (!tenant?.id || !conversation?.id) return { sent: false, skipped: 'missing tenant/conversation' };

    const creds = tenantWhatsAppCreds(tenant);
    const text = buildMessage({ tenant, conversation, customer });
    await sendWhatsAppMessage(creds, to, text);
    return { sent: true };
  } catch (err) {
    // Best-effort: a failed owner alert must not break the customer reply path.
    console.error('[handoffNotify] failed to notify owner:', err.message);
    return { sent: false, skipped: err.message };
  }
}

// Exported for tests.
export const _internals = { buildMessage, conversationLink, adminBaseUrl };
