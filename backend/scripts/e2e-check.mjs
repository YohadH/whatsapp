// Quick end-to-end smoke test against a running server on :4000
const BASE = 'http://localhost:4000';
const phone = '972500000001';

const post = (path, body, token) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then((r) => r.json());
const get = (path, token) =>
  fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then((r) => r.json());

const say = async (text) => {
  const r = await post('/api/whatsapp/simulate', { phone, text });
  const a = r.agentResponse;
  console.log(`👤 ${text}`);
  console.log(`🤖 ${a.reply.replace(/\n/g, ' ⏎ ')}`);
  console.log(`   intent=${a.intent} action=${a.next_action} status=${a.conversation_status} lead=${a.lead_score} q=${a.current_question_id || '-'}\n`);
  return a;
};

console.log('=== Conversation: booking flow ===\n');
await say('היי, אני רוצה לקבוע תור');
await say('יוסי כהן');
await say('0501234567');
const last = await say('טיפול פנים');

console.log('=== Verify link was sent + collected answers ===');
console.log('link_to_send:', last.link_to_send);
console.log('collected_answers:', JSON.stringify(last.collected_answers, null, 0), '\n');

console.log('=== Login + analytics ===');
const { token } = await post('/api/auth/login', { email: 'admin@example.com', password: 'admin123' });
const overview = await get('/api/analytics/overview', token);
console.log('overview:', JSON.stringify(overview));
const flows = await get('/api/flows', token);
console.log('\nflow.triggerWords type:', Array.isArray(flows[0].triggerWords) ? 'ARRAY ✅' : 'STRING ❌', '→', JSON.stringify(flows[0].triggerWords));
console.log('flow.questions[2].options:', JSON.stringify(flows[0].questions?.find(q=>q.options?.length)?.options));

const convs = await get('/api/conversations', token);
console.log('\nconversations total:', convs.total, '| latest status:', convs.items[0]?.status, '| leadScore:', convs.items[0]?.leadScore);
console.log('\n✅ E2E complete');
