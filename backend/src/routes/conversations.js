import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { trackEvent, EVENTS } from '../services/analytics.js';
import { notifyOwnerHandoff } from '../services/handoffNotify.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';

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

// The reserved tag the Leads pipeline uses to mark a conversation as manually
// "engaged" (dragged into the בטיפול column). It lives in the already-migrated
// `tags` JSON column — deliberately NOT a new schema column (adding one and reading
// it via the implicit-SELECT-* routes below would throw P2022 in production until a
// live migration is owner-applied; see AP-T71 / the waPin incident) and deliberately
// NOT `linkSent` (which must stay a truthful "a real link was sent" signal — it adds
// +10 to leadScore in services/leadScore.js and drives the "נשלח קישור" UI row).
export const ENGAGED_TAG = 'pipeline:engaged';

// PUT /api/conversations/:id/status
router.put(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const { status, needsHuman, linkSent, engaged } = req.body || {};
    const valid = ['active', 'completed', 'abandoned', 'needs_human'];
    if (status && !valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const existing = await ownedConversation(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });
    const data = {};
    if (status) data.status = status;
    if (needsHuman !== undefined) data.needsHuman = needsHuman;
    // linkSent is set ONLY when a real trackable link is dispatched (conversationEngine)
    // — never as a side effect of a pipeline drag. Kept accept-able here for
    // completeness, but the Leads board no longer sends it (accept an explicit boolean
    // only; a non-boolean is ignored).
    if (typeof linkSent === 'boolean') data.linkSent = linkSent;
    // `engaged` is the distinct "manually moved into בטיפול" marker (a boolean from the
    // Leads drag handler). It toggles the ENGAGED_TAG in the existing `tags` array
    // rather than touching linkSent/leadScore, so a manual stage move never inflates the
    // score or shows a false "link sent". We merge into the current tags (preserving any
    // other tags) — this is a manual admin action, so the read-then-write here is not a
    // hot concurrency path.
    if (typeof engaged === 'boolean') {
      const current = Array.isArray(existing.tags) ? existing.tags : [];
      const withoutMarker = current.filter((t) => t !== ENGAGED_TAG);
      data.tags = engaged ? [...withoutMarker, ENGAGED_TAG] : withoutMarker;
    }
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
    const existing = await ownedConversation(req.params.id, req.tenantId);
    if (!existing) return res.status(404).json({ error: 'Conversation not found' });
    // TOCTOU-safe (AP-T72): the false→true needsHuman flip IS the notify gate. A rapid
    // customer message (conversationEngine) racing this admin action — or two admin
    // clicks — could both read needsHuman:false and both alert the owner. So detect the
    // edge with a single conditional updateMany({ where: { needsHuman: false } }): exactly
    // ONE caller gets count===1 (the winner) and notifies; the rest stay silent. The
    // status/assignedTo assignment is idempotent, so it's fine to always re-apply it.
    const flip = await prisma.conversation.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId, needsHuman: false },
      data: { needsHuman: true },
    });
    const wonFlip = flip.count === 1;
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
    // Owner handoff alert — only the caller that won the false→true flip fires it.
    if (wonFlip) {
      const customer = await prisma.customer
        .findUnique({ where: { id: conversation.customerId }, select: { name: true, phone: true } })
        .catch(() => null);
      await notifyOwnerHandoff({ tenant: req.tenant, conversation, customer });
    }
    res.json(conversation);
  })
);

// POST /api/conversations/:id/reply — a human agent sends a free-text WhatsApp
// message to the customer from the dashboard, persisted as a `human` message.
// WhatsApp only allows free-text inside the 24h customer-service window; outside
// it Meta rejects the send (#131047) and we surface a clear "use a template" hint.
router.post(
  '/:id/reply',
  asyncHandler(async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'לא ניתן לשלוח הודעה ריקה' });
    if (text.length > 4096) return res.status(400).json({ error: 'ההודעה ארוכה מדי (עד 4096 תווים)' });

    const conv = await ownedConversation(req.params.id, req.tenantId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    let waMessageId = null;
    let simulated = false;
    try {
      const result = await sendWhatsAppMessage(tenantWhatsAppCreds(req.tenant), conv.whatsappPhone, text);
      simulated = Boolean(result?.simulated);
      waMessageId = result?.messages?.[0]?.id || null;
    } catch (err) {
      // 24h-window expiry (or any Meta send error) → friendly, actionable message.
      let msg = err.message || 'שליחת ההודעה נכשלה';
      if (err.code === 131047 || /24\s*hours/i.test(msg)) {
        msg = 'עברו יותר מ-24 שעות מההודעה האחרונה של הלקוח — מחוץ לחלון הזמן אפשר לשלוח רק תבנית מאושרת (דרך "שליחה מרובה").';
      }
      return res.status(err.status || 502).json({ error: msg, code: err.code || null });
    }

    const message = await prisma.message.create({
      data: {
        tenantId: req.tenantId,
        conversationId: conv.id,
        senderType: 'human',
        messageText: text,
        waMessageId,
        // Meta accepted the send → 'sent'. Delivery/read/failed are advanced later
        // by the status webhook. Simulator mode (no live number) has no receipts.
        status: simulated ? 'simulated' : 'sent',
      },
    });
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessage: text, lastActivityAt: new Date() },
    });
    res.json({ message, simulated });
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
