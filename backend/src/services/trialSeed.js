import prisma from '../lib/prisma.js';

// Seed a brand-new trial tenant with ONE ready-made example so the dashboards
// aren't empty during the 14-day trial — the owner immediately sees "how it
// goes": a lead-capture flow (off by default) + a short demo conversation that
// shows the AI agent handling a customer end-to-end.
//
// Everything is tagged/flagged `demo` so it's obvious it's a sample and easy to
// delete. Best-effort: callers wrap this so a seed failure never blocks signup.
export async function seedTrialExample(tenantId) {
  // 1) Example flow — lead capture. isActive:false so it never fires on a real
  // message; it's here to learn from and clone, not to run.
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

  // 2) Demo customer + conversation + a realistic back-and-forth. Agent turns carry
  // rawPayload.via='ai' so the inbox shows the "✨ סוכן AI" label, demonstrating it.
  const customer = await prisma.customer.create({
    data: { tenantId, name: 'לקוח לדוגמה', phone: '972500000001', tags: ['demo'] },
  });
  const convo = await prisma.conversation.create({
    data: { tenantId, customerId: customer.id, whatsappPhone: customer.phone, status: 'active', tags: ['demo'], leadScore: 60 },
  });

  const script = [
    ['customer', 'היי, ראיתי אתכם ואני מעוניין במידע על השירותים שלכם'],
    ['agent', 'שלום 😊 שמח לעזור! על איזה שירות תרצו לשמוע?'],
    ['customer', 'כמה עולה ייעוץ ראשוני?'],
    ['agent', 'הייעוץ הראשוני אצלנו ללא עלות ונמשך כ-30 דקות. מתי נוח לכם שנתאם?'],
    ['customer', 'אפשר מחר בבוקר'],
    ['agent', 'מעולה! רשמתי, ונחזור אליכם לתיאום מדויק. תודה שפניתם 🙏'],
  ];
  // Space the turns a minute apart, ending ~now, so ordering looks natural.
  const base = Date.now() - script.length * 60_000;
  for (let i = 0; i < script.length; i++) {
    const [senderType, text] = script[i];
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: convo.id,
        senderType,
        messageText: text,
        createdAt: new Date(base + i * 60_000),
        rawPayload: senderType === 'agent' ? { via: 'ai', demo: true } : { demo: true },
      },
    });
  }
  await prisma.conversation.update({
    where: { id: convo.id },
    data: { lastMessage: script[script.length - 1][1], lastActivityAt: new Date(base + script.length * 60_000) },
  });
}
