import prisma from '../lib/prisma.js';

// Seed a brand-new trial tenant with ready sample data across EVERY section so the
// owner immediately sees what the system can do during the 14-day trial — not an
// empty product. Everything is tagged/flagged `demo` where the model allows, so
// it's obviously a sample and easy to clear. Each block is independently guarded:
// one failing block never aborts the rest, and the whole thing is best-effort
// (the caller wraps it so a seed failure never blocks signup).
export async function seedTrialExample(tenantId) {
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

  // ── Example flow (תהליכים) — lead capture, off by default ──
  await safe('flow', async () => {
    await prisma.flow.create({
      data: {
        tenantId,
        name: 'דוגמה — איסוף ליד',
        description: 'תהליך לדוגמה שאפשר לערוך או למחוק. כך הסוכן אוסף פרטים מלקוח מתעניין.',
        triggerWords: ['מידע', 'פרטים', 'מעוניין'],
        finalMessage: 'תודה! קיבלנו את הפרטים ונחזור אליכם בהקדם 🙏',
        isActive: false,
        questions: {
          create: [
            { tenantId, questionText: 'שמח שפניתם אלינו! מה השם המלא שלכם?', questionType: 'text', orderIndex: 0 },
            { tenantId, questionText: 'במה נוכל לעזור לכם?', questionType: 'text', orderIndex: 1 },
            { tenantId, questionText: 'מה מספר הטלפון לחזרה?', questionType: 'phone', orderIndex: 2 },
          ],
        },
      },
    });
  });

  // ── Leads + conversations (מנהל לידים / שיחות / דאשבורד) ──
  // One detailed AI conversation (the "hero" example) + a few lighter leads with
  // varied scores/statuses so the leads board and dashboard look alive.
  await safe('conversations', async () => {
    // Hero conversation — full AI exchange.
    const hero = await prisma.customer.create({ data: { tenantId, name: 'לקוח לדוגמה', phone: '972500000001', tags: ['demo'] } });
    const heroConvo = await prisma.conversation.create({
      data: { tenantId, customerId: hero.id, whatsappPhone: hero.phone, status: 'active', tags: ['demo'], leadScore: 60 },
    });
    const script = [
      ['customer', 'היי, ראיתי אתכם ואני מעוניין במידע על השירותים שלכם'],
      ['agent', 'שלום 😊 שמח לעזור! על איזה שירות תרצו לשמוע?'],
      ['customer', 'כמה עולה ייעוץ ראשוני?'],
      ['agent', 'הייעוץ הראשוני אצלנו ללא עלות ונמשך כ-30 דקות. מתי נוח לכם שנתאם?'],
      ['customer', 'אפשר מחר בבוקר'],
      ['agent', 'מעולה! רשמתי, ונחזור אליכם לתיאום מדויק. תודה שפניתם 🙏'],
    ];
    const base = Date.now() - script.length * 60_000;
    await prisma.message.createMany({
      data: script.map(([senderType, messageText], i) => ({
        tenantId, conversationId: heroConvo.id, senderType, messageText,
        createdAt: new Date(base + i * 60_000),
        rawPayload: senderType === 'agent' ? { via: 'ai', demo: true } : { demo: true },
      })),
    });
    await prisma.conversation.update({
      where: { id: heroConvo.id },
      data: { lastMessage: script.at(-1)[1], lastActivityAt: new Date(base + script.length * 60_000) },
    });

    // Lighter leads — one message each, varied score/status.
    const leads = [
      { name: 'רות לוי', phone: '972500000002', score: 85, status: 'active', needsHuman: false, last: 'מעולה, אני רוצה להזמין 🙌', from: 'customer' },
      { name: 'משה ישראלי', phone: '972500000003', score: 45, status: 'needs_human', needsHuman: true, last: 'אפשר לדבר עם נציג אנושי?', from: 'customer' },
      { name: 'נועה ברק', phone: '972500000004', score: 20, status: 'completed', needsHuman: false, last: 'תודה רבה על השירות! 💙', from: 'customer' },
    ];
    for (let i = 0; i < leads.length; i++) {
      const l = leads[i];
      const c = await prisma.customer.create({ data: { tenantId, name: l.name, phone: l.phone, tags: ['demo'] } });
      const conv = await prisma.conversation.create({
        data: {
          tenantId, customerId: c.id, whatsappPhone: c.phone, status: l.status, leadScore: l.score,
          needsHuman: l.needsHuman, tags: ['demo'], lastMessage: l.last,
          lastActivityAt: new Date(Date.now() - (i + 1) * 3_600_000),
        },
      });
      await prisma.message.create({
        data: { tenantId, conversationId: conv.id, senderType: l.from, messageText: l.last, createdAt: new Date(Date.now() - (i + 1) * 3_600_000), rawPayload: { demo: true } },
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
