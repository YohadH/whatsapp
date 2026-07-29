import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.js';
import { EVENTS } from '../services/analytics.js';

// Every query is scoped to req.tenantId (set by the withTenant middleware).
const router = Router();

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
};
const dayKey = (date) => new Date(date).toISOString().slice(0, 10);

// Build a continuous daily series [{date, ...zeros}] for the last `days` days.
function emptySeries(days, keys) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysAgo(i);
    const row = { date: dayKey(d) };
    keys.forEach((k) => (row[k] = 0));
    out.push(row);
  }
  return out;
}
function bucketInto(series, items, getDate, key, inc = 1) {
  const idx = Object.fromEntries(series.map((r, i) => [r.date, i]));
  for (const it of items) {
    const k = dayKey(getDate(it));
    if (idx[k] !== undefined) series[idx[k]][key] += inc;
  }
  return series;
}

// ── Overview KPIs ────────────────────────────────────────────
router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const [
      totalConversations,
      newToday,
      openConversations,
      completedConversations,
      waitingForHuman,
      totalLeads,
      abandoned,
    ] = await Promise.all([
      prisma.conversation.count({ where: { tenantId } }),
      prisma.conversation.count({ where: { tenantId, createdAt: { gte: startOfToday() } } }),
      prisma.conversation.count({ where: { tenantId, status: 'active' } }),
      prisma.conversation.count({ where: { tenantId, status: 'completed' } }),
      prisma.conversation.count({ where: { tenantId, OR: [{ status: 'needs_human' }, { needsHuman: true }] } }),
      prisma.customer.count({ where: { tenantId } }),
      prisma.conversation.count({ where: { tenantId, status: 'abandoned' } }),
    ]);

    // Most used flow (by flow_started events)
    const flowStarts = await prisma.analyticsEvent.groupBy({
      by: ['flowId'],
      where: { tenantId, eventName: EVENTS.FLOW_STARTED, flowId: { not: null } },
      _count: { flowId: true },
      orderBy: { _count: { flowId: 'desc' } },
      take: 1,
    });
    let mostUsedFlow = null;
    if (flowStarts[0]?.flowId) {
      const f = await prisma.flow.findFirst({ where: { id: flowStarts[0].flowId, tenantId }, select: { id: true, name: true } });
      mostUsedFlow = f ? { ...f, count: flowStarts[0]._count.flowId } : null;
    }

    // Most clicked link
    const mostClickedLink = await prisma.link.findFirst({
      where: { tenantId },
      orderBy: { clicksCount: 'desc' },
      select: { id: true, name: true, clicksCount: true },
    });

    // Average response time (customer msg → next agent msg), sampled over recent messages
    const recentMsgs = await prisma.message.findMany({
      where: { tenantId, createdAt: { gte: daysAgo(30) } },
      orderBy: { createdAt: 'asc' },
      select: { conversationId: true, senderType: true, createdAt: true },
      take: 5000,
    });
    const lastCustomerAt = {};
    const deltas = [];
    for (const m of recentMsgs) {
      if (m.senderType === 'customer') lastCustomerAt[m.conversationId] = m.createdAt;
      else if (m.senderType === 'agent' && lastCustomerAt[m.conversationId]) {
        deltas.push((new Date(m.createdAt) - new Date(lastCustomerAt[m.conversationId])) / 1000);
        delete lastCustomerAt[m.conversationId];
      }
    }
    const avgResponseTimeSec = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;

    const conversionRate = totalConversations ? +((completedConversations / totalConversations) * 100).toFixed(1) : 0;

    res.json({
      totalConversations,
      newToday,
      openConversations,
      completedConversations,
      waitingForHuman,
      totalLeads,
      conversionRate,
      mostUsedFlow,
      mostClickedLink,
      avgResponseTimeSec,
      droppedBeforeComplete: abandoned,
    });
  })
);

// ── Conversations & leads over time ──────────────────────────
router.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const days = Math.min(180, parseInt(req.query.days || '30', 10));
    const since = daysAgo(days - 1);

    const [convs, leadEvents, customers] = await Promise.all([
      prisma.conversation.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.analyticsEvent.findMany({
        where: { tenantId, eventName: EVENTS.FLOW_COMPLETED, createdAt: { gte: since } },
        select: { createdAt: true },
      }),
      prisma.customer.findMany({ where: { tenantId, createdAt: { gte: since } }, select: { createdAt: true } }),
    ]);

    let series = emptySeries(days, ['conversations', 'leads', 'newCustomers']);
    series = bucketInto(series, convs, (c) => c.createdAt, 'conversations');
    series = bucketInto(series, leadEvents, (e) => e.createdAt, 'leads');
    series = bucketInto(series, customers, (c) => c.createdAt, 'newCustomers');

    // returning vs new customers (lifetime)
    const grouped = await prisma.conversation.groupBy({ by: ['customerId'], where: { tenantId }, _count: { customerId: true } });
    const returning = grouped.filter((g) => g._count.customerId > 1).length;
    const newCustomers = grouped.filter((g) => g._count.customerId === 1).length;

    res.json({ series, returningCustomers: returning, newCustomers });
  })
);

// ── Flow performance & funnel-per-flow ───────────────────────
router.get(
  '/flows',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const flows = await prisma.flow.findMany({ where: { tenantId }, select: { id: true, name: true } });
    const events = await prisma.analyticsEvent.groupBy({
      by: ['eventName', 'flowId'],
      where: { tenantId, flowId: { not: null }, eventName: { in: [EVENTS.FLOW_STARTED, EVENTS.FLOW_COMPLETED, EVENTS.FLOW_ABANDONED] } },
      _count: { _all: true },
    });
    const lookup = {};
    for (const e of events) {
      lookup[e.flowId] ??= {};
      lookup[e.flowId][e.eventName] = e._count._all;
    }

    const rows = flows.map((f) => {
      const started = lookup[f.id]?.[EVENTS.FLOW_STARTED] || 0;
      const completed = lookup[f.id]?.[EVENTS.FLOW_COMPLETED] || 0;
      const abandoned = lookup[f.id]?.[EVENTS.FLOW_ABANDONED] || 0;
      return {
        flowId: f.id,
        name: f.name,
        started,
        completed,
        abandoned,
        conversionRate: started ? +((completed / started) * 100).toFixed(1) : 0,
      };
    });

    const ranked = [...rows].filter((r) => r.started > 0).sort((a, b) => b.conversionRate - a.conversionRate);
    res.json({
      flows: rows,
      bestConverting: ranked[0] || null,
      worstConverting: ranked[ranked.length - 1] || null,
    });
  })
);

// ── Link clicks ──────────────────────────────────────────────
router.get(
  '/links',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const links = await prisma.link.findMany({ where: { tenantId }, select: { id: true, name: true, clicksCount: true } });

    // Count link_sent events per linkId by reading the (deserialized) metadata.
    const sentEvents = await prisma.analyticsEvent.findMany({
      where: { tenantId, eventName: EVENTS.LINK_SENT },
      select: { metadata: true },
    });
    const sentByLink = {};
    for (const e of sentEvents) {
      const linkId = e.metadata?.linkId;
      if (linkId) sentByLink[linkId] = (sentByLink[linkId] || 0) + 1;
    }

    const rows = links.map((l) => {
      const sentCount = sentByLink[l.id] || 0;
      return {
        linkId: l.id,
        name: l.name,
        clicks: l.clicksCount,
        sent: sentCount,
        clickRate: sentCount ? +((l.clicksCount / sentCount) * 100).toFixed(1) : 0,
      };
    });
    res.json({ links: rows });
  })
);

// ── Questions: customers-by-intent, drop-off by question ─────
router.get(
  '/questions',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;

    // PERF (BUG-WA-ANALYTICS-SLOW-QUESTIONS): this handler previously issued six
    // queries strictly SERIALLY (await one after another). On the remote Supabase
    // pooler each round-trip is ~300ms+, so the latencies stacked into a
    // multi-second — up to ~19s on the production tenant — response. The five
    // INDEPENDENT queries below are now issued in one Promise.all wave; only the
    // per-question `flowQuestion` lookup (which needs the `asked` ids) runs after.
    //
    // Two of the old queries were also structurally wasteful:
    //  • byIntent used groupBy(['conversationId']) and then read ONLY `.length` —
    //    materializing one row per distinct conversation (unbounded, no date/limit)
    //    purely to count distinct conversations. Replaced with a single
    //    COUNT(DISTINCT "conversationId") scalar aggregate (index [tenantId,eventName]).
    //  • unanswered used a Message→Conversation relation filter
    //    (`conversation: { needsHuman: true }`) with no supporting index on
    //    Message(tenantId, senderType), forcing a correlated join scan. Replaced
    //    with a two-step: fetch the (small, [tenantId,status]-indexed) needs-human
    //    conversation ids, then filter messages by `conversationId in (...)` which
    //    uses the Message(conversationId) index. On an empty needs-human set we skip
    //    the message query entirely.
    const [
      distinctIntentConversations,
      intentCounts,
      needsHumanConvs,
      asked,
      answered,
    ] = await Promise.all([
      // Customers by intent → we only need the DISTINCT-conversation COUNT, not the rows.
      prisma.$queryRaw`
        SELECT COUNT(DISTINCT "conversationId")::int AS count
        FROM "AnalyticsEvent"
        WHERE "tenantId" = ${tenantId}
          AND "eventName" = ${EVENTS.INTENT_DETECTED}
          AND "conversationId" IS NOT NULL
      `,
      prisma.conversation.groupBy({
        by: ['intent'],
        where: { tenantId, intent: { not: null } },
        _count: { intent: true },
      }),
      // Small, index-covered set of needs-human conversations for this tenant.
      prisma.conversation.findMany({
        where: { tenantId, needsHuman: true },
        select: { id: true },
      }),
      // Drop-off by question (asked vs answered per question)
      prisma.analyticsEvent.groupBy({
        by: ['questionId'],
        where: { tenantId, eventName: EVENTS.QUESTION_ASKED, questionId: { not: null } },
        _count: { _all: true },
      }),
      prisma.analyticsEvent.groupBy({
        by: ['questionId'],
        where: { tenantId, eventName: EVENTS.QUESTION_ANSWERED, questionId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const customersByIntent = intentCounts
      .map((i) => ({ intent: i.intent, count: i._count.intent }))
      .sort((a, b) => b.count - a.count);

    // Most common unanswered → last messages from conversations that went to human.
    const needsHumanIds = needsHumanConvs.map((c) => c.id);
    const unanswered = needsHumanIds.length
      ? await prisma.message.findMany({
          where: { tenantId, senderType: 'customer', conversationId: { in: needsHumanIds } },
          select: { messageText: true },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
      : [];

    const answeredMap = Object.fromEntries(answered.map((a) => [a.questionId, a._count._all]));
    const qIds = asked.map((a) => a.questionId);
    const questions = qIds.length
      ? await prisma.flowQuestion.findMany({
          where: { id: { in: qIds }, tenantId },
          select: { id: true, questionText: true, orderIndex: true },
        })
      : [];
    const qMap = Object.fromEntries(questions.map((q) => [q.id, q]));
    const dropOff = asked
      .map((a) => {
        const askedN = a._count._all;
        const answeredN = answeredMap[a.questionId] || 0;
        return {
          questionId: a.questionId,
          question: qMap[a.questionId]?.questionText || a.questionId,
          asked: askedN,
          answered: answeredN,
          dropOff: askedN - answeredN,
          dropOffRate: askedN ? +(((askedN - answeredN) / askedN) * 100).toFixed(1) : 0,
        };
      })
      .sort((a, b) => b.dropOff - a.dropOff);

    res.json({
      customersByIntent,
      mostCommonUnanswered: unanswered.map((u) => u.messageText),
      dropOffByQuestion: dropOff,
      _distinctIntentConversations: distinctIntentConversations[0]?.count ?? 0,
    });
  })
);

// ── Funnel ───────────────────────────────────────────────────
router.get(
  '/funnel',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const stages = [
      { key: 'conversation_started', label: 'שיחות שהתחילו', event: EVENTS.CONVERSATION_STARTED },
      { key: 'flow_started', label: 'תהליכים שהתחילו', event: EVENTS.FLOW_STARTED },
      { key: 'question_answered', label: 'תשובות שנאספו', event: EVENTS.QUESTION_ANSWERED },
      { key: 'flow_completed', label: 'תהליכים שהושלמו', event: EVENTS.FLOW_COMPLETED },
      { key: 'link_clicked', label: 'קליקים על קישור', event: EVENTS.LINK_CLICKED },
    ];
    const counts = await Promise.all(
      stages.map((s) => prisma.analyticsEvent.count({ where: { tenantId, eventName: s.event } }))
    );
    res.json({ funnel: stages.map((s, i) => ({ stage: s.label, key: s.key, count: counts[i] })) });
  })
);

export default router;
