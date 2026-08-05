import prisma from '../lib/prisma.js';
import { resolveApiKey } from '../lib/apiKeys.js';

// Auth for the Agent API (routes/agent.js). A request must carry a valid, non-revoked
// API key as `Authorization: Bearer heyil_sk_…` that holds the required scope. Sets
// req.tenantId + req.apiKeyId (tenant-scoped, exactly like the key's tenant — no
// cross-tenant access possible). Usage: router.get('/leads', requireApiKey('read'), …)
export function requireApiKey(requiredScope) {
  return async (req, res, next) => {
    try {
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const key = await resolveApiKey(token);
      if (!key) return res.status(401).json({ error: 'Invalid or revoked API key' });

      const scopes = Array.isArray(key.scopes) ? key.scopes : [];
      if (requiredScope && !scopes.includes(requiredScope)) {
        return res.status(403).json({ error: `This key is missing the required scope: ${requiredScope}`, code: 'missing_scope' });
      }

      req.tenantId = key.tenantId;
      req.apiKeyId = key.id;
      req.apiKeyScopes = scopes;

      // Best-effort lastUsedAt, throttled to once/minute so a busy key isn't a write storm.
      if (!key.lastUsedAt || Date.now() - new Date(key.lastUsedAt).getTime() > 60_000) {
        prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
