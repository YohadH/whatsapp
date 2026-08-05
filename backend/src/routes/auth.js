import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import prisma from '../lib/prisma.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { planEntitlements } from '../lib/plans.js';
import { seedTrialExample } from '../services/trialSeed.js';
import { seedNichePack } from '../services/seedNichePack.js';
import { isValidNiche } from '../data/nichePacks.js';

const router = Router();

// Self-service trial length. A new business that registers itself gets a 14-day
// trial: plan/status='trial' + trialEndsAt set this far out.
const TRIAL_DAYS = 14;

function slugify(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// POST /api/auth/register { businessName, email, password, ownerName? }
// PUBLIC self-service signup. Creates a fresh tenant on the trial plan (with a
// 14-day trialEndsAt) plus its owner AdminUser, then returns a JWT so the client
// logs straight in and lands on onboarding. No WhatsApp creds yet — those are
// connected during onboarding. Rate-limited at the app level (authLimiter).
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { businessName, email, password, ownerName, niche } = req.body || {};
    const name = String(businessName || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const nicheId = isValidNiche(niche) ? niche : null;

    if (!name || !cleanEmail || !password) {
      return res.status(400).json({ error: 'שם העסק, אימייל וסיסמה נדרשים' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: 'כתובת אימייל לא תקינה' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'הסיסמה חייבת להכיל לפחות 8 תווים' });
    }

    const existing = await prisma.adminUser.findUnique({ where: { email: cleanEmail }, select: { id: true } });
    if (existing) return res.status(409).json({ error: 'כבר קיים חשבון עם כתובת האימייל הזו' });

    // Derive a unique slug from the business name; append a short random suffix on
    // collision (bounded retries) so signup never fails on a name clash.
    const base = slugify(name) || 'עסק';
    let slug = base;
    for (let i = 0; i < 6; i++) {
      const clash = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });
      if (!clash) break;
      slug = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    }

    const ent = planEntitlements('trial');
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

    const tenant = await prisma.tenant.create({
      data: {
        name,
        slug,
        plan: 'trial',
        status: 'trial',
        trialEndsAt,
        dailyBroadcastCap: ent.dailyBroadcastCap,
        monthlyMessageLimit: ent.monthlyMessageLimit,
        niche: nicheId,
        // Every tenant gets its own knowledge-base row up front (same as admin-provisioned).
        knowledgeBase: { create: {} },
      },
      select: { id: true, trialEndsAt: true },
    });

    const user = await prisma.adminUser.create({
      data: {
        tenantId: tenant.id,
        email: cleanEmail,
        name: (ownerName && String(ownerName).trim()) || name,
        passwordHash: await bcrypt.hash(password, 10),
        role: 'admin',
        // They just chose their own password — no forced reset (unlike admin-provisioned).
        mustResetPassword: false,
      },
      select: { id: true, email: true, name: true, role: true, tenantId: true, mustResetPassword: true },
    });

    // Seed a ready starter so the trial isn't empty. A chosen niche gets its tailored
    // pack (KB + flows + demos + tone + integration hints); otherwise the generic
    // example. Best-effort — a seed failure must never block signup.
    try {
      if (nicheId) await seedNichePack(tenant.id, nicheId);
      else await seedTrialExample(tenant.id);
    } catch (err) {
      console.error('[register] starter seed failed:', err.message);
    }

    const token = signToken({ sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    res.status(201).json({ token, user, trialEndsAt: tenant.trialEndsAt });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = await prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = signToken({ sub: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        mustResetPassword: user.mustResetPassword,
      },
    });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.adminUser.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId,
      mustResetPassword: user.mustResetPassword,
    });
  })
);

// POST /api/auth/change-password { currentPassword, newPassword }
// Verifies the current password, sets the new one, clears mustResetPassword.
router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'הסיסמה החדשה חייבת להכיל לפחות 8 תווים' });
    }
    const user = await prisma.adminUser.findUnique({ where: { id: req.user.sub } });
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return res.status(401).json({ error: 'הסיסמה הנוכחית שגויה' });
    }
    await prisma.adminUser.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 10), mustResetPassword: false },
    });
    res.json({ ok: true });
  })
);

export default router;
