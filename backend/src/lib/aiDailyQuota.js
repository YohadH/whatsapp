import prisma from './prisma.js';

// Free automatic-AI replies per tenant per day. The first N AI replies each day cost
// no credit; beyond that the normal AI-credit billing (lib/credits.js) applies. Only
// platform-key tenants are metered — BYO-key tenants pay their own provider.
export const FREE_DAILY_AI_REPLIES = 10;

// yyyy-mm-dd in Israel time — the day boundary for the free quota. Using a stable
// TZ (not the server's) means the reset lands at Israel midnight regardless of where
// the process runs. en-CA formats as yyyy-mm-dd.
export function israelDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
}

// How many free AI replies this tenant has used TODAY (0 on a new day). Read-only —
// derives from the tenant row already loaded (no DB hit). Used for the allow gate and
// the super-admin usage view.
export function repliesToday(tenant, now = new Date()) {
  if (!tenant) return 0;
  return tenant.aiDailyDate === israelDay(now) ? tenant.aiDailyCount || 0 : 0;
}

// Is there still a free slot today? (read-only)
export function hasFreeQuotaToday(tenant, now = new Date()) {
  return repliesToday(tenant, now) < FREE_DAILY_AI_REPLIES;
}

// Consume ONE free daily AI reply. Returns true if the reply was free (a slot was
// available and is now taken), false if today's free quota is exhausted (the caller
// should fall through to paid credits). Concurrency-safe via conditional updateMany:
//  1) roll the day over (reset the counter) when the stored date isn't today — the
//     OR keeps it NULL-safe (a bare `not: today` misses NULL rows under SQL 3-valued
//     logic, same trap guarded in services/usageReset.js);
//  2) increment only while still under the cap for today, so two concurrent replies
//     can never push the counter past the cap.
export async function consumeDailyFreeReply(tenantId, now = new Date()) {
  const today = israelDay(now);
  await prisma.tenant.updateMany({
    where: { id: tenantId, OR: [{ aiDailyDate: null }, { aiDailyDate: { not: today } }] },
    data: { aiDailyDate: today, aiDailyCount: 0 },
  });
  const res = await prisma.tenant.updateMany({
    where: { id: tenantId, aiDailyDate: today, aiDailyCount: { lt: FREE_DAILY_AI_REPLIES } },
    data: { aiDailyCount: { increment: 1 } },
  });
  return res.count === 1;
}
