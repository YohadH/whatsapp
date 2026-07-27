import prisma from '../lib/prisma.js';
import config from '../config/index.js';
import { normalizePhone, isValidPhone } from '../lib/phone.js';
import { sendWhatsAppTemplate, sendWhatsAppMessage } from './whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { TENANT_SELECT } from '../middleware/tenant.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Meta error codes that doom every remaining recipient — quality, policy or
// template problems. One of these means the campaign must stop immediately:
// hammering on after them is exactly the behavior that gets a WABA restricted.
const ABORT_ERROR_CODES = new Set([
  132001, // template does not exist / not approved for this language
  132015, // template paused due to low quality
  132016, // template disabled
  131048, // spam rate limit hit — recipients are blocking the messages
  131031, // business account locked / restricted
  368, //    temporarily blocked for policy violations
  80007, //  WABA rate limit issues
]);

// Sample lists stored on the job row are capped so a 29k-contact job can't
// bloat a single jsonb column.
const MAX_STORED_ERRORS = 200;

// In-process stop flags for running jobs (single-process server).
const running = new Map();

export function isJobRunning(jobId) {
  return running.has(jobId);
}

// Count of a tenant's business-initiated sends in the rolling 24h window. Only
// template sends are recorded in the ledger: free-text messages only ever
// deliver inside an open 24h service window, which doesn't consume Meta's
// business-initiated conversation tier.
export async function sentInLast24h(tenantId) {
  return prisma.outboundSend.count({
    where: { tenantId, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
}

// Per-tenant cap: the tenant's configured dailyBroadcastCap (set per plan by the
// platform admin). An optional deployment-wide hard ceiling (BROADCAST_PLATFORM_MAX)
// clamps it if set, as a backstop against a misconfigured tenant.
function tenantCap(tenant) {
  const cap = tenant?.dailyBroadcastCap ?? config.broadcast.defaultDailyCap;
  return config.broadcast.platformMax ? Math.min(cap, config.broadcast.platformMax) : cap;
}

export async function quotaStatus(tenant) {
  const used = await sentInLast24h(tenant.id);
  const cap = tenantCap(tenant);
  return { cap, used, remaining: Math.max(0, cap - used) };
}

// Ask a running job to stop after the current contact. Returns true if the
// runner was signalled; false if no runner holds this job (e.g. after a server
// restart) — the caller should then just mark the row stopped in the DB.
export function signalStop(jobId) {
  const flag = running.get(jobId);
  if (!flag) return false;
  flag.stop = true;
  return true;
}

// Fire-and-forget: process a job in the background. The HTTP request that
// created the job returns immediately; the frontend polls the job row.
export function startJob(jobId) {
  if (running.has(jobId)) return;
  const flag = { stop: false };
  running.set(jobId, flag);
  runLoop(jobId, flag)
    .catch(async (err) => {
      console.error(`[broadcast] job ${jobId} crashed:`, err);
      await prisma.broadcastJob
        .update({
          where: { id: jobId },
          data: { status: 'aborted', abortReason: `שגיאה פנימית: ${err.message}` },
        })
        .catch(() => {});
    })
    .finally(() => running.delete(jobId));
}

// Server restart while a job was running leaves it 'running' in the DB with no
// runner attached. Mark such jobs stopped (their cursor is intact, so they can
// be resumed from the UI). Called once on boot.
export async function recoverOrphanJobs() {
  const { count } = await prisma.broadcastJob.updateMany({
    where: { status: 'running' },
    data: { status: 'stopped', abortReason: 'השרת הופעל מחדש — ניתן להמשיך מאיפה שנעצר' },
  });
  if (count) console.log(`[broadcast] marked ${count} orphaned job(s) as stopped`);
}

function pickFirstValue(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const value = String(candidate).trim();
    if (value) return value;
  }
  return null;
}

function renderText(message, vars) {
  let text = message;
  vars.forEach((v, i) => {
    text = text.split(`{{${i + 1}}}`).join(v ?? '');
  });
  if (vars.length) {
    text = text.split('{name}').join(vars[0] ?? '');
  }
  return text;
}

async function runLoop(jobId, flag) {
  const job = await prisma.broadcastJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'running') return;

  // EXPLICIT select (schema-drift hardening, see middleware/tenant.js TENANT_SELECT
  // + AP-T58): a bare findUnique implicitly SELECTs every schema.prisma column, so a
  // not-yet-migrated column (e.g. waPin) makes this line throw P2022 — which startJob's
  // catch silently turns into `status:'aborted'` AFTER the client already got HTTP 202.
  // TENANT_SELECT covers everything runLoop reads: tenantWhatsAppCreds() (id, waTokenEnc,
  // waPhoneNumberId, waBusinessAccountId, waApiVersion) + tenantCap() (dailyBroadcastCap)
  // + tenant.id for the per-tenant ledger/suppression queries.
  const tenant = await prisma.tenant.findUnique({ where: { id: job.tenantId }, select: TENANT_SELECT });
  if (!tenant) {
    await prisma.broadcastJob
      .update({ where: { id: jobId }, data: { status: 'aborted', abortReason: 'הלקוח לא נמצא' } })
      .catch(() => {});
    return;
  }
  const creds = tenantWhatsAppCreds(tenant);
  const cap = tenantCap(tenant);

  const contacts = Array.isArray(job.contacts) ? job.contacts : [];
  const suppressed = new Set(
    (await prisma.suppressedNumber.findMany({ where: { tenantId: tenant.id }, select: { phone: true } })).map(
      (s) => s.phone
    )
  );

  const isTemplate = job.mode === 'template';
  // Free-text sends don't consume the tier, so only template jobs draw quota.
  let remaining = isTemplate ? cap - (await sentInLast24h(tenant.id)) : Infinity;

  const counters = {
    sent: job.sent,
    failedCount: job.failedCount,
    invalidCount: job.invalidCount,
    suppressedCount: job.suppressedCount,
  };
  const failures = Array.isArray(job.failures) ? [...job.failures] : [];
  const invalid = Array.isArray(job.invalid) ? [...job.invalid] : [];
  let consecutiveFailures = 0;

  // Phones this job already delivered to, per the ledger. After a crash the
  // cursor can lag behind actual sends — never message the same person twice.
  const alreadySent = isTemplate
    ? new Set(
        (
          await prisma.outboundSend.findMany({ where: { tenantId: tenant.id, jobId }, select: { phone: true } })
        ).map((s) => s.phone)
      )
    : new Set();

  const flush = (cursor, extra = {}) =>
    prisma.broadcastJob.update({
      where: { id: jobId },
      data: {
        cursor,
        ...counters,
        failures: failures.slice(-MAX_STORED_ERRORS),
        invalid: invalid.slice(-MAX_STORED_ERRORS),
        ...extra,
      },
    });

  let i = job.cursor;
  for (; i < contacts.length; i++) {
    // Exit checks happen BEFORE processing contact i, so cursor=i lets a
    // resumed job pick up with this exact contact.
    if (flag.stop) {
      await flush(i, { status: 'stopped', abortReason: 'נעצר ידנית' });
      return;
    }
    if (remaining <= 0) {
      await flush(i, {
        status: 'quota_reached',
        abortReason: `הושגה המכסה היומית (${cap}) — ניתן להמשיך מחר`,
      });
      return;
    }

    const c = contacts[i] || {};
    const phone = normalizePhone(c.phone);

    if (!isValidPhone(phone)) {
      counters.invalidCount++;
      invalid.push({ phone: String(c.phone ?? ''), error: 'מספר לא תקין' });
    } else if (suppressed.has(phone)) {
      counters.suppressedCount++;
    } else {
      const vars = Array.isArray(c.vars) ? c.vars : [];
      try {
        if (isTemplate && alreadySent.has(phone)) {
          // Delivered before a crash (ledger row exists) while the cursor
          // lagged — count it as sent, don't message twice.
        } else if (isTemplate) {
          const headerImageLink = pickFirstValue(
            c.headerImageLink,
            c.imageUrl,
            c.image_url,
            c.image,
            job.headerImageLink
          );
          const headerImageId = pickFirstValue(c.headerImageId, c.imageId, job.headerImageId);

          // Templates with an IMAGE header require an image. Without it Meta
          // returns "(#132012) expected IMAGE, received UNKNOWN".
          if (job.requireHeaderImage && !headerImageLink && !headerImageId) {
            throw new Error('התבנית דורשת תמונת Header — יש לצרף תמונה');
          }

          await sendWhatsAppTemplate(creds, phone, job.templateName, job.languageCode, vars, {
            headerImageLink,
            headerImageId,
          });
          await prisma.outboundSend.create({ data: { tenantId: tenant.id, phone, jobId } });
          remaining--;
        } else {
          await sendWhatsAppMessage(creds, phone, renderText(job.message, vars));
        }
        counters.sent++;
        consecutiveFailures = 0;
      } catch (err) {
        counters.failedCount++;
        failures.push({ phone, error: err.message });
        consecutiveFailures++;

        if (ABORT_ERROR_CODES.has(err.code)) {
          await flush(i + 1, {
            status: 'aborted',
            abortReason: `הקמפיין נעצר אוטומטית — שגיאת איכות/מדיניות ממטא (קוד ${err.code}): ${err.message}`,
          });
          return;
        }
        if (consecutiveFailures >= config.broadcast.maxConsecutiveFailures) {
          await flush(i + 1, {
            status: 'aborted',
            abortReason: `הקמפיין נעצר אוטומטית — ${consecutiveFailures} כשלונות רצופים`,
          });
          return;
        }
      }

      await sleep(job.throttleMs);
    }

    // Persist progress after every contact — a crash may then repeat at most
    // one contact, and the ledger reconciliation above absorbs even that.
    await flush(i + 1);
  }

  await flush(i, { status: 'completed', abortReason: null });
}
