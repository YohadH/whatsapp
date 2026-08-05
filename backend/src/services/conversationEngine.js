import prisma from '../lib/prisma.js';
import config from '../config/index.js';
import { generateAgentResponse, ruleBasedResponse } from './aiAgent.js';
import { sendWhatsAppMessage, sendWhatsAppAudio, sendWhatsAppImage } from './whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { hasCredits, markLowCreditNudge, spendOneCredit } from '../lib/credits.js';
import { trackEvent, EVENTS } from './analytics.js';
import { computeLeadScore } from './leadScore.js';
import { notifyOwnerHandoff } from './handoffNotify.js';
import { deliverLeadEvent } from './outboundWebhook.js';
import { normalizePhone } from '../lib/phone.js';
import { createCalendarEvent } from './googleIntegration.js';
import { generateViaProvider } from './replyProvider.js';
import { hasFreeQuotaToday, consumeDailyFreeReply } from '../lib/aiDailyQuota.js';
import { effectiveReplyProvider } from '../lib/platformPipeline.js';

// Create a Google Calendar event from an agent-extracted booking. BEST-EFFORT and
// fire-and-forget: if the Calendar integration isn't configured/enabled/connected,
// createCalendarEvent throws a GoogleIntegrationError we swallow — so this is a
// no-op until the tenant connects Google, and it NEVER blocks or breaks a reply.
function bookCalendarBestEffort(tenantId, ev, customer) {
  try {
    if (!ev?.start) return;
    const start = ev.start;
    const end = ev.end || new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString();
    createCalendarEvent(tenantId, {
      summary: ev.summary || `תור — ${customer?.name || customer?.phone || 'לקוח'}`,
      description: `נקבע אוטומטית על ידי הסוכן.\nלקוח: ${customer?.name || ''} ${customer?.phone || ''}`.trim(),
      start,
      end,
      timeZone: ev.timeZone || 'Asia/Jerusalem',
    })
      .then((r) => console.log(`[calendar ${tenantId}] event created: ${r.id}`))
      .catch((e) => {
        // Silent for the expected "not live" gates; log anything unexpected.
        if (!['not_configured', 'not_enabled', 'not_connected', 'token_corrupt'].includes(e?.code)) {
          console.error(`[calendar ${tenantId}] create failed:`, e?.message);
        }
      });
  } catch (e) {
    console.error(`[calendar ${tenantId}] booking hook error:`, e?.message);
  }
}

// A URL-based image is downloaded by WhatsApp before delivery, so it can lag
// behind a small voice note sent right after. This short pause (only when a
// question has BOTH image and voice) gives the image a head start so it arrives
// first. Tune with MEDIA_SEND_DELAY_MS (e.g. set 600 for a shorter wait).
const MEDIA_ORDER_DELAY_MS = Number(process.env.MEDIA_SEND_DELAY_MS) || 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// True when a prisma write threw a unique-constraint violation (P2002) on the
// Message.@@unique([tenantId, waMessageId]) idempotency index — i.e. another
// concurrent webhook delivery for the SAME waMessageId already inserted this
// inbound message. Used to make the inbound message.create() itself the atomic
// dedup gate (see the TOCTOU note in handleIncomingMessage).
function isDuplicateWaMessage(err) {
  if (err?.code !== 'P2002') return false;
  const target = err?.meta?.target;
  // Prisma reports the offending unique index; match either the array form
  // (['tenantId','waMessageId']) or the constraint-name string form.
  if (Array.isArray(target)) return target.includes('waMessageId');
  return typeof target === 'string' ? target.includes('waMessageId') : true;
}

// Explicit select for every Conversation read/write on the live inbound-message path.
// DRIFT SAFETY (AP-T71): windowStartedAt/windowExpiresAt are added in migration
// 4_conversation_credit_window but may not be applied on the live DB yet (deliberate
// drift, like waPin). An implicit SELECT * would request those columns and throw P2022
// on every inbound message — silently dropping the customer's reply (the webhook has
// already 200'd). This lists exactly the columns this engine consumes downstream
// (id, currentFlowId, currentQuestionId, status, needsHuman, linkSent) and NOTHING
// else — the window columns are read/written only via chargeAiCredit()'s raw SQL. If
// you add a new conversation.<field> read below, add it here too.
const CONVERSATION_ENGINE_SELECT = {
  id: true,
  currentFlowId: true,
  currentQuestionId: true,
  status: true,
  needsHuman: true,
  linkSent: true,
  lastActivityAt: true, // stale-thread detection (24h bot restart)
};

// A lead that went quiet for this long and then writes again gets a FRESH bot
// run — no resuming a days-old flow question, no permanent "one & done" silence.
const STALE_CONVERSATION_MS = 24 * 60 * 60 * 1000;

// ── Out-of-hours (structured KB businessHours) ───────────────
// Day indexing matches the UI chips: 0=Sunday(א׳) … 6=Saturday(ש׳).
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// True when the tenant's structured schedule says "closed right now".
// Disabled/missing/malformed schedule → never out-of-hours (fail open).
function isOutOfHours(businessHours, timezone) {
  const bh = businessHours;
  if (!bh || bh.enabled !== true || !bh.awayMessage) return false;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'Asia/Jerusalem',
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value || '';
    const day = WEEKDAY_INDEX[get('weekday')];
    const hhmm = `${get('hour')}:${get('minute')}`;
    if (!Array.isArray(bh.days) || !bh.days.includes(day)) return true;
    return hhmm < (bh.open || '00:00') || hhmm >= (bh.close || '24:00');
  } catch {
    return false;
  }
}

// Don't repeat the away message on every night-time ping: suppress a resend if
// the SAME away text already went out on this conversation in the last 6h.
const AWAY_RESEND_MS = 6 * 60 * 60 * 1000;
function awayAlreadySentRecently(history, awayMessage) {
  const cutoff = Date.now() - AWAY_RESEND_MS;
  return history.some(
    (m) =>
      m.senderType === 'agent' &&
      m.messageText === awayMessage &&
      new Date(m.createdAt).getTime() > cutoff
  );
}

/**
 * Main entry point: process one inbound customer message end-to-end, on behalf
 * of a specific tenant. `tenant` is the full Tenant row (its WhatsApp creds are
 * used to reply). Returns { conversation, agentResponse, replySent }.
 */
export async function handleIncomingMessage({ tenant, phone: rawPhone, text, name, rawPayload, waMessageId, forceFlowId, simulated }) {
  if (!tenant?.id) throw new Error('handleIncomingMessage requires a tenant');
  const tenantId = tenant.id;
  const creds = tenantWhatsAppCreds(tenant);

  // Canonicalize the number up front so the SAME contact in different formats
  // (e.g. "0545532316" and "972545532316") resolves to ONE customer/thread —
  // otherwise each format becomes its own Customer row and shows as a duplicate.
  const phone = normalizePhone(rawPhone) || rawPhone;

  // 0) Idempotency: Meta delivers webhooks at-least-once. If we've already
  // stored this inbound message id for this tenant, skip re-processing.
  //
  // TOCTOU (AP-T72): this findUnique is only a cheap FAST-PATH — under two truly
  // concurrent deliveries of the SAME waMessageId, both can pass this check before
  // either has inserted the row, then both would create + reply (double answer +
  // double LLM charge). The REAL guard is the inbound message.create() below, which
  // is made the atomic dedup gate: it relies on the Message @@unique([tenantId,
  // waMessageId]) constraint and treats a P2002 unique violation as "duplicate,
  // skip reply". This mirrors the atomic-conditional TOCTOU fixes in credits.js
  // (chargeAiCredit / markLowCreditNudge) and admin.js (mark-paid) — exactly one
  // concurrent caller wins the insert; the loser bails without replying.
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

  // 2) ONE conversation per customer — a single WhatsApp-style thread per phone.
  // Reuse the customer's existing conversation (reopening/resetting it as needed);
  // only a brand-new customer gets a freshly created conversation. This is what
  // stops a "duplicate" conversation row from accumulating per session for one
  // number — the inbox shows one thread per contact, like WhatsApp itself.
  let conversation = await prisma.conversation.findFirst({
    where: { tenantId, customerId: customer.id },
    orderBy: { lastActivityAt: 'desc' },
    select: CONVERSATION_ENGINE_SELECT,
  });

  if (conversation) {
    const idleMs = conversation.lastActivityAt
      ? Date.now() - new Date(conversation.lastActivityAt).getTime()
      : Infinity;
    const flowCompleted = conversation.status === 'completed' && conversation.currentFlowId != null;

    // 2a) "One & done": completed a FLOW within 24h → record the inbound message
    // (so it's visible in the dashboard) and stay silent — don't re-run the flow.
    // History and collected answers are kept. Scoped to flow-completed threads so
    // plain chit-chat the AI marked "completed" doesn't silence the customer.
    if (!forceFlowId && flowCompleted && idleMs <= STALE_CONVERSATION_MS) {
      // Atomic dedup gate: a concurrent same-waMessageId delivery that already
      // stored this message makes the create throw P2002 → treat as duplicate.
      try {
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
      } catch (err) {
        if (isDuplicateWaMessage(err)) {
          return { conversation: null, agentResponse: null, replySent: false, duplicate: true };
        }
        throw err;
      }
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessage: text, lastActivityAt: new Date() },
        select: { id: true }, // drift-safe: don't RETURNING the unmigrated window cols (AP-T71)
      });
      await trackEvent(EVENTS.MESSAGE_RECEIVED, {
        tenantId,
        conversationId: conversation.id,
        customerId: customer.id,
        customerPhone: phone,
        metadata: { text, suppressed: true },
      });
      return { conversation, agentResponse: null, replySent: false, isNew: false, suppressed: true };
    }

    // 2-stale) 24h idle → restart the bot's process on this thread: clear the flow
    // pointers (no resuming a days-old mid-flow question) and hand it back to the
    // bot. History/answers are kept — only the STATE resets.
    if (idleMs > STALE_CONVERSATION_MS) {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { currentFlowId: null, currentQuestionId: null, status: 'active', needsHuman: false },
        select: CONVERSATION_ENGINE_SELECT,
      });
    } else if (conversation.status !== 'active' && conversation.status !== 'needs_human') {
      // Reopen a completed/abandoned thread (within 24h) so the bot engages again in
      // the SAME thread instead of spawning a new one. Keep the flow pointers — only
      // the stale path above clears them.
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: 'active', needsHuman: false },
        select: CONVERSATION_ENGINE_SELECT,
      });
    }

    // Simulator: when a specific flow is force-selected, clear any prior flow state
    // so the chosen flow starts FRESH from its first question — even if a previous
    // flow was mid-run or completed on this test thread.
    if (forceFlowId && conversation.currentFlowId) {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { currentFlowId: null, currentQuestionId: null, status: 'active', needsHuman: false },
        select: CONVERSATION_ENGINE_SELECT,
      });
    }
  }

  let isNew = false;
  if (!conversation) {
    // NOTE (orphan-conversation race): this create is deliberately NOT atomically
    // deduped by waMessageId — under two concurrent same-waMessageId deliveries both
    // handlers reach here and both create a Conversation. That's harmless for the
    // reply/charge path (the message-create gate at step 3 still lets exactly one
    // win), but the loser's empty row is cleaned up in that gate's P2002 catch below.
    conversation = await prisma.conversation.create({
      // isTest marks simulator threads so they stay out of the real inbox.
      data: { tenantId, customerId: customer.id, whatsappPhone: phone, status: 'active', isTest: !!simulated },
      select: CONVERSATION_ENGINE_SELECT, // drift-safe (AP-T71): don't RETURNING window cols
    });
    isNew = true;
    await trackEvent(EVENTS.CONVERSATION_STARTED, {
      tenantId,
      conversationId: conversation.id,
      customerId: customer.id,
      customerPhone: phone,
    });
    // New lead → notify any configured outbound webhook (Webhook/CRM, Zapier/Make).
    // Fire-and-forget: never blocks the reply pipeline.
    deliverLeadEvent(tenantId, 'lead.created', {
      contact: { name: customer.name || null, phone: customer.phone || phone },
      conversationId: conversation.id,
      firstMessage: text,
    });
  }

  // 3) Save incoming message — THIS is the atomic dedup gate (see the TOCTOU note
  // at step 0). Under two truly-concurrent deliveries of the same waMessageId, both
  // may pass the step-0 findUnique fast-path, but only ONE insert can satisfy the
  // Message @@unique([tenantId, waMessageId]) constraint. The loser throws P2002 →
  // we return early (duplicate) BEFORE running the LLM, charging a credit, or
  // sending a WhatsApp reply, so the customer gets exactly one answer, charged once.
  try {
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
  } catch (err) {
    if (isDuplicateWaMessage(err)) {
      // ORPHAN-CONVERSATION RACE (data-hygiene): the conversation.create() at step 2
      // (above) is NOT itself atomically deduped — under two concurrent deliveries of
      // the SAME waMessageId for a customer with NO open conversation, BOTH handlers
      // pass the step-0 fast-path AND both create a fresh Conversation before either
      // reaches this message-create gate. Only ONE wins the message insert; the other
      // (this one, if isNew) is left holding a brand-new Conversation with ZERO
      // messages — an empty status:'active' row that pollutes the dashboard's active
      // list, plus a stray CONVERSATION_STARTED analytics event. It does NOT cause a
      // double reply/charge (that's already guarded), so we clean it up here rather
      // than adding a live-DB unique constraint. Safe because at this point nothing
      // has been written to `conversation` yet (this failed insert would have been its
      // first message).
      //
      // ⚠ DATA-LOSS RACE (AP-T72): `isNew` does NOT prove the row is still empty by the
      // time this cleanup runs. A CONCURRENT, DISTINCT-waMessageId inbound message for
      // the SAME customer can independently run its own step-2 findFirst, find THIS
      // freshly-created conversation "active", and attach a REAL message to it before
      // this handler's cleanup fires. An unconditional conversation.delete() would then
      // CASCADE-DELETE (Message.conversationId is required + onDelete:Cascade) that
      // other customer's genuine message — silent, no crash, "the message just vanished".
      // So the delete is a CONDITIONAL delete: it only removes the row if it STILL has
      // zero messages (messages:{none:{}}), checked atomically at delete time. If a
      // message attached in the race window, the delete matches 0 rows → we leave the
      // (now non-empty, legitimately in-use) conversation alone and NEVER destroy the
      // attached message. Mirrors the atomic-conditional updateMany/deleteMany pattern
      // used by the needsHuman flip below and credits.js/admin.js. Worst case on a lost
      // race is a harmless empty active row left behind — never a lost message.
      // Best-effort: a cleanup failure must never turn a duplicate into a thrown error.
      if (isNew) {
        try {
          // Reap the stray CONVERSATION_STARTED event FIRST, guarded on the conversation
          // still being message-less (`conversation: { messages: { none: {} } }`). This
          // must precede the conversation delete: AnalyticsEvent→Conversation is
          // onDelete:SetNull, so once the conversation row is gone the event's
          // conversationId is NULLed and can no longer be matched to reap. The relation
          // guard means we only strip the event off a row we're genuinely about to
          // delete (still empty) — never off a row a concurrent message put back in use.
          await prisma.analyticsEvent.deleteMany({
            where: {
              tenantId,
              conversationId: conversation.id,
              eventName: EVENTS.CONVERSATION_STARTED,
              conversation: { messages: { none: {} } },
            },
          });
          // Then the CONDITIONAL conversation delete: matches only while still empty.
          // count===0 ⇒ a concurrent distinct-waMessageId message attached in the race
          // window; leaving the (now in-use) conversation + its message intact is correct.
          await prisma.conversation.deleteMany({
            where: { id: conversation.id, messages: { none: {} } },
          });
        } catch (cleanupErr) {
          console.error('[engine] failed to clean up orphan conversation after dedup race:', cleanupErr.message);
        }
      }
      return { conversation: null, agentResponse: null, replySent: false, duplicate: true };
    }
    throw err;
  }
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

  // 4.5) Out-of-hours: outside the structured schedule the bot answers with the
  // configured away message instead of running flows/AI (inbound already stored,
  // thread stays open). Re-sends are throttled to once per 6h per conversation.
  if (isOutOfHours(kb?.businessHours, tenant.timezone)) {
    const away = kb.businessHours.awayMessage;
    if (!awayAlreadySentRecently(history, away)) {
      try {
        await sendWhatsAppMessage(creds, phone, away);
      } catch (err) {
        console.error('[engine] out-of-hours reply failed:', err.message);
      }
      await prisma.message.create({
        data: {
          tenantId,
          conversationId: conversation.id,
          senderType: 'agent',
          messageText: away,
          intent: 'out_of_hours',
          rawPayload: { via: 'rules' },
        },
      });
    }
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessage: text, lastActivityAt: new Date() },
      select: { id: true },
    });
    return {
      conversation,
      agentResponse: { intent: 'out_of_hours', response_text: kb.businessHours.awayMessage },
      replySent: true,
      outOfHours: true,
    };
  }

  // Deterministic flow selection when not already inside a flow:
  //  1) a flow whose trigger words appear in the message, else
  //  2) a "default" flow (isDefault) that starts on ANY message (e.g. "hey").
  let suggestedFlow = null;
  if (!conversation.currentFlowId) {
    // Simulator: `forceFlowId` explicitly picks the flow to test, bypassing
    // trigger-word matching (only ever set by /simulate — the webhook path is
    // unaffected). Falls back to normal matching if the id isn't a tenant flow.
    const forced = forceFlowId ? flows.find((fl) => fl.id === forceFlowId) : null;
    if (forced) {
      suggestedFlow = { id: forced.id, name: forced.name };
    } else {
      const lc = text.toLowerCase();
      const matched = flows.find((fl) => fl.triggerWords?.some((w) => w && lc.includes(String(w).toLowerCase())));
      const fallback = matched || flows.find((fl) => fl.isDefault);
      if (fallback) suggestedFlow = { id: fallback.id, name: fallback.name };
    }
  }

  const ctx = {
    incomingText: text,
    tenant, // selects the AI provider (BYO key vs platform) in services/llm.js
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
  // Which engine produced the visible reply text — persisted on the Message so the
  // inbox can label it honestly: 'ai' (real LLM text) vs 'flow'/'rules' (bot).
  let replyVia = 'flow';
  if (conversation.currentFlowId) {
    // Mid-flow → record answer + advance, deterministically.
    agentResponse = ruleBasedResponse(ctx);
  } else if (suggestedFlow) {
    // Trigger word matched → start that flow fresh from question 1.
    ctx.state.startFlowId = suggestedFlow.id;
    agentResponse = ruleBasedResponse(ctx);
  } else {
    // No flow context. Reply-engine PRIORITY (system-wide "local Claude for everyone"):
    //   1) the tenant's OWN AI key (BYO) → built-in AI on their key, unmetered;
    //   2) otherwise → the central local-Claude pipeline (run AFTER lead scoring below,
    //      metered by the 10/day free quota → 1 credit/reply over the cap).
    // So we only call the built-in cloud AI for BYO tenants; everyone else gets a
    // rule-based skeleton here and the pipeline fills in the real reply downstream —
    // which is why no platform OpenAI key is needed.
    const byoKey = tenant.aiProvider && tenant.aiApiKeyEnc;
    const aiOn = tenant.aiEnabled !== false;
    const allowAI = aiOn && !!byoKey; // built-in AI runs ONLY on a tenant's own key
    const { response: llm, ai } = await generateAgentResponse(ctx, { allowAI });
    // BYO replies are ai.billable:false → no platform credit charge, no daily cap.
    const wantsToStart =
      llm.flow_id &&
      flows.some((f) => f.id === llm.flow_id) &&
      (llm.next_action === 'ask_next_question' || llm.intent === 'predefined_flow_start');
    if (wantsToStart) {
      // LLM detected the customer wants a flow → start it deterministically.
      // The VISIBLE text is the deterministic flow question, so it tags as bot.
      ctx.state.startFlowId = llm.flow_id;
      agentResponse = ruleBasedResponse(ctx);
    } else {
      agentResponse = llm; // BYO KB answer, or a rule-based skeleton (pipeline fills in)
      replyVia = ai.used ? 'ai' : 'rules';
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

  // Local-Claude pipeline = the PRIMARY free-form reply engine for tenants WITHOUT their
  // own AI key. (BYO tenants were already answered on their own key above; deterministic
  // flow steps — replyVia 'flow' — are never overridden.) The effective provider is the
  // tenant's own reply-provider if set, else the platform-wide default pipeline.
  //
  // Metering (revenue-safe): the first 10 replies/day/customer are free; beyond that each
  // reply costs exactly 1 credit (priced above the per-reply model cost). We gate BEFORE
  // answering (free slot OR credits available) and meter only AFTER a real reply comes
  // back, so a pass/timeout is never charged. Over the cap with no credits → hand off.
  const byoKey = tenant.aiProvider && tenant.aiApiKeyEnc;
  const aiOn = tenant.aiEnabled !== false;
  const pipeline = aiOn && !byoKey && replyVia === 'rules' ? await effectiveReplyProvider(tenant) : null;
  if (pipeline?.enabled) {
    const canAnswer = hasFreeQuotaToday(tenant) || (await hasCredits(tenantId));
    if (!canAnswer) {
      outOfCredits = true;
      agentResponse.needs_human = true; // over the daily cap and no credits → human handoff
      await markLowCreditNudge(tenantId);
    } else {
      const provided = await generateViaProvider(tenant, { conversation, customer, phone, text, history, kb, flows }, pipeline);
      if (provided?.reply) {
        // Meter only on a real answer: consume a free daily slot, else charge 1 credit.
        const free = await consumeDailyFreeReply(tenantId);
        if (!free) await spendOneCredit({ tenantId, reason: 'ai_reply' });
        else if (tenant.lowCreditNotifiedAt) await prisma.tenant.update({ where: { id: tenantId }, data: { lowCreditNotifiedAt: null } }).catch(() => {});
        agentResponse.reply = provided.reply;
        replyText = provided.reply; // the provider owns its full reply text (incl. any link)
        replyVia = 'ai'; // real AI text → inbox shows "✨ סוכן AI"
        agentResponse.needs_human = provided.needs_human === true;
        if (provided.conversation_status) agentResponse.conversation_status = provided.conversation_status;
        if (provided.calendar_event !== undefined) agentResponse.calendar_event = provided.calendar_event;
      } else {
        // Pipeline passed / is down → no charge; hand off to a human (safety net).
        agentResponse.needs_human = true;
      }
    }
  }

  // Google Calendar: if the agent confirmed a concrete booking, create the event on
  // the tenant's connected calendar (best-effort, fire-and-forget — dormant until
  // the Calendar integration is connected).
  if (agentResponse.calendar_event?.start) {
    bookCalendarBestEffort(tenantId, agentResponse.calendar_event, { name: customer.name, phone });
  }

  // Persist the per-message state (everything EXCEPT the needsHuman flip, which is
  // handled atomically below). needsHuman is deliberately left out of this update so
  // the notify gate can be a race-safe conditional flip (see next block).
  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: agentResponse.conversation_status,
      intent: agentResponse.intent,
      currentFlowId: agentResponse.flow_id,
      currentQuestionId: agentResponse.current_question_id,
      lastMessage: text,
      leadScore,
      linkSent,
      lastActivityAt: new Date(),
    },
    select: CONVERSATION_ENGINE_SELECT, // drift-safe (AP-T71): don't RETURNING window cols
  });

  // Owner handoff notification (§2.4): the moment a conversation newly needs a
  // human, WhatsApp the business owner with context. Fire only on the false→true
  // edge; best-effort (never breaks the reply pipeline).
  //
  // TOCTOU-safe (AP-T72): the notify gate IS the DB write. Two near-simultaneous
  // triggers (a rapid customer message + a concurrent admin assign-human, or two
  // webhook deliveries) could both read needsHuman:false before either wrote true,
  // double-alerting the owner. Instead of read-then-write, the flip is a single
  // conditional updateMany({ where: { needsHuman: false } }) — exactly ONE caller
  // gets count===1 (wins the flip) and sends; all others get 0 and stay silent.
  // Mirrors the credits.js window-open gate and payments.js mark-paid flip.
  if (agentResponse.needs_human) {
    const flip = await prisma.conversation.updateMany({
      where: { id: conversation.id, needsHuman: false },
      data: { needsHuman: true },
    });
    conversation.needsHuman = true;
    if (flip.count === 1) {
      await notifyOwnerHandoff({
        tenant,
        conversation: { ...conversation, whatsappPhone: phone, lastMessage: text },
        customer: { name: customer.name, phone: customer.phone || phone },
      });
      // Handoff → also fire the outbound webhook (fire-and-forget).
      deliverLeadEvent(tenantId, 'lead.needs_human', {
        contact: { name: customer.name || null, phone: customer.phone || phone },
        conversationId: conversation.id,
        lastMessage: text,
        leadScore,
      });
    }
  } else {
    // Not (or no longer) needing a human — clear the flag without notifying.
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { needsHuman: false },
      select: { id: true },
    });
    conversation.needsHuman = false;
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
        // Honest sender tag for the inbox (no `type` key, so the media-card
        // detection in the frontend keeps ignoring this payload).
        rawPayload: { via: replyVia },
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
