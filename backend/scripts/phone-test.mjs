const BASE = 'http://localhost:4000';
const phone = '972545532316'; // simulates the WhatsApp sender's number
const say = async (text) => {
  const r = await fetch(BASE + '/api/whatsapp/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, text }),
  }).then((r) => r.json());
  const a = r.agentResponse;
  console.log(`👤 ${text}`);
  console.log(`🤖 ${a.reply.replace(/\n/g, ' ⏎ ')}`);
  console.log(`   collected: ${JSON.stringify(a.collected_answers.map((x) => x.answer))}\n`);
};

await say('אני רוצה לקבוע תור');     // should ask name
await say('דנה לוי');                // should SKIP phone (auto-filled) → ask service
await say('עיצוב גבות');            // optional time or finish
