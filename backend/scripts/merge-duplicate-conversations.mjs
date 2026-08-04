// Maintenance: consolidate duplicate customers/conversations so there is ONE
// customer and ONE thread per real phone number.
//
// The engine now (a) canonicalizes inbound numbers with normalizePhone and (b)
// keeps a single conversation per customer. Accounts created before those changes
// can hold two kinds of duplicates:
//   1. Same number in different formats → two Customer rows
//      ("0545532316" vs "972545532316").
//   2. One customer with several conversation rows (a thread per past session).
//
// This script fixes both:
//   Step 1 — group customers by normalizePhone(phone); reassign the duplicates'
//            conversations / answers / events to a single keeper, set the keeper's
//            phone to the normalized value, delete the duplicate customers.
//   Step 2 — for each customer with >1 conversation, merge into the most-recent
//            keeper (messages/answers/events reassigned, empties deleted) and
//            normalize the thread's whatsappPhone.
//
// Usage:  node scripts/merge-duplicate-conversations.mjs
import prisma from '../src/lib/prisma.js';
import { normalizePhone } from '../src/lib/phone.js';

async function mergeCustomers(tenantId) {
  const customers = await prisma.customer.findMany({ where: { tenantId }, select: { id: true, phone: true, name: true } });
  const byNorm = {};
  for (const c of customers) {
    const key = normalizePhone(c.phone) || c.phone;
    (byNorm[key] ||= []).push(c);
  }
  let removed = 0;
  for (const [norm, group] of Object.entries(byNorm)) {
    if (group.length < 2) {
      // Single customer — still normalize its phone if it drifted from canonical.
      const only = group[0];
      if (only.phone !== norm) {
        const clash = await prisma.customer.findFirst({ where: { tenantId, phone: norm, NOT: { id: only.id } }, select: { id: true } });
        if (!clash) await prisma.customer.update({ where: { id: only.id }, data: { phone: norm } });
      }
      continue;
    }
    // Prefer the customer already at the canonical number, and one with a name.
    group.sort((a, b) => (b.phone === norm ? 1 : 0) - (a.phone === norm ? 1 : 0) || (b.name ? 1 : 0) - (a.name ? 1 : 0));
    const keeper = group[0];
    for (const dup of group.slice(1)) {
      await prisma.conversation.updateMany({ where: { customerId: dup.id }, data: { customerId: keeper.id } });
      await prisma.customerAnswer.updateMany({ where: { customerId: dup.id }, data: { customerId: keeper.id } });
      await prisma.analyticsEvent.updateMany({ where: { customerId: dup.id }, data: { customerId: keeper.id } });
      await prisma.customer.delete({ where: { id: dup.id } });
      removed++;
    }
    await prisma.customer.update({
      where: { id: keeper.id },
      data: { phone: norm, ...(keeper.name ? {} : { name: group.find((g) => g.name)?.name || null }) },
    });
  }
  return removed;
}

async function mergeConversations(tenantId) {
  const convos = await prisma.conversation.findMany({
    where: { tenantId },
    select: { id: true, customerId: true, whatsappPhone: true, lastActivityAt: true, createdAt: true, leadScore: true },
  });
  const byCust = {};
  for (const c of convos) (byCust[c.customerId] ||= []).push(c);
  let removed = 0;
  for (const group of Object.values(byCust)) {
    if (group.length < 2) {
      const only = group[0];
      const norm = normalizePhone(only.whatsappPhone);
      if (norm && norm !== only.whatsappPhone) await prisma.conversation.update({ where: { id: only.id }, data: { whatsappPhone: norm } });
      continue;
    }
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
    const last = await prisma.message.findFirst({ where: { conversationId: keeper.id }, orderBy: { createdAt: 'desc' }, select: { messageText: true, createdAt: true } });
    await prisma.conversation.update({
      where: { id: keeper.id },
      data: {
        leadScore: maxScore,
        whatsappPhone: normalizePhone(keeper.whatsappPhone) || keeper.whatsappPhone,
        ...(last ? { lastMessage: last.messageText, lastActivityAt: last.createdAt } : {}),
      },
    });
  }
  return removed;
}

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  let custRemoved = 0;
  let convRemoved = 0;
  for (const t of tenants) {
    const cr = await mergeCustomers(t.id);
    const vr = await mergeConversations(t.id);
    custRemoved += cr;
    convRemoved += vr;
    if (cr || vr) console.log(`${t.name}: merged ${cr} duplicate customers, ${vr} duplicate conversations`);
  }
  console.log(`\nTotal — duplicate customers removed: ${custRemoved}, duplicate conversations removed: ${convRemoved}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
