import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import prisma from '../lib/prisma.js';
import config from '../config/index.js';
import { asyncHandler } from '../middleware/error.js';
import { encryptSecret } from '../lib/crypto.js';
import { checkToken, finalizeWhatsAppConnection } from '../services/whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { PLANS, isValidPlan, planEntitlements } from '../lib/plans.js';
import { connectWhatsApp, embeddedSignupPublicConfig } from '../services/embeddedSignup.js';
import { grantCredits, creditsState } from '../lib/credits.js';
import { repliesToday, FREE_DAILY_AI_REPLIES } from '../lib/aiDailyQuota.js';
import { invalidatePlatformPipelineCache } from '../lib/platformPipeline.js';
import { TENANT_SELECT } from '../middleware/tenant.js';

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

// GET /api/admin/ai-usage → every customer's AI activation + today's free-reply usage.
// Powers the Tenants admin page columns and the Agent Console's super-admin view.
router.get(
  '/ai-usage',
  asyncHandler(async (req, res) => {
    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, plan: true, status: true,
        aiEnabled: true, aiDailyCount: true, aiDailyDate: true,
        aiProvider: true, aiApiKeyEnc: true,
        monthlyMessageLimit: true, creditsUsedThisPeriod: true, purchasedCredits: true,
        _count: { select: { conversations: true } },
      },
    });
    const items = tenants.map((t) => {
      const byo = Boolean(t.aiProvider && t.aiApiKeyEnc);
      return {
        id: t.id,
        name: t.name,
        plan: t.plan,
        status: t.status,
        aiEnabled: t.aiEnabled !== false,
        mode: byo ? 'own-key' : 'platform', // own-key tenants aren't metered by the daily cap
        usedToday: repliesToday(t),
        dailyLimit: FREE_DAILY_AI_REPLIES,
        creditsAvailable: byo ? null : creditsState(t).available,
        conversations: t._count.conversations,
      };
    });
    // AI-on first, then heaviest users first — the ones worth watching float to the top.
    items.sort((a, b) => Number(b.aiEnabled) - Number(a.aiEnabled) || b.usedToday - a.usedToday);
    res.json({ items, dailyLimit: FREE_DAILY_AI_REPLIES });
  })
);

// GET /api/admin/platform-pipeline → the CENTRAL local-Claude pipeline config (the one
// brain that answers every opted-in customer without their own AI key).
router.get(
  '/platform-pipeline',
  asyncHandler(async (req, res) => {
    const row = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
    res.json({ enabled: !!row?.replyEnabled, url: row?.replyUrl || '', hasSecret: !!row?.replySecretEnc });
  })
);

// PUT /api/admin/platform-pipeline { enabled, url, secret? } → set the central pipeline.
// Secret is optional on update (keep the stored one if omitted); stored encrypted.
router.put(
  '/platform-pipeline',
  asyncHandler(async (req, res) => {
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const data = { replyEnabled: enabled, replyUrl: url || null };
    const rawSecret = typeof req.body?.secret === 'string' ? req.body.secret.trim() : '';
    if (rawSecret) data.replySecretEnc = encryptSecret(rawSecret);
    const row = await prisma.platformConfig.upsert({
      where: { id: 'singleton' },
      update: data,
      create: { id: 'singleton', ...data },
    });
    invalidatePlatformPipelineCache(); // so the change takes effect on the next reply
    res.json({ enabled: row.replyEnabled, url: row.replyUrl || '', hasSecret: !!row.replySecretEnc });
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

    // Trim stray whitespace on IDs — a pasted trailing space breaks Graph API calls.
    if (typeof data.waBusinessAccountId === 'string') data.waBusinessAccountId = data.waBusinessAccountId.trim() || null;
    if (typeof data.waPhoneNumberId === 'string') data.waPhoneNumberId = data.waPhoneNumberId.trim() || null;

    const tenant = await prisma.tenant.update({ where: { id: req.params.id }, data, select: TENANT_PUBLIC_SELECT });

    // When a token was just set, complete the connection like Embedded Signup does:
    // register the number for Cloud API + subscribe our app to its WABA's webhooks.
    // Best-effort and non-blocking — the save succeeds regardless.
    if (b.waToken && tenant.waPhoneNumberId) {
      // GRACEFUL DEGRADATION (schema-drift): this block re-fetches the FULL tenant
      // row to read `waPin` (needed to reuse the 2-step PIN for Meta re-registration).
      // Unlike the other fixes in the drift-hardening chain, this one CANNOT be fixed
      // with an explicit `select` — `waPin` (migration 3_tenant_wa_pin) is genuinely
      // absent from the live DB, so selecting it explicitly still throws P2022. The
      // read below runs directly in the handler body (not inside the fire-and-forget
      // .then()), so an unguarded throw here would surface as a plain 500 via
      // asyncHandler — AFTER the primary tenant.update() at :287 already committed.
      // That gave admins a spurious 500 on an ordinary "set/rotate WhatsApp token"
      // action even though their change had saved. We therefore wrap the waPin
      // re-fetch + Meta-finalize in try/catch: on ANY failure (the missing-column
      // P2022 or otherwise) we log and skip the finalize step, and still return the
      // success response built from the tenant row that WAS saved at :287. Applying
      // the migration (task whatsapp-agent-bug-wa-schema-drift-wapin-p0) is the real
      // fix that lets this block run; this is only the crash-safety net until then.
      try {
        const full = await prisma.tenant.findUnique({ where: { id: tenant.id } });
        // Reuse the tenant's stored 2-step PIN so Meta accepts re-registration; if it
        // has none, finalize generates one and we persist it for next time.
        const existingPin = full.waPin || undefined;
        finalizeWhatsAppConnection(tenantWhatsAppCreds(full), { existingPin })
          .then(async (r) => {
            if (!r.register.ok && !r.register.skipped) console.warn('[admin] number register failed:', r.register.error);
            if (!r.subscribe.ok && !r.subscribe.skipped) console.warn('[admin] WABA subscribe failed:', r.subscribe.error);
            // Persist a freshly-generated PIN so future re-registrations reuse it.
            // Only write when we didn't already have one and register succeeded.
            //
            // CONCURRENCY (fixes the last-write-wins waPin race): two simultaneous
            // "connect tenant" PUTs for the same tenant can each generate a DIFFERENT
            // PIN, send it to Meta, and — with an unconditional update — both overwrite
            // waPin (last-write-wins), so the stored PIN can end up NOT matching the one
            // Meta actually accepted, with no self-correction path. Mirror the TOCTOU
            // guard from mark-paid (commit 2d5b9b3): a conditional updateMany that only
            // writes when waPin IS STILL null lets Postgres serialize the row write —
            // exactly one concurrent caller wins (count 1) and its PIN sticks; every
            // other caller sees count 0 and leaves the winner's PIN untouched. Since
            // finalize reuses an already-stored PIN when one exists, whichever PIN wins
            // the DB write is the one that was (or will be, on retry) registered with
            // Meta — the stored value can no longer diverge from what Meta holds.
            if (!full.waPin && r.register.ok && r.register.pin) {
              const persisted = await prisma.tenant
                .updateMany({
                  where: { id: full.id, waPin: null },
                  data: { waPin: r.register.pin },
                })
                .catch((e) => {
                  console.warn('[admin] persist waPin failed:', e.message);
                  return { count: 0 };
                });
              if (persisted.count === 0) {
                // Another concurrent connect already set waPin first (or it was set
                // between our read and this write). Skip — do NOT overwrite the winner's
                // PIN; that value is the authoritative one for future re-registration.
                console.warn(
                  '[admin] waPin already set by a concurrent connect for tenant',
                  full.id,
                  '— keeping the existing PIN, not overwriting.'
                );
              }
            }
          })
          .catch((e) => console.warn('[admin] finalize connection error:', e.message));
      } catch (e) {
        // Missing-column P2022 (waPin not yet migrated live) or any other failure in
        // the waPin re-fetch / Meta-finalize block. The primary tenant.update() at
        // :287 already succeeded, so we do NOT let this discard the saved change:
        // log, skip the (best-effort) Meta re-registration, and fall through to the
        // normal success response below.
        console.warn('[admin] skipped WhatsApp finalize after token update (waPin re-fetch failed):', e.message);
      }
    }
    res.json(publicTenant(tenant));
  })
);

// POST /api/admin/tenants/:id/verify-credentials → live check of the WA token
router.post(
  '/tenants/:id/verify-credentials',
  asyncHandler(async (req, res) => {
    // Explicit projection (schema-drift hardening — see middleware/tenant.js
    // TENANT_SELECT). Avoids select-all requesting a declared-but-unmigrated
    // column (e.g. Tenant.waPin, migration 3_tenant_wa_pin) and 500ing. This
    // handler only needs the WhatsApp creds for checkToken(), which TENANT_SELECT
    // covers (waTokenEnc/waPhoneNumberId/waBusinessAccountId/waApiVersion) and
    // which deliberately excludes waPin. NOTE: the direct waPin lookup in the
    // PUT /tenants/:id finalize block is intentionally left select-all — it needs
    // waPin, so no select can fix it; it is instead wrapped in try/catch there to
    // degrade gracefully until migration 3_tenant_wa_pin is applied live (a separate
    // owner-gated concern).
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: TENANT_SELECT });
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
//
// CONCURRENCY (fixes the TOCTOU double-credit race): the old code did a read
// (findUnique) → guard (status === 'paid') → grant → write (update). Under
// Postgres' default Read Committed isolation, two concurrent calls for the same
// purchase.id (admin double-click, two open tabs, a webhook retry) could both read
// status:'pending', both pass the guard, and both call grantCredits() — crediting
// the tenant twice for one real payment. CreditPurchase.status has no unique/
// conditional DB constraint to catch it.
//
// The fix mirrors chargeAiCredit(): make the status flip itself the atomic gate.
// A single conditional UPDATE ... WHERE id = ? AND status <> 'paid' lets Postgres
// serialize the row write — exactly one concurrent caller sees 1 affected row (it
// "won the race"), every other sees 0. We only grant credits on the winning call.
// The flip, the grant, and the ledger row all live in ONE transaction, so a crash
// between the flip and the grant can't leave the purchase paid-but-not-credited
// (the whole transaction rolls back together).
router.post(
  '/credit-purchases/:id/mark-paid',
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    const providerRef = req.body?.ref || 'manual';

    const outcome = await prisma.$transaction(async (tx) => {
      // Atomic gate: flip pending → paid only if not already paid. The affected-row
      // count tells us whether THIS call won the race (1) or lost it / already paid (0).
      const flip = await tx.creditPurchase.updateMany({
        where: { id, status: { not: 'paid' } },
        data: { status: 'paid', paidAt: new Date(), providerRef },
      });

      if (flip.count !== 1) {
        // 0 rows: either the purchase doesn't exist, or it was already paid (a
        // concurrent caller won, or a prior mark-paid). Distinguish for the response;
        // in NEITHER case do we grant credits again.
        const existing = await tx.creditPurchase.findUnique({ where: { id } });
        if (!existing) return { code: 404, body: { error: 'Purchase not found' } };
        return { code: 409, body: { error: 'already paid' } };
      }

      // We won the race → grant the credits in the SAME transaction. Inlined (rather
      // than calling grantCredits, which opens its own transaction) so the balance
      // increment + ledger row are atomic with the status flip.
      const purchase = await tx.creditPurchase.findUnique({ where: { id } });
      await tx.tenant.update({
        where: { id: purchase.tenantId },
        data: { purchasedCredits: { increment: purchase.credits } },
      });
      await tx.creditTransaction.create({
        data: { tenantId: purchase.tenantId, type: 'topup', amount: purchase.credits, reason: purchase.packId },
      });
      return { code: 200, body: purchase };
    });

    res.status(outcome.code).json(outcome.body);
  })
);

// ── Per-tenant margin: revenue proxy vs Meta cost vs OpenAI cost ─────────────
// GET /api/admin/margin?month=YYYY-MM  (defaults to the current calendar month)
//
// The super-admin margin view (system-gap-analysis §2.7 + §4 / CREDITS_DESIGN §6):
// per tenant, per month, show the three cost/revenue legs so real margin is visible:
//   • revenueCredits — credits CHARGED this month (debit ledger rows, |amount|). A
//     revenue PROXY: 1 debited credit ≈ 1 handled conversation the tenant paid for.
//     (True revenue in currency depends on the tenant's plan/pack price; wired when
//     pack pricing is finalized — §2.3. Credits charged is the honest available proxy.)
//   • metaCostCents — sum of MetaCostEntry.costEstimateCents (Meta's own per-conversation
//     cost, estimated from the config rate card). `metaCostPlaceholder`=true means the
//     rate card is uncalibrated (owner hasn't entered real Meta numbers) → do NOT read the
//     Meta cost as real money yet.
//   • openAiCost — NOT tracked in this codebase as a monetary cost. We DO record
//     per-message OpenAI TOKENS on the credit ledger (CreditTransaction.tokensIn/Out), so
//     we surface summed tokens as a proxy, but there is no $/token cost table → openAiCostCents
//     is null and openAiCostTracked=false. This is a known gap, not a fabricated number.
router.get(
  '/margin',
  asyncHandler(async (req, res) => {
    // Resolve the month window [start, nextMonthStart).
    const monthStr = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : null;
    const now = new Date();
    const start = monthStr
      ? new Date(`${monthStr}-01T00:00:00.000Z`)
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const month = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`;

    const tenants = await prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, slug: true, plan: true, currency: true },
    });

    // Revenue proxy: credits DEBITED (AI replies charged) per tenant this month.
    const debits = await prisma.creditTransaction.groupBy({
      by: ['tenantId'],
      where: { type: 'debit', createdAt: { gte: start, lt: end } },
      _sum: { amount: true, tokensIn: true, tokensOut: true },
      _count: { _all: true },
    });
    const debitByTenant = Object.fromEntries(
      debits.map((d) => [
        d.tenantId,
        {
          creditsCharged: Math.abs(d._sum.amount || 0),
          chargeCount: d._count._all,
          tokensIn: d._sum.tokensIn || 0,
          tokensOut: d._sum.tokensOut || 0,
        },
      ])
    );

    // Meta cost: sum of estimated conversation cost per tenant this month. Table may not
    // be migrated live yet → degrade to zeros (metaCostTracked=false) rather than 500.
    let metaByTenant = {};
    let metaCostTracked = true;
    try {
      const metaAgg = await prisma.metaCostEntry.groupBy({
        by: ['tenantId'],
        where: { createdAt: { gte: start, lt: end } },
        _sum: { costEstimateCents: true },
        _count: { _all: true },
      });
      // Whether any entry in the window is a placeholder (uncalibrated rate card).
      const placeholderAgg = await prisma.metaCostEntry.groupBy({
        by: ['tenantId'],
        where: { createdAt: { gte: start, lt: end }, placeholder: true },
        _count: { _all: true },
      });
      const placeholderCount = Object.fromEntries(placeholderAgg.map((p) => [p.tenantId, p._count._all]));
      metaByTenant = Object.fromEntries(
        metaAgg.map((m) => [
          m.tenantId,
          {
            metaCostCents: m._sum.costEstimateCents || 0,
            metaEvents: m._count._all,
            metaCostPlaceholder: (placeholderCount[m.tenantId] || 0) > 0,
          },
        ])
      );
    } catch (err) {
      const code = err?.code || err?.meta?.code;
      if (code === 'P2021' || code === 'P2022' || code === '42P01' || code === '42703') {
        metaCostTracked = false; // MetaCostEntry not migrated live yet
      } else {
        throw err;
      }
    }

    const rows = tenants.map((t) => {
      const rev = debitByTenant[t.id] || { creditsCharged: 0, chargeCount: 0, tokensIn: 0, tokensOut: 0 };
      const meta = metaByTenant[t.id] || { metaCostCents: 0, metaEvents: 0, metaCostPlaceholder: false };
      return {
        tenantId: t.id,
        name: t.name,
        slug: t.slug,
        plan: t.plan,
        currency: t.currency,
        // Revenue proxy (credits charged this month).
        creditsCharged: rev.creditsCharged,
        chargeCount: rev.chargeCount,
        // Meta cost (estimated, in cents of config.metaPricing.currency).
        metaCostCents: meta.metaCostCents,
        metaEvents: meta.metaEvents,
        metaCostPlaceholder: meta.metaCostPlaceholder,
        // OpenAI: tokens only (no monetary cost table in this codebase — known gap).
        openAiTokensIn: rev.tokensIn,
        openAiTokensOut: rev.tokensOut,
        openAiCostCents: null,
      };
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.creditsCharged += r.creditsCharged;
        acc.metaCostCents += r.metaCostCents;
        acc.openAiTokensIn += r.openAiTokensIn;
        acc.openAiTokensOut += r.openAiTokensOut;
        return acc;
      },
      { creditsCharged: 0, metaCostCents: 0, openAiTokensIn: 0, openAiTokensOut: 0 }
    );

    res.json({
      month,
      currency: config.metaPricing?.currency || 'USD',
      metaCostTracked,
      // True when the rate card is a placeholder (all-0/uncalibrated) → the Meta cost
      // numbers are structurally 0 and must not be read as real money.
      metaRateCardPlaceholder: config.metaPricing?.placeholder !== false,
      openAiCostTracked: false, // no $/token cost table in this codebase (documented gap)
      rows,
      totals,
    });
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

// ── Google integration add-on (paid, OFF by default) ─────────────────────────
// POST /api/admin/tenants/:id/google-integration  body: { enabled: true|false }
// The super-admin flips the per-tenant flag when a customer buys/cancels the
// Gmail+Calendar add-on. Uses raw SQL so it is drift-safe: if migration
// 5_google_integration is not applied to the live DB yet, this returns 503
// "not_migrated" (a clear ops signal) instead of a 500 — mirroring the service
// layer's graceful degradation (AP-T71). Never exposes tokens.
router.post(
  '/tenants/:id/google-integration',
  asyncHandler(async (req, res) => {
    const existing = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: 'Tenant not found' });
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    try {
      await prisma.$executeRaw`
        UPDATE "Tenant" SET "googleIntegrationEnabled" = ${enabled} WHERE "id" = ${req.params.id}`;
    } catch (err) {
      const msg = String(err?.message || '');
      if (err?.code === 'P2022' || err?.code === '42703' || /column .*does not exist/i.test(msg)) {
        return res.status(503).json({
          error: 'Google integration columns are not migrated on this database yet (apply migration 5_google_integration).',
          code: 'not_migrated',
        });
      }
      throw err;
    }
    res.json({ id: req.params.id, googleIntegrationEnabled: enabled });
  })
);

export default router;
