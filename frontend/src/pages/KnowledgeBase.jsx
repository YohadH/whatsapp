import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, ErrorState, errMsg } from '../components/ui.jsx';

const FIELDS = [
  { key: 'businessDescription', label: 'תיאור העסק', rows: 3 },
  { key: 'productInfo', label: 'מידע על מוצרים', rows: 3 },
  { key: 'serviceInfo', label: 'מידע על שירותים', rows: 3 },
  { key: 'prices', label: 'מחירים', rows: 3 },
  { key: 'shippingInfo', label: 'מידע על משלוחים', rows: 2 },
  { key: 'returnPolicy', label: 'מדיניות החזרות', rows: 2 },
  { key: 'faq', label: 'שאלות נפוצות', rows: 4 },
  { key: 'openingHours', label: 'שעות פעילות', rows: 2 },
  { key: 'contactDetails', label: 'פרטי יצירת קשר', rows: 2 },
  { key: 'limitations', label: 'מגבלות חשובות', rows: 2 },
  { key: 'customInstructions', label: 'הוראות מיוחדות לסוכן', rows: 3 },
];

// Structured business-hours widget — day chips (א׳–ש׳) + open/close times + an
// away message. When enabled, the engine auto-replies with the away message
// outside these hours instead of running the agent.
const DAY_LABELS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
function BusinessHours({ value, onChange }) {
  const bh = value || { enabled: false, days: [0, 1, 2, 3, 4], open: '09:00', close: '17:00', awayMessage: '' };
  const set = (patch) => onChange({ ...bh, ...patch });
  const toggleDay = (d) =>
    set({ days: bh.days?.includes(d) ? bh.days.filter((x) => x !== d) : [...(bh.days || []), d].sort() });

  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="font-semibold">🕐 שעות פעילות</h3>
          <p className="text-xs text-slate-400 mt-0.5">מחוץ לשעות אלה הסוכן ישיב בהודעת "לא זמין" במקום לענות.</p>
        </div>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" className="accent-brand-500" checked={bh.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          מופעל
        </label>
      </div>
      {bh.enabled && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {DAY_LABELS.map((lbl, d) => (
              <button
                type="button"
                key={d}
                onClick={() => toggleDay(d)}
                className={`h-9 w-9 rounded-full text-sm transition ${
                  bh.days?.includes(d) ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div><label className="label">פתיחה</label><input type="time" className="input w-32" value={bh.open || '09:00'} onChange={(e) => set({ open: e.target.value })} /></div>
            <div><label className="label">סגירה</label><input type="time" className="input w-32" value={bh.close || '17:00'} onChange={(e) => set({ close: e.target.value })} /></div>
          </div>
          <div>
            <label className="label">הודעה מחוץ לשעות הפעילות</label>
            <textarea className="input h-20" value={bh.awayMessage || ''} onChange={(e) => set({ awayMessage: e.target.value })} placeholder="תודה על פנייתכם! אנחנו זמינים בימים א׳–ה׳ 09:00–17:00 ונחזור אליכם בהקדם 🙏" />
          </div>
        </div>
      )}
    </div>
  );
}

export default function KnowledgeBase() {
  const [kb, setKb] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');

  function load() {
    setLoading(true);
    setError('');
    api.get('/api/knowledge-base')
      .then((res) => setKb(res.data))
      .catch((err) => setError(errMsg(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    setSaveError('');
    const payload = Object.fromEntries(FIELDS.map((f) => [f.key, kb[f.key] || '']));
    payload.businessHours = kb.businessHours || null;
    try {
      const res = await api.put('/api/knowledge-base', payload);
      setKb(res.data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(errMsg(err, 'שמירת מאגר הידע נכשלה'));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;
  if (error || !kb) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <PageHeader
        title="מאגר ידע"
        subtitle="המידע היחיד שהסוכן עונה ממנו — אל תשאירו פרטים חשובים בחוץ"
        actions={
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'שומר…' : saved ? '✓ נשמר' : 'שמירה'}
          </button>
        }
      />
      {saveError && <div className="card bg-red-50 text-red-600 text-sm mb-4">{saveError}</div>}
      <BusinessHours value={kb.businessHours} onChange={(bh) => setKb({ ...kb, businessHours: bh })} />
      <div className="grid md:grid-cols-2 gap-4">
        {FIELDS.map((f) => (
          <div key={f.key} className="card">
            <label className="label">{f.label}</label>
            <textarea
              className="input"
              style={{ height: `${f.rows * 1.8 + 1}rem` }}
              value={kb[f.key] || ''}
              onChange={(e) => setKb({ ...kb, [f.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
