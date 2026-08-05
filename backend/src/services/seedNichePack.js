import prisma from '../lib/prisma.js';
import { getNichePack } from '../data/nichePacks.js';

// Seed a tenant with a NICHE starter pack (data/nichePacks.js): a written knowledge
// base + FAQ + business hours, the agent tone (customInstructions), 2–3 ready flows
// (INACTIVE), demo conversations, a demo campaign and a link — everything tailored to
// the vertical so the owner immediately sees how HeyIL works for their business.
//
// REPLACES the generic demo: this is called instead of seedTrialExample when a niche
// is chosen (niche 'other' seeds the generic pack). Best-effort + per-block guarded so
// one failure never aborts the rest; never blocks signup. Also stores Tenant.niche.
//
// Idempotency: no-ops if a demo customer already exists for the tenant (fixed demo
// phones are unique per tenant+phone), so re-running can't duplicate.
const DEMO_PHONES = ['972500000001', '972500000002', '972500000003', '972500000004'];

export async function seedNichePack(tenantId, nicheId) {
  const pack = getNichePack(nicheId);
  if (!pack) return; // unknown niche → caller falls back to the generic trial seed

  // Record the chosen niche even if a previous seed already ran.
  await prisma.tenant.update({ where: { id: tenantId }, data: { niche: pack.id } }).catch(() => {});

  const already = await prisma.customer.findFirst({
    where: { tenantId, phone: { in: DEMO_PHONES } },
    select: { id: true },
  });
  if (already) return;

  const safe = async (label, fn) => {
    try { await fn(); } catch (err) { console.error(`[seedNichePack:${nicheId}] ${label} failed:`, err.message); }
  };

  // ── Knowledge base + tone + business hours ──
  await safe('knowledgeBase', async () => {
    await prisma.knowledgeBase.update({
      where: { tenantId },
      data: {
        businessDescription: pack.kb.businessDescription || null,
        serviceInfo: pack.kb.serviceInfo || null,
        prices: pack.kb.prices || null,
        faq: pack.kb.faq || null,
        openingHours: pack.kb.openingHours || null,
        contactDetails: pack.kb.contactDetails || null,
        returnPolicy: pack.kb.returnPolicy || null,
        limitations: pack.kb.limitations || null,
        customInstructions: pack.tone || null,
        businessHours: pack.businessHours || null,
      },
    });
  });

  // ── Flows (inactive — a head start, not something that fires yet) ──
  await safe('flows', async () => {
    for (const f of pack.flows || []) {
      await prisma.flow.create({
        data: {
          tenantId,
          name: f.name,
          description: f.description || null,
          triggerWords: f.triggerWords || [],
          finalMessage: f.finalMessage || null,
          isActive: false,
          questions: {
            create: (f.questions || []).map((q, i) => ({
              tenantId,
              questionText: q.questionText,
              questionType: q.questionType || 'text',
              options: Array.isArray(q.options) ? q.options : [],
              isRequired: q.isRequired ?? true,
              orderIndex: i,
            })),
          },
        },
      });
    }
  });

  // ── Demo conversations (showcase — tagged demo, shown in the inbox) ──
  await safe('conversations', async () => {
    const HOUR = 3_600_000;
    const demos = pack.demos || [];
    for (let d = 0; d < demos.length; d++) {
      const demo = demos[d];
      const customer = await prisma.customer.create({ data: { tenantId, name: demo.name, phone: demo.phone, tags: ['demo'] } });
      const convo = await prisma.conversation.create({
        data: {
          tenantId, customerId: customer.id, whatsappPhone: demo.phone,
          status: demo.status || 'active', leadScore: demo.score || 50, needsHuman: !!demo.needsHuman, tags: ['demo'],
        },
      });
      const base = Date.now() - (d + 1) * HOUR;
      const gap = 60_000;
      await prisma.message.createMany({
        data: (demo.script || []).map(([from, text, via], i) => ({
          tenantId, conversationId: convo.id,
          senderType: from === 'agent' ? 'agent' : 'customer',
          messageText: text,
          createdAt: new Date(base + i * gap),
          rawPayload: from === 'agent' ? { via: via || 'ai', demo: true } : { demo: true },
        })),
      });
      const last = (demo.script || []).at(-1);
      await prisma.conversation.update({
        where: { id: convo.id },
        data: { lastMessage: last ? last[1] : null, lastActivityAt: new Date(base + (demo.script?.length || 0) * gap) },
      });
    }
  });

  // ── Demo broadcast campaign (so דיוור isn't empty) ──
  await safe('broadcast', async () => {
    await prisma.broadcastJob.create({
      data: { tenantId, label: pack.broadcastLabel || 'קמפיין לדוגמה', status: 'completed', mode: 'template', templateName: 'flash_sale', languageCode: 'he', contacts: [], total: 120, sent: 118, failedCount: 2 },
    });
  });

  // ── Link ──
  await safe('link', async () => {
    if (pack.link) {
      await prisma.link.create({
        data: { tenantId, name: pack.link.name, url: pack.link.url, description: pack.link.description || null, isActive: true },
      });
    }
  });
}
