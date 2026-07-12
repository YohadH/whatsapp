// LOCAL DEMO DATA GENERATOR — for the "demo" tenant only, against a LOCAL Postgres.
// Purpose: populate the product's own demo tenant ("סטודיו לדוגמה") with realistic
// 30-day activity so the admin Dashboard + Analytics render populated (not empty)
// for landing-page screenshots. This is representative DEMO data on the demo tenant,
// NOT a real customer and NOT fabricated marketing metrics.
//
// Safe to run repeatedly: it wipes prior demo activity rows for the demo tenant first.
// NEVER point this at a production DATABASE_URL — intended for localhost:5433 docker PG.
import prisma from '../src/lib/prisma.js';
import { EVENTS } from '../src/services/analytics.js';

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const daysAgo = (n, h = 10, m = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, m, 0, 0);
  return d;
};

const INTENTS = ['booking', 'pricing', 'info', 'catalog', 'support'];
const FIRST = ['דנה', 'יעל', 'נועה', 'מיכל', 'רות', 'שירה', 'תמר', 'אורית', 'ליאת', 'הדס', 'גליה', 'ענת', 'מור', 'רוני', 'אלה'];
const LAST = ['לוי', 'כהן', 'מזרחי', 'פרץ', 'ביטון', 'אברהם', 'דהן', 'חדד', 'אזולאי', 'גבאי'];

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: 'demo' } });
  if (!tenant) throw new Error('demo tenant not found — run prisma/seed.js first');
  const tenantId = tenant.id;

  const flows = await prisma.flow.findMany({ where: { tenantId }, include: { questions: { orderBy: { orderIndex: 'asc' } } } });
  const links = await prisma.link.findMany({ where: { tenantId } });
  if (!flows.length || !links.length) throw new Error('demo flows/links missing — run prisma/seed.js first');

  // ── wipe prior demo activity (keep flows/links/KB/admins) ──
  await prisma.analyticsEvent.deleteMany({ where: { tenantId } });
  await prisma.message.deleteMany({ where: { tenantId } });
  await prisma.customerAnswer.deleteMany({ where: { tenantId } });
  await prisma.conversation.deleteMany({ where: { tenantId } });
  await prisma.customer.deleteMany({ where: { tenantId } });
  await prisma.link.updateMany({ where: { tenantId }, data: { clicksCount: 0 } });

  let convTotal = 0, completedTotal = 0, leadTotal = 0, linkClicks = {};

  // Spread ~55 conversations across the last 30 days (more recent = busier).
  for (let day = 29; day >= 0; day--) {
    const perDay = day <= 6 ? rnd(2, 4) : rnd(1, 3); // busier last week
    for (let c = 0; c < perDay; c++) {
      const startH = rnd(8, 22), startM = rnd(0, 59);
      const created = daysAgo(day, startH, startM);
      const flow = pick(flows);
      const intent = pick(INTENTS);
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const phone = `+97250${rnd(1000000, 9999999)}`;

      // outcome mix: 55% completed(lead), 20% needs_human, 15% abandoned, 10% active
      const roll = Math.random();
      let status = 'active', needsHuman = false, completed = false, abandoned = false;
      if (roll < 0.55) { status = 'completed'; completed = true; }
      else if (roll < 0.75) { status = 'needs_human'; needsHuman = true; }
      else if (roll < 0.90) { status = 'abandoned'; abandoned = true; }

      const customer = await prisma.customer.create({
        data: { tenantId, name, phone, createdAt: created, updatedAt: created, tags: completed ? ['lead'] : [] },
      });
      leadTotal += 1; // every customer row is a captured lead/contact

      const conv = await prisma.conversation.create({
        data: {
          tenantId, customerId: customer.id, whatsappPhone: phone, status, intent,
          currentFlowId: flow.id, needsHuman, leadScore: completed ? rnd(60, 95) : rnd(10, 55),
          linkSent: completed, lastMessage: 'תודה!', createdAt: created, updatedAt: created, lastActivityAt: created,
        },
      });
      convTotal += 1;
      if (completed) completedTotal += 1;

      // ── messages: customer→agent pairs with realistic response deltas (2–40s) ──
      const turns = rnd(3, 6);
      let t = new Date(created);
      const msgs = [];
      for (let i = 0; i < turns; i++) {
        msgs.push({ tenantId, conversationId: conv.id, senderType: 'customer', messageText: pick(['היי, יש תור השבוע?', 'כמה עולה טיפול פנים?', 'מתי אתם פתוחים?', 'אפשר לקבוע?', 'יש חניה?']), createdAt: new Date(t) });
        t = new Date(t.getTime() + rnd(2, 40) * 1000); // agent replies within seconds
        msgs.push({ tenantId, conversationId: conv.id, senderType: 'agent', messageText: pick(['בשמחה! יש תור מחר ב-16:30', 'טיפול פנים 250 ₪', 'ראשון–חמישי 09:00–19:00', 'קבעתי לך ✅', 'יש חניון בסמוך']), createdAt: new Date(t) });
        t = new Date(t.getTime() + rnd(20, 180) * 1000);
      }
      if (needsHuman) msgs.push({ tenantId, conversationId: conv.id, senderType: 'customer', messageText: pick(['אני רוצה לדבר עם נציג', 'יש לי בעיה מיוחדת', 'זה דחוף, אפשר טלפון?']), createdAt: new Date(t) });
      await prisma.message.createMany({ data: msgs });

      // ── analytics events (funnel) ──
      const ev = [];
      const push = (eventName, extra = {}) => ev.push({ tenantId, eventName, conversationId: conv.id, customerId: customer.id, customerPhone: phone, createdAt: created, ...extra });
      push(EVENTS.CONVERSATION_STARTED);
      push(EVENTS.INTENT_DETECTED, { metadata: { intent } });
      push(EVENTS.FLOW_STARTED, { flowId: flow.id });
      // question asked/answered with drop-off on later questions
      const qs = flow.questions;
      for (let qi = 0; qi < qs.length; qi++) {
        push(EVENTS.QUESTION_ASKED, { flowId: flow.id, questionId: qs[qi].id });
        // drop-off grows with question index for non-completed convos
        const answerProb = completed ? 0.97 : Math.max(0.2, 0.85 - qi * 0.2);
        if (Math.random() < answerProb) push(EVENTS.QUESTION_ANSWERED, { flowId: flow.id, questionId: qs[qi].id });
      }
      if (completed) {
        push(EVENTS.FLOW_COMPLETED, { flowId: flow.id });
        const link = pick(links);
        push(EVENTS.LINK_SENT, { flowId: flow.id, metadata: { linkId: link.id } });
        if (Math.random() < 0.65) { push(EVENTS.LINK_CLICKED, { metadata: { linkId: link.id } }); linkClicks[link.id] = (linkClicks[link.id] || 0) + 1; }
      } else if (abandoned) {
        push(EVENTS.FLOW_ABANDONED, { flowId: flow.id });
      } else if (needsHuman) {
        push(EVENTS.HUMAN_HANDOFF_REQUESTED);
      }
      await prisma.analyticsEvent.createMany({ data: ev });
    }
  }

  // ── roll up link click counts ──
  for (const [linkId, clicks] of Object.entries(linkClicks)) {
    await prisma.link.update({ where: { id: linkId }, data: { clicksCount: clicks } });
  }

  console.log(`✅ demo data populated for tenant "${tenant.name}" (${tenant.slug})`);
  console.log(`   conversations: ${convTotal} · completed(leads): ${completedTotal} · contacts: ${leadTotal}`);
  console.log(`   link clicks: ${JSON.stringify(linkClicks)}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
