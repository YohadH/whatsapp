// Wipes conversational/lead data while KEEPING config (flows, links, KB, admin user).
import prisma from '../src/lib/prisma.js';

async function counts() {
  const [conversations, messages, answers, events, customers, flows, links] = await Promise.all([
    prisma.conversation.count(),
    prisma.message.count(),
    prisma.customerAnswer.count(),
    prisma.analyticsEvent.count(),
    prisma.customer.count(),
    prisma.flow.count(),
    prisma.link.count(),
  ]);
  return { conversations, messages, answers, events, customers, flows, links };
}

console.log('BEFORE:', JSON.stringify(await counts()));

// Order respects FK constraints (children first).
await prisma.analyticsEvent.deleteMany({});
await prisma.customerAnswer.deleteMany({});
await prisma.message.deleteMany({});
await prisma.conversation.deleteMany({});
await prisma.customer.deleteMany({});

console.log('AFTER: ', JSON.stringify(await counts()));
console.log('✅ Cleaned. Flows, links, knowledge base and admin user were kept.');
await prisma.$disconnect();
