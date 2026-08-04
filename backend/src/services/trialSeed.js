import prisma from '../lib/prisma.js';

// Seed a brand-new trial tenant with ready sample data across EVERY section so the
// owner immediately sees what the system can do during the 14-day trial — not an
// empty product. Everything is tagged/flagged `demo` where the model allows, so
// it's obviously a sample and easy to clear. Each block is independently guarded:
// one failing block never aborts the rest, and the whole thing is best-effort
// (the caller wraps it so a seed failure never blocks signup).
// Demo customers are keyed by these fixed phones; a Customer is unique per
// (tenantId, phone), so re-running can never create a second copy.
const DEMO_PHONES = ['972500000001', '972500000002', '972500000003', '972500000004'];

export async function seedTrialExample(tenantId) {
  // Idempotency guard: if the demo already exists for this tenant, do nothing —
  // so calling the seed more than once (register + a manual backfill) never
  // produces duplicate demo conversations for the same phone number.
  const already = await prisma.customer.findFirst({
    where: { tenantId, phone: { in: DEMO_PHONES } },
    select: { id: true },
  });
  if (already) return;

  const safe = async (label, fn) => {
    try { await fn(); } catch (err) { console.error(`[trialSeed] ${label} failed:`, err.message); }
  };

  // ── Knowledge base (מאגר ידע) — example content the agent answers from ──
  await safe('knowledgeBase', async () => {
    await prisma.knowledgeBase.update({
      where: { tenantId },
      data: {
        businessDescription: 'אנחנו עסק שנותן שירות ומוכר מוצרים ללקוחות. (טקסט לדוגמה — עדכנו אותו כך שישקף את העסק שלכם.)',
        serviceInfo: 'שירות אישי, זמינות גבוהה, ומענה מהיר בוואטסאפ.',
        prices: 'ייעוץ ראשוני — ללא עלות. חבילות בתשלום מ-₪199.',
        faq: 'ש: מה שעות הפעילות? ת: א׳–ה׳ 09:00–17:00.\nש: האם יש משלוחים? ת: כן, לכל הארץ, 3–5 ימי עסקים.',
        openingHours: 'א׳–ה׳ 09:00–17:00, ו׳ 09:00–13:00',
        contactDetails: 'טלפון: 03-0000000 · מייל: hello@example.com',
        businessHours: { enabled: true, days: [0, 1, 2, 3, 4], open: '09:00', close: '17:00', awayMessage: 'תודה על פנייתכם! אנחנו זמינים א׳–ה׳ 09:00–17:00 ונחזור אליכם בהקדם 🙏' },
      },
    });
  });

  // ── Example flow (תהליכים) — appointment booking, matches the demo
  // conversation below. Off by default; the owner clones/edits it. ──
  await safe('flow', async () => {
    await prisma.flow.create({
      data: {
        tenantId,
        name: 'קביעת תור — דוגמה',
        description: 'תהליך לדוגמה שאפשר לערוך או למחוק. כך הסוכן מתאם תור אוטומטית מול הלקוח.',
        triggerWords: ['תור', 'לקבוע', 'פגישה', 'זימון'],
        finalMessage: 'מעולה! נאשר את התור ונשלח לכם תזכורת לפני המועד 📌',
        isActive: false,
        questions: {
          create: [
            { tenantId, questionText: 'בשמחה! לאיזה שירות תרצו לקבוע תור?', questionType: 'text', orderIndex: 0 },
            { tenantId, questionText: 'מתי נוח לכם? (יום ושעה מועדפים)', questionType: 'text', orderIndex: 1 },
            { tenantId, questionText: 'מה השם המלא?', questionType: 'text', orderIndex: 2 },
            { tenantId, questionText: 'מספר טלפון ליצירת קשר', questionType: 'phone', orderIndex: 3 },
          ],
        },
      },
    });
  });

  // ── Leads + conversations (מנהל לידים / שיחות / דאשבורד) ──
  // Four demo conversations, each SHOWCASING a distinct capability so the owner
  // sees what the app does: a structured flow, AI answering from the knowledge
  // base, a handoff to a human, and the out-of-hours auto-reply. Agent turns carry
  // `via` so the inbox shows the right label (via:'ai' → ✨ סוכן AI, else → 🤖 בוט).
  await safe('conversations', async () => {
    const AWAY = 'תודה על פנייתכם! אנחנו זמינים א׳–ה׳ 09:00–17:00 ונחזור אליכם בהקדם 🙏';
    const HOUR = 3_600_000;
    // spec: { name, phone, score, status, needsHuman?, minutesGap, script:[[from,text,via?]] }
    const demos = [
      {
        // 1) FLOW in action — appointment booking (🤖 בוט / via:'flow').
        name: 'לקוח לדוגמה', phone: '972500000001', score: 70, status: 'active', startAgo: 6 * HOUR, gap: 60_000,
        script: [
          ['customer', 'היי, אפשר לקבוע תור?'],
          ['agent', 'בשמחה! לאיזה שירות תרצו לקבוע תור?', 'flow'],
          ['customer', 'תספורת וסידור זקן'],
          ['agent', 'מתי נוח לכם? (יום ושעה מועדפים)', 'flow'],
          ['customer', 'יום חמישי אחרי 17:00'],
          ['agent', 'מה השם המלא?', 'flow'],
          ['customer', 'לקוח לדוגמה'],
          ['agent', 'מספר טלפון ליצירת קשר', 'flow'],
          ['customer', '050-1234567'],
          ['agent', 'מעולה! נאשר את התור ונשלח לכם תזכורת לפני המועד 📌', 'flow'],
        ],
      },
      {
        // 2) AI answering from the KNOWLEDGE BASE (✨ סוכן AI / via:'ai').
        name: 'רות לוי', phone: '972500000002', score: 85, status: 'active', startAgo: 5 * HOUR, gap: 90_000,
        script: [
          ['customer', 'שלום, כמה עולה ייעוץ אצלכם ומה שעות הפעילות?'],
          ['agent', 'שלום 😊 הייעוץ הראשוני אצלנו ללא עלות (כ-30 דקות), וחבילות בתשלום מ-₪199. אנחנו זמינים א׳–ה׳ 09:00–17:00 ובשישי עד 13:00.', 'ai'],
          ['customer', 'מעולה, אני רוצה להזמין 🙌'],
          ['agent', 'יופי! אפשר לתאם עכשיו — לאיזה יום ושעה נוח לכם?', 'ai'],
        ],
      },
      {
        // 3) HANDOFF to a human (needs_human → ממתין לנציג).
        name: 'משה ישראלי', phone: '972500000003', score: 50, status: 'needs_human', needsHuman: true, startAgo: 3 * HOUR, gap: 60_000,
        script: [
          ['customer', 'יש לי בעיה מורכבת עם הזמנה קודמת — אפשר לדבר עם נציג אנושי?'],
          ['agent', 'בהחלט 🙌 אני מעביר אתכם לנציג/ה מהצוות — הם יחזרו אליכם בהקדם עם פתרון.', 'ai'],
        ],
      },
      {
        // 4) OUT-OF-HOURS auto-reply (🤖 בוט / via:'rules').
        name: 'נועה ברק', phone: '972500000004', score: 20, status: 'active', startAgo: 12 * HOUR, gap: 60_000,
        script: [
          ['customer', 'היי, אתם זמינים עכשיו? 🌙'],
          ['agent', AWAY, 'rules'],
        ],
      },
    ];

    for (const d of demos) {
      const customer = await prisma.customer.create({ data: { tenantId, name: d.name, phone: d.phone, tags: ['demo'] } });
      const convo = await prisma.conversation.create({
        data: {
          tenantId, customerId: customer.id, whatsappPhone: customer.phone,
          status: d.status, leadScore: d.score, needsHuman: !!d.needsHuman, tags: ['demo'],
        },
      });
      const base = Date.now() - d.startAgo;
      await prisma.message.createMany({
        data: d.script.map(([from, text, via], i) => ({
          tenantId, conversationId: convo.id, senderType: from === 'agent' ? 'agent' : 'customer', messageText: text,
          createdAt: new Date(base + i * d.gap),
          rawPayload: from === 'agent' ? { via: via || 'ai', demo: true } : { demo: true },
        })),
      });
      await prisma.conversation.update({
        where: { id: convo.id },
        data: { lastMessage: d.script.at(-1)[1], lastActivityAt: new Date(base + d.script.length * d.gap) },
      });
    }
  });

  // ── Expenses (הוצאות) — a couple of parsed receipts ──
  await safe('expenses', async () => {
    await prisma.expense.createMany({
      data: [
        { tenantId, vendor: 'ספקי הדפוס בע״מ', total: 340.0, currency: 'ILS', category: 'ציוד וחומרים', summary: 'הזמנת חומרי הדפסה (דוגמה)', expenseDate: new Date(Date.now() - 3 * 86_400_000), status: 'parsed' },
        { tenantId, vendor: 'חברת חשמל', total: 212.5, currency: 'ILS', category: 'חשבונות', summary: 'חשבון חשמל דו-חודשי (דוגמה)', expenseDate: new Date(Date.now() - 10 * 86_400_000), status: 'parsed' },
      ],
    });
  });

  // ── Broadcast campaign (דיוור) — one completed example in the history ──
  await safe('broadcast', async () => {
    await prisma.broadcastJob.create({
      data: {
        tenantId, label: 'מבצע לדוגמה — השקה', status: 'completed', mode: 'template',
        templateName: 'flash_sale', languageCode: 'he',
        contacts: [], total: 120, sent: 118, failedCount: 2,
      },
    });
  });

  // ── Link (מאגר ידע וקישורים) — one shareable link ──
  await safe('link', async () => {
    await prisma.link.create({
      data: { tenantId, name: 'קביעת פגישה (דוגמה)', url: 'https://example.com/booking', description: 'קישור לתיאום פגישה — ערכו או מחקו.', isActive: true },
    });
  });
}
