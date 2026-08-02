import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { UPLOADS_ROOT } from '../services/media.js';

// Tenant-scoped expense book — receipts captured over WhatsApp by the owner
// (services/receipts.js). Mounted behind requireAuth + withTenant in app.js.
const router = Router();

// GET /api/expenses?month=YYYY-MM → rows (newest first) + totals for the range.
// Undated rows (extraction couldn't read a date) fall back to their createdAt.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(req.query.month || ''));
    let where = { tenantId: req.tenantId };
    if (m) {
      const from = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
      const to = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
      where = {
        tenantId: req.tenantId,
        OR: [
          { expenseDate: { gte: from, lt: to } },
          { expenseDate: null, createdAt: { gte: from, lt: to } },
        ],
      };
    }
    const items = await prisma.expense.findMany({
      where,
      orderBy: [{ expenseDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
    });
    const totals = items.reduce(
      (acc, e) => {
        acc.total += e.total ? Number(e.total) : 0;
        acc.vat += e.vatAmount ? Number(e.vatAmount) : 0;
        if (e.status === 'needs_review') acc.needsReview += 1;
        return acc;
      },
      { total: 0, vat: 0, needsReview: 0, count: items.length }
    );
    res.json({ items, totals });
  })
);

// PUT /api/expenses/:id → owner corrections (vendor/amounts/date/category/status).
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: 'Expense not found' });

    const b = req.body || {};
    const data = {};
    if ('vendor' in b) data.vendor = String(b.vendor || '').trim() || null;
    if ('category' in b) data.category = String(b.category || '').trim() || null;
    if ('summary' in b) data.summary = String(b.summary || '').trim() || null;
    for (const k of ['total', 'vatAmount']) {
      if (k in b) {
        const n = b[k] === null || b[k] === '' ? null : Number(b[k]);
        if (n !== null && (!Number.isFinite(n) || n < 0)) {
          return res.status(400).json({ error: 'סכום לא תקין' });
        }
        data[k] = n;
      }
    }
    if ('expenseDate' in b) {
      if (!b.expenseDate) data.expenseDate = null;
      else {
        const d = new Date(String(b.expenseDate) + 'T00:00:00Z');
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'תאריך לא תקין' });
        data.expenseDate = d;
      }
    }
    // Any manual edit clears the review flag unless explicitly kept.
    data.status = b.status === 'needs_review' ? 'needs_review' : 'parsed';

    const updated = await prisma.expense.update({ where: { id: existing.id }, data });
    res.json(updated);
  })
);

// DELETE /api/expenses/:id — removes the row and its cached image file.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const existing = await prisma.expense.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: { id: true, imagePath: true },
    });
    if (!existing) return res.status(404).json({ error: 'Expense not found' });
    await prisma.expense.delete({ where: { id: existing.id } });
    if (existing.imagePath) {
      const abs = path.resolve(UPLOADS_ROOT, existing.imagePath);
      // Never follow a stored path outside the uploads root.
      if (abs.startsWith(UPLOADS_ROOT)) fs.promises.unlink(abs).catch(() => {});
    }
    res.json({ ok: true });
  })
);

// GET /api/expenses/:id/image → the cached receipt photo.
router.get(
  '/:id/image',
  asyncHandler(async (req, res) => {
    const e = await prisma.expense.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: { imagePath: true },
    });
    if (!e?.imagePath) return res.status(404).json({ error: 'אין תמונה לקבלה זו' });
    const abs = path.resolve(UPLOADS_ROOT, e.imagePath);
    if (!abs.startsWith(UPLOADS_ROOT) || !fs.existsSync(abs)) {
      return res.status(404).json({ error: 'קובץ התמונה לא נמצא' });
    }
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(abs);
  })
);

export default router;
