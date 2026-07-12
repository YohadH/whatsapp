import OpenAI from 'openai';
import { z } from 'zod';
import config from '../config/index.js';

const openai = config.openai.enabled ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

export const INTENTS = [
  'general_question',
  'product_question',
  'service_question',
  'pricing_question',
  'shipping_question',
  'booking_request',
  'payment_request',
  'support_request',
  'human_agent_request',
  'predefined_flow_start',
  'unknown',
];

export const NEXT_ACTIONS = [
  'answer_question',
  'ask_next_question',
  'send_link',
  'transfer_to_human',
  'end_conversation',
];

// ─────────────────────────────────────────────────────────────
// Output schema — the contract the backend relies on.
// ─────────────────────────────────────────────────────────────
const AnswerSchema = z.object({
  question_id: z.string().nullable().optional(),
  question: z.string().nullable().optional(),
  answer: z.string(),
});

const ResponseSchema = z.object({
  reply: z.string(),
  intent: z.string(),
  next_action: z.string(),
  flow_id: z.string().nullable(),
  current_question_id: z.string().nullable(),
  collected_answers: z.array(AnswerSchema).default([]),
  link_to_send: z.string().nullable(),
  conversation_status: z.enum(['active', 'completed', 'abandoned', 'needs_human']),
  lead_score: z.number().int().min(1).max(100),
  needs_human: z.boolean(),
  reset_answers: z.boolean().default(false),
});

// ─────────────────────────────────────────────────────────────
// Prompt building
// ─────────────────────────────────────────────────────────────
function buildKnowledgeBaseBlock(kb) {
  if (!kb) return 'אין כרגע מידע במאגר הידע.';
  const rows = [
    ['תיאור העסק', kb.businessDescription],
    ['מוצרים', kb.productInfo],
    ['שירותים', kb.serviceInfo],
    ['מחירים', kb.prices],
    ['משלוחים', kb.shippingInfo],
    ['מדיניות החזרות', kb.returnPolicy],
    ['שאלות נפוצות', kb.faq],
    ['שעות פעילות', kb.openingHours],
    ['פרטי יצירת קשר', kb.contactDetails],
    ['מגבלות חשובות', kb.limitations],
    ['הוראות מיוחדות', kb.customInstructions],
  ].filter(([, v]) => v && String(v).trim());
  if (!rows.length) return 'אין כרגע מידע במאגר הידע.';
  return rows.map(([k, v]) => `### ${k}\n${v}`).join('\n\n');
}

function buildFlowsBlock(flows) {
  if (!flows?.length) return 'אין כרגע תהליכים מוגדרים.';
  return flows
    .map((f) => {
      const questions = f.questions
        .map((q, i) => {
          const opts = q.options?.length ? ` | אפשרויות: ${q.options.join(', ')}` : '';
          const req = q.isRequired ? 'חובה' : 'רשות';
          return `    ${i + 1}. [id=${q.id}] (${q.questionType}, ${req})${opts}\n       "${q.questionText}"`;
        })
        .join('\n');
      return [
        `- flow_id: ${f.id}`,
        `  שם: ${f.name}`,
        f.description ? `  תיאור: ${f.description}` : null,
        `  מילות הפעלה: ${f.triggerWords?.join(', ') || '—'}`,
        `  הודעת סיום: ${f.finalMessage || '—'}`,
        `  קישור לשליחה בסוף: ${f.linkUrl || '—'}`,
        `  שאלות:\n${questions || '    (אין שאלות)'}`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

function buildSystemPrompt(kb, flows) {
  return `אתה סוכן שירות לקוחות בוואטסאפ של עסק. המטרה שלך: לענות ללקוחות, להפעיל תהליכי שאלות מוגדרים מראש, לאסוף פרטים, ולשלוח קישורים רלוונטיים.

## כללי שפה והתנהגות
- ענה תמיד בעברית, אלא אם הלקוח כותב בשפה אחרת (אז ענה באותה שפה).
- הודעות קצרות, ברורות וטבעיות בסגנון וואטסאפ. מנומס ועוזר, לא רובוטי מדי.
- **כשהלקוח שואל שאלה — ענה עליה ישירות וקונקרטית מתוך מאגר הידע, כולל המספרים עצמם (מחירים, שעות, פרטים).** לדוגמה, אם נשאלת על מחיר טיפול פנים, החזר את המחיר המדויק. אל תסתפק בברכה כללית או בתיאור כללי של העסק.
- אל תפתח כל הודעה ב"שלום". ברך רק בהודעה הראשונה בשיחה, ורק אם הלקוח בירך — אחרת גש ישר לעניין.
- שאל רק שאלה אחת בכל פעם.
- אל תמציא מידע. ענה רק על סמך מאגר הידע שמופיע למטה.
- אם התשובה לשאלה אכן לא קיימת במאגר הידע, רק אז אמור בנימוס שנציג אנושי יחזור עם תשובה (needs_human=true, next_action=transfer_to_human).
- בחר intent מדויק לפי תוכן ההודעה (למשל שאלה על מחיר = pricing_question, שאלה על שירות = service_question).

## סיווג כוונה (intent) — בחר אחת:
${INTENTS.map((i) => `- ${i}`).join('\n')}

## לוגיקת תהליכים (flows)
- **מספר הטלפון של הלקוח כבר ידוע מהוואטסאפ (מופיע במצב השיחה). אל תשאל אף פעם שאלות מסוג phone — מלא אותן אוטומטית עם המספר הידוע, הוסף את התשובה ל-collected_answers, ועבור ישר לשאלה הבאה.**
- אם הלקוח מבקש להתחיל תהליך או כתב מילת הפעלה של תהליך פעיל → התחל את התהליך, שאל את השאלה הראשונה לפי הסדר (next_action=ask_next_question, intent=predefined_flow_start).
- **בחירת התהליך הנכון: אם במצב השיחה מצוין "תהליך מתאים לפי מילות הפעלה", זהו התהליך הסמכותי — השתמש ב-flow_id הזה בדיוק ואל תבחר תהליך אחר.** אל תציע ללקוח "להתחיל תהליך" — פשוט התחל ושאל את השאלה הראשונה.
- אם הלקוח כבר בתוך תהליך → שמור את התשובה שלו לשאלה הנוכחית בתוך collected_answers, ועבור לשאלה הבאה.
- שאלות רשות אפשר לדלג רק אם הלקוח מסרב או שהתהליך מתיר דילוג.
- כשכל שאלות החובה נאספו → סכם בקצרה את הפרטים, שלח את הודעת הסיום, סמן next_action=send_link אם יש קישור (אחרת end_conversation), conversation_status=completed.

## בקשת נציג אנושי
- אם הלקוח מבקש לדבר עם נציג/אדם → next_action=transfer_to_human, needs_human=true, conversation_status=needs_human, עצור את התהליך והשב בנימוס שנציג ימשיך מכאן.

## פלט — חובה להחזיר JSON תקין בלבד, בדיוק במבנה הזה:
{
  "reply": "הודעת הוואטסאפ ללקוח (עברית, מוכנה לשליחה, ללא URL גולמי)",
  "intent": "<אחת מהכוונות>",
  "next_action": "answer_question | ask_next_question | send_link | transfer_to_human | end_conversation",
  "flow_id": "<מזהה התהליך הנוכחי או null>",
  "current_question_id": "<מזהה השאלה שתישאל עכשיו או null>",
  "collected_answers": [{"question_id":"...","question":"...","answer":"..."}],
  "link_to_send": "<ה-URL מהתהליך לשליחה, או null>",
  "conversation_status": "active | completed | abandoned | needs_human",
  "lead_score": <מספר שלם 1-100>,
  "needs_human": <true|false>
}

חשוב: אל תכניס URL לתוך "reply" — המערכת מצרפת את הקישור באופן אוטומטי. ב-link_to_send החזר את ה-URL המוגדר של התהליך. ב-collected_answers החזר את כל התשובות שנאספו עד כה (כולל החדשה).

# מאגר הידע של העסק
${buildKnowledgeBaseBlock(kb)}

# התהליכים הפעילים
${buildFlowsBlock(flows)}`;
}

function buildStatePrompt(state, history) {
  const answers = state.collectedAnswers?.length
    ? state.collectedAnswers.map((a) => `  - [${a.question_id}] ${a.question}: ${a.answer}`).join('\n')
    : '  (אין עדיין)';
  const hist = history
    .slice(-12)
    .map((m) => `${m.senderType === 'customer' ? 'לקוח' : 'סוכן'}: ${m.text}`)
    .join('\n');
  return `# מצב השיחה הנוכחי
- מספר הוואטסאפ הידוע של הלקוח: ${state.customerPhone || 'לא ידוע'}
- תהליך מתאים לפי מילות הפעלה (סמכותי — אם הלקוח מתחיל תהליך, השתמש בדיוק בזה): ${state.suggestedFlow ? `${state.suggestedFlow.id} (${state.suggestedFlow.name})` : 'אין התאמה'}
- flow_id נוכחי: ${state.currentFlowId || 'null'}
- current_question_id נוכחי: ${state.currentQuestionId || 'null'}
- סטטוס: ${state.status}
- needs_human: ${state.needsHuman}
- תשובות שנאספו:
${answers}

# היסטוריית השיחה (אחרונות)
${hist || '(התחלת שיחה)'}`;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────
export async function generateAgentResponse(ctx) {
  if (openai) {
    try {
      return await callOpenAI(ctx);
    } catch (err) {
      console.error('[aiAgent] OpenAI failed, falling back to rules:', err.message);
    }
  }
  return ruleBasedResponse(ctx);
}

async function callOpenAI(ctx) {
  const system = buildSystemPrompt(ctx.knowledgeBase, ctx.flows);
  const statePrompt = buildStatePrompt(ctx.state, ctx.history);

  const completion = await openai.chat.completions.create({
    model: config.openai.model,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${statePrompt}\n\n# הודעה נכנסת מהלקוח\n${ctx.incomingText}` },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content || '{}';
  const parsed = ResponseSchema.parse(JSON.parse(raw));
  return parsed;
}

// ─────────────────────────────────────────────────────────────
// Rule-based fallback (works with no OpenAI key) — keeps the
// system fully demoable end-to-end.
// ─────────────────────────────────────────────────────────────
const HUMAN_KEYWORDS = ['נציג', 'אנושי', 'בנאדם', 'בן אדם', 'אדם אמיתי', 'לדבר עם', 'שירות לקוחות', 'human', 'agent'];

function detectIntent(text, startedFlow) {
  const t = text.toLowerCase();
  if (HUMAN_KEYWORDS.some((k) => t.includes(k))) return 'human_agent_request';
  if (startedFlow) return 'predefined_flow_start';
  if (/(מחיר|כמה עולה|עלות|תשלום)/.test(t)) return 'pricing_question';
  if (/(משלוח|שילוח|מתי יגיע|דואר)/.test(t)) return 'shipping_question';
  if (/(לשלם|תשלום|לרכוש|לקנות)/.test(t)) return 'payment_request';
  if (/(לקבוע|פגישה|תור|שיחה|זימון)/.test(t)) return 'booking_request';
  if (/(תקלה|בעיה|לא עובד|תמיכה|עזרה)/.test(t)) return 'support_request';
  if (/(מוצר|פריט|דגם|קטלוג)/.test(t)) return 'product_question';
  if (/(שירות|שירותים)/.test(t)) return 'service_question';
  if (text.trim()) return 'general_question';
  return 'unknown';
}

function orderedQuestions(flow) {
  return [...flow.questions].sort((a, b) => a.orderIndex - b.orderIndex);
}

export function ruleBasedResponse(ctx) {
  const { incomingText, flows, state } = ctx;
  const text = (incomingText || '').trim();

  // 1) Human handoff
  if (HUMAN_KEYWORDS.some((k) => text.toLowerCase().includes(k))) {
    return base({
      reply: 'אין בעיה 🙂 נציג אנושי יחזור אליך בהקדם. תודה על הסבלנות!',
      intent: 'human_agent_request',
      next_action: 'transfer_to_human',
      flow_id: state.currentFlowId,
      current_question_id: null,
      collected_answers: state.collectedAnswers || [],
      link_to_send: null,
      conversation_status: 'needs_human',
      needs_human: true,
    });
  }

  // 1b) Explicit fresh start (deterministic trigger match or LLM-detected intent).
  // Starts at the first question WITHOUT recording the triggering message as an answer.
  if (state.startFlowId && !state.currentFlowId) {
    const flow = flows.find((f) => f.id === state.startFlowId);
    if (flow) {
      const questions = orderedQuestions(flow);
      const collected = [];
      const next = pickNextQuestion(questions, collected, state.customerPhone);
      return next ? askQuestion(flow, next, collected) : finishFlow(flow, collected);
    }
  }

  // 2) Already inside a flow → validate / record / advance
  if (state.currentFlowId) {
    const flow = flows.find((f) => f.id === state.currentFlowId);
    if (flow) {
      const questions = orderedQuestions(flow);
      const collected = [...(state.collectedAnswers || [])];

      const currentQ = questions.find((q) => q.id === state.currentQuestionId) || questions[0];
      const isSkip = /(דלג|לא רוצה|אין|לא רלוונטי)/.test(text) && currentQ && !currentQ.isRequired;

      // 2a) Validate the answer; on failure, re-ask the same question with a hint
      if (currentQ && !isSkip) {
        const v = validateAnswer(currentQ, text);
        if (!v.valid) return askQuestion(flow, currentQ, collected, v.error);
        collected.push({ question_id: currentQ.id, question: currentQ.questionText, answer: v.value ?? text.trim() });
      }

      // 2b) Advance, or finish (final message + link) when everything is collected
      const next = pickNextQuestion(questions, collected, state.customerPhone);
      return next ? askQuestion(flow, next, collected) : finishFlow(flow, collected);
    }
  }

  // 3) Not in a flow → check trigger words to start one
  const lc = text.toLowerCase();
  const triggered = flows.find((f) => f.triggerWords?.some((w) => w && lc.includes(w.toLowerCase())));
  if (triggered) {
    const questions = orderedQuestions(triggered);
    const collected = [];
    const next = pickNextQuestion(questions, collected, state.customerPhone);
    return next ? askQuestion(triggered, next, collected) : finishFlow(triggered, collected);
  }

  // 4) General question → no KB reasoning in fallback mode
  const intent = detectIntent(text, false);
  return base({
    reply: 'תודה על פנייתך! 🙂 קיבלתי את ההודעה. נציג שלנו יחזור אליך עם המידע המבוקש בהקדם.',
    intent,
    next_action: 'transfer_to_human',
    flow_id: null,
    current_question_id: null,
    collected_answers: state.collectedAnswers || [],
    link_to_send: null,
    conversation_status: intent === 'general_question' ? 'active' : 'needs_human',
    needs_human: intent !== 'general_question',
  });
}

// Returns the next question to ask. Phone-type questions are auto-filled with the
// known WhatsApp number (pushed into `collected`) and skipped. Returns null when done.
function pickNextQuestion(questions, collected, phone) {
  const answered = new Set(collected.map((a) => a.question_id));
  for (const q of questions) {
    if (answered.has(q.id)) continue;
    if (q.questionType === 'phone' && phone) {
      collected.push({ question_id: q.id, question: q.questionText, answer: phone });
      answered.add(q.id);
      continue;
    }
    return q;
  }
  return null;
}

function askQuestion(flow, q, collected, errorPrefix) {
  const opts = q.options?.length ? `\n(${q.options.join(' / ')})` : '';
  const head = errorPrefix ? `${errorPrefix}\n` : '';
  return base({
    reply: `${head}${q.questionText}${opts}`,
    intent: 'predefined_flow_start',
    next_action: 'ask_next_question',
    flow_id: flow.id,
    current_question_id: q.id,
    collected_answers: collected,
    link_to_send: null,
    conversation_status: 'active',
    needs_human: false,
  });
}

// Validate an answer against the question type. Returns { valid, error?, value? }.
function validateAnswer(q, text) {
  const t = (text || '').trim();
  if (!t) return { valid: false, error: 'לא קלטתי תשובה, אפשר לנסות שוב? 🙂' };

  switch (q.questionType) {
    case 'number': {
      const m = t.match(/\d+/);
      if (!m) return { valid: false, error: 'אנא הזן/הזיני מספר (ספרות).' };
      return { valid: true, value: m[0] };
    }
    case 'email': {
      if (!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(t))
        return { valid: false, error: 'כתובת האימייל לא נראית תקינה, אפשר לבדוק שוב?' };
      return { valid: true };
    }
    case 'phone': {
      const digits = t.replace(/[^\d]/g, '');
      if (digits.length < 7) return { valid: false, error: 'מספר הטלפון לא נראה תקין, אפשר שוב?' };
      return { valid: true, value: digits };
    }
    case 'yes_no': {
      const s = t.toLowerCase();
      if (['כן', 'לא', 'yes', 'no'].some((w) => s.includes(w))) return { valid: true };
      return { valid: false, error: 'אנא השב/י כן או לא.' };
    }
    case 'single_choice':
    case 'multiple_choice': {
      if (q.options?.length) {
        const norm = (s) => s.trim().toLowerCase();
        const ok = q.options.some((o) => norm(o) === norm(t) || norm(t).includes(norm(o)) || norm(o).includes(norm(t)));
        if (!ok) return { valid: false, error: `אנא בחר/י מתוך האפשרויות: ${q.options.join(' / ')}` };
      }
      return { valid: true };
    }
    default:
      return { valid: true };
  }
}

// All questions answered → optionally send the closing message (the link, if any,
// is appended by the engine). When sendFinalMessage is false, or no message is set,
// `reply` is empty and the engine sends nothing (beyond a link, if configured).
function finishFlow(flow, collected) {
  const finalMsg = flow.sendFinalMessage === false ? '' : (flow.finalMessage || '');
  return base({
    reply: finalMsg,
    intent: 'predefined_flow_start',
    next_action: flow.linkUrl ? 'send_link' : 'end_conversation',
    flow_id: flow.id,
    current_question_id: null,
    collected_answers: collected,
    link_to_send: flow.linkUrl || null,
    conversation_status: 'completed',
    needs_human: false,
  });
}

function base(partial) {
  return ResponseSchema.parse({ lead_score: 1, ...partial });
}
