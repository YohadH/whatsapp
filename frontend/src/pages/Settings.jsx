import { useEffect, useRef, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { launchEmbeddedSignup } from '../lib/fbEmbeddedSignup.js';

export default function Settings() {
  const { user } = useAuth();
  const [health, setHealth] = useState(null);
  // Google add-on entitlement state (Tenant.googleIntegrationEnabled — the PAID
  // gate, flipped ONLY by a super-admin). Fetched once here and shared by both the
  // Integrations list (to badge the Google-group toggles) and the GoogleConnect
  // panel. Flipping a gmail/calendar toggle does NOT change this — it only records
  // the tenant's intent — so there is no "bump to re-check the gate" anymore.
  const [google, setGoogle] = useState(null);
  const loadGoogle = () => {
    api.get('/api/integrations/google/status')
      .then((r) => setGoogle(r.data))
      .catch(() => setGoogle({ enabled: false }));
  };

  useEffect(() => {
    api.get('/health').then((res) => setHealth(res.data)).catch(() => {});
    loadGoogle();
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

      <BusinessProfile />
      <WhatsAppConnect />
      <Integrations google={google} />
      <GoogleConnect status={google} reload={loadGoogle} />
      <Simulator />
    </div>
  );
}

// Business profile — name + the owner's personal WhatsApp number. The owner
// number is what the receipts pipeline recognizes: a photo sent FROM it to the
// business number lands in the expense book instead of the customer inbox.
function BusinessProfile() {
  const [name, setName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/api/settings/profile')
      .then((r) => { setName(r.data.name || ''); setOwnerPhone(r.data.ownerPhone || ''); })
      .catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    setErr('');
    setSaved(false);
    setSaving(true);
    try {
      const r = await api.put('/api/settings/profile', { name: name.trim(), ownerPhone: ownerPhone.trim() });
      setOwnerPhone(r.data.ownerPhone || '');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (ex) {
      setErr(ex.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mt-4">
      <h3 className="font-semibold mb-1">פרטי העסק</h3>
      <p className="text-xs text-slate-400 mb-4">
        🧾 מהמספר האישי של בעל/ת העסק אפשר לצלם קבלות ישירות לוואטסאפ של העסק — הן ייקלטו אוטומטית בעמוד <b>הוצאות</b>.
      </p>
      <form onSubmit={save} className="grid sm:grid-cols-2 gap-3 items-end max-w-2xl">
        <div>
          <label className="label">שם העסק</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="label">הוואטסאפ האישי של בעל/ת העסק</label>
          <input className="input" dir="ltr" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="050-1234567" />
        </div>
        <div className="sm:col-span-2 flex items-center gap-3">
          <button className="btn-primary" disabled={saving}>{saving ? 'שומר…' : 'שמירה'}</button>
          {saved && <span className="text-sm text-green-600">✓ נשמר</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
        </div>
      </form>
    </div>
  );
}

// Owner-toggled connections (Gmail, Calendar, Sheets, Webhook/CRM, …). Each toggle
// records the tenant's INTENT to use a service per-tenant (Tenant.integrations) —
// it does NOT grant any entitlement. In particular, flipping a Google-group toggle
// (gmail/calendar/sheets) does NOT enable the paid Google add-on: that gate is
// Tenant.googleIntegrationEnabled, flipped only by a super-admin. So a Google-group
// toggle can be ON while the add-on is still locked — we badge those rows and show a
// clear "requires the paid add-on" note instead of the old silent no-op.
function Integrations({ google }) {
  const [catalog, setCatalog] = useState(null);
  const [enabled, setEnabled] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // The paid Google add-on is entitled only when the status endpoint reports it.
  // `null` = still loading → don't badge yet (avoid a flash of "locked").
  const googleEntitled = google == null ? null : Boolean(google.enabled);

  useEffect(() => {
    api.get('/api/settings/integrations')
      .then((r) => { setCatalog(r.data.catalog); setEnabled(r.data.enabled || {}); })
      .catch(() => setCatalog([]));
  }, []);

  async function toggle(slug, group) {
    const nextVal = !enabled[slug];
    setEnabled((e) => ({ ...e, [slug]: nextVal })); // optimistic
    setBusy(slug); setError(''); setNotice('');
    try {
      const r = await api.put('/api/settings/integrations', { slug, enabled: nextVal });
      setEnabled(r.data.enabled);
      // Turning a Google-group connection ON while the paid add-on isn't entitled
      // saves the intent but can't actually connect Google — say so explicitly
      // instead of leaving the user to wonder why nothing happened.
      if (nextVal && group === 'google' && googleEntitled === false) {
        setNotice('החיבור נשמר, אך תוסף Google (בתשלום) עדיין לא הופעל לחשבון שלכם. פנו למנהל המערכת כדי להפעיל אותו לפני חיבור החשבון.');
      }
    } catch (err) {
      setEnabled((e) => ({ ...e, [slug]: !nextVal })); // revert on failure
      setError(err.response?.data?.error || 'עדכון החיבור נכשל');
    } finally {
      setBusy('');
    }
  }

  if (!catalog) return null;
  const ICONS = { gmail: '📧', calendar: '📅', sheets: '📊', webhook: '🔗', calendly: '🗓️', zapier: '⚡' };

  return (
    <div className="card mt-4">
      <h3 className="font-semibold mb-1">🔌 אינטגרציות וחיבורים</h3>
      <p className="text-sm text-gray-500 mb-4">הפעילו או כבו חיבורים למערכות חיצוניות — אפשר לערוך בכל רגע.</p>
      {error && <div className="rounded-lg bg-red-50 text-red-600 text-sm p-3 mb-3">{error}</div>}
      {notice && <div className="rounded-lg bg-amber-50 text-amber-700 text-sm p-3 mb-3">{notice}</div>}
      <ul className="divide-y divide-slate-100">
        {catalog.map((it) => {
          const locked = it.group === 'google' && googleEntitled === false;
          return (
            <li key={it.slug} className="flex items-center justify-between gap-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xl shrink-0" aria-hidden>{ICONS[it.slug] || '🔌'}</span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 flex items-center gap-2">
                    {it.label}
                    {locked && (
                      <span className="badge bg-amber-100 text-amber-700 text-[10px] font-medium" title="דורש הפעלת תוסף Google בתשלום על ידי מנהל המערכת">
                        🔒 תוסף בתשלום
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 truncate">{it.desc}</div>
                </div>
              </div>
              <Toggle on={!!enabled[it.slug]} busy={busy === it.slug} onClick={() => toggle(it.slug, it.group)} label={it.label} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Accessible on/off switch. Green track = on. Knob slides via transform so the
// motion stays smooth (RTL-safe: color is the primary state cue).
function Toggle({ on, busy, onClick, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label}
      disabled={busy} onClick={onClick}
      className={`relative inline-flex h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? 'bg-brand-500' : 'bg-slate-300'}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-0' : 'translate-x-[1.25rem]'}`}
      />
    </button>
  );
}

// Google (Gmail + Calendar) add-on — paid, OFF by default. Entitlement lives in
// Tenant.googleIntegrationEnabled (the paid gate, flipped only by a super-admin),
// surfaced by /google/status as `enabled`. When NOT entitled we no longer render
// nothing (the old silent no-op that made the Google-group toggles look broken) —
// we render an explicit "not enabled for your account" card so the user gets
// feedback and knows the paid add-on is required. `status`/`reload` are lifted to
// the parent so this panel and the Integrations badges stay in sync.
function GoogleConnect({ status, reload }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Still loading the status → render nothing yet (avoids a flash of the locked card).
  if (!status) return null;

  // Not entitled to the paid add-on → show an explicit locked state, not silence.
  if (!status.enabled) {
    return (
      <div className="card mt-4">
        <h3 className="font-semibold mb-3">Google (Gmail + יומן) — תוסף</h3>
        <div className="rounded-lg bg-amber-50 text-amber-700 text-sm p-3">
          🔒 תוסף Google (בתשלום) עדיין לא הופעל לחשבון שלכם. הוא מאפשר יצירת אירועי
          יומן ושליחת מיילים אוטומטית מתוך השיחה. פנו למנהל המערכת כדי להפעיל אותו.
        </div>
        {status.notMigrated && (
          <p className="text-xs text-amber-500 mt-2">התוסף עדיין לא הופעל בשרת (נדרשת הפעלת מיגרציה).</p>
        )}
      </div>
    );
  }

  async function connect() {
    setError(''); setBusy(true);
    try {
      // Ask for the consent URL as JSON, then send the browser to Google.
      const r = await api.get('/api/integrations/google/connect?json=1');
      if (r.data?.url) window.location.href = r.data.url;
    } catch (err) {
      setError(err.response?.data?.error || 'פתיחת החיבור ל-Google נכשלה');
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setError(''); setBusy(true);
    try { await api.post('/api/integrations/google/disconnect'); reload?.(); }
    catch (err) { setError(err.response?.data?.error || 'ניתוק Google נכשל'); }
    finally { setBusy(false); }
  }

  return (
    <div className="card mt-4">
      <h3 className="font-semibold mb-3">Google (Gmail + יומן) — תוסף</h3>
      {status.connected ? (
        <div className="flex items-center justify-between text-sm">
          <span>מחובר: <strong>{status.email || 'חשבון Google'}</strong></span>
          <button className="btn" onClick={disconnect} disabled={busy}>נתק</button>
        </div>
      ) : (
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500">חברו חשבון Google כדי לאפשר יצירת אירועי יומן ושליחת מיילים.</span>
          <button className="btn btn-primary" onClick={connect} disabled={busy}>
            {busy ? 'רגע…' : 'חיבור Google'}
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
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
