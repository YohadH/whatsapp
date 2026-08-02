import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { encryptSecret } from '../lib/crypto.js';
import { checkToken } from '../services/whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { connectWhatsApp, embeddedSignupPublicConfig } from '../services/embeddedSignup.js';
import {
  platformNumberingConfigured,
  startNumberConnect,
  verifyAndRegister,
  splitPhone,
} from '../services/numberRegistration.js';

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
      platformNumbering: platformNumberingConfigured(),
    });
  })
);

// ── Business profile (onboarding step 1) ─────────────────────────────────────
// GET/PUT the tenant's own display name. Deliberately name-only: plan, caps and
// entitlements stay super-admin-governed in routes/admin.js.
router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    // req.tenant comes from TENANT_SELECT (no name); read the two fields directly.
    const t = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: { name: true, ownerPhone: true },
    });
    res.json({ name: t?.name || '', ownerPhone: t?.ownerPhone || '' });
  })
);

router.put(
  '/profile',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'שם העסק לא יכול להיות ריק' });
    if (name.length > 80) return res.status(400).json({ error: 'שם העסק ארוך מדי (עד 80 תווים)' });
    const data = { name };
    // ownerPhone (optional): digits-only international-ish; empty clears it.
    if ('ownerPhone' in (req.body || {})) {
      const digits = String(req.body.ownerPhone || '').replace(/\D/g, '');
      if (digits && (digits.length < 9 || digits.length > 15)) {
        return res.status(400).json({ error: 'מספר הטלפון של בעל/ת העסק לא תקין' });
      }
      data.ownerPhone = digits || null;
    }
    const t = await prisma.tenant.update({ where: { id: req.tenantId }, data });
    res.json({ name: t.name, ownerPhone: t.ownerPhone || '' });
  })
);

// ── Connect by phone number (no Embedded Signup) ─────────────────────────────
// The customer types their number + a display name; we register it under the
// PLATFORM's WABA and Meta texts them a code, which they enter to finish.

// POST /api/settings/number/start → add the number to our WABA + trigger the code.
// body: { cc, phone, displayName, codeMethod? } → { phoneNumberId }
router.post(
  '/number/start',
  asyncHandler(async (req, res) => {
    const { cc, phoneNumber } = splitPhone(req.body?.cc, req.body?.phone);
    const displayName = (req.body?.displayName || '').trim();

    // Refuse if the fully-qualified number is already connected to another tenant.
    if (cc && phoneNumber) {
      const full = cc + phoneNumber;
      const clash = await prisma.tenant.findFirst({
        where: { waPhoneNumberId: full, NOT: { id: req.tenantId } },
        select: { id: true },
      });
      if (clash) return res.status(409).json({ error: 'מספר זה כבר מחובר לחשבון אחר' });
    }

    try {
      const { phoneNumberId } = await startNumberConnect({
        cc,
        phoneNumber,
        displayName,
        codeMethod: req.body?.codeMethod,
      });
      res.json({ phoneNumberId, status: 'code_sent' });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  })
);

// POST /api/settings/number/verify → verify the code, register, store on the tenant.
// body: { phoneNumberId, code } → { connected, phoneNumberId }
router.post(
  '/number/verify',
  asyncHandler(async (req, res) => {
    const phoneNumberId = String(req.body?.phoneNumberId || '').trim();
    const code = req.body?.code;
    if (!phoneNumberId || !code) return res.status(400).json({ error: 'phoneNumberId and code are required' });

    // Guard against binding a number that another tenant already holds.
    const clash = await prisma.tenant.findFirst({
      where: { waPhoneNumberId: phoneNumberId, NOT: { id: req.tenantId } },
      select: { id: true },
    });
    if (clash) return res.status(409).json({ error: 'מספר זה כבר מחובר לחשבון אחר' });

    let result;
    try {
      result = await verifyAndRegister({ phoneNumberId, code });
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message });
    }

    await prisma.tenant.update({
      where: { id: req.tenantId },
      data: {
        waPhoneNumberId: result.phoneNumberId,
        waBusinessAccountId: result.wabaId,
        waTokenEnc: encryptSecret(result.token),
      },
    });
    res.json({ connected: true, phoneNumberId: result.phoneNumberId, businessAccountId: result.wabaId });
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

// ── Integrations (owner-toggled connections) ─────────────────────────────────
// Catalog of connectable services the owner can switch on/off. Enabled-state is
// persisted per-tenant in Tenant.integrations (JSONB map of { slug: boolean }).
// These toggles record the tenant's INTENT to use a service — they do NOT grant
// any entitlement. In particular, the Google-group toggles (gmail/calendar/sheets)
// must NOT touch Tenant.googleIntegrationEnabled: that column is the PAID Google
// add-on entitlement gate, whose SOLE writer is the super-admin route
// POST /api/admin/tenants/:id/google-integration (routes/admin.js). Deriving it
// from a tenant-side toggle here would let a tenant self-grant the paid add-on for
// free, and let an unrelated toggle silently revoke an admin-granted entitlement.
// A tenant who flips a Google toggle on but has no admin-granted entitlement still
// hits 403 "not_enabled" at /api/integrations/google/connect (integrations.js
// requireGoogleEnabled), which re-reads googleIntegrationEnabled via the service.
const INTEGRATION_CATALOG = [
  { slug: 'gmail', label: 'Gmail', desc: 'שליחת מיילים אוטומטית מתוך השיחה', group: 'google' },
  { slug: 'calendar', label: 'Google Calendar', desc: 'תיאום פגישות ויצירת אירועים ביומן', group: 'google' },
  { slug: 'sheets', label: 'Google Sheets', desc: 'ייצוא לידים ותשובות לגיליון', group: 'google' },
  { slug: 'webhook', label: 'Webhook / CRM', desc: 'שליחת לידים ל-CRM או לכל מערכת חיצונית', group: null },
  { slug: 'calendly', label: 'Calendly', desc: 'קביעת פגישות דרך Calendly', group: null },
  { slug: 'zapier', label: 'Zapier / Make', desc: 'חיבור לאלפי אפליקציות דרך אוטומציה', group: null },
];
const CATALOG_SLUGS = new Set(INTEGRATION_CATALOG.map((i) => i.slug));

// Normalize the stored JSON (which may be null, or hold stale slugs) into a clean
// { slug: boolean } map covering exactly the current catalog.
function readIntegrations(tenant) {
  const raw = tenant?.integrations && typeof tenant.integrations === 'object' ? tenant.integrations : {};
  const out = {};
  for (const item of INTEGRATION_CATALOG) out[item.slug] = raw[item.slug] === true;
  return out;
}

// GET /api/settings/integrations → catalog + this tenant's enabled map.
router.get(
  '/integrations',
  asyncHandler(async (req, res) => {
    res.json({ catalog: INTEGRATION_CATALOG, enabled: readIntegrations(req.tenant) });
  })
);

// PUT /api/settings/integrations → { slug, enabled } toggles one connection.
router.put(
  '/integrations',
  asyncHandler(async (req, res) => {
    const slug = String(req.body?.slug || '');
    const enabled = req.body?.enabled === true;
    if (!CATALOG_SLUGS.has(slug)) return res.status(400).json({ error: 'אינטגרציה לא מוכרת' });

    const current = readIntegrations(req.tenant);
    const next = { ...current, [slug]: enabled };

    // Persist ONLY the intent map. Never derive/write googleIntegrationEnabled here —
    // that is the paid add-on entitlement, granted exclusively by the super-admin
    // route in routes/admin.js (see the block comment above). Writing it from a
    // tenant-side toggle would let a tenant self-grant the paid add-on and would let
    // an unrelated toggle clobber an admin-granted entitlement back to false.
    await prisma.tenant.update({
      where: { id: req.tenantId },
      data: { integrations: next },
    });

    res.json({ enabled: next });
  })
);

export default router;
