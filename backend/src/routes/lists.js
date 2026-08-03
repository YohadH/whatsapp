import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { normalizePhone, isValidPhone } from '../lib/phone.js';

// Saved recipient lists (דיוור) — reusable audiences. File parsing stays in
// /api/broadcast/preview (the frontend maps columns there and posts plain
// members here), so this router is pure CRUD + normalization.
// Mounted behind requireAuth + withTenant (app.js).
const router = Router();

const MAX_MEMBERS = 20000;

// Normalize + dedupe an incoming members payload. Invalid phones are dropped
// and reported back so the UI can say "3 שורות נפסלו".
function cleanMembers(raw) {
  const seen = new Set();
  const members = [];
  let dropped = 0;
  for (const m of Array.isArray(raw) ? raw : []) {
    const phone = normalizePhone(m?.phone);
    if (!isValidPhone(phone) || seen.has(phone)) {
      dropped += 1;
      continue;
    }
    seen.add(phone);
    members.push({
      phone,
      name: typeof m?.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 120) : null,
      vars: Array.isArray(m?.vars) ? m.vars.slice(0, 10).map((v) => String(v ?? '')) : [],
    });
    if (members.length >= MAX_MEMBERS) break;
  }
  return { members, dropped };
}

// GET /api/lists → the tenant's lists with member counts, newest-updated first.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const lists = await prisma.recipientList.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { members: true } } },
    });
    res.json(lists.map((l) => ({ id: l.id, name: l.name, count: l._count.members, updatedAt: l.updatedAt })));
  })
);

// GET /api/lists/:id → list + members (for sending / editing).
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const list = await prisma.recipientList.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: { members: { orderBy: { phone: 'asc' } } },
    });
    if (!list) return res.status(404).json({ error: 'הרשימה לא נמצאה' });
    res.json({ id: list.id, name: list.name, updatedAt: list.updatedAt, members: list.members });
  })
);

// POST /api/lists { name, members? } → create (normalized + deduped).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'שם הרשימה חסר' });
    if (name.length > 80) return res.status(400).json({ error: 'שם הרשימה ארוך מדי' });
    const { members, dropped } = cleanMembers(req.body?.members);
    const list = await prisma.recipientList.create({
      data: {
        tenantId: req.tenantId,
        name,
        members: { create: members.map((m) => ({ ...m, tenantId: req.tenantId })) },
      },
      include: { _count: { select: { members: true } } },
    });
    res.json({ id: list.id, name: list.name, count: list._count.members, dropped });
  })
);

// POST /api/lists/:id/members { members } → merge more members in (upsert-ish:
// duplicates inside the list are skipped via the [listId, phone] unique).
router.post(
  '/:id/members',
  asyncHandler(async (req, res) => {
    const list = await prisma.recipientList.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: { id: true },
    });
    if (!list) return res.status(404).json({ error: 'הרשימה לא נמצאה' });
    const { members, dropped } = cleanMembers(req.body?.members);
    const result = await prisma.recipientListMember.createMany({
      data: members.map((m) => ({ ...m, tenantId: req.tenantId, listId: list.id })),
      skipDuplicates: true,
    });
    await prisma.recipientList.update({ where: { id: list.id }, data: { updatedAt: new Date() } });
    res.json({ added: result.count, dropped });
  })
);

// PUT /api/lists/:id { name } → rename.
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'שם הרשימה חסר' });
    const updated = await prisma.recipientList.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId },
      data: { name },
    });
    if (!updated.count) return res.status(404).json({ error: 'הרשימה לא נמצאה' });
    res.json({ ok: true });
  })
);

// DELETE /api/lists/:id/members/:memberId → remove one member.
router.delete(
  '/:id/members/:memberId',
  asyncHandler(async (req, res) => {
    const del = await prisma.recipientListMember.deleteMany({
      where: { id: req.params.memberId, listId: req.params.id, tenantId: req.tenantId },
    });
    if (!del.count) return res.status(404).json({ error: 'הנמען לא נמצא' });
    res.json({ ok: true });
  })
);

// DELETE /api/lists/:id → delete the list (members cascade).
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const del = await prisma.recipientList.deleteMany({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!del.count) return res.status(404).json({ error: 'הרשימה לא נמצאה' });
    res.json({ ok: true });
  })
);

export default router;
