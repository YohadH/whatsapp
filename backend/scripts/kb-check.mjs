const BASE = 'http://localhost:4000';
const ask = async (phone, text) => {
  const r = await fetch(BASE + '/api/whatsapp/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, text }),
  }).then((r) => r.json());
  const a = r.agentResponse;
  console.log(`👤 ${text}`);
  console.log(`🤖 ${a.reply.replace(/\n/g, ' ⏎ ')}`);
  console.log(`   intent=${a.intent} action=${a.next_action} q=${a.current_question_id || '-'}\n`);
};

await ask('972522220001', 'כמה עולה טיפול פנים?');
await ask('972522220002', 'מה השעות שלכם בשישי?');
await ask('972522220003', 'אני רוצה לקבוע תור');
