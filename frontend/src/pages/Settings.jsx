import { useEffect, useRef, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { launchEmbeddedSignup } from '../lib/fbEmbeddedSignup.js';

export default function Settings() {
  const { user } = useAuth();
  const [health, setHealth] = useState(null);

  useEffect(() => {
    api.get('/health').then((res) => setHealth(res.data)).catch(() => {});
  }, []);

  return (
    <div>
      <PageHeader title="הגדרות" subtitle="חיבורים, חשבון, ובדיקת הסוכן" />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card">
          <h3 className="font-semibold mb-3">סטטוס חיבורים</h3>
          <ul className="text-sm space-y-2">
            <Status label="שרת" ok={!!health} text={health ? 'מחובר' : 'לא זמין'} />
            <Status label="OpenAI" ok={health?.openai} text={health?.openai ? 'פעיל' : 'כבוי (מצב חוקים)'} />
            <Status label="WhatsApp Cloud API" ok={health?.whatsapp} text={health?.whatsapp ? 'פעיל' : 'כבוי (סימולטור)'} />
          </ul>
          <p className="text-xs text-gray-400 mt-4">
            את מפתחות ה-API מגדירים בקובץ <code>backend/.env</code> (OPENAI_API_KEY, WHATSAPP_TOKEN…).
          </p>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-3">חשבון</h3>
          <dl className="text-sm space-y-2">
            <div className="flex justify-between"><dt className="text-gray-500">שם</dt><dd>{user?.name}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">אימייל</dt><dd>{user?.email}</dd></div>
            <div className="flex justify-between"><dt className="text-gray-500">תפקיד</dt><dd>{user?.role}</dd></div>
          </dl>
        </div>
      </div>

      <WhatsAppConnect />
      <Simulator />
    </div>
  );
}

// Lets a tenant admin connect their WhatsApp number. Primary path: type the number +
// enter the code Meta texts (registered under the platform's WABA — no popup).
// Secondary: Meta Embedded Signup (one-click, needs META_APP_ID + META_CONFIG_ID).
function WhatsAppConnect() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [verify, setVerify] = useState(null);
  // Connect-by-number two-step flow.
  const [num, setNum] = useState({ cc: '972', phone: '', name: '', method: 'SMS' });
  const [step, setStep] = useState('form'); // 'form' → 'code'
  const [pendingId, setPendingId] = useState('');
  const [code, setCode] = useState('');
  const [numBusy, setNumBusy] = useState(false);

  function load() {
    setLoading(true);
    api.get('/api/settings/whatsapp')
      .then((r) => setState(r.data))
      .catch((err) => setError(err.response?.data?.error || 'טעינת סטטוס ה-WhatsApp נכשלה'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function connect() {
    setError(''); setConnecting(true);
    try {
      const es = state?.embeddedSignup;
      const { code: fbCode, phoneNumberId, wabaId } = await launchEmbeddedSignup(es);
      await api.post('/api/settings/connect-whatsapp', { code: fbCode, phoneNumberId, wabaId });
      setVerify(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'החיבור נכשל');
    } finally {
      setConnecting(false);
    }
  }

  async function sendCode() {
    if (!num.phone.trim() || !num.name.trim()) { setError('יש למלא מספר טלפון ושם עסק'); return; }
    setError(''); setNumBusy(true);
    try {
      const r = await api.post('/api/settings/number/start', { cc: num.cc, phone: num.phone, displayName: num.name, codeMethod: num.method });
      setPendingId(r.data.phoneNumberId);
      setStep('code');
    } catch (err) {
      setError(err.response?.data?.error || 'שליחת הקוד נכשלה');
    } finally {
      setNumBusy(false);
    }
  }

  async function verifyNumber() {
    if (!code.trim()) { setError('יש להזין את הקוד שקיבלתם'); return; }
    setError(''); setNumBusy(true);
    try {
      await api.post('/api/settings/number/verify', { phoneNumberId: pendingId, code });
      setStep('form'); setCode(''); setPendingId('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'אימות הקוד נכשל');
    } finally {
      setNumBusy(false);
    }
  }

  async function runVerify() {
    setVerify({ loading: true });
    try {
      const r = await api.post('/api/settings/whatsapp/verify');
      setVerify(r.data);
    } catch (err) {
      setVerify({ error: err.response?.data?.error || 'הבדיקה נכשלה' });
    }
  }

  const esConfigured = state?.embeddedSignup?.configured;
  const numbering = state?.platformNumbering;

  return (
    <div className="card mt-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-semibold">📱 חיבור מספר WhatsApp</h3>
        {state?.connected && <button className="btn-ghost text-sm" onClick={runVerify}>בדיקת חיבור</button>}
      </div>
      <p className="text-sm text-gray-500 mb-3">
        חברו מספר WhatsApp כדי שהסוכן יענה ללקוחות אמיתיים. הטוקן נשמר מוצפן.
      </p>

      {loading ? (
        <div className="text-sm text-gray-400">טוען…</div>
      ) : (
        <>
          {state?.connected ? (
            <div className="rounded-lg bg-green-50 text-green-700 text-sm p-3 mb-3">
              ● מחובר — מספר: <span className="font-mono">{state.phoneNumberId}</span>
            </div>
          ) : (
            <div className="rounded-lg bg-gray-50 text-gray-600 text-sm p-3 mb-3">
              ○ עדיין לא מחובר — הסוכן פועל כרגע במצב סימולטור בלבד.
            </div>
          )}

          {error && <div className="rounded-lg bg-red-50 text-red-600 text-sm p-3 mb-3">{error}</div>}

          {verify && (
            <div className={`text-xs rounded p-2 mb-3 ${verify.valid ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
              {verify.loading ? 'בודק…' : verify.error ? verify.error
                : verify.valid ? `הטוקן תקין ✓ ${verify.neverExpires ? '(לא פג)' : verify.expiresIso ? 'פג ' + verify.expiresIso.slice(0, 10) : ''}`
                : 'הטוקן אינו תקין'}
            </div>
          )}

          {/* Primary: connect by number + code */}
          {numbering ? (
            <div className="rounded-lg border p-3 mb-3">
              <div className="text-sm font-medium mb-2">חיבור לפי מספר טלפון</div>
              {step === 'form' ? (
                <>
                  <div className="flex gap-2 mb-2">
                    <input className="input w-20" value={num.cc} onChange={(e) => setNum((n) => ({ ...n, cc: e.target.value }))} placeholder="972" />
                    <input className="input flex-1" value={num.phone} onChange={(e) => setNum((n) => ({ ...n, phone: e.target.value }))} placeholder="מספר טלפון (למשל 501234567)" />
                  </div>
                  <input className="input mb-2" value={num.name} onChange={(e) => setNum((n) => ({ ...n, name: e.target.value }))} placeholder="שם העסק שיוצג בוואטסאפ" />
                  <div className="flex items-center gap-3 mb-2 text-sm">
                    <label className="flex items-center gap-1"><input type="radio" checked={num.method === 'SMS'} onChange={() => setNum((n) => ({ ...n, method: 'SMS' }))} /> SMS</label>
                    <label className="flex items-center gap-1"><input type="radio" checked={num.method === 'VOICE'} onChange={() => setNum((n) => ({ ...n, method: 'VOICE' }))} /> שיחה קולית</label>
                  </div>
                  <button className="btn-primary" disabled={numBusy} onClick={sendCode}>{numBusy ? 'שולח…' : 'שליחת קוד אימות'}</button>
                </>
              ) : (
                <>
                  <p className="text-xs text-gray-500 mb-2">שלחנו קוד בן 6 ספרות ל-{num.cc}{num.phone}. הזינו אותו כאן:</p>
                  <input className="input mb-2 tracking-widest text-center" value={code} onChange={(e) => setCode(e.target.value)} placeholder="______" maxLength={8} />
                  <div className="flex gap-2">
                    <button className="btn-primary" disabled={numBusy} onClick={verifyNumber}>{numBusy ? 'מאמת…' : 'אימות וחיבור'}</button>
                    <button className="btn-ghost" disabled={numBusy} onClick={() => { setStep('form'); setCode(''); }}>ביטול</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-400 mb-3">
              חיבור לפי מספר אינו זמין עדיין — יש להגדיר בשרת חשבון WhatsApp פלטפורמה
              (<code>PLATFORM_WABA_ID</code> + <code>PLATFORM_WA_TOKEN</code>) לאחר אישור Tech Provider.
            </div>
          )}

          {/* Secondary: Embedded Signup */}
          {esConfigured && (
            <button className="btn-ghost text-sm" disabled={connecting} onClick={connect}>
              {connecting ? 'מחבר…' : '🔗 או חיבור דרך Meta (Embedded Signup)'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Status({ label, ok, text }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={`badge ${ok ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-600'}`}>
        ● {text}
      </span>
    </li>
  );
}

function Simulator() {
  const [phone, setPhone] = useState('972500000000');
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [last, setLast] = useState(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function send(e) {
    e.preventDefault();
    if (!text.trim()) return;
    const userMsg = text;
    setMessages((m) => [...m, { from: 'customer', text: userMsg }]);
    setText('');
    setSending(true);
    try {
      const res = await api.post('/api/whatsapp/simulate', { phone, text: userMsg });
      const ar = res.data.agentResponse;
      setMessages((m) => [...m, { from: 'agent', text: ar.reply }]);
      setLast(ar);
    } catch (err) {
      setMessages((m) => [...m, { from: 'agent', text: '⚠️ שגיאה: ' + (err.response?.data?.error || err.message) }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card mt-4">
      <h3 className="font-semibold mb-1">🧪 סימולטור סוכן</h3>
      <p className="text-sm text-gray-500 mb-3">בדקו את הסוכן בדיוק כמו לקוח אמיתי בוואטסאפ. ההודעות נשמרות גם תחת "שיחות".</p>

      <div className="flex items-center gap-2 mb-3">
        <label className="text-sm text-gray-500">טלפון לקוח לבדיקה:</label>
        <input className="input w-48" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn-ghost" onClick={() => { setMessages([]); setLast(null); }}>איפוס</button>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 border rounded-xl bg-gray-50 flex flex-col" style={{ height: 380 }}>
          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {messages.length === 0 && <div className="text-center text-gray-400 text-sm mt-10">שלחו הודעה כדי להתחיל…</div>}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.from === 'customer' ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${m.from === 'customer' ? 'bg-white border' : 'bg-brand-600 text-white'}`}>
                  {m.text}
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>
          <form onSubmit={send} className="border-t p-2 flex gap-2">
            <input className="input flex-1" placeholder="כתבו הודעה כלקוח…" value={text} onChange={(e) => setText(e.target.value)} disabled={sending} />
            <button className="btn-primary" disabled={sending}>{sending ? '…' : 'שליחה'}</button>
          </form>
        </div>

        <div className="border rounded-xl p-3 bg-gray-900 text-green-300 text-xs overflow-auto" style={{ height: 380 }}>
          <div className="text-gray-400 mb-2">תגובת JSON אחרונה של הסוכן:</div>
          <pre className="whitespace-pre-wrap">{last ? JSON.stringify(last, null, 2) : '—'}</pre>
        </div>
      </div>
    </div>
  );
}
