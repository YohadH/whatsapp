import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner } from '../components/ui.jsx';

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

export default function KnowledgeBase() {
  const [kb, setKb] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/api/knowledge-base').then((res) => setKb(res.data)).finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    const payload = Object.fromEntries(FIELDS.map((f) => [f.key, kb[f.key] || '']));
    const res = await api.put('/api/knowledge-base', payload);
    setKb(res.data);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  if (loading) return <Spinner />;

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
