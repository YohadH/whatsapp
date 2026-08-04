// One-off / maintenance: merge duplicate conversations into a single thread per
// (tenant, customer=phone). The engine now keeps ONE conversation per phone
// (services/conversationEngine.js), but accounts that accumulated multiple
// conversation rows before that change need consolidating.
//
// Keeper = the most recently active conversation for the customer. Every other
// conversation's messages / customer answers / analytics events are reassigned to
// the keeper, then the now-empty duplicates are deleted. Keeper's leadScore is set
// to the group max and its lastMessage/lastActivityAt recomputed from messages.
//
// Usage:  node scripts/merge-duplicate-conversations.mjs
import prisma from '../src/lib/prisma.js';

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  let removed = 0;
  for (const t of tenants) {
    const convos = await prisma.conversation.findMany({
      where: { tenantId: t.id },
      select: { id: true, customerId: true, lastActivityAt: true, createdAt: true, leadScore: true },
    });
    const byCust = {};
    for (const c of convos) (byCust[c.customerId] ||= []).push(c);
    for (const group of Object.values(byCust)) {
      if (group.length < 2) continue;
      group.sort((a, b) => new Date(b.lastActivityAt || b.createdAt) - new Date(a.lastActivityAt || a.createdAt));
      const keeper = group[0];
      const maxScore = Math.max(...group.map((g) => g.leadScore || 0));
      for (const ex of group.slice(1)) {
        await prisma.message.updateMany({ where: { conversationId: ex.id }, data: { conversationId: keeper.id } });
        await prisma.customerAnswer.updateMany({ where: { conversationId: ex.id }, data: { conversationId: keeper.id } });
        await prisma.analyticsEvent.updateMany({ where: { conversationId: ex.id }, data: { conversationId: keeper.id } });
        await prisma.conversation.delete({ where: { id: ex.id } });
        removed++;
      }
      const last = await prisma.message.findFirst({
        where: { conversationId: keeper.id },
        orderBy: { createdAt: 'desc' },
        select: { messageText: true, createdAt: true },
      });
      await prisma.conversation.update({
        where: { id: keeper.id },
        data: { leadScore: maxScore, ...(last ? { lastMessage: last.messageText, lastActivityAt: last.createdAt } : {}) },
      });
    }
    const after = await prisma.conversation.count({ where: { tenantId: t.id } });
    if (convos.length !== after) console.log(`${t.name}: ${convos.length} → ${after} conversations`);
  }
  console.log('duplicate conversations removed:', removed);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
