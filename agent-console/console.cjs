// HeyIL Agent Console — a tiny LOCAL control panel for your agents.
//
// Runs on your machine only (never deployed). It is BOTH:
//   1. the reply-provider endpoint (POST /reply) — the "escalation brain", and
//   2. a status dashboard (http://localhost:8790) showing whether everything is wired.
//
// Zero npm dependencies (pure Node http + fetch), so it packages to a single .exe.
// Config comes from config.json next to the exe (see config.example.json) or env vars.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')); } catch { /* use env/defaults */ }
  return {
    port: Number(file.port || process.env.PORT || 8790),
    anthropicKey: file.anthropicKey || process.env.ANTHROPIC_API_KEY || '',
    model: file.model || process.env.MODEL || 'claude-opus-5',
    heyilSecret: file.heyilSecret || process.env.HEYIL_SECRET || '',
    heyilBaseUrl: (file.heyilBaseUrl || process.env.HEYIL_BASE_URL || 'https://www.heyil.co.il').replace(/\/+$/, ''),
    heyilApiKey: file.heyilApiKey || process.env.HEYIL_API_KEY || '',
  };
}
const CFG = loadConfig();

const state = { startedAt: Date.now(), replyCount: 0, passCount: 0, lastReply: null, log: [] };
const pushLog = (e) => { state.log.unshift({ ts: new Date().toISOString(), ...e }); state.log = state.log.slice(0, 40); };

// Call Claude via the raw REST API (no SDK → zero deps).
async function askClaude(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': CFG.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: CFG.model, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(28000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function verifySig(raw, sig) {
  if (!CFG.heyilSecret) return true; // no secret configured (set one!)
  const expected = 'sha256=' + crypto.createHmac('sha256', CFG.heyilSecret).update(raw).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig || ''), Buffer.from(expected)); } catch { return false; }
}

async function checkHeyil() {
  try {
    const r = await fetch(CFG.heyilBaseUrl + '/health', { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, commit: j.commit || null };
  } catch (e) { return { ok: false, error: e.message }; }
}
async function checkApiKey() {
  if (!CFG.heyilApiKey) return { configured: false };
  try {
    const r = await fetch(CFG.heyilBaseUrl + '/api/agent/leads?limit=1', { headers: { Authorization: 'Bearer ' + CFG.heyilApiKey }, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return { configured: true, status: r.status, valid: r.status === 200 };
  } catch (e) { return { configured: true, error: e.message }; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (obj, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && url.pathname === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(DASHBOARD);
  }
  if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true });

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const [heyil, apiKey] = await Promise.all([checkHeyil(), checkApiKey()]);
    return json({
      console: { up: true, uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000), port: CFG.port },
      replyAgent: { requests: state.replyCount, passes: state.passCount, lastReply: state.lastReply, claudeConfigured: !!CFG.anthropicKey, model: CFG.model, secretSet: !!CFG.heyilSecret },
      heyil: { baseUrl: CFG.heyilBaseUrl, ...heyil },
      apiKey,
      log: state.log,
    });
  }

  // The reply-provider endpoint HeyIL calls.
  if (req.method === 'POST' && url.pathname === '/reply') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (!verifySig(raw, req.headers['x-heyil-signature'])) { pushLog({ type: 'reply', ok: false, note: 'bad signature' }); return json({ error: 'bad signature' }, 401); }
    let p = {};
    try { p = JSON.parse(raw.toString()); } catch { /* empty */ }
    if (!CFG.anthropicKey) { pushLog({ type: 'reply', ok: false, note: 'no ANTHROPIC key' }); return json({ pass: true }); }
    try {
      const system = `אתה סוכן שירות של העסק "${p.tenant?.name || ''}". ענה בעברית, בקצרה ובנימוס, אך ורק על סמך מאגר הידע. אם אין לך מספיק מידע כדי לענות באחריות — החזר בדיוק PASS.\n${p.knowledgeBase ? 'מאגר ידע: ' + JSON.stringify(p.knowledgeBase) : ''}`;
      const history = (p.history || []).map((m) => `${m.role === 'customer' ? 'לקוח' : 'סוכן'}: ${m.text}`).join('\n');
      const user = `${history ? history + '\n' : ''}לקוח: ${p.message?.text || ''}\nכתוב את התשובה ללקוח בלבד, או PASS.`;
      const text = await askClaude(system, user);
      state.lastReply = new Date().toISOString();
      if (!text || text.toUpperCase() === 'PASS') { state.passCount++; pushLog({ type: 'reply', ok: true, from: p.customer?.phone, in: p.message?.text, out: '↩︎ PASS' }); return json({ pass: true }); }
      state.replyCount++;
      pushLog({ type: 'reply', ok: true, from: p.customer?.phone, in: p.message?.text, out: text });
      return json({ reply: text });
    } catch (e) {
      pushLog({ type: 'reply', ok: false, note: e.message });
      return json({ pass: true }, 200);
    }
  }

  res.statusCode = 404; res.end('not found');
});

server.listen(CFG.port, () => {
  const u = `http://localhost:${CFG.port}`;
  console.log(`\n  HeyIL Agent Console → ${u}`);
  console.log(`  Reply endpoint (give the tunnel of this + /reply to HeyIL): POST ${u}/reply\n`);
  try { exec(`start "" "${u}"`); } catch { /* not on Windows; open it manually */ }
});

// ── Dashboard (single self-contained page) ───────────────────────────────────
const DASHBOARD = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>HeyIL — סטטוס הסוכנים</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}
body{margin:0;font-family:Segoe UI,system-ui,Arial,sans-serif;background:#0f1117;color:#e8eaed}
.wrap{max-width:900px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 2px}.sub{color:#9aa0a6;font-size:13px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.card{background:#171a21;border:1px solid #262b36;border-radius:14px;padding:14px}
.card h3{margin:0 0 8px;font-size:13px;color:#9aa0a6;font-weight:600}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:14px;padding:3px 0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-inline-start:6px}
.ok{background:#34d399}.bad{background:#f87171}.warn{background:#fbbf24}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;background:#232833;color:#c8ccd4}
.log{background:#171a21;border:1px solid #262b36;border-radius:14px;padding:8px 12px;max-height:320px;overflow:auto;font-size:13px}
.le{padding:8px 4px;border-bottom:1px solid #232833}.le:last-child{border:0}
.le .t{color:#6b7280;font-size:11px}.le .in{color:#c8ccd4}.le .out{color:#a7f3d0}
code{background:#232833;padding:1px 6px;border-radius:6px;font-size:12px}
.foot{color:#6b7280;font-size:12px;margin-top:14px}
</style></head><body><div class="wrap">
<h1>🎛️ סטטוס הסוכנים — HeyIL</h1><div class="sub">מתעדכן כל 5 שניות · פועל מקומית על המחשב שלך בלבד</div>
<div class="grid" id="cards"></div>
<h3 style="color:#9aa0a6;font-size:13px;margin:0 0 8px">📜 פעילות אחרונה</h3>
<div class="log" id="log"></div>
<div class="foot" id="foot"></div>
</div><script>
const dot=(s)=>'<span class="dot '+s+'"></span>';
async function tick(){
  let d; try{ d=await (await fetch('/api/status')).json(); }catch(e){ document.getElementById('foot').textContent='אין חיבור לקונסולה'; return; }
  const claude = d.replyAgent.claudeConfigured;
  const heyOk = d.heyil.ok;
  const keyState = d.apiKey.configured ? (d.apiKey.valid ? 'ok':'bad') : 'warn';
  const cards=[
    ['🧠 סוכן התגובות', [
      ['מפתח Claude', (claude?dot('ok')+'מוגדר':dot('bad')+'חסר')],
      ['סוד חתימה', (d.replyAgent.secretSet?dot('ok')+'מוגדר':dot('warn')+'לא מוגדר')],
      ['תשובות שנענו', '<span class="pill">'+d.replyAgent.requests+'</span>'],
      ['הועברו לנציג (PASS)', '<span class="pill">'+d.replyAgent.passes+'</span>'],
      ['תגובה אחרונה', d.replyAgent.lastReply? new Date(d.replyAgent.lastReply).toLocaleTimeString('he-IL'):'—'],
    ]],
    ['🌐 חיבור ל-HeyIL', [
      ['סטטוס', (heyOk?dot('ok')+'מחובר':dot('bad')+'לא זמין')],
      ['כתובת', '<code dir=ltr>'+d.heyil.baseUrl.replace('https://','')+'</code>'],
      ['גרסה', d.heyil.commit? '<code>'+d.heyil.commit+'</code>':'—'],
    ]],
    ['🔑 מפתח API (Ops)', [
      ['סטטוס', d.apiKey.configured? (d.apiKey.valid? dot('ok')+'תקין' : dot('bad')+'לא תקין ('+d.apiKey.status+')') : dot('warn')+'לא הוגדר'],
    ]],
    ['⚙️ הקונסולה', [
      ['פעילה', dot('ok')+'כן'],
      ['פורט', '<span class="pill">'+d.console.port+'</span>'],
      ['זמן ריצה', Math.floor(d.console.uptimeSec/60)+' דק׳'],
    ]],
  ];
  document.getElementById('cards').innerHTML = cards.map(([t,rows])=>'<div class="card"><h3>'+t+'</h3>'+rows.map(([k,v])=>'<div class="row"><span>'+k+'</span><span>'+v+'</span></div>').join('')+'</div>').join('');
  document.getElementById('log').innerHTML = (d.log||[]).map(e=>'<div class="le"><div class="t">'+new Date(e.ts).toLocaleTimeString('he-IL')+(e.ok===false?' · ✗ '+(e.note||''):'')+'</div>'+(e.in?'<div class="in">👤 '+e.in+'</div>':'')+(e.out?'<div class="out">🤖 '+e.out+'</div>':'')+'</div>').join('') || '<div class="le" style="color:#6b7280">אין עדיין פעילות — שלחו הודעת בדיקה מ-HeyIL</div>';
  document.getElementById('foot').textContent = 'עודכן '+new Date().toLocaleTimeString('he-IL');
}
tick(); setInterval(tick, 5000);
</script></body></html>`;
