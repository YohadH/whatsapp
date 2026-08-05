import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, Modal, EmptyState } from '../components/ui.jsx';
import { launchEmbeddedSignup } from '../lib/fbEmbeddedSignup.js';

const STATUS_BADGE = {
  active: 'bg-green-100 text-green-700',
  trial: 'bg-amber-100 text-amber-700',
  suspended: 'bg-red-100 text-red-700',
};

const emptyForm = {
  name: '', slug: '', plan: 'trial',
  waPhoneNumberId: '', waBusinessAccountId: '', waToken: '', waVerifyToken: '',
  bioTitle: '', bioSubtitle: '',
  adminEmail: '', adminPassword: '',
};

export default function Tenants() {
  const { setActiveTenant } = useAuth();
  const navigate = useNavigate();
  const [tenants, setTenants] = useState(null);
  const [plans, setPlans] = useState({});
  const [esConfig, setEsConfig] = useState({ configured: false });
  const [pending, setPending] = useState([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null); // tenant id being edited
  const [approving, setApproving] = useState('');
  const [margin, setMargin] = useState(null); // per-tenant Meta-cost / margin view
  const [aiUsage, setAiUsage] = useState({}); // tenantId → { aiEnabled, usedToday, dailyLimit, mode, creditsAvailable }

  async function load() {
    const [t, p, es, pur, mg, ai] = await Promise.all([
      api.get('/api/admin/tenants'),
      api.get('/api/admin/plans'),
      api.get('/api/admin/embedded-signup/config').catch(() => ({ data: { configured: false } })),
      api.get('/api/admin/credit-purchases?status=pending').catch(() => ({ data: [] })),
      api.get('/api/admin/margin').catch(() => ({ data: null })),
      api.get('/api/admin/ai-usage').catch(() => ({ data: { items: [] } })),
    ]);
    setTenants(t.data);
    setPlans(p.data.plans || {});
    setEsConfig(es.data);
    setPending(pur.data);
    setMargin(mg.data);
    setAiUsage(Object.fromEntries((ai.data.items || []).map((r) => [r.id, r])));
  }
  useEffect(() => { load().catch(() => setTenants([])); }, []);

  async function markPaid(purchase) {
    setApproving(purchase.id);
    try {
      await api.post(`/api/admin/credit-purchases/${purchase.id}/mark-paid`, {});
      await load();
    } catch {
      /* surfaced by reload */
    } finally {
      setApproving('');
    }
  }

  function actAs(t) {
    setActiveTenant(t.id);
    navigate('/dashboard');
  }

  if (!tenants) return <Spinner className="h-64" />;

  return (
    <div>
      <PageHeader
        title="עסקים (Tenants)"
        subtitle="ניהול הלקוחות של הפלטפורמה — פרטי WhatsApp, תוכנית, ומשתמשים"
        actions={<button className="btn-primary" onClick={() => setCreating(true)}>+ עסק חדש</button>}
      />

      {pending.length > 0 && (
        <div className="card mb-4 border-amber-200 bg-amber-50">
          <div className="font-semibold text-sm mb-2">💳 רכישות קרדיטים הממתינות לאישור ({pending.length})</div>
          <div className="space-y-1">
            {pending.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-sm bg-white rounded px-3 py-1.5">
                <span>{p.tenant?.name || p.tenantId} · <span className="text-gray-500">{p.credits.toLocaleString('he-IL')} קרדיטים · ₪{p.amountIls}</span></span>
                <button className="btn-primary text-xs" disabled={approving === p.id} onClick={() => markPaid(p)}>
                  {approving === p.id ? 'מאשר…' : 'אישור תשלום'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <PlatformPipelineCard />

      {margin && margin.rows && (
        <MarginTable margin={margin} />
      )}

      {tenants.length === 0 ? (
        <EmptyState>אין עדיין עסקים. צרו את הראשון עם "עסק חדש".</EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {tenants.map((t) => (
            <div key={t.id} className="card space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold text-lg">{t.name}</div>
                  <div className="text-xs text-gray-400">/{t.slug} · {plans[t.plan]?.label || t.plan}</div>
                </div>
                <span className={`badge ${STATUS_BADGE[t.status] || 'bg-gray-100 text-gray-600'}`}>{t.status}</span>
              </div>
              <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                <span>👥 {t.counts?.customers ?? 0} לקוחות</span>
                <span>💬 {t.counts?.conversations ?? 0} שיחות</span>
                <span>🧑‍💼 {t.counts?.admins ?? 0} משתמשים</span>
                <span className={t.waTokenConfigured ? 'text-green-600' : 'text-red-500'}>
                  {t.waTokenConfigured ? '🔑 WhatsApp מחובר' : '⚠️ אין טוקן'}
                </span>
                {t.waPhoneNumberId && <span className="font-mono">📱 {t.waPhoneNumberId}</span>}
              </div>
              {aiUsage[t.id] && <AiUsageLine u={aiUsage[t.id]} />}
              <div className="flex gap-2 pt-1">
                <button className="btn-ghost text-sm" onClick={() => actAs(t)}>כניסה לדאשבורד ←</button>
                <button className="btn-ghost text-sm" onClick={() => setEditing(t.id)}>עריכה</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <CreateTenantModal plans={plans} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />
      )}
      {editing && (
        <EditTenantModal tenantId={editing} plans={plans} esConfig={esConfig} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}

// The CENTRAL local-Claude pipeline: one endpoint that answers every opted-in customer
// who hasn't brought their own AI key. Set the tunnel URL + signing secret once here.
function PlatformPipelineCard() {
  const [cfg, setCfg] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.get('/api/admin/platform-pipeline').then((r) => {
    setCfg(r.data); setEnabled(!!r.data.enabled); setUrl(r.data.url || '');
  }).catch(() => setCfg({ enabled: false, url: '', hasSecret: false }));
  useEffect(() => { load(); }, []);

  async function save(e) {
    e.preventDefault(); setErr(''); setSaved(false); setSaving(true);
    try {
      await api.put('/api/admin/platform-pipeline', { enabled, url: url.trim(), secret: secret.trim() || undefined });
      setSecret(''); setSaved(true); setTimeout(() => setSaved(false), 2500); load();
    } catch (ex) { setErr(ex.response?.data?.error || 'השמירה נכשלה'); } finally { setSaving(false); }
  }

  if (!cfg) return null;
  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="font-semibold text-sm">🧠 מוח ה-AI המרכזי (Claude מקומי)</div>
        <span className={`badge ${enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>{enabled ? 'פעיל' : 'כבוי'}</span>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        נקודת קצה אחת (ה-Claude המקומי שלכם דרך tunnel) שעונה לכל הלקוחות שהפעילו AI ואין להם מפתח משלהם.
        ללא מפתחות ענן. 10 תשובות חינם ליום ללקוח, ומעבר לכך קרדיט לכל תשובה. אם המחשב/tunnel כבוי — הלקוח עובר לנציג.
      </p>
      <form onSubmit={save} className="space-y-3 max-w-2xl">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          הפעלת המוח המרכזי לכל הלקוחות
        </label>
        <div>
          <label className="label">כתובת ה-endpoint (HTTPS)</label>
          <input className="input" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://xxxx.trycloudflare.com/reply" />
        </div>
        <div>
          <label className="label">סוד לחתימה {cfg.hasSecret && <span className="text-green-600 text-xs">(שמור ✓)</span>}</label>
          <input className="input" dir="ltr" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.hasSecret ? '•••••••• (מלאו רק כדי להחליף)' : 'אותו ערך כמו ב-config.json של הקונסולה'} />
        </div>
        {err && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2">{err}</div>}
        <div className="flex items-center gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? 'שומר…' : 'שמירה'}</button>
          {saved && <span className="text-green-600 text-sm">נשמר ✓</span>}
        </div>
      </form>
    </div>
  );
}

// Per-tenant AI activation + today's free-reply usage (from GET /api/admin/ai-usage).
function AiUsageLine({ u }) {
  const atCap = u.mode === 'platform' && u.usedToday >= u.dailyLimit;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className={`badge ${u.aiEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
        {u.aiEnabled ? '✨ AI פעיל' : 'AI כבוי'}
      </span>
      {u.aiEnabled && u.mode === 'platform' && (
        <span className={atCap ? 'text-red-600 font-medium' : 'text-gray-500'}>
          {u.usedToday}/{u.dailyLimit} תשובות היום{atCap ? ' · עבר לקרדיטים' : ''}
        </span>
      )}
      {u.aiEnabled && u.mode === 'own-key' && <span className="text-gray-500">🔑 מפתח עצמאי (ללא מגבלה)</span>}
      {u.mode === 'platform' && <span className="text-gray-400">· {u.creditsAvailable} קרדיטים</span>}
    </div>
  );
}

function Field({ label, hint, ...props }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input className="input" {...props} />
      {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
    </div>
  );
}

// Super-admin margin view: revenue proxy (credits charged) vs Meta cost vs OpenAI cost,
// per tenant, for the current month. Meta cost comes from MetaCostEntry (webhook pricing
// categories). See routes/admin.js GET /api/admin/margin + system-gap-analysis §2.7/§4.
function MarginTable({ margin }) {
  const cur = margin.currency || 'USD';
  const money = (cents) => `${(cents / 100).toFixed(2)} ${cur}`;
  const rows = [...margin.rows].sort((a, b) => b.metaCostCents - a.metaCostCents);
  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold text-sm">📊 מרווח לפי לקוח — {margin.month}</div>
        <div className="text-xs text-gray-400">
          הכנסה = קרדיטים שחויבו · עלות Meta = הערכה לפי קטגוריית תמחור
        </div>
      </div>

      {margin.metaRateCardPlaceholder && (
        <div className="text-xs bg-amber-50 border border-amber-200 rounded px-3 py-1.5 mb-2 text-amber-700">
          ⚠️ טבלת תעריפי Meta עדיין לא מוגדרת (placeholder) — עלות ה-Meta מוצגת כ-0 ואינה כסף אמיתי.
          יש למלא את המספרים האמיתיים ב-<code>config.metaPricing</code> (משתני <code>META_RATE_*</code>).
        </div>
      )}
      {!margin.metaCostTracked && (
        <div className="text-xs bg-red-50 border border-red-200 rounded px-3 py-1.5 mb-2 text-red-600">
          טבלת <code>MetaCostEntry</code> אינה קיימת ב-DB עדיין (יש להריץ את מיגרציה 7_meta_cost_entry).
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-xs border-b">
              <th className="text-right font-medium py-1">לקוח</th>
              <th className="text-right font-medium py-1">קרדיטים שחויבו</th>
              <th className="text-right font-medium py-1">עלות Meta</th>
              <th className="text-right font-medium py-1">אירועי Meta</th>
              <th className="text-right font-medium py-1">טוקנים (OpenAI)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.tenantId} className="border-b last:border-0">
                <td className="py-1.5">{r.name}</td>
                <td className="py-1.5">{r.creditsCharged.toLocaleString('he-IL')}</td>
                <td className="py-1.5">
                  {money(r.metaCostCents)}
                  {r.metaCostPlaceholder && <span className="text-amber-500 mr-1" title="תעריף לא מכויל">*</span>}
                </td>
                <td className="py-1.5 text-gray-500">{r.metaEvents}</td>
                <td className="py-1.5 text-gray-500">
                  {(r.openAiTokensIn + r.openAiTokensOut).toLocaleString('he-IL')}
                  <span className="text-gray-300 mr-1" title="אין טבלת עלות $/טוקן בקוד — פער ידוע">(אין עלות ₪)</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold border-t">
              <td className="py-1.5">סה״כ</td>
              <td className="py-1.5">{margin.totals.creditsCharged.toLocaleString('he-IL')}</td>
              <td className="py-1.5">{money(margin.totals.metaCostCents)}</td>
              <td className="py-1.5" />
              <td className="py-1.5 text-gray-500">
                {(margin.totals.openAiTokensIn + margin.totals.openAiTokensOut).toLocaleString('he-IL')}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {!margin.openAiCostTracked && (
        <p className="text-xs text-gray-400 mt-2">
          עלות OpenAI ב-₪ אינה נמדדת בקוד הזה (רק טוקנים נרשמים בספר הקרדיטים) — פער ידוע, לא מספר מומצא.
        </p>
      )}
    </div>
  );
}

function CreateTenantModal({ plans, onClose, onCreated }) {
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      const body = {
        name: form.name, slug: form.slug || undefined, plan: form.plan,
        waPhoneNumberId: form.waPhoneNumberId || undefined,
        waBusinessAccountId: form.waBusinessAccountId || undefined,
        waToken: form.waToken || undefined,
        waVerifyToken: form.waVerifyToken || undefined,
        bioTitle: form.bioTitle || undefined,
        bioSubtitle: form.bioSubtitle || undefined,
      };
      if (form.adminEmail && form.adminPassword) {
        body.admin = { email: form.adminEmail, password: form.adminPassword };
      }
      await api.post('/api/admin/tenants', body);
      onCreated();
    } catch (err) {
      setError(err.response?.data?.error || 'יצירת העסק נכשלה');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open title="עסק חדש" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="שם העסק" value={form.name} onChange={set('name')} required />
          <Field label="מזהה URL (slug)" value={form.slug} onChange={set('slug')} placeholder="acme" hint="לעמוד הקישורים הציבורי /l/slug" />
        </div>
        <div>
          <label className="label">תוכנית</label>
          <select className="input" value={form.plan} onChange={set('plan')}>
            {Object.entries(plans).map(([k, p]) => (
              <option key={k} value={k}>{p.label} — {p.dailyBroadcastCap.toLocaleString()} ליום</option>
            ))}
          </select>
        </div>

        <div className="border-t pt-3">
          <div className="font-medium text-sm mb-2">פרטי WhatsApp (אפשר להשלים אחר כך)</div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Phone Number ID" value={form.waPhoneNumberId} onChange={set('waPhoneNumberId')} hint="מזהה המספר שאליו מגיע ה-webhook" />
            <Field label="WABA ID" value={form.waBusinessAccountId} onChange={set('waBusinessAccountId')} hint="נדרש לרשימת התבניות" />
            <Field label="Access Token" type="password" value={form.waToken} onChange={set('waToken')} hint="נשמר מוצפן" />
            <Field label="Verify Token" value={form.waVerifyToken} onChange={set('waVerifyToken')} hint="אם לעסק אפליקציית Meta משלו" />
          </div>
        </div>

        <div className="border-t pt-3">
          <div className="font-medium text-sm mb-2">משתמש מנהל ראשון (אופציונלי)</div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="אימייל" type="email" value={form.adminEmail} onChange={set('adminEmail')} />
            <Field label="סיסמה זמנית" value={form.adminPassword} onChange={set('adminPassword')} hint="המשתמש יתבקש להחליף בכניסה" />
          </div>
        </div>

        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn-ghost" onClick={onClose}>ביטול</button>
          <button className="btn-primary" disabled={saving || !form.name}>{saving ? 'יוצר…' : 'יצירת עסק'}</button>
        </div>
      </form>
    </Modal>
  );
}

function EditTenantModal({ tenantId, plans, esConfig, onClose, onSaved }) {
  const [tenant, setTenant] = useState(null);
  const [admins, setAdmins] = useState([]);
  const [form, setForm] = useState({});
  const [newToken, setNewToken] = useState('');
  const [verify, setVerify] = useState(null);
  const [newAdmin, setNewAdmin] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [grantAmt, setGrantAmt] = useState('');
  const [granting, setGranting] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function grantCredits() {
    const amt = parseInt(grantAmt, 10);
    if (!amt) return;
    setError(''); setGranting(true);
    try {
      const r = await api.post(`/api/admin/tenants/${tenantId}/credits`, { amount: amt, reason: 'manual_grant' });
      // r.data = { purchased, available, ... } — reflect the new purchased balance locally.
      setTenant((t) => ({ ...t, purchasedCredits: r.data.purchased, creditsUsedThisPeriod: t.creditsUsedThisPeriod }));
      setGrantAmt('');
    } catch (err) {
      setError(err.response?.data?.error || 'הענקת הקרדיטים נכשלה');
    } finally {
      setGranting(false);
    }
  }

  async function connectEmbeddedSignup() {
    setError(''); setConnecting(true);
    try {
      const { code, phoneNumberId, wabaId } = await launchEmbeddedSignup(esConfig);
      const r = await api.post(`/api/admin/tenants/${tenantId}/connect-whatsapp`, { code, phoneNumberId, wabaId });
      setTenant(r.data.tenant);
      setForm((f) => ({ ...f, waPhoneNumberId: r.data.tenant.waPhoneNumberId || '', waBusinessAccountId: r.data.tenant.waBusinessAccountId || '' }));
      setVerify(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'החיבור נכשל');
    } finally {
      setConnecting(false);
    }
  }

  useEffect(() => {
    Promise.all([api.get(`/api/admin/tenants/${tenantId}`), api.get(`/api/admin/tenants/${tenantId}/admins`)])
      .then(([t, a]) => {
        setTenant(t.data);
        setForm({
          name: t.data.name, slug: t.data.slug, plan: t.data.plan, status: t.data.status,
          waPhoneNumberId: t.data.waPhoneNumberId || '', waBusinessAccountId: t.data.waBusinessAccountId || '',
          waVerifyToken: t.data.waVerifyToken || '', bioTitle: t.data.bioTitle || '', bioSubtitle: t.data.bioSubtitle || '',
          dailyBroadcastCap: t.data.dailyBroadcastCap,
        });
        setAdmins(a.data);
      })
      .catch(() => setError('טעינת העסק נכשלה'));
  }, [tenantId]);

  async function save(e) {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      const body = { ...form };
      if (newToken) body.waToken = newToken;
      await api.put(`/api/admin/tenants/${tenantId}`, body);
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  async function verifyCreds() {
    setVerify({ loading: true });
    try {
      const r = await api.post(`/api/admin/tenants/${tenantId}/verify-credentials`);
      setVerify(r.data);
    } catch (err) {
      setVerify({ error: err.response?.data?.error || 'הבדיקה נכשלה' });
    }
  }

  async function addAdmin(e) {
    e.preventDefault();
    try {
      const r = await api.post(`/api/admin/tenants/${tenantId}/admins`, newAdmin);
      setAdmins((a) => [...a, r.data]);
      setNewAdmin({ email: '', password: '' });
    } catch (err) {
      setError(err.response?.data?.error || 'הוספת המשתמש נכשלה');
    }
  }

  if (!tenant) return <Modal open title="עריכת עסק" onClose={onClose}><Spinner /></Modal>;

  return (
    <Modal open title={`עריכה — ${tenant.name}`} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="שם העסק" value={form.name} onChange={set('name')} />
          <Field label="slug" value={form.slug} onChange={set('slug')} />
          <div>
            <label className="label">תוכנית</label>
            <select className="input" value={form.plan} onChange={set('plan')}>
              {Object.entries(plans).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
            </select>
          </div>
          <div>
            <label className="label">סטטוס</label>
            <select className="input" value={form.status} onChange={set('status')}>
              <option value="active">פעיל</option>
              <option value="trial">ניסיון</option>
              <option value="suspended">מושהה</option>
            </select>
          </div>
          <Field label="מכסת שליחה יומית" type="number" value={form.dailyBroadcastCap} onChange={set('dailyBroadcastCap')} hint="נקבע ע״י התוכנית; ניתן לעקוף" />
        </div>

        <div className="border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <div className="font-medium text-sm">פרטי WhatsApp</div>
            <button type="button" className="btn-ghost text-sm" onClick={verifyCreds}>בדיקת טוקן</button>
          </div>
          {esConfig?.configured && (
            <div className="mb-3 rounded-lg bg-brand-50 p-3 flex items-center justify-between gap-3">
              <div className="text-xs text-gray-600">
                חיבור בלחיצה אחת: הלקוח מחבר את חשבון ה-WhatsApp שלו דרך Meta (Embedded Signup) — הטוקן נשמר אוטומטית ומוצפן.
              </div>
              <button type="button" className="btn-primary text-sm whitespace-nowrap" disabled={connecting} onClick={connectEmbeddedSignup}>
                {connecting ? 'מחבר…' : '🔗 חיבור WhatsApp'}
              </button>
            </div>
          )}
          {verify && (
            <div className={`text-xs rounded p-2 mb-2 ${verify.valid ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
              {verify.loading ? 'בודק…' : verify.error ? verify.error
                : verify.valid ? `תקין ✓ ${verify.neverExpires ? '(לא פג)' : verify.expiresIso ? 'פג ' + verify.expiresIso.slice(0, 10) : ''}`
                : `לא תקין: ${verify.error || 'טוקן לא קונפג'}`}
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Phone Number ID" value={form.waPhoneNumberId} onChange={set('waPhoneNumberId')} />
            <Field label="WABA ID" value={form.waBusinessAccountId} onChange={set('waBusinessAccountId')} />
            <Field label="Access Token חדש" type="password" value={newToken} onChange={(e) => setNewToken(e.target.value)}
              hint={tenant.waTokenConfigured ? 'טוקן קיים מוגדר — מלאו רק כדי להחליף' : 'אין טוקן — הזינו כדי לחבר'} />
            <Field label="Verify Token" value={form.waVerifyToken} onChange={set('waVerifyToken')} />
          </div>
        </div>

        <div className="border-t pt-3">
          <div className="font-medium text-sm mb-2">מיתוג עמוד הקישורים (/l/{tenant.slug})</div>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="כותרת" value={form.bioTitle} onChange={set('bioTitle')} />
            <Field label="כותרת משנה" value={form.bioSubtitle} onChange={set('bioSubtitle')} />
          </div>
        </div>

        <div className="border-t pt-3">
          <div className="font-medium text-sm mb-2">קרדיטים ל-AI</div>
          <div className="text-xs text-gray-500 mb-2">
            זמינים: <span className="font-semibold text-gray-700">{Math.max(0, (tenant.monthlyMessageLimit || 0) - (tenant.creditsUsedThisPeriod || 0)) + (tenant.purchasedCredits || 0)}</span>
            {' '}(מכסה חודשית {tenant.monthlyMessageLimit || 0} · נוצלו {tenant.creditsUsedThisPeriod || 0} · נרכשו {tenant.purchasedCredits || 0})
          </div>
          <div className="flex gap-2 items-end">
            <div className="flex-1"><label className="label">הענקת/החסרת קרדיטים</label>
              <input className="input" type="number" placeholder="לדוגמה 1000 (או ‎-100 להחסרה)" value={grantAmt} onChange={(e) => setGrantAmt(e.target.value)} /></div>
            <button type="button" className="btn-ghost whitespace-nowrap" disabled={granting} onClick={grantCredits}>
              {granting ? 'מעניק…' : '+ הענקה'}
            </button>
          </div>
        </div>

        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</div>}
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn-ghost" onClick={onClose}>סגירה</button>
          <button className="btn-primary" disabled={saving}>{saving ? 'שומר…' : 'שמירה'}</button>
        </div>
      </form>

      <div className="border-t mt-5 pt-4">
        <div className="font-medium text-sm mb-2">משתמשים ({admins.length})</div>
        <div className="space-y-1 mb-3">
          {admins.map((a) => (
            <div key={a.id} className="flex items-center justify-between text-sm bg-gray-50 rounded px-3 py-1.5">
              <span>{a.name} · <span className="text-gray-500">{a.email}</span></span>
              <span className="text-xs text-gray-400">{a.role}{a.mustResetPassword ? ' · ממתין לאיפוס' : ''}</span>
            </div>
          ))}
        </div>
        <form onSubmit={addAdmin} className="flex gap-2 items-end">
          <div className="flex-1"><label className="label">אימייל</label><input className="input" type="email" value={newAdmin.email} onChange={(e) => setNewAdmin((n) => ({ ...n, email: e.target.value }))} required /></div>
          <div className="flex-1"><label className="label">סיסמה זמנית</label><input className="input" value={newAdmin.password} onChange={(e) => setNewAdmin((n) => ({ ...n, password: e.target.value }))} required /></div>
          <button className="btn-ghost">+ הוספה</button>
        </form>
      </div>
    </Modal>
  );
}
