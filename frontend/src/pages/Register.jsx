import { useState } from 'react';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { NICHES } from '../data/niches.js';

// Self-service trial signup. Creates a tenant on the 14-day trial plan and logs
// the new owner straight in, landing them on onboarding to connect WhatsApp.
const PERKS = [
  { icon: '🤖', title: 'סוכן AI חכם', desc: 'עונה ללקוחות אוטומטית 24/7 בעברית' },
  { icon: '📣', title: 'דיוור לקוחות', desc: 'קמפיינים ותבניות מאושרות בלחיצה' },
  { icon: '🧾', title: 'ניהול לידים והוצאות', desc: 'הכול במקום אחד, מחובר לוואטסאפ' },
];

export default function Register() {
  const { register, user } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ businessName: '', ownerName: '', email: '', password: '', niche: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (user) {
    return <Navigate to={user.role === 'super_admin' ? '/tenants' : '/dashboard'} replace />;
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (form.password.length < 8) {
      setError('הסיסמה חייבת להכיל לפחות 8 תווים');
      return;
    }
    setLoading(true);
    try {
      await register(form);
      navigate('/onboarding');
    } catch (err) {
      setError(err.response?.data?.error || 'ההרשמה נכשלה, נסו שוב');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex bg-heyil-dark" dir="rtl">
      {/* Value panel (hidden on small screens) */}
      <div className="hidden md:flex flex-col justify-center w-1/2 p-12 text-white">
        <div className="inline-flex self-start bg-white rounded-2xl px-6 py-4 mb-10 shadow-xl">
          <img src="/brand/logo-transparent.png" alt="HeyIL" className="h-16 w-auto" />
        </div>
        <h1 className="text-3xl font-bold leading-snug mb-3">
          14 ימי ניסיון חינם
        </h1>
        <p className="text-white/70 mb-8 max-w-md">
          הפעילו את סוכן ה-AI של HeyIL על מספר הוואטסאפ העסקי שלכם — בלי כרטיס אשראי, בלי התחייבות.
        </p>
        <ul className="space-y-4 max-w-md">
          {PERKS.map((p) => (
            <li key={p.title} className="flex items-start gap-3">
              <span className="text-2xl">{p.icon}</span>
              <div>
                <div className="font-semibold">{p.title}</div>
                <div className="text-sm text-white/60">{p.desc}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {/* Form panel */}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
          <div className="text-center mb-6 md:hidden">
            <img src="/brand/logo-transparent.png" alt="HeyIL" className="h-20 w-auto mx-auto" />
          </div>
          <h2 className="text-xl font-bold text-center mb-1">פתיחת חשבון</h2>
          <p className="text-sm text-slate-500 text-center mb-6">14 ימי ניסיון חינם · ללא כרטיס אשראי</p>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="label">שם העסק</label>
              <input className="input" value={form.businessName} onChange={set('businessName')} required autoFocus />
            </div>
            <div>
              <label className="label">מה תחום העסק?</label>
              <p className="text-xs text-slate-400 mb-2">נכין לכם חשבון עם דוגמאות, תהליכים והגדרות שמתאימים בדיוק לתחום שלכם.</p>
              <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pl-1">
                {NICHES.map((n) => (
                  <button
                    type="button"
                    key={n.id}
                    onClick={() => setForm((f) => ({ ...f, niche: n.id }))}
                    className={`text-right rounded-xl border p-2.5 transition ${
                      form.niche === n.id ? 'border-brand-500 ring-1 ring-brand-500 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-lg">{n.emoji}</span>
                      <span className="text-sm font-medium text-ink-900 leading-tight">{n.label}</span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5 truncate">{n.tagline}</div>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="label">שם מלא (אופציונלי)</label>
              <input className="input" value={form.ownerName} onChange={set('ownerName')} />
            </div>
            <div>
              <label className="label">אימייל</label>
              <input className="input" type="email" value={form.email} onChange={set('email')} required />
            </div>
            <div>
              <label className="label">סיסמה</label>
              <input className="input" type="password" value={form.password} onChange={set('password')} required minLength={8} placeholder="לפחות 8 תווים" />
            </div>
            {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}
            <button className="btn-primary w-full" disabled={loading}>
              {loading ? 'יוצר חשבון…' : 'התחלת ניסיון חינם'}
            </button>
          </form>

          <p className="text-sm text-slate-500 text-center mt-5">
            כבר יש לכם חשבון?{' '}
            <Link to="/login" className="text-brand-600 font-medium hover:underline">התחברות</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
