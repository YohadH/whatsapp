// Concurrency test for markLowCreditNudge TOCTOU fix (AP-T72).
// Proves the OLD read-then-write pattern double-fires (returns true 2x) under a
// Promise.all race, while the NEW atomic conditional updateMany returns true
// exactly once. Runs against the live DB on a throwaway tenant, cleaned up by id.
//
// Run from the backend package root:  node scripts/toctou-lowcredit-nudge-test.mjs
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { markLowCreditNudge } from '../src/lib/credits.js';

const prisma = new PrismaClient();

// OLD (buggy) implementation — read-then-write, exactly as it was before the fix.
async function markLowCreditNudge_OLD(tenantId) {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { lowCreditNotifiedAt: true },
  });
  if (t?.lowCreditNotifiedAt) return false;
  await prisma.tenant
    .update({ where: { id: tenantId }, data: { lowCreditNotifiedAt: new Date() } })
    .catch(() => {});
  return true;
}

const CONCURRENCY = 8;
let created = [];

async function makeTenant(tag) {
  const t = await prisma.tenant.create({
    data: {
      name: `TOCTOU-nudge-${tag}-${Date.now()}`,
      slug: `toctou-nudge-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      lowCreditNotifiedAt: null,
    },
    select: { id: true },
  });
  created.push(t.id);
  return t.id;
}

async function run(fn, tenantId) {
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => fn(tenantId).catch((e) => ({ err: e.message })))
  );
  const wins = results.filter((r) => r === true).length;
  const errs = results.filter((r) => r && r.err).length;
  return { wins, errs, results };
}

(async () => {
  try {
    // 1) OLD pattern — expect >1 winner (race not guarded) at least sometimes.
    const oldId = await makeTenant('old');
    const oldRun = await run(markLowCreditNudge_OLD, oldId);
    const oldRow = await prisma.tenant.findUnique({ where: { id: oldId }, select: { lowCreditNotifiedAt: true } });
    console.log(`OLD read-then-write:  winners=${oldRun.wins} (errs=${oldRun.errs})  set=${!!oldRow.lowCreditNotifiedAt}`);

    // 2) NEW atomic conditional — expect exactly 1 winner.
    const newId = await makeTenant('new');
    const newRun = await run(markLowCreditNudge, newId);
    const newRow = await prisma.tenant.findUnique({ where: { id: newId }, select: { lowCreditNotifiedAt: true } });
    console.log(`NEW atomic updateMany: winners=${newRun.wins} (errs=${newRun.errs})  set=${!!newRow.lowCreditNotifiedAt}`);

    // 3) Idempotency: a late call on the already-flipped NEW tenant must return false.
    const late = await markLowCreditNudge(newId);
    console.log(`NEW late call (already flipped): returned=${late} (expected false)`);

    const oldRaced = oldRun.wins > 1;
    const newSingle = newRun.wins === 1 && late === false;
    console.log('');
    console.log(`RESULT: OLD double-fired=${oldRaced ? 'YES (race is real)' : 'no (not reproduced this run)'}, NEW single-winner=${newSingle ? 'YES' : 'NO'}`);
    if (!newSingle) process.exitCode = 1;
  } catch (e) {
    console.error('TEST ERROR:', e.message);
    process.exitCode = 2;
  } finally {
    if (created.length) {
      await prisma.tenant.deleteMany({ where: { id: { in: created } } });
      console.log(`cleaned up ${created.length} throwaway tenant(s)`);
    }
    await prisma.$disconnect();
  }
})();
