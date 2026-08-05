import prisma from './prisma.js';
import { decryptSecret } from './crypto.js';
import { replyProviderConfig } from '../services/replyProvider.js';

// The central local-Claude pipeline (PlatformConfig singleton). Cached briefly so the
// hot message path doesn't hit the DB every reply, but short enough that the owner can
// update the tunnel URL and see it take effect within ~30s (no redeploy).
const CACHE_MS = 30000;
let _cache = { at: 0, cfg: null };

export function invalidatePlatformPipelineCache() {
  _cache = { at: 0, cfg: null };
}

// Returns { url, secret, enabled:true, source:'platform' } when the platform pipeline is
// configured + enabled, else null.
export async function getPlatformPipeline() {
  const now = Date.now();
  if (now - _cache.at < CACHE_MS) return _cache.cfg;
  let cfg = null;
  try {
    const row = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } });
    if (row?.replyEnabled && row.replyUrl) {
      cfg = {
        url: row.replyUrl,
        secret: row.replySecretEnc ? decryptSecret(row.replySecretEnc) : null,
        enabled: true,
        source: 'platform',
      };
    }
  } catch {
    cfg = null; // table not migrated / DB blip → behave as "no platform pipeline"
  }
  _cache = { at: now, cfg };
  return cfg;
}

// The effective reply provider for a tenant, in priority order:
//   1) the tenant's OWN reply-provider (if they configured one), else
//   2) the platform default pipeline.
// Returns a provider cfg { url, secret, timeoutMs, consultOn, enabled, source } or null.
// (BYO AI-key tenants are handled earlier in the engine and never reach here.)
export async function effectiveReplyProvider(tenant) {
  const own = replyProviderConfig(tenant);
  if (own) return { ...own, enabled: true, source: 'tenant' };
  const plat = await getPlatformPipeline();
  // 90s timeout: the central brain may run Claude via the local CLI (subscription) which
  // takes ~10–40s/reply — well under Cloudflare's ~100s tunnel limit.
  if (plat) return { url: plat.url, secret: plat.secret, timeoutMs: 90000, consultOn: 'always', enabled: true, source: 'platform' };
  return null;
}
