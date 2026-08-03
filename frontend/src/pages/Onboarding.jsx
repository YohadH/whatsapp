import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client.js';

// SmartSend-style split-screen onboarding: dark brand panel (right, RTL) with the
// step list, light form panel (left) with the current step. Three steps:
//   1 · פרטי עסק     — business name + short description (KB businessDescription)
//   2 · חיבור WhatsApp — three paths; "existing number" runs the real SMS-code
//        connect (settings/number/start + /verify) when platform numbering is
//        configured, the other paths record the choice for the team to execute.
//   3 · סיום          — summary + into the dashboard.
const STEPS = [
  { n: 1, label: 'פרטי עסק' },
  { n: 2, label: 'חיבור WhatsApp' },
  { n: 3, label: 'סיום' },
];

// The three WhatsApp-connect paths (step 2 radio cards).
const WA_PATHS = [
  {
    id: 'existing',
    title: 'חיבור מספר עם WhatsApp קיים',
    desc: 'המספר מתחבר לחשבון הרשמי — והאפליקציה בטלפון ממשיכה לעבוד כרגיל.',
    badge: '⚡ המהיר ביותר',
  },
  {
    id: 'port',
    title: 'חיבור מספר ממערכת רשמית אחרת',
    desc: 'עוברים ממערכת רשמית אחרת? אנחנו מבצעים את ההעברה מקצה לקצה — המספר נשאר שלכם.',
  },
  {
    id: 'new',
    title: 'מספר חדש ל-WhatsApp',
    desc: 'אנחנו רוכשים, מגדירים ומחברים מספר טלפון חדש לחשבון WhatsApp רשמי — הכל עלינו.',
  },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Step 1 — business profile.
  const [bizName, setBizName] = useState('');
  const [bizDesc, setBizDesc] = useState('');
  const [ownerPhone, setOwnerPhone] = useState(''); // owner's personal WhatsApp (alerts + receipts)

  // Step 2 — WhatsApp path + the live "existing number" connect flow.
  const [waState, setWaState] = useState(null); // GET /api/settings/whatsapp
  const [path, setPath] = useState('existing');
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState(''); // set once the code was sent
  const [code, setCode] = useState('');
  const [connectedNow, setConnectedNow] = useState(false);

  useEffect(() => {
    api.get('/api/settings/profile').then((r) => {
      setBizName(r.data.name || '');
      setOwnerPhone(r.data.ownerPhone || '');
    }).catch(() => {});
    api.get('/api/knowledge-base').then((r) => setBizDesc(r.data?.businessDescription || '')).catch(() => {});
    api.get('/api/settings/whatsapp').then((r) => setWaState(r.data)).catch(() => setWaState({}));
  }, []);

  const connected = connectedNow || Boolean(waState?.connected);
  const canSelfConnect = Boolean(waState?.platformNumbering);

  async function saveStep1() {
    setErr('');
    if (!bizName.trim()) { setErr('איך קוראים לעסק? זה השם שהלקוחות יראו.'); return; }
    setSaving(true);
    try {
      await api.put('/api/settings/profile', { name: bizName.trim(), ownerPhone: ownerPhone.trim() });
      if (bizDesc.trim()) await api.put('/api/knowledge-base', { businessDescription: bizDesc.trim() });
      setStep(2);
    } catch (e) {
      setErr(e.response?.data?.error || 'השמירה נכשלה — נסו שוב');
    } finally {
      setSaving(false);
    }
  }

  async function startCode() {
    setErr('');
    if (!phone.trim()) { setErr('הזינו את מספר הטלפון של העסק'); return; }
    setSaving(true);
    try {
      const r = await api.post('/api/settings/number/start', {
        cc: '972',
        phone: phone.trim(),
        displayName: displayName.trim() || bizName.trim(),
      });
      setPhoneNumberId(r.data.phoneNumberId);
    } catch (e) {
      setErr(e.response?.data?.error || 'שליחת הקוד נכשלה — בדקו את המספר ונסו שוב');
    } finally {
      setSaving(false);
    }
  }

  async function verifyCode() {
    setErr('');
    if (!code.trim()) { setErr('הזינו את הקוד שקיבלתם ב-SMS'); return; }
    setSaving(true);
    try {
      await api.post('/api/settings/number/verify', { phoneNumberId, code: code.trim() });
      setConnectedNow(true);
      setStep(3);
    } catch (e) {
      setErr(e.response?.data?.error || 'אימות הקוד נכשל — נסו שוב');
    } finally {
      setSaving(false);
    }
  }

  // Step-2 continue for the concierge paths (port / new number): the team executes;
  // we just move on — the choice is shown again in the summary.
  function continueStep2() {
    setErr('');
    if (path === 'existing' && canSelfConnect && !connected) {
      // The self-serve flow finishes via verifyCode(); "continue" here only applies
      // before a code was requested — nudge toward it instead of silently skipping.
      setErr('לחצו על "שליחת קוד אימות" כדי לחבר את המספר, או בחרו מסלול אחר.');
      return;
    }
    setStep(3);
  }

  return (
    <div dir="rtl" className="min-h-screen flex flex-col lg:flex-row bg-slate-50">
      {/* ── Dark brand panel (inline-start = right in RTL) ── */}
      <aside className="lg:w-[44%] shrink-0 bg-heyil-dark text-white flex flex-col p-8 lg:p-12">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-xs font-semibold tracking-widest text-brand-300 mb-3">הצטרפות · 3 שלבים</div>
            <h1 className="text-2xl lg:text-3xl font-bold leading-snug">נבנה יחד את חשבון ה-WhatsApp המקצועי שלך.</h1>
            <p className="text-white/60 mt-2 text-sm">2 דקות עד שיחה ראשונה. לא צריך לשנות מספר, לא צריך מפתח.</p>
          </div>
          <Link to="/dashboard" className="shrink-0 text-xs bg-white/10 hover:bg-white/20 transition rounded-full px-4 py-2 whitespace-nowrap">
            ← חזרה לדשבורד
          </Link>
        </div>

        {/* step list */}
        <ol className="mt-10 space-y-3">
          {STEPS.map((s) => (
            <li
              key={s.n}
              className={`flex items-center gap-3 rounded-xl px-4 py-3.5 transition ${
                step === s.n ? 'bg-white/10 ring-1 ring-white/20' : 'opacity-55'
              }`}
            >
              <span
                className={`grid place-items-center h-7 w-7 rounded-full text-sm font-bold ${
                  step > s.n ? 'bg-brand-500 text-white' : step === s.n ? 'bg-white text-ink-900' : 'bg-white/15 text-white/70'
                }`}
              >
                {step > s.n ? '✓' : s.n}
              </span>
              <span className={`text-sm ${step === s.n ? 'font-semibold' : ''}`}>{s.label}</span>
            </li>
          ))}
        </ol>

        <div className="mt-auto pt-10">
          <img src="/brand/logo-transparent-dark.png" alt="HeyIL" className="h-20 w-auto mb-3" />
          <div className="text-[11px] tracking-widest text-white/40 font-semibold">
            OFFICIAL WHATSAPP API · META BUSINESS
          </div>
        </div>
      </aside>

      {/* ── Form panel ── */}
      <main className="flex-1 flex justify-center p-6 lg:p-14 overflow-y-auto">
        <div className="w-full max-w-xl">
          {step === 1 && (
            <>
              <h2 className="text-2xl font-bold text-ink-900">פרטי העסק</h2>
              <p className="text-sm text-slate-500 mt-1 mb-7">נתחיל בהכרות קצרה. הפרטים האלה משמשים גם לאימות עם Meta.</p>
              <div className="space-y-5">
                <div>
                  <label className="label">שם העסק</label>
                  <input className="input" value={bizName} onChange={(e) => setBizName(e.target.value)} placeholder="לדוגמ׳: סטודיו יופי תל אביב" />
                </div>
                <div>
                  <label className="label">מה העסק עושה? (משפט או שניים)</label>
                  <textarea
                    className="input h-24"
                    value={bizDesc}
                    onChange={(e) => setBizDesc(e.target.value)}
                    placeholder="הסוכן משתמש בזה כדי לענות ללקוחות בשם העסק — אפשר לדייק אחר כך במאגר הידע"
                  />
                </div>
                <div>
                  <label className="label">הוואטסאפ האישי של בעל/ת העסק</label>
                  <input className="input" dir="ltr" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="050-1234567" />
                  <p className="text-xs text-slate-400 mt-1">מהמספר הזה תקבלו התראות — וכל צילום קבלה שתשלחו ממנו למספר העסק ייקלט אוטומטית בספר ההוצאות 🧾</p>
                </div>
                {err && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2.5">{err}</div>}
                <button className="btn-primary px-8" disabled={saving} onClick={saveStep1}>
                  {saving ? 'שומר…' : 'המשך ←'}
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="text-2xl font-bold text-ink-900">חיבור WhatsApp</h2>
              <p className="text-sm text-slate-500 mt-1 mb-7">
                {connected ? 'המספר כבר מחובר ✓ — אפשר להמשיך.' : 'איך תרצו לחבר את המספר? בכל המסלולים — המספר נשאר שלכם.'}
              </p>

              {!connected && (
                <div className="space-y-3 mb-6">
                  {WA_PATHS.map((p) => (
                    <label
                      key={p.id}
                      className={`block cursor-pointer rounded-2xl border bg-white p-4 transition ${
                        path === p.id ? 'border-brand-500 ring-2 ring-brand-100' : 'border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <input type="radio" name="wa-path" className="mt-1.5 accent-brand-500" checked={path === p.id} onChange={() => { setPath(p.id); setErr(''); }} />
                        <div className="min-w-0">
                          <div className="font-semibold text-ink-900 flex items-center gap-2 flex-wrap">
                            {p.title}
                            {p.badge && <span className="badge bg-brand-50 text-brand-600 border border-brand-200">{p.badge}</span>}
                          </div>
                          <div className="text-sm text-slate-500 mt-0.5">{p.desc}</div>
                        </div>
                      </div>

                      {/* live self-serve connect, only for "existing" when the platform can register numbers */}
                      {p.id === 'existing' && path === 'existing' && canSelfConnect && (
                        <div className="mt-4 pt-4 border-t border-slate-100 space-y-3" onClick={(e) => e.preventDefault()}>
                          {!phoneNumberId ? (
                            <>
                              <div className="grid sm:grid-cols-2 gap-3">
                                <div>
                                  <label className="label">מספר הטלפון של העסק</label>
                                  <input className="input" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-1234567" />
                                </div>
                                <div>
                                  <label className="label">שם תצוגה (יופיע ללקוחות)</label>
                                  <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={bizName || 'שם העסק'} />
                                </div>
                              </div>
                              <button type="button" className="btn-ghost text-sm" disabled={saving} onClick={startCode}>
                                {saving ? 'שולח…' : 'שליחת קוד אימות ב-SMS'}
                              </button>
                            </>
                          ) : (
                            <>
                              <div className="text-sm text-slate-600">שלחנו קוד אימות ב-SMS למספר. הזינו אותו כאן:</div>
                              <div className="flex gap-2">
                                <input className="input w-40" dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
                                <button type="button" className="btn-primary" disabled={saving} onClick={verifyCode}>
                                  {saving ? 'מאמת…' : 'אימות וחיבור'}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      {/* concierge note for the existing-number path when self-serve isn't configured */}
                      {p.id === 'existing' && path === 'existing' && !canSelfConnect && (
                        <div className="mt-3 text-xs text-slate-500 bg-slate-50 rounded-lg p-3">
                          החיבור מתבצע יחד עם הצוות שלנו — נחזור אליכם תוך יום עסקים אחד לתיאום. אין צורך בטפסים מול Meta.
                        </div>
                      )}
                    </label>
                  ))}
                </div>
              )}

              {err && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2.5 mb-4">{err}</div>}
              <div className="flex items-center gap-4">
                <button className="btn-primary px-8" disabled={saving} onClick={continueStep2}>המשך ←</button>
                <button className="text-sm text-slate-400 hover:text-slate-600" onClick={() => setStep(1)}>→ חזרה</button>
                <button className="text-sm text-slate-400 hover:text-slate-600 ms-auto" onClick={() => navigate('/dashboard')}>דלגו ואחברו אחר כך</button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="text-2xl font-bold text-ink-900">הכל מוכן 🎉</h2>
              <p className="text-sm text-slate-500 mt-1 mb-7">זה מה שסגרנו עכשיו:</p>
              <ul className="space-y-3 mb-8">
                <li className="flex items-center gap-3 bg-white rounded-xl border border-slate-200 p-4">
                  <span className="grid place-items-center h-8 w-8 rounded-full bg-green-100 text-green-700 font-bold">✓</span>
                  <div>
                    <div className="font-medium text-ink-900">{bizName || 'העסק שלכם'}</div>
                    <div className="text-xs text-slate-500">פרטי העסק נשמרו — הסוכן עונה בשם הזה</div>
                  </div>
                </li>
                <li className="flex items-center gap-3 bg-white rounded-xl border border-slate-200 p-4">
                  <span className={`grid place-items-center h-8 w-8 rounded-full font-bold ${connected ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                    {connected ? '✓' : '…'}
                  </span>
                  <div>
                    <div className="font-medium text-ink-900">חיבור WhatsApp</div>
                    <div className="text-xs text-slate-500">
                      {connected
                        ? 'המספר מחובר ל-API הרשמי — הסוכן מוכן לענות'
                        : path === 'new'
                          ? 'נרכוש ונגדיר מספר חדש בשבילכם — הצוות שלנו יחזור אליכם תוך יום עסקים'
                          : 'הצוות שלנו ישלים את חיבור המספר — נחזור אליכם תוך יום עסקים'}
                    </div>
                  </div>
                </li>
                <li className="flex items-center gap-3 bg-white rounded-xl border border-slate-200 p-4">
                  <span className="grid place-items-center h-8 w-8 rounded-full bg-brand-50 text-brand-600 font-bold">→</span>
                  <div>
                    <div className="font-medium text-ink-900">הצעד הבא: מאגר הידע</div>
                    <div className="text-xs text-slate-500">מחירים, שירותים ושעות פתיחה — ככל שהמאגר מדויק יותר, הסוכן חד יותר</div>
                  </div>
                </li>
              </ul>
              <div className="flex items-center gap-4">
                <button className="btn-primary px-8" onClick={() => navigate('/dashboard')}>לדשבורד ←</button>
                <button className="text-sm text-slate-400 hover:text-slate-600" onClick={() => navigate('/content')}>למאגר הידע</button>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
