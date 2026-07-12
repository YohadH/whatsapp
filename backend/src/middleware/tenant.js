import prisma from '../lib/prisma.js';

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

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
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
