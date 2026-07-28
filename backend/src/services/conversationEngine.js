import prisma from '../lib/prisma.js';
import config from '../config/index.js';
import { generateAgentResponse, ruleBasedResponse } from './aiAgent.js';
import { sendWhatsAppMessage, sendWhatsAppAudio, sendWhatsAppImage } from './whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { hasCredits, chargeAiCredit, markLowCreditNudge } from '../lib/credits.js';
import { trackEvent, EVENTS } from './analytics.js';
import { computeLeadScore } from './leadScore.js';
import { notifyOwnerHandoff } from './handoffNotify.js';

// A URL-based image is downloaded by WhatsApp before delivery, so it can lag
// behind a small voice note sent right after. This short pause (only when a
// question has BOTH image and voice) gives the image a head start so it arrives
// first. Tune with MEDIA_SEND_DELAY_MS (e.g. set 600 for a shorter wait).
const MEDIA_ORDER_DELAY_MS = Number(process.env.MEDIA_SEND_DELAY_MS) || 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Main entry point: process one inbound customer message end-to-end, on behalf
 * of a specific tenant. `tenant` is the full Tenant row (its WhatsApp creds are
 * used to reply). Returns { conversation, agentResponse, replySent }.
 */
export async function handleIncomingMessage({ tenant, phone, text, name, rawPayload, waMessageId }) {
  if (!tenant?.id) throw new Error('handleIncomingMessage requires a tenant');
  const tenantId = tenant.id;
  const creds = tenantWhatsAppCreds(tenant);

  // 0) Idempotency: Meta delivers webhooks at-least-once. If we've already
  // stored this inbound message id for this tenant, skip re-processing.
  if (waMessageId) {
    const seen = await prisma.message.findUnique({
      where: { tenantId_waMessageId: { tenantId, waMessageId } },
      select: { id: true },
    });
    if (seen) return { conversation: null, agentResponse: null, replySent: false, duplicate: true };
  }

  // 1) Customer
  const customer = await prisma.customer.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    update: name ? { name } : {},
    create: { tenantId, phone, name: name || null },
  });

  // 2) Conversation (reuse an open one, else start fresh)
  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, customerId: customer.id, status: { in: ['active', 'needs_human'] } },
    orderBy: { createdAt: 'desc' },
  });

  // 2a) "One & done": if there's no open conversation but this customer already
  // COMPLETED A FLOW, stay silent — record the inbound message (so it's visible in
  // the dashboard) and bump activity, but don't reply or restart a flow. Scoped to
  // conversations that actually ran a flow (currentFlowId set), so plain chit-chat
  // the AI happens to mark "completed" doesn't permanently silence the customer.
  if (!conversation) {
    const completed = await prisma.conversation.findFirst({
      where: { tenantId, customerId: customer.id, status: 'completed', currentFlowId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (completed) {
      await prisma.message.create({
        data: {
          tenantId,
          conversationId: completed.id,
          senderType: 'customer',
          messageText: text,
          waMessageId: waMessageId || null,
          rawPayload: rawPayload || undefined,
        },
      });
      await prisma.conversation.update({
        where: { id: completed.id },
        data: { lastMessage: text, lastActivityAt: new Date() },
      });
      await trackEvent(EVENTS.MESSAGE_RECEIVED, {
        tenantId,
        conversationId: completed.id,
        customerId: customer.id,
        customerPhone: phone,
        metadata: { text, suppressed: true },
      });
      return { conversation: completed, agentResponse: null, replySent: false, isNew: false, suppressed: true };
    }
  }

  let isNew = false;
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { tenantId, customerId: customer.id, whatsappPhone: phone, status: 'active' },
    });
    isNew = true;
    await trackEvent(EVENTS.CONVERSATION_STARTED, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerPhone: phone,
    });
  }

  // 3) Save incoming message
  await prisma.message.create({
    data: {
      tenantId,
      conversationId: conversation.id,
      senderType: 'customer',
      messageText: text,
      waMessageId: waMessageId || null,
      rawPayload: rawPayload || undefined,
    },
  });
  await trackEvent(EVENTS.MESSAGE_RECEIVED, {
    tenantId,
    conversationId: conversation.id,
    customerId: customer.id,
    customerPhone: phone,
    metadata: { text },
  });

  // 4) Build context for the agent
  const [kb, flows, existingAnswers, history] = await Promise.all([
    prisma.knowledgeBase.findUnique({ where: { tenantId } }),
    loadActiveFlows(tenantId),
    prisma.customerAnswer.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'asc' } }),
    prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      take: 30,
    }),
  ]);

  // Deterministic flow selection when not already inside a flow:
  //  1) a flow whose trigger words appear in the message, else
  //  2) a "default" flow (isDefault) that starts on ANY message (e.g. "hey").
  let suggestedFlow = null;
  if (!conversation.currentFlowId) {
    const lc = text.toLowerCase();
    const matched = flows.find((fl) => fl.triggerWords?.some((w) => w && lc.includes(String(w).toLowerCase())));
    const fallback = matched || flows.find((fl) => fl.isDefault);
    if (fallback) suggestedFlow = { id: fallback.id, name: fallback.name };
  }

  const ctx = {
    incomingText: text,
    knowledgeBase: kb,
    flows,
    state: {
      currentFlowId: conversation.currentFlowId,
      currentQuestionId: conversation.currentQuestionId,
      status: conversation.status,
      needsHuman: conversation.needsHuman,
      customerPhone: phone,
      suggestedFlow,
      collectedAnswers: existingAnswers.map((a) => ({
        question_id: a.questionId,
        question: a.questionText,
        answer: a.answer,
      })),
    },
    history: history.map((m) => ({ senderType: m.senderType, text: m.messageText })),
  };

  // 5) Run the agent.
  // Flow EXECUTION is always deterministic (ordered questions, phone auto-fill,
  // correct answer recording). The LLM is used only to (a) answer free-form
  // knowledge-base questions and (b) DETECT intent to start a flow conversationally
  // (e.g. "כן" after being offered). It never executes flow steps itself.
  // AI credits: only the free-form LLM branch below costs a credit. Deterministic
  // flow steps (mid-flow, trigger-word start) are always free. When the tenant is
  // out of credits we force the rule-based path and flag it (graceful degrade).
  let agentResponse;
  let outOfCredits = false;
  if (conversation.currentFlowId) {
    // Mid-flow → record answer + advance, deterministically.
    agentResponse = ruleBasedResponse(ctx);
  } else if (suggestedFlow) {
    // Trigger word matched → start that flow fresh from question 1.
    ctx.state.startFlowId = suggestedFlow.id;
    agentResponse = ruleBasedResponse(ctx);
  } else {
    // No flow context → ask the LLM (KB answer or conversational start), but only
    // if the tenant has credits. Out of credits → rule-based reply, no charge.
    const allowAI = await hasCredits(tenantId);
    outOfCredits = !allowAI;
    const { response: llm, ai } = await generateAgentResponse(ctx, { allowAI });
    if (ai.used) {
      // A real OpenAI reply was produced → charge exactly one credit.
      const state = await chargeAiCredit({ tenantId, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut });
      // Clear any prior low-credit nudge once credits are flowing again.
      if (tenant.lowCreditNotifiedAt) {
        await prisma.tenant.update({ where: { id: tenantId }, data: { lowCreditNotifiedAt: null } }).catch(() => {});
      }
      if (state && state.available <= 0) await markLowCreditNudge(tenantId); // just hit zero
    } else if (outOfCredits) {
      await markLowCreditNudge(tenantId);
    }
    const wantsToStart =
      llm.flow_id &&
      flows.some((f) => f.id === llm.flow_id) &&
      (llm.next_action === 'ask_next_question' || llm.intent === 'predefined_flow_start');
    if (wantsToStart) {
      // LLM detected the customer wants a flow → start it deterministically.
      ctx.state.startFlowId = llm.flow_id;
      agentResponse = ruleBasedResponse(ctx);
    } else {
      agentResponse = llm; // pure knowledge-base answer / chit-chat
    }
  }

  // 6) Persist newly collected answers (diff vs existing)
  // If the customer asked to restart, wipe previously stored answers first.
  if (agentResponse.reset_answers) {
    await prisma.customerAnswer.deleteMany({ where: { conversationId: conversation.id } });
    existingAnswers.length = 0;
  }
  const existingQids = new Set(existingAnswers.map((a) => a.questionId).filter(Boolean));
  const newAnswers = (agentResponse.collected_answers || []).filter(
    (a) => a.question_id && !existingQids.has(a.question_id)
  );
  for (const a of newAnswers) {
    await prisma.customerAnswer.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        customerId: customer.id,
        flowId: agentResponse.flow_id || conversation.currentFlowId || null,
        questionId: a.question_id,
        questionText: a.question || null,
        answer: a.answer,
      },
    });
    await trackEvent(EVENTS.QUESTION_ANSWERED, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerPhone: phone,
      flowId: agentResponse.flow_id,
      questionId: a.question_id,
      metadata: { answer: a.answer },
    });
    await captureContactFromAnswer(customer.id, a);
  }

  // 7) Resolve link + build trackable URL, append to reply
  let replyText = agentResponse.reply;
  let linkSent = conversation.linkSent;
  if (agentResponse.next_action === 'send_link') {
    const trackable = await resolveTrackableLink(tenantId, agentResponse, conversation.id);
    if (trackable) {
      replyText = `${replyText}\n${trackable.url}`;
      linkSent = true;
      await trackEvent(EVENTS.LINK_SENT, {
        tenantId,
        conversationId: conversation.id,
        customerId: customer.id,
        customerPhone: phone,
        flowId: agentResponse.flow_id,
        metadata: { linkId: trackable.linkId, url: trackable.target },
      });
    }
  }

  // 8) Lifecycle analytics
  await emitLifecycleEvents({ tenantId, conversation, agentResponse, customer, phone });

  // 9) Compute lead score + persist conversation state
  const flow = flows.find((f) => f.id === (agentResponse.flow_id || conversation.currentFlowId));
  const requiredCount = flow ? flow.questions.filter((q) => q.isRequired).length : 0;
  const totalAnswers = existingAnswers.length + newAnswers.length;
  const leadScore = computeLeadScore({
    intent: agentResponse.intent,
    answersCount: totalAnswers,
    requiredCount,
    linkSent,
    status: agentResponse.conversation_status,
  });
  agentResponse.lead_score = leadScore;

  // Capture the pre-update handoff state so we can alert the owner exactly on the
  // false→true edge below (not on every message while it stays true). §2.4.
  const wasNeedsHuman = conversation.needsHuman;

  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: agentResponse.conversation_status,
      intent: agentResponse.intent,
      currentFlowId: agentResponse.flow_id,
      currentQuestionId: agentResponse.current_question_id,
      needsHuman: agentResponse.needs_human,
      lastMessage: text,
      leadScore,
      linkSent,
      lastActivityAt: new Date(),
    },
  });

  // Owner handoff notification (§2.4): the moment a conversation newly needs a
  // human, WhatsApp the business owner with context. Fire only on the false→true
  // edge; best-effort (never breaks the reply pipeline). lastMessage was just set
  // to this inbound `text` above, so pass a conversation view that carries it.
  if (!wasNeedsHuman && agentResponse.needs_human) {
    await notifyOwnerHandoff({
      tenant,
      conversation: { ...conversation, whatsappPhone: phone, lastMessage: text },
      customer: { name: customer.name, phone: customer.phone || phone },
    });
  }

  // 10) Save agent reply + send via WhatsApp. Skip entirely when there's nothing
  // to send — e.g. a flow that completes with no closing message and no link.
  const hasReply = !!(replyText && replyText.trim());

  // Media attached to the question being asked: when there's an image, the text
  // is sent AS THE IMAGE CAPTION (one combined message); otherwise as a normal
  // text message. The voice note (if any) follows as a separate message.
  let voiceUrl = null;
  let imageUrl = null;
  if (agentResponse.next_action === 'ask_next_question' && agentResponse.current_question_id && flow) {
    const askedQuestion = flow.questions.find((q) => q.id === agentResponse.current_question_id);
    voiceUrl = askedQuestion?.voiceUrl || null;
    imageUrl = askedQuestion?.imageUrl || null;
  }

  let replySent = false;
  if (hasReply || imageUrl) {
    await prisma.message.create({
      data: {
        tenantId,
        conversationId: conversation.id,
        senderType: 'agent',
        messageText: replyText,
        intent: agentResponse.intent,
      },
    });
    await trackEvent(EVENTS.MESSAGE_SENT, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerPhone: phone,
      metadata: { reply: replyText, intent: agentResponse.intent },
    });
    // Count against the tenant's monthly message allowance (best-effort).
    await prisma.tenant
      .update({ where: { id: tenantId }, data: { messagesThisPeriod: { increment: 1 } } })
      .catch(() => {});
    replySent = true;
    try {
      if (imageUrl) {
        await sendWhatsAppImage(creds, phone, imageUrl, hasReply ? replyText : undefined);
      } else {
        await sendWhatsAppMessage(creds, phone, replyText);
      }
      if (voiceUrl) {
        if (imageUrl) await sleep(MEDIA_ORDER_DELAY_MS); // let the image land first
        await sendWhatsAppAudio(creds, phone, voiceUrl);
      }
    } catch (err) {
      replySent = false;
      console.error('[engine] failed to send WhatsApp reply:', err.message);
    }
  }

  return { conversation, agentResponse: { ...agentResponse, reply: replyText }, replySent, isNew, outOfCredits };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
async function loadActiveFlows(tenantId) {
  const flows = await prisma.flow.findMany({
    where: { tenantId, isActive: true },
    include: { questions: { orderBy: { orderIndex: 'asc' } }, link: true },
  });
  return flows.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    triggerWords: f.triggerWords,
    isDefault: f.isDefault,
    finalMessage: f.finalMessage,
    sendFinalMessage: f.sendFinalMessage,
    linkId: f.linkId,
    linkUrl: f.link?.url || null,
    questions: f.questions.map((q) => ({
      id: q.id,
      questionText: q.questionText,
      questionType: q.questionType,
      options: q.options,
      voiceUrl: q.voiceUrl,
      imageUrl: q.imageUrl,
      isRequired: q.isRequired,
      orderIndex: q.orderIndex,
    })),
  }));
}

/**
 * Build a trackable redirect link (/r/:linkId?c=:conversationId) when the link
 * exists as a Link record with click tracking; otherwise return the raw URL.
 */
async function resolveTrackableLink(tenantId, agentResponse, conversationId) {
  // Prefer the flow's configured link record.
  let link = null;
  if (agentResponse.flow_id) {
    const flow = await prisma.flow.findFirst({
      where: { id: agentResponse.flow_id, tenantId },
      include: { link: true },
    });
    link = flow?.link || null;
  }
  // Fall back to matching by URL (within this tenant).
  if (!link && agentResponse.link_to_send) {
    link = await prisma.link.findFirst({ where: { tenantId, url: agentResponse.link_to_send } });
  }

  if (link) {
    const target = link.url;
    const url = link.trackClicks
      ? `${config.publicBaseUrl}/r/${link.id}?c=${conversationId}`
      : target;
    return { linkId: link.id, url, target };
  }
  if (agentResponse.link_to_send) {
    return { linkId: null, url: agentResponse.link_to_send, target: agentResponse.link_to_send };
  }
  return null;
}

async function emitLifecycleEvents({ tenantId, conversation, agentResponse, customer, phone }) {
  const base = { tenantId, conversationId: conversation.id, customerId: customer.id, customerPhone: phone, flowId: agentResponse.flow_id };

  await trackEvent(EVENTS.INTENT_DETECTED, { ...base, metadata: { intent: agentResponse.intent } });

  // Flow just started (no prior flow, now in one)
  if (!conversation.currentFlowId && agentResponse.flow_id) {
    await trackEvent(EVENTS.FLOW_STARTED, base);
  }
  // A question is being asked
  if (agentResponse.next_action === 'ask_next_question' && agentResponse.current_question_id) {
    await trackEvent(EVENTS.QUESTION_ASKED, { ...base, questionId: agentResponse.current_question_id });
  }
  if (agentResponse.next_action === 'transfer_to_human' || agentResponse.needs_human) {
    await trackEvent(EVENTS.HUMAN_HANDOFF_REQUESTED, base);
  }
  if (agentResponse.conversation_status === 'completed' && conversation.status !== 'completed') {
    await trackEvent(EVENTS.FLOW_COMPLETED, base);
    await trackEvent(EVENTS.CONVERSATION_CLOSED, base);
  }
  if (agentResponse.conversation_status === 'abandoned' && conversation.status !== 'abandoned') {
    await trackEvent(EVENTS.FLOW_ABANDONED, base);
  }
}

/**
 * Opportunistically capture email/phone from typed answers onto the customer record.
 */
async function captureContactFromAnswer(customerId, answer) {
  const val = (answer.answer || '').trim();
  const emailMatch = val.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const data = {};
  if (emailMatch) data.email = emailMatch[0];
  const qid = (answer.question_id || '').toLowerCase();
  if (qid.includes('name') || /שם/.test(answer.question || '')) data.name = val;
  if (Object.keys(data).length) {
    try {
      await prisma.customer.update({ where: { id: customerId }, data });
    } catch {
      /* non-fatal */
    }
  }
}
