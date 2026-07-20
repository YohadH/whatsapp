import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';

// Mounted at /api — exposes both /flows* and /questions/:id paths per spec.
// Every query is scoped to req.tenantId (set by the withTenant middleware).
const router = Router();

const flowInclude = { questions: { orderBy: { orderIndex: 'asc' } }, link: true };

// ── Flows CRUD ───────────────────────────────────────────────
router.get(
  '/flows',
  asyncHandler(async (req, res) => {
    const flows = await prisma.flow.findMany({
      where: { tenantId: req.tenantId },
      include: flowInclude,
      orderBy: { createdAt: 'desc' },
    });
    res.json(flows);
  })
);

router.post(
  '/flows',
  asyncHandler(async (req, res) => {
    const { name, description, triggerWords, finalMessage, sendFinalMessage, linkId, isActive, isDefault, questions } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    // Tenant-ownership guard: a flow may only reference a Link owned by the same tenant,
    // else the outbound message would leak another tenant's URL and skew their analytics.
    if (linkId) {
      const link = await prisma.link.findFirst({ where: { id: linkId, tenantId: req.tenantId }, select: { id: true } });
      if (!link) return res.status(404).json({ error: 'Link not found' });
    }
    const flow = await prisma.flow.create({
      data: {
        tenantId: req.tenantId,
        name,
        description: description || null,
        triggerWords: Array.isArray(triggerWords) ? triggerWords : [],
        finalMessage: finalMessage || null,
        sendFinalMessage: sendFinalMessage ?? true,
        linkId: linkId || null,
        isActive: isActive ?? true,
        isDefault: isDefault ?? false,
        questions: Array.isArray(questions)
          ? {
              create: questions.map((q, i) => ({
                tenantId: req.tenantId,
                questionText: q.questionText || q.question || '',
                questionType: q.questionType || q.type || 'text',
                options: Array.isArray(q.options) ? q.options : [],
                voiceUrl: q.voiceUrl || null,
                imageUrl: q.imageUrl || null,
                isRequired: q.isRequired ?? q.required ?? true,
                orderIndex: q.orderIndex ?? i,
              })),
            }
          : undefined,
      },
      include: flowInclude,
    });
    res.status(201).json(flow);
  })
);

router.get(
  '/flows/:id',
  asyncHandler(async (req, res) => {
    const flow = await prisma.flow.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, include: flowInclude });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    res.json(flow);
  })
);

router.put(
  '/flows/:id',
  asyncHandler(async (req, res) => {
    const { name, description, triggerWords, finalMessage, sendFinalMessage, linkId, isActive, isDefault } = req.body || {};
    const owned = await prisma.flow.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, select: { id: true } });
    if (!owned) return res.status(404).json({ error: 'Flow not found' });
    // Tenant-ownership guard on the referenced Link (only when a non-null linkId is being set).
    if (linkId) {
      const link = await prisma.link.findFirst({ where: { id: linkId, tenantId: req.tenantId }, select: { id: true } });
      if (!link) return res.status(404).json({ error: 'Link not found' });
    }
    const data = {};
    if (name !== undefined) data.name = name;
    if (description !== undefined) data.description = description;
    if (triggerWords !== undefined) data.triggerWords = Array.isArray(triggerWords) ? triggerWords : [];
    if (finalMessage !== undefined) data.finalMessage = finalMessage;
    if (sendFinalMessage !== undefined) data.sendFinalMessage = sendFinalMessage;
    if (linkId !== undefined) data.linkId = linkId || null;
    if (isActive !== undefined) data.isActive = isActive;
    if (isDefault !== undefined) data.isDefault = isDefault;
    const flow = await prisma.flow.update({ where: { id: req.params.id }, data, include: flowInclude });
    res.json(flow);
  })
);

router.delete(
  '/flows/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.flow.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!count) return res.status(404).json({ error: 'Flow not found' });
    res.status(204).end();
  })
);

// ── Flow questions ───────────────────────────────────────────
router.post(
  '/flows/:id/questions',
  asyncHandler(async (req, res) => {
    const { questionText, question, questionType, type, options, voiceUrl, imageUrl, isRequired, required, orderIndex } = req.body || {};
    const flow = await prisma.flow.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, select: { id: true } });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    const count = await prisma.flowQuestion.count({ where: { flowId: req.params.id } });
    const q = await prisma.flowQuestion.create({
      data: {
        tenantId: req.tenantId,
        flowId: req.params.id,
        questionText: questionText || question || '',
        questionType: questionType || type || 'text',
        options: Array.isArray(options) ? options : [],
        voiceUrl: voiceUrl || null,
        imageUrl: imageUrl || null,
        isRequired: isRequired ?? required ?? true,
        orderIndex: orderIndex ?? count,
      },
    });
    res.status(201).json(q);
  })
);

router.put(
  '/questions/:id',
  asyncHandler(async (req, res) => {
    const { questionText, questionType, options, voiceUrl, imageUrl, isRequired, orderIndex } = req.body || {};
    const owned = await prisma.flowQuestion.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, select: { id: true } });
    if (!owned) return res.status(404).json({ error: 'Question not found' });
    const data = {};
    if (questionText !== undefined) data.questionText = questionText;
    if (questionType !== undefined) data.questionType = questionType;
    if (options !== undefined) data.options = Array.isArray(options) ? options : [];
    if (voiceUrl !== undefined) data.voiceUrl = voiceUrl || null;
    if (imageUrl !== undefined) data.imageUrl = imageUrl || null;
    if (isRequired !== undefined) data.isRequired = isRequired;
    if (orderIndex !== undefined) data.orderIndex = orderIndex;
    const q = await prisma.flowQuestion.update({ where: { id: req.params.id }, data });
    res.json(q);
  })
);

router.delete(
  '/questions/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.flowQuestion.deleteMany({ where: { id: req.params.id, tenantId: req.tenantId } });
    if (!count) return res.status(404).json({ error: 'Question not found' });
    res.status(204).end();
  })
);

router.put(
  '/flows/:id/reorder-questions',
  asyncHandler(async (req, res) => {
    const { order } = req.body || {}; // array of question ids in desired order
    if (!Array.isArray(order)) return res.status(400).json({ error: 'order (array of question ids) is required' });
    const flow = await prisma.flow.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, select: { id: true } });
    if (!flow) return res.status(404).json({ error: 'Flow not found' });
    // updateMany with the tenant guard ensures we only touch this tenant's questions.
    await prisma.$transaction(
      order.map((qid, i) =>
        prisma.flowQuestion.updateMany({ where: { id: qid, tenantId: req.tenantId }, data: { orderIndex: i } })
      )
    );
    const updated = await prisma.flow.findFirst({ where: { id: req.params.id, tenantId: req.tenantId }, include: flowInclude });
    res.json(updated);
  })
);

export default router;
