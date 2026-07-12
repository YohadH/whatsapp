import { useEffect, useRef, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { useAuth } from '../context/AuthContext.jsx';

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

      <Simulator />
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
