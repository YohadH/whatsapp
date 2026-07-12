import prisma from '../lib/prisma.js';
import config from '../config/index.js';

// Reset each tenant's `messagesThisPeriod` counter once its usage window
// (config.usage.periodDays, default 30) has elapsed. A single updateMany zeroes
// the counter and stamps a fresh period start for every tenant whose window has
// passed. Safe to run often and idempotent (only elapsed windows match).
export async function resetElapsedPeriods(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.usage.periodDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.tenant.updateMany({
    where: { periodStartedAt: { lt: cutoff } },
    data: { messagesThisPeriod: 0, periodStartedAt: now },
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
