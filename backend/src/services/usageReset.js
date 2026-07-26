import prisma from '../lib/prisma.js';
import config from '../config/index.js';

// Reset each tenant's per-period counters once its usage window
// (config.usage.periodDays, default 30) has elapsed. Zeroes the message counter AND
// the monthly AI-credit usage (which re-grants the plan's monthly allotment), clears
// any low-credit nudge, and stamps a fresh period start for every tenant whose window
// has passed. Safe to run often and idempotent (only elapsed windows match).
export async function resetElapsedPeriods(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.usage.periodDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.tenant.updateMany({
    where: { periodStartedAt: { lt: cutoff } },
    data: { messagesThisPeriod: 0, creditsUsedThisPeriod: 0, lowCreditNotifiedAt: null, periodStartedAt: now },
  });
  if (count) console.log(`[usage] reset monthly counter for ${count} tenant(s)`);
  return count;
}

// Run at boot and every `intervalHours` after. Returns the timer so callers can
// clear it (tests/shutdown). Failures are logged, never thrown.
export function startUsageResetScheduler(intervalHours = 6) {
  const tick = () => resetElapsedPeriods().catch((err) => console.error('[usage] reset failed:', err.message));
  tick();
  const timer = setInterval(tick, intervalHours * 60 * 60 * 1000);
  timer.unref?.(); // don't keep the process alive just for this
  return timer;
}
