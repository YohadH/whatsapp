import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { encryptSecret } from '../lib/crypto.js';
import { checkToken } from '../services/whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { PLANS, isValidPlan, planEntitlements } from '../lib/plans.js';
import { connectWhatsApp, embeddedSignupPublicConfig } from '../services/embeddedSignup.js';
import { grantCredits } from '../lib/credits.js';

// Platform-owner (super_admin) routes for provisioning and managing tenants.
// Mounted at /api/admin behind requireAuth + requireSuperAdmin.
const router = Router();

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// A tenant row without secret material, plus its usage counts.
const TENANT_PUBLIC_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  waPhoneNumberId: true,
  waBusinessAccountId: true,
  waVerifyToken: true,
  waApiVersion: true,
  displayName: true,
  bioTitle: true,
  bioSubtitle: true,
  locale: true,
  currency: true,
  timezone: true,
  legalCompanyName: true,
  legalContactEmail: true,
  legalWebsiteUrl: true,
  plan: true,
  dailyBroadcastCap: true,
  monthlyMessageLimit: true,
  messagesThisPeriod: true,
  creditsUsedThisPeriod: true,
  purchasedCredits: true,
  periodStartedAt: true,
  trialEndsAt: true,
  createdAt: true,
  updatedAt: true,
};

// Expose whether a WhatsApp token is configured, never the token itself.
function publicTenant(t) {
  if (!t) return null;
  const { waTokenEnc, ...rest } = t;
  return { ...rest, waTokenConfigured: !!waTokenEnc };
}

// GET /api/admin/plans → plan catalog for the UI
router.get(
  '/plans',
  asyncHandler(async (req, res) => {
    res.json({ plans: PLANS });
  })
);

// GET /api/admin/embedded-signup/config → public params to launch the FB flow
router.get(
  '/embedded-signup/config',
  asyncHandler(async (req, res) => {
    res.json(embeddedSignupPublicConfig());
  })
);

// POST /api/admin/tenants/:id/connect-whatsapp
// Completes Meta Embedded Signup: exchanges the auth `code` for a token,
// subscribes our app to the WABA, and stores the (encrypted) credentials.
// body: { code, phoneNumberId, wabaId }
router.post(
  '/tenants/:id/connect-whatsapp',
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { code, phoneNumberId, wabaId } = req.body || {};
    // Refuse if this number already belongs to another tenant.
    if (phoneNumberId) {
      const clash = await prisma.tenant.findFirst({
        where: { waPhoneNumberId: phoneNumberId, NOT: { id: tenant.id } },
        select: { id: true },
      });
      if (clash) return res.status(409).json({ error: 'that phone_number_id is already connected to another tenant' });
    }

    let result;
    try {
      result = await connectWhatsApp({ code, phoneNumberId, wabaId });
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message });
    }

    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        waPhoneNumberId: result.phoneNumberId,
        waBusinessAccountId: result.wabaId,
        waTokenEnc: encryptSecret(result.token),
      },
      select: TENANT_PUBLIC_SELECT,
    });
    res.json({ tenant: publicTenant(updated), register: result.register });
  })
);

// GET /api/admin/tenants → all tenants + counts
router.get(
  '/tenants',
  asyncHandler(async (req, res) => {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      select: { ...TENANT_PUBLIC_SELECT, waTokenEnc: true, _count: { select: { customers: true, conversations: true, admins: true } } },
    });
    res.json(tenants.map((t) => ({ ...publicTenant(t), counts: t._count })));
  })
);

// POST /api/admin/tenants → create a tenant (+ optionally its first admin)
router.post(
  '/tenants',
  asyncHandler(async (req, res) => {
    const {
      name,
      slug,
      plan = 'trial',
      waPhoneNumberId,
      waBusinessAccountId,
      waToken,
      waVerifyToken,
      waApiVersion,
      displayName,
      bioTitle,
      bioSubtitle,
      locale,
      currency,
      timezone,
      legalCompanyName,
      legalContactEmail,
      legalWebsiteUrl,
      admin, // optional { email, name, password }
    } = req.body || {};

    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!isValidPlan(plan)) return res.status(400).json({ error: `unknown plan "${plan}"` });

    const finalSlug = slugify(slug || name) || `t-${crypto.randomBytes(3).toString('hex')}`;
    if (await prisma.tenant.findUnique({ where: { slug: finalSlug }, select: { id: true } })) {
      return res.status(409).json({ error: `slug "${finalSlug}" is taken` });
    }
    if (waPhoneNumberId) {
      const clash = await prisma.tenant.findUnique({ where: { waPhoneNumberId }, select: { id: true } });
      if (clash) return res.status(409).json({ error: 'that WhatsApp phone_number_id is already assigned to another tenant' });
    }

    const ent = planEntitlements(plan);
    const tenant = await prisma.tenant.create({
      data: {
        name,
        slug: finalSlug,
        plan,
        dailyBroadcastCap: ent.dailyBroadcastCap,
        monthlyMessageLimit: ent.monthlyMessageLimit,
        waPhoneNumberId: waPhoneNumberId || null,
        waBusinessAccountId: waBusinessAccountId || null,
        waTokenEnc: waToken ? encryptSecret(waToken) : null,
        waVerifyToken: waVerifyToken || null,
        waApiVersion: waApiVersion || undefined,
        displayName: displayName || null,
        bioTitle: bioTitle || null,
        bioSubtitle: bioSubtitle || null,
        locale: locale || undefined,
        currency: currency || undefined,
        timezone: timezone || undefined,
        legalCompanyName: legalCompanyName || null,
        legalContactEmail: legalContactEmail || null,
        legalWebsiteUrl: legalWebsiteUrl || null,
        // Give every tenant its own knowledge-base row up front.
        knowledgeBase: { create: {} },
      },
      select: TENANT_PUBLIC_SELECT,
    });

    let createdAdmin = null;
    if (admin?.email && admin?.password) {
      const passwordHash = await bcrypt.hash(admin.password, 10);
      const user = await prisma.adminUser.create({
        data: {
          tenantId: tenant.id,
          email: String(admin.email).toLowerCase(),
          name: admin.name || name,
          passwordHash,
          role: 'admin',
          mustResetPassword: true,
        },
        select: { id: true, email: true, name: true, role: true, tenantId: true },
      });
      createdAdmin = user;
    }

    res.status(201).json({ tenant: publicTenant(tenant), admin: createdAdmin });
  })
);

// GET /api/admin/tenants/:id
router.get(
  '/tenants/:id',
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.params.id },
      select: { ...TENANT_PUBLIC_SELECT, waTokenEnc: true },
    });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(publicTenant(tenant));
  })
);

// PUT /api/admin/tenants/:id → update branding / creds / plan / status
router.put(
  '/tenants/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: 'Tenant not found' });

    const b = req.body || {};
    const data = {};
    for (const f of [
      'name', 'waBusinessAccountId', 'waVerifyToken', 'waApiVersion',
      'displayName', 'bioTitle', 'bioSubtitle', 'locale', 'currency', 'timezone',
      'legalCompanyName', 'legalContactEmail', 'legalWebsiteUrl',
    ]) {
      if (b[f] !== undefined) data[f] = b[f] || null;
    }
    if (b.status !== undefined) {
      if (!['active', 'suspended', 'trial'].includes(b.status)) return res.status(400).json({ error: 'invalid status' });
      data.status = b.status;
    }
    if (b.slug !== undefined) {
      const s = slugify(b.slug);
      const clash = await prisma.tenant.findFirst({ where: { slug: s, NOT: { id: req.params.id } }, select: { id: true } });
      if (clash) return res.status(409).json({ error: `slug "${s}" is taken` });
      data.slug = s;
    }
    if (b.waPhoneNumberId !== undefined) {
      if (b.waPhoneNumberId) {
        const clash = await prisma.tenant.findFirst({
          where: { waPhoneNumberId: b.waPhoneNumberId, NOT: { id: req.params.id } },
          select: { id: true },
        });
        if (clash) return res.status(409).json({ error: 'phone_number_id already assigned to another tenant' });
      }
      data.waPhoneNumberId = b.waPhoneNumberId || null;
    }
    // Only re-encrypt when a new token is actually supplied.
    if (b.waToken) data.waTokenEnc = encryptSecret(b.waToken);
    if (b.waToken === null || b.waToken === '') data.waTokenEnc = null;

    if (b.plan !== undefined) {
      if (!isValidPlan(b.plan)) return res.status(400).json({ error: `unknown plan "${b.plan}"` });
      data.plan = b.plan;
      // Applying a plan resets entitlements unless caps are explicitly overridden below.
      const ent = planEntitlements(b.plan);
      data.dailyBroadcastCap = ent.dailyBroadcastCap;
      data.monthlyMessageLimit = ent.monthlyMessageLimit;
    }
    if (b.dailyBroadcastCap !== undefined) data.dailyBroadcastCap = parseInt(b.dailyBroadcastCap, 10) || 0;
    if (b.monthlyMessageLimit !== undefined) data.monthlyMessageLimit = parseInt(b.monthlyMessageLimit, 10) || 0;

    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data, select: TENANT_PUBLIC_SELECT });
    res.json(publicTenant(tenant));
  })
);

// POST /api/admin/tenants/:id/verify-credentials → live check of the WA token
router.post(
  '/tenants/:id/verify-credentials',
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(await checkToken(tenantWhatsAppCreds(tenant)));
  })
);

// POST /api/admin/tenants/:id/credits → grant/adjust AI credits (top-up stand-in
// until the Israeli payment gateway is wired). body: { amount, reason? }
router.post(
  '/tenants/:id/credits',
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const amt = parseInt(req.body?.amount, 10);
    if (!Number.isInteger(amt) || amt === 0) {
      return res.status(400).json({ error: 'amount must be a non-zero integer' });
    }
    const state = await grantCredits({
      tenantId: tenant.id,
      amount: amt,
      type: amt > 0 ? 'topup' : 'adjust',
      reason: req.body?.reason || 'manual_grant',
    });
    res.json(state);
  })
);

// GET /api/admin/credit-purchases?status=pending → credit-pack purchases across all
// tenants (for manual approval until a payment gateway is wired).
router.get(
  '/credit-purchases',
  asyncHandler(async (req, res) => {
    const status = req.query.status || 'pending';
    const purchases = await prisma.creditPurchase.findMany({
      where: status === 'all' ? {} : { status: String(status) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { tenant: { select: { id: true, name: true, slug: true } } },
    });
    res.json(purchases);
  })
);

// POST /api/admin/credit-purchases/:id/mark-paid → confirm payment + grant the credits.
router.post(
  '/credit-purchases/:id/mark-paid',
  asyncHandler(async (req, res) => {
    const purchase = await prisma.creditPurchase.findUnique({ where: { id: req.params.id } });
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    if (purchase.status === 'paid') return res.status(409).json({ error: 'already paid' });

    // Grant the credits, then flip the purchase to paid (in that order so a failed
    // grant leaves the purchase pending rather than paid-but-not-credited).
    await grantCredits({
      tenantId: purchase.tenantId,
      amount: purchase.credits,
      type: 'topup',
      reason: purchase.packId,
    });
    const updated = await prisma.creditPurchase.update({
      where: { id: purchase.id },
      data: { status: 'paid', paidAt: new Date(), providerRef: req.body?.ref || 'manual' },
    });
    res.json(updated);
  })
);

// ── Tenant admin users ───────────────────────────────────────
router.get(
  '/tenants/:id/admins',
  asyncHandler(async (req, res) => {
    const admins = await prisma.adminUser.findMany({
      where: { tenantId: req.params.id },
      select: { id: true, email: true, name: true, role: true, mustResetPassword: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(admins);
  })
);

router.post(
  '/tenants/:id/admins',
  asyncHandler(async (req, res) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true, name: true } });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    const { email, name, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
    const exists = await prisma.adminUser.findUnique({ where: { email: String(email).toLowerCase() }, select: { id: true } });
    if (exists) return res.status(409).json({ error: 'a user with that email already exists' });
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.adminUser.create({
      data: {
        tenantId: tenant.id,
        email: String(email).toLowerCase(),
        name: name || tenant.name,
        passwordHash,
        role: 'admin',
        mustResetPassword: true,
      },
      select: { id: true, email: true, name: true, role: true, tenantId: true, mustResetPassword: true },
    });
    res.status(201).json(user);
  })
);

export default router;
