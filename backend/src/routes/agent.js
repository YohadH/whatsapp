import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { requireApiKey } from '../middleware/apiKeyAuth.js';
import { normalizePhone } from '../lib/phone.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';

// External-agent API. Every route is authed by an API key (Authorization: Bearer
// heyil_sk_…) scoped to ONE tenant, and gated on a scope. Mounted at /api/agent
// behind a dedicated rate limiter (app.js). This is the surface an owner's local
// Claude (ops / data-sync) talks to — never the DB, never the login.
const router = Router();

// ── Reads (scope: read) ──────────────────────────────────────────────────────

// GET /api/agent/leads?status=&limit= — conversations with lead info (test threads excluded).
router.get(
  '/leads',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const where = { tenantId: req.tenantId, isTest: false };
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.needsHuman !== undefined) where.needsHuman = req.query.needsHuman === 'true';
    const items = await prisma.conversation.findMany({
      where,
      orderBy: { lastActivityAt: 'desc' },
      take: limit,
      select: {
        id: true, whatsappPhone: true, status: true, leadScore: true, needsHuman: true,
        lastMessage: true, lastActivityAt: true, tags: true,
        customer: { select: { name: true, phone: true } },
      },
    });
    res.json({ items, count: items.length });
  })
);

// GET /api/agent/conversations/:id — the thread + its messages.
router.get(
  '/conversations/:id',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      select: { id: true, whatsappPhone: true, status: true, leadScore: true, needsHuman: true, lastActivityAt: true, customer: { select: { name: true, phone: true } } },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const messages = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      select: { senderType: true, messageText: true, createdAt: true },
    });
    res.json({ conversation, messages });
  })
);

// GET /api/agent/campaigns — broadcast jobs.
router.get(
  '/campaigns',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const items = await prisma.broadcastJob.findMany({
      where: { tenantId: req.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, label: true, status: true, total: true, sent: true, failedCount: true, createdAt: true },
    });
    res.json({ items });
  })
);

// GET /api/agent/knowledge-base — the tenant's knowledge base.
router.get(
  '/knowledge-base',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const kb = await prisma.knowledgeBase.findUnique({ where: { tenantId: req.tenantId } });
    res.json(kb || {});
  })
);

// GET /api/agent/expenses — the expense book.
router.get(
  '/expenses',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const items = await prisma.expense.findMany({
      where: { tenantId: req.tenantId },
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      select: { vendor: true, total: true, currency: true, category: true, summary: true, expenseDate: true },
    });
    res.json({ items });
  })
);

// ── Write (scope: write:messaging) ───────────────────────────────────────────

// POST /api/agent/messages { phone, text } — send a WhatsApp message to a customer.
// Records it on the customer's thread and sends via the tenant's WhatsApp (or logs
// in simulator mode when no number is connected).
router.post(
  '/messages',
  requireApiKey('write:messaging'),
  asyncHandler(async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const text = String(req.body?.text || '').trim();
    if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
    if (text.length > 4096) return res.status(400).json({ error: 'text too long' });

    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: { id: true, waTokenEnc: true, waPhoneNumberId: true, waBusinessAccountId: true, waApiVersion: true },
    });
    const creds = tenantWhatsAppCreds(tenant);

    // Record on the customer's single thread (create the customer/thread if new).
    const customer = await prisma.customer.upsert({
      where: { tenantId_phone: { tenantId: req.tenantId, phone } },
      update: {},
      create: { tenantId: req.tenantId, phone },
    });
    let convo = await prisma.conversation.findFirst({
      where: { tenantId: req.tenantId, customerId: customer.id },
      orderBy: { lastActivityAt: 'desc' },
      select: { id: true },
    });
    if (!convo) {
      convo = await prisma.conversation.create({
        data: { tenantId: req.tenantId, customerId: customer.id, whatsappPhone: phone, status: 'active' },
        select: { id: true },
      });
    }
    await prisma.message.create({
      data: { tenantId: req.tenantId, conversationId: convo.id, senderType: 'agent', messageText: text, rawPayload: { via: 'api' } },
    });
    await prisma.conversation.update({ where: { id: convo.id }, data: { lastMessage: text, lastActivityAt: new Date() } });

    let result;
    try {
      result = await sendWhatsAppMessage(creds, phone, text);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
    res.json({ ok: true, phone, conversationId: convo.id, simulated: !!result?.simulated });
  })
);

export default router;
