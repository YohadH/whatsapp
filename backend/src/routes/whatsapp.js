import { Router } from 'express';
import crypto from 'node:crypto';
import config from '../config/index.js';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { withTenant, TENANT_SELECT } from '../middleware/tenant.js';
import { parseIncomingMessage } from '../services/whatsapp.js';
import { handleIncomingMessage } from '../services/conversationEngine.js';
import { handleOptOut } from '../services/optOut.js';

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
    res.sendStatus(200); // acknowledge fast; process inline (small scale)
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
router.post(
  '/simulate',
  requireAuth,
  withTenant,
  asyncHandler(async (req, res) => {
    const { phone, text, name } = req.body || {};
    if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
    if (await handleOptOut(req.tenant, phone, text)) return res.json({ optedOut: true });
    const result = await handleIncomingMessage({ tenant: req.tenant, phone, text, name });
    res.json(result);
  })
);

export default router;
