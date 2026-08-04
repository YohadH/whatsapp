import { useEffect, useRef, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { launchEmbeddedSignup } from '../lib/fbEmbeddedSignup.js';

// Settings sections — surfaced as a side nav (desktop) / scrollable tab bar
// (mobile). Keeps a long page organized and works on iPhone + Android.
const SECTIONS = [
  { id: 'general', label: 'כללי', icon: '🏢' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '📱' },
  { id: 'ai', label: 'בינה מלאכותית', icon: '✨' },
  { id: 'integrations', label: 'אינטגרציות', icon: '🔌' },
  { id: 'test', label: 'בדיקת הסוכן', icon: '🧪' },
];

export default function Settings() {
  const { user } = useAuth();
  const [health, setHealth] = useState(null);
  const [section, setSection] = useState('general');
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

      <div className="md:grid md:grid-cols-[210px_1fr] md:gap-6">
        {/* Section nav: wraps onto multiple rows on mobile (no horizontal scroll),
            sticky vertical list on desktop. */}
        <nav className="flex flex-wrap md:flex-col gap-1.5 mb-4 md:mb-0 md:sticky md:top-4 md:self-start">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`shrink-0 flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm text-right whitespace-nowrap transition ${
                section === s.id
                  ? 'bg-brand-500 text-white font-medium shadow-sm'
                  : 'bg-white md:bg-transparent text-slate-600 hover:bg-slate-100'
              }`}
            >
              <span aria-hidden>{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0">
          {section === 'general' && (
            <>
              <BusinessProfile />
              <AccountCard user={user} />
            </>
          )}
          {section === 'whatsapp' && (
            <>
              <WhatsAppConnect />
              <ServerStatus health={health} />
            </>
          )}
          {section === 'ai' && <AiProvider />}
          {section === 'integrations' && (
            <>
              <Integrations google={google} />
              <GoogleConnect status={google} reload={loadGoogle} />
            </>
          )}
          {section === 'test' && <Simulator />}
        </div>
      </div>
    </div>
  );
}

// Server/connection status card (WhatsApp section).
function ServerStatus({ health }) {
  return (
    <div className="card mt-4">
      <h3 className="font-semibold mb-3">סטטוס חיבורים</h3>
      <ul className="text-sm space-y-2">
        <Status label="שרת" ok={!!health} text={health ? 'מחובר' : 'לא זמין'} />
        <Status label="OpenAI" ok={health?.openai} text={health?.openai ? 'פעיל' : 'כבוי (מצב חוקים)'} />
        <Status label="WhatsApp Cloud API" ok={health?.whatsapp} text={health?.whatsapp ? 'פעיל' : 'כבוי (סימולטור)'} />
      </ul>
    </div>
  );
}

// Logged-in account details (general section).
function AccountCard({ user }) {
  return (
    <div className="card mt-4">
      <h3 className="font-semibold mb-3">חשבון</h3>
      <dl className="text-sm space-y-2">
        <div className="flex justify-between"><dt className="text-gray-500">שם</dt><dd>{user?.name}</dd></div>
        <div className="flex justify-between"><dt className="text-gray-500">אימייל</dt><dd>{user?.email}</dd></div>
        <div className="flex justify-between"><dt className="text-gray-500">תפקיד</dt><dd>{user?.role}</dd></div>
      </dl>
    </div>
  );
}

// AI provider — bring-your-own key (OpenAI / Claude) or the platform default.
// When a tenant sets its own key, the agent runs on it and platform AI credits
// are not consumed. Leaving it on "platform" keeps the credits-backed default.
function AiProvider() {
  const [cfg, setCfg] = useState(null); // { providers, provider, model, hasKey }
  const [provider, setProvider] = useState('platform');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const load = () =>
    api.get('/api/settings/ai').then((r) => {
      setCfg(r.data);
      setProvider(r.data.provider || 'platform');
      setModel(r.data.model || '');
    }).catch(() => {});
  useEffect(() => { load(); }, []);

  function pickProvider(p) {
    setProvider(p);
    setApiKey('');
    if (p !== 'platform' && cfg?.providers?.[p]) setModel(cfg.providers[p].models[0]);
  }

  async function save(e) {
    e.preventDefault();
    setErr('');
    setSaved(false);
    setSaving(true);
    try {
      await api.put('/api/settings/ai', { provider, model, apiKey: apiKey.trim() || undefined });
      setApiKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      load();
    } catch (ex) {
      setErr(ex.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  const providers = cfg?.providers || {};
  const models = provider !== 'platform' ? providers[provider]?.models || [] : [];

  return (
    <div className="card mt-4">
      <h3 className="font-semibold mb-1">מנוע הבינה המלאכותית</h3>
      <p className="text-xs text-slate-400 mb-4">
        כברירת מחדל הסוכן עובד על מנוע ה-AI שלנו (נצרך מקרדיטים). ניתן לחבר מפתח API משלכם — או-פן-איי או Claude —
        ואז השיחות ירוצו על החשבון שלכם ולא ינוכו קרדיטים.
      </p>
      <form onSubmit={save} className="space-y-4 max-w-2xl">
        <div className="grid sm:grid-cols-3 gap-2">
          {[{ id: 'platform', label: 'ברירת מחדל (קרדיטים)' }, { id: 'openai', label: providers.openai?.label || 'OpenAI' }, { id: 'anthropic', label: providers.anthropic?.label || 'Claude' }].map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => pickProvider(p.id)}
              className={`rounded-xl border px-3 py-3 text-sm text-center transition ${
                provider === p.id ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {provider !== 'platform' && (
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">מודל</label>
              <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="label">מפתח API {cfg?.hasKey && <span className="text-green-600 text-xs">(מפתח שמור ✓)</span>}</label>
              <input className="input" dir="ltr" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} />
              <p className="text-xs text-slate-400 mt-1">המפתח נשמר מוצפן ולא מוצג שוב.</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={saving}>{saving ? 'שומר…' : 'שמירה'}</button>
          {saved && <span className="text-sm text-green-600">✓ נשמר</span>}
          {err && <span className="text-sm text-red-600">{err}</span>}
        </div>
      </form>
    </div>
  );
}

// Business profile — name + the owner's personal WhatsApp number. The owner
// number is what the receipts pipeline recognizes: a photo sent FROM it to the
// business number lands in the expense book instead of the customer inbox.
function BusinessProfile() {
  const [name, setName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    api.get('/api/settings/profile')
      .then((r) => { setName(r.data.name || ''); setOwnerPhone(r.data.ownerPhone || ''); setLogoUrl(r.data.logoUrl || ''); })
      .catch(() => {});
  }, []);

  // Upload the picked image, then persist the returned URL immediately so the logo
  // sticks even if the owner never presses "save" on the rest of the form.
  async function pickLogo(file) {
    if (!file) return;
    setErr('');
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const up = await api.post('/api/uploads/image', fd);
      const url = up.data.url;
      setLogoUrl(url);
      await api.put('/api/settings/profile', { name: name.trim() || 'העסק שלי', logoUrl: url });
    } catch (ex) {
      setErr(ex.response?.data?.error || 'העלאת הלוגו נכשלה');
    } finally {
      setUploading(false);
    }
  }
  async function removeLogo() {
    setLogoUrl('');
    try { await api.put('/api/settings/profile', { name: name.trim() || 'העסק שלי', logoUrl: '' }); } catch { /* ignore */ }
  }

  async function save(e) {
    e.preventDefault();
    setErr('');
    setSaved(false);
    setSaving(true);
    try {
      const r = await api.put('/api/settings/profile', { name: name.trim(), ownerPhone: ownerPhone.trim(), logoUrl });
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
        השם והלוגו מייצגים את העסק בפני הלקוחות. 🧾 מהמספר האישי של בעל/ת העסק אפשר לצלם קבלות ישירות לוואטסאפ — הן ייקלטו אוטומטית בעמוד <b>הוצאות</b>.
      </p>

      {/* Logo uploader */}
      <div className="flex items-center gap-4 mb-4">
        <div className="h-20 w-20 rounded-2xl border border-dashed border-slate-300 bg-slate-50 grid place-items-center overflow-hidden shrink-0">
          {logoUrl ? (
            <img src={logoUrl} alt="לוגו" className="h-full w-full object-cover" />
          ) : (
            <span className="text-2xl text-slate-300">🏢</span>
          )}
        </div>
        <div className="text-sm">
          <label className="btn-ghost cursor-pointer inline-block">
            {uploading ? 'מעלה…' : logoUrl ? 'החלפת לוגו' : 'העלאת לוגו'}
            <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={(e) => pickLogo(e.target.files?.[0])} />
          </label>
          {logoUrl && (
            <button type="button" className="btn-ghost text-red-600 mr-1" onClick={removeLogo}>הסרה</button>
          )}
          <p className="text-xs text-slate-400 mt-1">JPG/PNG, עד 5MB · מומלץ ריבוע</p>
        </div>
      </div>

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
  const [config, setConfig] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // The paid Google add-on is entitled only when the status endpoint reports it.
  // `null` = still loading → don't badge yet (avoid a flash of "locked").
  const googleEntitled = google == null ? null : Boolean(google.enabled);

  const reload = () =>
    api.get('/api/settings/integrations')
      .then((r) => { setCatalog(r.data.catalog); setEnabled(r.data.enabled || {}); setConfig(r.data.config || {}); })
      .catch(() => setCatalog([]));
  useEffect(() => { reload(); }, []);

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
      {(() => {
        // Only present integrations that are actually usable now; the rest are
        // shown as a muted "בקרוב" (coming soon) list so no dead toggles appear.
        // URL-configurable ones (webhook/zapier) render a connect form.
        const configItems = catalog.filter((it) => it.ready && it.configurable);
        const toggleItems = catalog.filter((it) => it.ready && !it.configurable);
        const readyItems = toggleItems; // toggle rows
        const soonItems = catalog.filter((it) => !it.ready);
        return (
          <>
            {configItems.map((it) => (
              <WebhookConfig key={it.slug} item={it} icon={ICONS[it.slug]} config={config[it.slug]} onChanged={reload} />
            ))}

            {readyItems.length > 0 && (
              <ul className="divide-y divide-slate-100">
                {readyItems.map((it) => {
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
            )}
            {configItems.length === 0 && toggleItems.length === 0 && (
              <div className="rounded-lg bg-slate-50 text-slate-500 text-sm p-3">
                עדיין אין אינטגרציות פעילות לחשבון שלכם — נוסיף חיבורים בקרוב 👇
              </div>
            )}

            {soonItems.length > 0 && (
              <div className="mt-5">
                <div className="text-xs font-semibold text-slate-400 mb-2">בקרוב</div>
                <ul className="divide-y divide-slate-100">
                  {soonItems.map((it) => (
                    <li key={it.slug} className="flex items-center justify-between gap-4 py-3 opacity-70">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-xl shrink-0 grayscale" aria-hidden>{ICONS[it.slug] || '🔌'}</span>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-700">{it.label}</div>
                          <div className="text-xs text-slate-400 truncate">{it.desc}</div>
                        </div>
                      </div>
                      <span className="badge bg-slate-100 text-slate-500 text-[10px] font-medium shrink-0">בקרוב</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

// Connect form for a URL-based integration (Webhook/CRM, Zapier/Make): paste an
// HTTPS endpoint (+ optional signing secret), save, send a live test, disconnect.
function WebhookConfig({ item, icon, config, onChanged }) {
  const connected = !!config?.url;
  const [url, setUrl] = useState(config?.url || '');
  const [secret, setSecret] = useState('');
  const [open, setOpen] = useState(connected);
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => { setUrl(config?.url || ''); }, [config?.url]);

  async function save() {
    setBusy('save'); setErr(''); setTest(null);
    try {
      await api.put('/api/settings/integrations/webhook', { slug: item.slug, url: url.trim(), secret: secret.trim() || undefined });
      setSecret('');
      onChanged();
    } catch (e) { setErr(e.response?.data?.error || 'שמירה נכשלה'); }
    finally { setBusy(''); }
  }
  async function disconnect() {
    setBusy('disc'); setErr(''); setTest(null);
    try { await api.put('/api/settings/integrations/webhook', { slug: item.slug, url: '' }); setUrl(''); onChanged(); }
    catch (e) { setErr(e.response?.data?.error || 'ניתוק נכשל'); }
    finally { setBusy(''); }
  }
  async function runTest() {
    setBusy('test'); setTest(null); setErr('');
    try { const r = await api.post('/api/settings/integrations/webhook/test', { slug: item.slug }); setTest({ ok: true, status: r.data.status }); }
    catch (e) { setTest({ ok: false, msg: e.response?.data?.error || 'הבדיקה נכשלה', status: e.response?.data?.status }); }
    finally { setBusy(''); }
  }

  return (
    <div className="border border-slate-200 rounded-xl p-3 mb-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xl shrink-0" aria-hidden>{icon || '🔗'}</span>
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-800 flex items-center gap-2">
              {item.label}
              {connected && <span className="badge bg-green-100 text-green-700 text-[10px] font-medium">● מחובר</span>}
            </div>
            <div className="text-xs text-slate-500 truncate">{item.desc}</div>
          </div>
        </div>
        <button className="btn-ghost text-sm shrink-0" onClick={() => setOpen((o) => !o)}>
          {open ? 'סגירה' : connected ? 'ניהול' : 'חיבור'}
        </button>
      </div>

      {open && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <div>
            <label className="label">כתובת ה-Webhook (HTTPS)</label>
            <input className="input" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/…" />
          </div>
          <div>
            <label className="label">סוד לחתימה (אופציונלי)</label>
            <input className="input" dir="ltr" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={config?.hasSecret ? '•••••• (שמור — הזינו כדי להחליף)' : 'לחתימת X-HeyIL-Signature'} />
            <p className="text-xs text-slate-400 mt-1">בכל ליד חדש נשלח POST עם פרטי הליד. אם הוגדר סוד, נחתום את הגוף ב-HMAC-SHA256.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary" disabled={busy === 'save' || !url.trim()} onClick={save}>{busy === 'save' ? 'שומר…' : 'שמירה'}</button>
            {connected && <button className="btn-ghost" disabled={busy === 'test'} onClick={runTest}>{busy === 'test' ? 'בודק…' : 'שליחת בדיקה'}</button>}
            {connected && <button className="btn-ghost text-red-600 mr-auto" disabled={busy === 'disc'} onClick={disconnect}>{busy === 'disc' ? '…' : 'ניתוק'}</button>}
          </div>
          {test && (
            <div className={`text-sm rounded-lg p-2 ${test.ok ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'}`}>
              {test.ok ? `✓ נשלח בהצלחה (HTTP ${test.status})` : `✗ ${test.msg}${test.status ? ` (HTTP ${test.status})` : ''}`}
            </div>
          )}
          {err && <div className="text-sm text-red-600">{err}</div>}
        </div>
      )}
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

  // Show this panel only when Google is actually READY to connect (the paid add-on
  // is enabled for this tenant). Until then it lives in the Integrations "בקרוב"
  // list, so we don't present a connect button that would just 403.
  if (!status || !status.enabled) return null;

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

  async function disconnect() {
    if (!confirm('לנתק את מספר ה-WhatsApp? הנתונים שלכם (שיחות, לידים, תהליכים) יישָמרו במלואם — רק החיבור ינותק ותוכלו לחבר מחדש בכל רגע.')) return;
    setError(''); setConnecting(true);
    try {
      await api.post('/api/settings/whatsapp/disconnect');
      setVerify(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || 'הניתוק נכשל');
    } finally {
      setConnecting(false);
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
            <div className="rounded-lg bg-green-50 text-green-700 text-sm p-3 mb-3 flex items-center justify-between gap-3 flex-wrap">
              <span>● מחובר — מספר: <span className="font-mono">{state.phoneNumberId}</span></span>
              <button className="btn-ghost text-red-600 text-sm" disabled={connecting} onClick={disconnect}>
                {connecting ? '…' : 'ניתוק'}
              </button>
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
  const [sending, setSending] = useState(false);
  const [flows, setFlows] = useState([]);
  const [flowId, setFlowId] = useState(''); // '' = automatic (match by trigger words)
  const [loading, setLoading] = useState(true); // gate the whole body until flows load (no pop-in)
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    api.get('/api/flows')
      .then((r) => setFlows((r.data || []).filter((f) => f.isActive)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Pick a flow to force-test → start a clean thread (fresh test number + cleared chat).
  function pickFlow(id) {
    setFlowId(id);
    setMessages([]);
    if (id) setPhone(`9725000000${String(10 + Math.floor((Date.now() / 1000) % 89)).padStart(2, '0')}`);
  }

  async function send(e) {
    e.preventDefault();
    if (!text.trim()) return;
    const userMsg = text;
    setMessages((m) => [...m, { from: 'customer', text: userMsg }]);
    setText('');
    setSending(true);
    try {
      const res = await api.post('/api/whatsapp/simulate', { phone, text: userMsg, flowId: flowId || undefined });
      const ar = res.data.agentResponse;
      if (ar?.reply) {
        // Show HOW the agent answered: ✨ AI (used the LLM) vs 🤖 automatic (rule/flow).
        setMessages((m) => [...m, { from: 'agent', text: ar.reply, src: ar.ai?.used ? 'ai' : 'rules' }]);
      } else {
        setMessages((m) => [...m, { from: 'agent', text: 'ℹ️ הסוכן לא השיב על הודעה זו (למשל אחרי סיום תהליך).', src: 'info' }]);
      }
    } catch (err) {
      setMessages((m) => [...m, { from: 'agent', text: '⚠️ שגיאה: ' + (err.response?.data?.error || err.message), src: 'error' }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card mt-4">
      <h3 className="font-semibold mb-1">🧪 סימולטור סוכן</h3>
      <p className="text-sm text-gray-500 mb-3">בדקו את הסוכן בדיוק כמו לקוח אמיתי — הוא עונה מתוך <b>מאגר הידע</b>, <b>התהליכים</b> ו<b>מנוע הבינה</b> שהגדרתם. ההודעות נשמרות גם תחת "שיחות".</p>

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-slate-400 text-sm">
          <span className="inline-block h-7 w-7 rounded-full border-2 border-slate-200 border-t-brand-500 animate-spin" />
          טוען את הסימולטור…
        </div>
      ) : (
      <>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {flows.length > 0 && (
          <>
            <label className="text-sm text-gray-500">תהליך לבדיקה:</label>
            <select className="input w-56" value={flowId} onChange={(e) => pickFlow(e.target.value)}>
              <option value="">אוטומטי (לפי מילות הפעלה)</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </>
        )}
        <label className="text-sm text-gray-500">טלפון לבדיקה:</label>
        <input className="input w-40" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn-ghost" onClick={() => setMessages([])}>איפוס</button>
      </div>
      {flowId && (
        <div className="text-xs text-brand-600 bg-brand-50 rounded-lg p-2 mb-3">
          🔀 בדיקת התהליך <b>{flows.find((f) => f.id === flowId)?.name}</b> — שלחו הודעה כלשהי כדי להתחיל אותו מההתחלה.
        </div>
      )}

      <div className="border rounded-xl bg-gray-50 flex flex-col" style={{ height: 420 }}>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {messages.length === 0 && <div className="text-center text-gray-400 text-sm mt-10">שלחו הודעה כדי להתחיל…</div>}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.from === 'customer' ? 'justify-start' : 'justify-end'}`}>
              <div className={`max-w-[80%] ${m.from === 'customer' ? '' : 'text-left'}`}>
                <div className={`rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${m.from === 'customer' ? 'bg-white border' : 'bg-brand-600 text-white'}`}>
                  {m.text}
                </div>
                {m.from === 'agent' && (m.src === 'ai' || m.src === 'rules') && (
                  <div className="text-[11px] text-gray-400 mt-0.5 px-1">
                    {m.src === 'ai' ? '✨ נענה על ידי AI' : '🤖 מענה אוטומטי (כלל/תהליך)'}
                  </div>
                )}
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
      </>
      )}
    </div>
  );
}
