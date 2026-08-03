// Curated Hebrew FLOW starters. A flow is a sequence of questions the agent asks
// a customer over WhatsApp. Picking a template pre-fills the flow editor (name,
// trigger words, closing message, questions) — the owner tweaks and saves via the
// normal /api/flows path. The phone preview is generated from `questions` (each
// question renders as an agent bubble; its `sample` renders as the customer's
// reply) so the preview reads like a real, coherent conversation.
export const FLOW_TEMPLATE_CATEGORIES = [
  { id: 'all', label: 'הכל' },
  { id: 'lead', label: 'לידים ומכירות' },
  { id: 'booking', label: 'תורים ופגישות' },
  { id: 'service', label: 'שירות ותמיכה' },
  { id: 'ecommerce', label: 'הזמנות' },
];

// Each template → a Flow shape the editor understands:
//   { name, description, triggerWords[], finalMessage,
//     questions[{ questionText, questionType, options?, isRequired?, sample }] }
// `sample` is preview-only (a plausible customer answer); it is NOT persisted.
export const FLOW_TEMPLATES = [
  {
    key: 'lead_capture',
    title: 'איסוף ליד חדש',
    icon: '🎯',
    category: 'lead',
    description: 'לוכד פרטי לקוח מתעניין: שם, מה מחפש ודרך ליצירת קשר.',
    triggerWords: ['מידע', 'פרטים', 'מעוניין', 'הצעה'],
    finalMessage: 'תודה! קיבלנו את הפרטים ונחזור אליכם בהקדם 🙏',
    questions: [
      { questionText: 'שמח שפניתם אלינו! מה השם המלא שלכם?', questionType: 'text', sample: 'דנה כהן' },
      { questionText: 'במה נוכל לעזור לכם?', questionType: 'text', sample: 'מחפשת שירותי עיצוב למותג חדש' },
      { questionText: 'מה מספר הטלפון לחזרה?', questionType: 'phone', sample: '050-1234567' },
    ],
  },
  {
    key: 'quote_request',
    title: 'בקשת הצעת מחיר',
    icon: '💰',
    category: 'lead',
    description: 'אוסף את הפרטים הדרושים כדי להכין הצעת מחיר מדויקת.',
    triggerWords: ['הצעת מחיר', 'מחיר', 'הצעה'],
    finalMessage: 'קיבלנו! נכין עבורכם הצעת מחיר ונשלח אליכם בהקדם 💼',
    questions: [
      { questionText: 'לאיזה שירות או מוצר תרצו הצעת מחיר?', questionType: 'text', sample: 'עיצוב לוגו למותג' },
      { questionText: 'ספרו לנו קצת על הצרכים שלכם (כמות, היקף, לוחות זמנים)', questionType: 'text', sample: 'לוגו + כרטיס ביקור, תוך שבועיים' },
      { questionText: 'מה השם שלכם?', questionType: 'text', sample: 'דנה כהן' },
      { questionText: 'לאיזה טלפון לחזור?', questionType: 'phone', sample: '050-1234567' },
    ],
  },
  {
    key: 'appointment_booking',
    title: 'קביעת תור',
    icon: '📅',
    category: 'booking',
    description: 'מתאם תור: איזה שירות, תאריך מועדף ופרטי הלקוח.',
    triggerWords: ['תור', 'לקבוע', 'פגישה', 'זימון'],
    finalMessage: 'מעולה! נאשר את התור ונשלח לכם תזכורת לפני המועד 📌',
    questions: [
      { questionText: 'לאיזה שירות תרצו לקבוע תור?', questionType: 'text', sample: 'תספורת וסידור זקן' },
      { questionText: 'מתי נוח לכם? (יום ושעה מועדפים)', questionType: 'text', sample: 'יום חמישי אחרי 17:00' },
      { questionText: 'מה השם המלא?', questionType: 'text', sample: 'דנה כהן' },
      { questionText: 'מספר טלפון ליצירת קשר', questionType: 'phone', sample: '050-1234567' },
    ],
  },
  {
    key: 'restaurant_reservation',
    title: 'הזמנת מקום במסעדה',
    icon: '🍽️',
    category: 'booking',
    description: 'הזמנת שולחן: תאריך, שעה, מספר סועדים ושם.',
    triggerWords: ['הזמנת מקום', 'שולחן', 'הזמנה'],
    finalMessage: 'ההזמנה נקלטה! נשמח לארח אתכם 🍷',
    questions: [
      { questionText: 'לאיזה תאריך תרצו להזמין מקום?', questionType: 'date', sample: 'שבת, 16/08' },
      { questionText: 'באיזו שעה?', questionType: 'text', sample: '20:30' },
      { questionText: 'כמה סועדים תהיו?', questionType: 'number', sample: '4' },
      { questionText: 'על שם מי לרשום את ההזמנה?', questionType: 'text', sample: 'דנה כהן' },
    ],
  },
  {
    key: 'product_order',
    title: 'הזמנת מוצר',
    icon: '🛍️',
    category: 'ecommerce',
    description: 'קליטת הזמנה: מוצר, כמות, פרטי משלוח ותשלום.',
    triggerWords: ['הזמנה', 'לקנות', 'רכישה', 'מוצר'],
    finalMessage: 'ההזמנה התקבלה! נעדכן אתכם כשהיא יוצאת למשלוח 📦',
    questions: [
      { questionText: 'איזה מוצר תרצו להזמין?', questionType: 'text', sample: 'נעלי ריצה, מידה 42' },
      { questionText: 'כמה יחידות?', questionType: 'number', sample: '1' },
      { questionText: 'מה השם המלא לקבלה?', questionType: 'text', sample: 'דנה כהן' },
      { questionText: 'מה כתובת המשלוח המלאה?', questionType: 'text', sample: 'הרצל 15, תל אביב' },
    ],
  },
  {
    key: 'return_exchange',
    title: 'החזרה או החלפה',
    icon: '🔄',
    category: 'ecommerce',
    description: 'מטפל בבקשת החזרה/החלפה: מספר הזמנה, סיבה ופתרון מבוקש.',
    triggerWords: ['החזרה', 'החלפה', 'ביטול', 'זיכוי'],
    finalMessage: 'קיבלנו את הבקשה — נציג יחזור אליכם עם ההמשך 🤝',
    questions: [
      { questionText: 'מה מספר ההזמנה?', questionType: 'text', sample: '#10231' },
      { questionText: 'מה הסיבה להחזרה/החלפה?', questionType: 'text', sample: 'המידה לא מתאימה' },
      { questionText: 'מה תעדיפו — החזר כספי, זיכוי או החלפה?', questionType: 'single_choice', options: ['החזר כספי', 'זיכוי', 'החלפה'], sample: 'החלפה' },
    ],
  },
  {
    key: 'support_ticket',
    title: 'פנייה לתמיכה',
    icon: '🛠️',
    category: 'service',
    description: 'פותח קריאת שירות: סוג התקלה, תיאור ופרטי לקוח.',
    triggerWords: ['תמיכה', 'תקלה', 'בעיה', 'עזרה'],
    finalMessage: 'הפנייה נפתחה! צוות התמיכה יחזור אליכם בהקדם 🧑‍💻',
    questions: [
      { questionText: 'במה מדובר?', questionType: 'single_choice', options: ['תקלה טכנית', 'שאלה על מוצר', 'חשבונית ותשלום', 'אחר'], sample: 'תקלה טכנית' },
      { questionText: 'תארו בבקשה את הבעיה בכמה מילים', questionType: 'text', sample: 'האפליקציה לא נטענת מאתמול' },
      { questionText: 'מה הטלפון או המייל לחזרה?', questionType: 'text', sample: 'dana@email.com' },
    ],
  },
  {
    key: 'feedback_survey',
    title: 'משוב לקוח',
    icon: '⭐',
    category: 'service',
    description: 'סקר קצר לאחר שירות: דירוג, מה היה טוב ומה לשפר.',
    triggerWords: ['משוב', 'חוות דעת', 'ביקורת'],
    finalMessage: 'תודה על המשוב! הוא עוזר לנו להשתפר עבורכם 💙',
    questions: [
      { questionText: 'איך היינו? דרגו מ-1 עד 5', questionType: 'single_choice', options: ['5 — מצוין', '4 — טוב', '3 — סביר', '2 — פחות', '1 — גרוע'], sample: '5 — מצוין' },
      { questionText: 'מה הכי אהבתם?', questionType: 'text', isRequired: false, sample: 'השירות המהיר והאדיב' },
      { questionText: 'מה נוכל לשפר?', questionType: 'text', isRequired: false, sample: 'זמני ההמתנה בטלפון' },
    ],
  },
  {
    key: 'event_registration',
    title: 'רישום לאירוע',
    icon: '🎟️',
    category: 'lead',
    description: 'רישום לאירוע/וובינר: שם, מייל ומספר משתתפים.',
    triggerWords: ['הרשמה', 'אירוע', 'וובינר', 'כנס'],
    finalMessage: 'נרשמתם בהצלחה! נשלח לכם את כל הפרטים למייל 🎉',
    questions: [
      { questionText: 'מה השם המלא?', questionType: 'text', sample: 'דנה כהן' },
      { questionText: 'מה כתובת המייל לשליחת הפרטים?', questionType: 'email', sample: 'dana@email.com' },
      { questionText: 'כמה משתתפים תהיו?', questionType: 'number', sample: '2' },
    ],
  },
];
