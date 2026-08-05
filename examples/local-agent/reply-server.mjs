// HeyIL reply-provider starter — a local "escalation brain".
//
// HeyIL POSTs a `reply.request` here when its built-in bot isn't enough; you answer
// with Claude and return { reply } (or { pass: true } to let the bot/human handle it).
// Run this, expose it over an HTTPS tunnel (cloudflared / ngrok), and paste the tunnel
// URL + the shared secret into:
//   HeyIL → Settings → מנוע הבינה → מוח תגובות מותאם.
//
//   npm i && cp .env.example .env   # fill ANTHROPIC_API_KEY + HEYIL_SECRET
//   node reply-server.mjs
//   cloudflared tunnel --url http://localhost:8787   # → gives you the HTTPS URL
import express from 'express';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';

const PORT = process.env.PORT || 8787;
const SECRET = process.env.HEYIL_SECRET || ''; // the SAME secret you set in HeyIL
const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY

const app = express();
// Capture the RAW body so we can verify HeyIL's HMAC signature.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Verify the request really came from HeyIL (X-HeyIL-Signature = HMAC-SHA256 of the body).
function verifySignature(req) {
  if (!SECRET) return true; // no secret set → skip (SET ONE in production)
  const got = String(req.headers['x-heyil-signature'] || '');
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(req.rawBody).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected)); } catch { return false; }
}

app.post('/reply', async (req, res) => {
  if (!verifySignature(req)) return res.status(401).json({ error: 'bad signature' });
  const p = req.body || {};
  try {
    const system = [
      `אתה סוכן שירות מומחה של העסק "${p.tenant?.name || ''}"${p.tenant?.niche ? ` (תחום: ${p.tenant.niche})` : ''}.`,
      'ענה בעברית, בקצרה, בנימוס ובמקצועיות — אך ורק על סמך מאגר הידע והתהליכים שמצורפים.',
      'אם אין לך מספיק מידע כדי לענות באחריות, החזר בדיוק את המילה: PASS (כדי שהמערכת תעביר לנציג אנושי).',
      p.knowledgeBase ? `\nמאגר הידע:\n${JSON.stringify(p.knowledgeBase)}` : '',
      p.flows?.length ? `\nתהליכים זמינים:\n${JSON.stringify(p.flows)}` : '',
    ].join('\n');

    const history = (p.history || []).map((m) => `${m.role === 'customer' ? 'לקוח' : 'סוכן'}: ${m.text}`).join('\n');
    const user = `${history ? `היסטוריית השיחה:\n${history}\n\n` : ''}הודעת הלקוח: ${p.message?.text || ''}\n\nכתוב את התשובה ללקוח בלבד, או PASS.`;

    const msg = await anthropic.messages.create({
      model: 'claude-opus-5', // change to claude-sonnet-5 for faster/cheaper if you like
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: user }],
    });

    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (!text || text.toUpperCase() === 'PASS') return res.json({ pass: true });
    return res.json({ reply: text });
  } catch (err) {
    console.error('[reply] error:', err.message);
    return res.status(500).json({ pass: true }); // let HeyIL fall back to its human hand-off
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`HeyIL reply provider listening on :${PORT}`));
