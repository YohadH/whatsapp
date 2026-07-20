import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { encryptSecret } from '../lib/crypto.js';
import { checkToken } from '../services/whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { connectWhatsApp, embeddedSignupPublicConfig } from '../services/embeddedSignup.js';

// Tenant-facing account settings, scoped to the caller's OWN tenant (req.tenantId,
// set by withTenant). This lets a tenant admin self-connect their WhatsApp number
// via Meta Embedded Signup, mirroring the super-admin flow in routes/admin.js but
// always acting on their own tenant — never another's.
const router = Router();

// GET /api/settings/whatsapp → current connection state (never the token itself).
router.get(
  '/whatsapp',
  asyncHandler(async (req, res) => {
    const t = req.tenant;
    res.json({
      phoneNumberId: t.waPhoneNumberId || null,
      businessAccountId: t.waBusinessAccountId || null,
      apiVersion: t.waApiVersion || null,
      connected: Boolean(t.waTokenEnc && t.waPhoneNumberId),
      embeddedSignup: embeddedSignupPublicConfig(),
    });
  })
);

// GET /api/settings/embedded-signup/config → public params to launch the FB flow.
router.get(
  '/embedded-signup/config',
  asyncHandler(async (req, res) => {
    res.json(embeddedSignupPublicConfig());
  })
);

// POST /api/settings/connect-whatsapp → complete Embedded Signup for THIS tenant.
// body: { code, phoneNumberId, wabaId }
router.post(
  '/connect-whatsapp',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const { code, phoneNumberId, wabaId } = req.body || {};

    // Refuse if this number already belongs to a different tenant.
    if (phoneNumberId) {
      const clash = await prisma.tenant.findFirst({
        where: { waPhoneNumberId: phoneNumberId, NOT: { id: tenantId } },
        select: { id: true },
      });
      if (clash) return res.status(409).json({ error: 'מספר ה-WhatsApp הזה כבר מחובר לחשבון אחר' });
    }

    let result;
    try {
      result = await connectWhatsApp({ code, phoneNumberId, wabaId });
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message });
    }

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        waPhoneNumberId: result.phoneNumberId,
        waBusinessAccountId: result.wabaId,
        waTokenEnc: encryptSecret(result.token),
      },
    });

    res.json({
      connected: true,
      phoneNumberId: result.phoneNumberId,
      businessAccountId: result.wabaId,
      register: result.register,
    });
  })
);

// POST /api/settings/whatsapp/verify → live check that the stored token works.
router.post(
  '/whatsapp/verify',
  asyncHandler(async (req, res) => {
    res.json(await checkToken(tenantWhatsAppCreds(req.tenant)));
  })
);

export default router;
