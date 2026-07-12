import dotenv from 'dotenv';
dotenv.config();

const token = process.env.WHATSAPP_TOKEN;
const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
const v = process.env.WHATSAPP_API_VERSION || 'v21.0';

// Normalize Israeli numbers: 0545532316 → 972545532316
function normalize(raw) {
  let n = String(raw).replace(/[^\d]/g, '');
  if (n.startsWith('0')) n = '972' + n.slice(1);
  return n;
}

const to = normalize(process.argv[2]);
const mode = process.argv[3] || 'template'; // 'template' | 'text'

const url = `https://graph.facebook.com/${v}/${id}/messages`;
const body =
  mode === 'text'
    ? { messaging_product: 'whatsapp', to, type: 'text', text: { body: process.argv[4] || 'בדיקה מהסוכן ✅' } }
    : { messaging_product: 'whatsapp', to, type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } };

console.log(`→ sending ${mode} to ${to} …`);
const r = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const json = await r.json();
if (r.status === 200) {
  console.log('✅ Accepted by WhatsApp:', JSON.stringify(json));
  console.log('   (check the recipient phone — it should arrive within seconds)');
} else {
  console.log(`❌ Send failed (${r.status}):`, JSON.stringify(json, null, 2));
}
