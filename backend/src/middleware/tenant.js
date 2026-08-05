import prisma from '../lib/prisma.js';

// EXPLICIT column projection for the Tenant record that withTenant() loads and
// attaches to every tenant-scoped request. This is deliberately NOT a select-all.
//
// WHY (schema-drift hardening — 3rd occurrence of this failure class, see
// decisions/lessons-learned.md AP-T58/AP-T64, BUG-WA-002): a bare
// `findUnique({ where:{id} })` implicitly selects EVERY column declared in
// schema.prisma. If schema.prisma declares a column that has not actually been
// migrated onto the live DB yet, that select-all makes Prisma request the
// missing column and every tenant-scoped route 500s across the board (P2022).
// By listing only the columns that withTenant() and its downstream callers
// actually read, a not-yet-migrated column added to schema.prisma cannot take
// down the whole tenant surface — the new column is simply not requested until a
// caller (and this list) is updated to use it, which is a code change, not a
// silent runtime break.
//
// EVERY field here is read by a withTenant()-mounted consumer. When you add a
// field, confirm (a) it is live-migrated (backend/prisma/migrations/), and (b) a
// caller actually needs it. Consumers and the fields they read:
//   - withTenant() itself ................ id, status
//   - tenantWhatsAppCreds() (lib/tenantContext.js) . id, waTokenEnc,
//         waPhoneNumberId, waBusinessAccountId, waApiVersion
//   - settings.js GET /whatsapp .......... waPhoneNumberId, waBusinessAccountId,
//         waApiVersion, waTokenEnc
//   - quotaStatus()/tenantCap() (broadcastRunner.js) . id, dailyBroadcastCap
//   - creditsState() (lib/credits.js) .... monthlyMessageLimit,
//         creditsUsedThisPeriod, purchasedCredits
//   - credits.js GET / .................... periodStartedAt
//   - handleIncomingMessage() (conversationEngine.js, via /simulate) . id,
//         lowCreditNotifiedAt
// All columns below are present in migration 0_init / 1_credits (verified live).
export const TENANT_SELECT = {
  id: true,
  status: true,
  waPhoneNumberId: true,
  waBusinessAccountId: true,
  waTokenEnc: true,
  waApiVersion: true,
  dailyBroadcastCap: true,
  monthlyMessageLimit: true,
  creditsUsedThisPeriod: true,
  purchasedCredits: true,
  periodStartedAt: true,
  lowCreditNotifiedAt: true,
  integrations: true, // owner-toggled connections map (read in routes/settings.js)
  integrationConfig: true, // webhook/zapier connection config (read in routes/settings.js)
  niche: true, // business vertical → per-niche integration recommendations (routes/settings.js)
  ownerPhone: true, // owner-recognition for the receipts pipeline (services/receipts.js)
  timezone: true, // out-of-hours schedule evaluation (conversationEngine)
  aiProvider: true, // BYO-AI (dormant until configured)
  aiApiKeyEnc: true,
  aiModel: true,
};

// Resolve the active tenant for a request and attach `req.tenant` / `req.tenantId`.
// Must run AFTER requireAuth.
//
//  - A tenant admin/agent is locked to their own `req.user.tenantId`.
//  - A super_admin has no tenant of their own; to use tenant-scoped dashboards
//    they "act as" a tenant by passing the `X-Tenant-Id` header (or ?tenantId=).
//
// Every tenant-scoped admin route mounts this, so route handlers can trust
// `req.tenantId` and filter all queries by it.
export async function withTenant(req, res, next) {
  try {
    const user = req.user || {};
    let tenantId = user.tenantId || null;

    if (!tenantId && user.role === 'super_admin') {
      tenantId = req.header('X-Tenant-Id') || req.query.tenantId || null;
    }

    if (!tenantId) {
      return res.status(400).json({
        error: 'No tenant selected. Super admins must pass an X-Tenant-Id header.',
      });
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: TENANT_SELECT });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    // A non-super-admin bound to a different tenant must never reach another's data.
    if (user.role !== 'super_admin' && user.tenantId !== tenant.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (tenant.status === 'suspended' && user.role !== 'super_admin') {
      return res.status(403).json({ error: 'This account is suspended. Contact support.' });
    }

    req.tenant = tenant;
    req.tenantId = tenant.id;
    next();
  } catch (err) {
    next(err);
  }
}
