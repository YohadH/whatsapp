import { Router } from 'express';
import crypto from 'node:crypto';
import config from '../config/index.js';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { withTenant, TENANT_SELECT } from '../middleware/tenant.js';
import { parseIncomingMessage, parseStatusEvents } from '../services/whatsapp.js';
import { handleIncomingMessage } from '../services/conversationEngine.js';
import { parseMetaMessagingWebhook } from '../services/metaMessaging.js';
import { handleOptOut } from '../services/optOut.js';
import { recordMetaCostFromStatuses } from '../services/metaCost.js';
import { isOwnerPhone, processReceiptImage } from '../services/receipts.js';

const router = Router();

// Meta webhook verification handshake. All tenants share this one callback URL,
// so accept the master env verify token OR any tenant's own verify token (for
// tenants that bring their own Meta app).
router.get(
  '/webhook',
  asyncHandler(async (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode !== 'subscribe' || !token) return res.sendStatus(403);
    if (token === config.whatsapp.verifyToken) return res.status(200).send(challenge);
    const tenant = await prisma.tenant.findFirst({
      where: { waVerifyToken: token },
      select: { id: true },
    });
    return tenant ? res.status(200).send(challenge) : res.sendStatus(403);
  })
);

// Verify Meta's HMAC signature over the RAW request body (captured in app.js).
// When no app secret is configured, verification is skipped (dev only) — a
// warning is logged at boot.
function verifySignature(req) {
  const secret = config.whatsapp.appSecret;
  if (!secret) return true;
  const header = req.get('X-Hub-Signature-256') || '';
  if (!header.startsWith('sha256=') || !req.rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Instagram Direct + Facebook Messenger inbound. Routed to a tenant by the Page id
// (Messenger) or IG business id (Instagram) stored in tenant.integrations.meta, then run
// through the SAME agent pipeline as WhatsApp — only the channel + identity differ.
async function handleMetaMessagingWebhook(body) {
  const events = parseMetaMessagingWebhook(body);
  for (const ev of events) {
    const pathKey = ev.channel === 'instagram' ? 'igAccountId' : 'pageId';
    const tenant = await prisma.tenant.findFirst({
      where: { integrations: { path: ['meta', pathKey], equals: ev.recipientId } },
      select: TENANT_SELECT,
    });
    if (!tenant) {
      console.warn(`[webhook] no tenant for ${ev.channel} id ${ev.recipientId} — dropping`);
      continue;
    }
    if (tenant.status === 'suspended') continue;
    try {
      await handleIncomingMessage({
        tenant,
        channel: ev.channel,
        externalId: ev.externalId,
        text: ev.text,
        waMessageId: ev.messageId, // Meta message id → reused for inbound idempotency
        rawPayload: ev,
      });
    } catch (err) {
      console.error(`[webhook] ${ev.channel} handleIncomingMessage error:`, err.message);
    }
  }
}

// Inbound messages from WhatsApp Cloud API. Routed to a tenant by the Meta
// phone_number_id in the payload metadata.
router.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    if (!verifySignature(req)) {
      console.warn('[webhook] signature verification failed — rejecting');
      return res.sendStatus(403);
    }

    const parsed = parseIncomingMessage(req.body);
    // Meta delivers pricing/cost info on `statuses[]` events (delivery/read receipts),
    // NOT on `messages[]`. A status-only payload has no `parsed.text`, so it falls
    // through the inbound-message handling below — record its Meta conversation-cost
    // (system-gap-analysis §2.7) here, additively, before we return. Best-effort:
    // recordMetaCost* never throws and never touches the credit-charging logic.
    const statusParse = parseStatusEvents(req.body);
    res.sendStatus(200); // acknowledge fast; process inline (small scale)

    // ── Instagram / Messenger ──────────────────────────────────────────────────
    // These Page-based channels arrive on the SAME webhook with object 'instagram' |
    // 'page' and a different shape (entry[].messaging[]). Handle + return before the
    // WhatsApp-format parsing below (which assumes changes[].value.messages).
    if (req.body?.object === 'instagram' || req.body?.object === 'page') {
      try {
        await handleMetaMessagingWebhook(req.body);
      } catch (err) {
        console.error('[webhook] messenger/instagram processing error:', err.message);
      }
      return;
    }

    if (statusParse && statusParse.events?.length && statusParse.phoneNumberId) {
      try {
        const costTenant = await prisma.tenant.findUnique({
          where: { waPhoneNumberId: statusParse.phoneNumberId },
          select: { id: true },
        });
        if (costTenant) {
          await recordMetaCostFromStatuses({
            tenantId: costTenant.id,
            statusParse,
            // Map Meta's conversation id → our Conversation.id when a Message carries it.
            resolveConversationId: async (metaConvId) => {
              // Best-effort: we don't persist Meta's conversation id today, so this is a
              // no-op mapping for now (recorded with metaConversationId for later
              // reconciliation with Meta analytics). Kept as a seam for a future join.
              void metaConvId;
              return null;
            },
          });
        }
      } catch (err) {
        console.error('[webhook] meta-cost recording error:', err.message);
      }
    }

    // Delivery/read/failed receipts → advance our outbound Message.status so the
    // inbox can show sent/delivered/read/failed ticks. (parseStatusEvents above is
    // billing-only and drops non-priced events, so we read the raw statuses here.)
    // Monotonic: never regress a status, and treat `failed` as terminal.
    try {
      const statuses = req.body?.entry?.[0]?.changes?.[0]?.value?.statuses;
      if (Array.isArray(statuses)) {
        const RANK = { sent: 1, delivered: 2, read: 3 };
        for (const s of statuses) {
          if (!s?.id || !s?.status) continue;
          if (s.status === 'failed') {
            await prisma.message.updateMany({ where: { waMessageId: s.id }, data: { status: 'failed' } });
            continue;
          }
          const rank = RANK[s.status];
          if (!rank) continue;
          const msg = await prisma.message.findFirst({ where: { waMessageId: s.id }, select: { id: true, status: true } });
          if (!msg || msg.status === 'failed') continue;
          if (rank > (RANK[msg.status] || 0)) {
            await prisma.message.update({ where: { id: msg.id }, data: { status: s.status } });
          }
        }
      }
    } catch (err) {
      console.error('[webhook] delivery-status update error:', err.message);
    }

    if (!parsed || !parsed.text) return;
    if (!parsed.phoneNumberId) {
      console.warn('[webhook] payload missing phone_number_id — cannot route to a tenant');
      return;
    }

    // Explicit projection (schema-drift hardening — see middleware/tenant.js
    // TENANT_SELECT). A bare findUnique select-all here requests EVERY column
    // declared in schema.prisma; a column declared but not yet migrated live
    // (e.g. Tenant.waPin, migration 3_tenant_wa_pin) makes Prisma throw P2022.
    // This webhook acks with HTTP 200 BEFORE this lookup runs, so a throw here is
    // swallowed (console-only) and the customer's message is silently dropped —
    // strictly worse than a 500. TENANT_SELECT covers every field the downstream
    // consumers (handleOptOut, handleIncomingMessage → tenantWhatsAppCreds/credits)
    // actually read; waPhoneNumberId is unique so findUnique still applies.
    const tenant = await prisma.tenant.findUnique({
      where: { waPhoneNumberId: parsed.phoneNumberId },
      select: TENANT_SELECT,
    });
    if (!tenant) {
      console.warn(`[webhook] no tenant for phone_number_id ${parsed.phoneNumberId} — dropping`);
      return;
    }
    if (tenant.status === 'suspended') return;

    try {
      // Receipts-by-WhatsApp: an IMAGE from the OWNER's own phone is a receipt,
      // not a customer conversation — extract + book it instead of waking the agent.
      if (parsed.media?.kind === 'image' && isOwnerPhone(tenant, parsed.phone)) {
        await processReceiptImage({ tenant, parsed });
        return;
      }
      // "הסר" / "stop" → suppression list; don't hand it to the agent.
      if (await handleOptOut(tenant, parsed.phone, parsed.text)) return;
      await handleIncomingMessage({
        tenant,
        phone: parsed.phone,
        text: parsed.text,
        name: parsed.name,
        rawPayload: parsed.raw,
        waMessageId: parsed.waMessageId,
      });
    } catch (err) {
      console.error('[webhook] processing error:', err);
    }
  })
);

// Local simulator: drive the full pipeline without Meta, for the caller's own
// tenant. Auth-gated (no longer public) so it can't be abused to send messages
// or burn OpenAI credits.
//
// COST-LEAK LOCKDOWN: /simulate runs the FULL AI-charging pipeline (handleIncomingMessage
// → the platform OpenAI key) with NO real WhatsApp connection required, so a fresh trial
// signup could otherwise hit real OpenAI billing here unlimited times at zero cost to
// themselves. Two gates now stop that: (1) the tenant must have an ACTUALLY-CONNECTED
// WhatsApp number — waPhoneNumberId + an encrypted token (the same enabled-signal
// lib/tenantContext.js uses) — so simulate only works once a tenant has done the real
// WhatsApp onboarding, not on a throwaway account; (2) even for a connected tenant, the
// downstream hasCredits() gate (lib/credits.js) already withholds platform AI from an
// expired-unpaid trial, so an expired trial gets only the free rule-based reply here too.
router.post(
  '/simulate',
  requireAuth,
  withTenant,
  asyncHandler(async (req, res) => {
    const { phone, text, name, flowId } = req.body || {};
    if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
    // A trial customer must be able to TEST the agent (see real answers from their
    // own knowledge base / flows / AI) before connecting WhatsApp — that's the whole
    // point of the trial. Cost is already bounded WITHOUT a connection gate:
    //   • auth + the /simulate rate limiter (app.js) cap request volume;
    //   • the downstream hasCredits() gate (lib/credits.js) withholds platform AI once
    //     the tenant's credit allotment is spent → an over-quota tenant gets only the
    //     free rule-based reply (no OpenAI spend);
    //   • a tenant with its OWN AI key (Settings → מנוע הבינה) runs on that key, never
    //     the platform key.
    // So the simulator runs for any authenticated tenant; it just replies in simulator
    // mode (logs instead of sending) when no number is connected.
    if (await handleOptOut(req.tenant, phone, text)) return res.json({ optedOut: true });
    // `flowId` (optional, simulator only): force-test a specific flow. `simulated`
    // flags the thread as a test so it's hidden from the real inbox.
    const result = await handleIncomingMessage({ tenant: req.tenant, phone, text, name, forceFlowId: flowId || undefined, simulated: true });
    res.json(result);
  })
);

export default router;
