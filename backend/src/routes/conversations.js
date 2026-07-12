import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { trackEvent, EVENTS } from '../services/analytics.js';

const router = Router();

// Verify a conversation belongs to the caller's tenant; returns it or null.
async function ownedConversation(id, tenantId) {
  return prisma.conversation.findFirst({ where: { id, tenantId } });
}

// GET /api/conversations?status=&needsHuman=&search=&page=&pageSize=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { status, needsHuman, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const pageSize = Math.min(100, parseInt(req.query.pageSize || '25', 10));

    const where = { tenantId: req.tenantId };
    if (status) where.status = status;
    if (needsHuman !== undefined) where.needsHuman = needsHuman === 'true';
    if (search) {
      where.OR = [
        { whatsappPhone: { contains: search } },
        { customer: { name: { contains: search } } },
        { lastMessage: { contains: search } },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.findMany({
        where,
        include: { customer: true, flow: { select: { id: true, name: true } } },
        orderBy: { lastActivityAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ total, page, pageSize, items });
  })
);

// GET /api/conversations/:id — full detail incl. messages + answers
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        customer: true,
        flow: true,
        messages: { orderBy: { createdAt: 'asc' } },
        answers: { orderBy: { createdAt: 'asc' }, include: { question: true } },
      },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.json(conversation);
  })
);

// PUT /api/conversations/:id/status
router.put(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const { status, needsHuman } = req.body || {};
    const valid = ['active', 'completed', 'abandoned', 'needs_human'];
    if (status && !valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    if (!(await ownedConversation(req.params.id, req.tenantId)))
      return res.status(404).json({ error: 'Conversation not found' });
    const data = {};
    if (status) data.status = status;
    if (needsHuman !== undefined) data.needsHuman = needsHuman;
    const conversation = await prisma.conversation.update({ where: { id: req.params.id }, data });
    if (status === 'completed' || status === 'abandoned') {
      await trackEvent(EVENTS.CONVERSATION_CLOSED, {
        tenantId: req.tenantId,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        metadata: { status, by: 'admin' },
      });
    }
    res.json(conversation);
  })
);

// POST /api/conversations/:id/note  — add/replace internal note
router.post(
  '/:id/note',
  asyncHandler(async (req, res) => {
    const { note, append } = req.body || {};
    if (note === undefined) return res.status(400).json({ error: 'note is required' });
    const existing = await ownedConversation(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });
    let value = note;
    if (append) value = [existing.notes, note].filter(Boolean).join('\n');
    const conversation = await prisma.conversation.update({ where: { id: req.params.id }, data: { notes: value } });
    res.json(conversation);
  })
);

// POST /api/conversations/:id/assign-human
router.post(
  '/:id/assign-human',
  asyncHandler(async (req, res) => {
    const { assignedTo } = req.body || {};
    if (!(await ownedConversation(req.params.id, req.tenantId)))
      return res.status(404).json({ error: 'Conversation not found' });
    const conversation = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { needsHuman: true, status: 'needs_human', assignedTo: assignedTo || req.user?.email || 'human' },
    });
    await trackEvent(EVENTS.HUMAN_HANDOFF_REQUESTED, {
      tenantId: req.tenantId,
      conversationId: conversation.id,
      customerId: conversation.customerId,
      metadata: { assignedTo: conversation.assignedTo, by: 'admin' },
    });
    res.json(conversation);
  })
);

// POST /api/conversations/:id/tags
router.post(
  '/:id/tags',
  asyncHandler(async (req, res) => {
    const { tags } = req.body || {};
    if (!(await ownedConversation(req.params.id, req.tenantId)))
      return res.status(404).json({ error: 'Conversation not found' });
    const conversation = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { tags: Array.isArray(tags) ? tags : [] },
    });
    res.json(conversation);
  })
);

export default router;
