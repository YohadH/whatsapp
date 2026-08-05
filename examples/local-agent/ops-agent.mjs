// HeyIL Ops agent — ask in plain language; Claude uses the HeyIL Agent API as tools.
//   node ops-agent.mjs "כמה לידים ממתינים לנציג? סכם אותם"
//   node ops-agent.mjs "שלח ל-972501234567: התור שלך מחר ב-10:00"
//
// Needs a HeyIL API key (Settings → מפתחות API) with the scopes you use here:
//   read (list_leads / get_conversation) + write:messaging (send_message).
import Anthropic from '@anthropic-ai/sdk';

const BASE = (process.env.HEYIL_BASE_URL || 'https://heyil.co.il').replace(/\/$/, '');
const KEY = process.env.HEYIL_API_KEY;
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

// Thin client for the scoped HeyIL Agent API.
async function heyil(path, opts = {}) {
  const res = await fetch(`${BASE}/api/agent${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res.json().catch(() => ({ error: `HTTP ${res.status}` }));
}

const tools = [
  { name: 'list_leads', description: 'List leads/conversations, newest first. Optional filters.',
    input_schema: { type: 'object', properties: { status: { type: 'string' }, needsHuman: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'get_conversation', description: 'Get one conversation + its messages by id.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_campaigns', description: 'List broadcast campaigns.', input_schema: { type: 'object', properties: {} } },
  { name: 'send_message', description: 'Send a WhatsApp message to a customer by phone.',
    input_schema: { type: 'object', properties: { phone: { type: 'string' }, text: { type: 'string' } }, required: ['phone', 'text'] } },
];

async function runTool(name, input = {}) {
  if (name === 'list_leads') {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(input)) if (v != null) q.set(k, String(v));
    return heyil(`/leads?${q.toString()}`);
  }
  if (name === 'get_conversation') return heyil(`/conversations/${input.id}`);
  if (name === 'get_campaigns') return heyil('/campaigns');
  if (name === 'send_message') return heyil('/messages', { method: 'POST', body: JSON.stringify(input) });
  return { error: 'unknown tool' };
}

const question = process.argv.slice(2).join(' ') || 'סכם את הלידים שממתינים לנציג';
const messages = [{ role: 'user', content: question }];

for (let step = 0; step < 8; step++) {
  const msg = await anthropic.messages.create({ model: 'claude-opus-5', max_tokens: 1024, tools, messages });
  messages.push({ role: 'assistant', content: msg.content });
  const toolUses = msg.content.filter((b) => b.type === 'tool_use');
  if (!toolUses.length) {
    console.log('\n' + msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    break;
  }
  const results = [];
  for (const tu of toolUses) {
    console.error(`→ ${tu.name}(${JSON.stringify(tu.input)})`);
    const out = await runTool(tu.name, tu.input);
    results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) });
  }
  messages.push({ role: 'user', content: results });
}
