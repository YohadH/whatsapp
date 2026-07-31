import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { asyncHandler } from '../middleware/error.js';
import { sheetToRows } from '../lib/sheet.js';
import { listMessageTemplates, createMessageTemplate, checkToken } from '../services/whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { normalizePhone } from '../lib/phone.js';
import prisma from '../lib/prisma.js';
import config from '../config/index.js';
import {
  startJob,
  signalStop,
  isJobRunning,
  quotaStatus,
} from '../services/broadcastRunner.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// GET /api/broadcast/token-status → read-only token validity/expiry/scopes
router.get(
  '/token-status',
  asyncHandler(async (req, res) => {
    res.json(await checkToken(tenantWhatsAppCreds(req.tenant)));
  })
);

// GET /api/broadcast/templates
// → { configured, templates:[{name,language,status,bodyText,variableCount}] }
router.get(
  '/templates',
  asyncHandler(async (req, res) => {
    const { configured, templates } = await listMessageTemplates(tenantWhatsAppCreds(req.tenant));
    res.json({ configured, templates });
  })
);

// POST /api/broadcast/templates → create a template + submit to Meta for approval.
// body: { name, category, language, bodyText, footerText?, examples? (comma string or array) }
const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'];
router.post(
  '/templates',
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    // Meta requires the name be lowercase letters/numbers/underscores only.
    const name = String(b.name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
    if (!name) return res.status(400).json({ error: 'שם תבנית נדרש (אותיות באנגלית, מספרים וקו תחתון)' });
    if (!b.bodyText || !String(b.bodyText).trim()) return res.status(400).json({ error: 'תוכן ההודעה נדרש' });

    const category = TEMPLATE_CATEGORIES.includes(b.category) ? b.category : 'UTILITY';
    const examples = Array.isArray(b.examples)
      ? b.examples
      : String(b.examples || '').split(',').map((s) => s.trim()).filter(Boolean);

    try {
      const result = await createMessageTemplate(tenantWhatsAppCreds(req.tenant), {
        name,
        category,
        language: b.language || 'he',
        bodyText: String(b.bodyText),
        footerText: b.footerText,
        examples,
      });
      res.status(201).json(result); // { id, status: 'PENDING', category }
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  })
);

// POST /api/broadcast/preview multipart "file"
// → { columns, rows, count }
router.post(
  '/preview',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    if (!sheet) {
      return res.json({ columns: [], rows: [], count: 0 });
    }

    const rows = sheetToRows(sheet);

    const columns = rows.length ? Object.keys(rows[0]) : [];

    res.json({
      columns,
      rows,
      count: rows.length,
    });
  })
);

// Keep only the fields the runner uses — CSV rows can carry arbitrary columns.
function sanitizeContact(c) {
  const out = { phone: String(c?.phone ?? ''), vars: Array.isArray(c?.vars) ? c.vars : [] };
  for (const key of ['headerImageLink', 'imageUrl', 'image_url', 'image', 'headerImageId', 'imageId']) {
    const v = c?.[key];
    if (v !== undefined && v !== null && String(v).trim()) out[key] = v;
  }
  return out;
}

// Every BroadcastJob column except `contacts` — the work list can hold tens of
// thousands of entries, and the job endpoints are polled every ~1.5s.
const JOB_PUBLIC_SELECT = {
  id: true,
  status: true,
  abortReason: true,
  mode: true,
  templateName: true,
  languageCode: true,
  message: true,
  headerImageLink: true,
  headerImageId: true,
  requireHeaderImage: true,
  throttleMs: true,
  cursor: true,
  total: true,
  sent: true,
  failedCount: true,
  invalidCount: true,
  suppressedCount: true,
  duplicatesRemoved: true,
  failures: true,
  invalid: true,
  createdAt: true,
  updatedAt: true,
};

function publicJob(job) {
  if (!job) return null;
  return { ...job, running: isJobRunning(job.id) };
}

// POST /api/broadcast/send — validates, dedups by normalized phone, creates a
// background BroadcastJob and returns 202 + { jobId } immediately. Progress is
// polled via GET /api/broadcast/jobs/:id. The runner enforces the rolling-24h
// send cap, the opt-out suppression list, and a circuit breaker that aborts
// the campaign on Meta quality/policy errors.
//
// body example for image-header template:
// {
//   "mode": "template",
//   "templateName": "israel_shiduh",
//   "languageCode": "he",
//   "headerImageLink": "https://cdn.shopify.com/your-image.jpg",
//   "contacts": [{ "phone": "0545532316", "vars": [] }]
// }
router.post(
  '/send',
  asyncHandler(async (req, res) => {
    const {
      mode = 'template',
      templateName,
      languageCode = 'he',
      message,
      contacts,
      throttleMs,

      // Global media header params
      headerImageLink,
      headerImageId,
      requireHeaderImage, // true when the chosen template has an IMAGE header
    } = req.body || {};

    if (!Array.isArray(contacts) || !contacts.length) {
      return res.status(400).json({
        error: 'contacts (non-empty array) is required',
      });
    }

    if (mode === 'template' && !templateName) {
      return res.status(400).json({
        error: 'templateName is required for template mode',
      });
    }

    if (mode === 'text' && !message) {
      return res.status(400).json({
        error: 'message is required for text mode',
      });
    }

    // Same person twice in a list doubles their odds of blocking us — dedup by
    // normalized phone. Entries that don't normalize are kept so the runner
    // reports them as invalid and the user sees them.
    const seen = new Set();
    let duplicatesRemoved = 0;
    const deduped = [];
    for (const c of contacts) {
      const normalized = normalizePhone(c?.phone);
      if (normalized) {
        if (seen.has(normalized)) {
          duplicatesRemoved++;
          continue;
        }
        seen.add(normalized);
      }
      deduped.push(sanitizeContact(c));
    }

    const job = await prisma.broadcastJob.create({
      data: {
        tenantId: req.tenantId,
        mode,
        templateName: templateName || null,
        languageCode: languageCode || null,
        message: message || null,
        headerImageLink: headerImageLink || null,
        headerImageId: headerImageId || null,
        requireHeaderImage: !!requireHeaderImage,
        // Campaigns may run slower than the safety floor, never faster.
        throttleMs: Math.max(config.broadcast.defaultThrottleMs, parseInt(throttleMs, 10) || 0),
        contacts: deduped,
        total: deduped.length,
        duplicatesRemoved,
      },
    });

    startJob(job.id);

    res.status(202).json({
      jobId: job.id,
      total: job.total,
      duplicatesRemoved,
      quota: await quotaStatus(req.tenant),
    });
  })
);

// GET /api/broadcast/quota → { cap, used, remaining } over the rolling 24h
router.get(
  '/quota',
  asyncHandler(async (req, res) => {
    res.json(await quotaStatus(req.tenant));
  })
);

// GET /api/broadcast/jobs → recent jobs, newest first (no contact lists)
router.get(
  '/jobs',
  asyncHandler(async (req, res) => {
    const jobs = await prisma.broadcastJob.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: JOB_PUBLIC_SELECT,
    });
    res.json(jobs.map(publicJob));
  })
);

// GET /api/broadcast/jobs/:id → live progress for one job
router.get(
  '/jobs/:id',
  asyncHandler(async (req, res) => {
    const job = await prisma.broadcastJob.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: JOB_PUBLIC_SELECT,
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(publicJob(job));
  })
);

// POST /api/broadcast/jobs/:id/stop — graceful stop after the current contact
router.post(
  '/jobs/:id/stop',
  asyncHandler(async (req, res) => {
    const job = await prisma.broadcastJob.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: { id: true, status: true },
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const signalled = signalStop(job.id);
    if (!signalled && job.status === 'running') {
      // No runner holds this job (e.g. it was orphaned by a restart) — mark it
      // stopped directly.
      await prisma.broadcastJob.update({
        where: { id: job.id },
        data: { status: 'stopped', abortReason: 'נעצר ידנית' },
      });
    }
    res.json({ ok: true });
  })
);

// POST /api/broadcast/jobs/:id/resume — continue from the stored cursor
router.post(
  '/jobs/:id/resume',
  asyncHandler(async (req, res) => {
    const job = await prisma.broadcastJob.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: { id: true, status: true, cursor: true, total: true },
    });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (isJobRunning(job.id)) return res.status(409).json({ error: 'Job is already running' });
    if (!['stopped', 'quota_reached', 'aborted'].includes(job.status)) {
      return res.status(400).json({ error: `Cannot resume a ${job.status} job` });
    }
    if (job.cursor >= job.total) {
      return res.status(400).json({ error: 'Job already processed all contacts' });
    }

    const updated = await prisma.broadcastJob.update({
      where: { id: job.id },
      data: { status: 'running', abortReason: null },
      select: JOB_PUBLIC_SELECT,
    });
    startJob(updated.id);
    res.json(publicJob(updated));
  })
);

export default router;