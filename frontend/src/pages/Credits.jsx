import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { StatCard, Spinner, ErrorState, errMsg } from '../components/ui.jsx';

const TXN_LABELS = {
  debit: 'שימוש ב-AI',
  topup: 'רכישת קרדיטים',
  grant: 'זיכוי',
  adjust: 'התאמה',
};

export default function Credits() {
  const [data, setData] = useState(null);
  const [txns, setTxns] = useState([]);
  const [packs, setPacks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [buying, setBuying] = useState('');
  const [notice, setNotice] = useState('');

  function load() {
    setLoading(true);
    setError('');
    Promise.all([api.get('/api/credits'), api.get('/api/credits/transactions'), api.get('/api/credits/packs')])
      .then(([c, t, p]) => {
        setData(c.data);
        setTxns(t.data);
        setPacks(p.data.packs || []);
      })
      .catch((err) => setError(errMsg(err)))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function buy(pack) {
    setBuying(pack.id); setNotice('');
    try {
      const r = await api.post('/api/credits/purchase', { packId: pack.id });
      if (r.data.mode === 'redirect' && r.data.url) {
        window.location.href = r.data.url; // real gateway
      } else {
        setNotice(`בקשת רכישה של ${pack.label} התקבלה. הקרדיטים ייטענו לאחר אישור התשלום.`);
      }
    } catch (err) {
      setNotice(errMsg(err, 'הרכישה נכשלה'));
    } finally {
      setBuying('');
    }
  }

  if (loading) return <Spinner />;
  if (error || !data) return <ErrorState message={error} onRetry={load} />;

  const fmt = (n) => Number(n).toLocaleString('he-IL');

  return (
    <div>
      <PageHeader
        title="קרדיטים"
        subtitle="כל תשובת AI ללקוח צורכת קרדיט אחד. שאלות במסגרת תהליך מוגדר — חינם."
      />

      {data.lowCredit && (
        <div className="card bg-red-50 text-red-700 text-sm mb-4">
          נגמרו הקרדיטים — הסוכן ממשיך לענות במצב בסיסי (ללא AI). טענו קרדיטים כדי להחזיר תשובות חכמות.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="קרדיטים זמינים" value={fmt(data.available)} accent="text-brand-600" />
        <StatCard label="נוצלו החודש" value={fmt(data.spentThisPeriod)} />
        <StatCard label="מכסה חודשית שנותרה" value={`${fmt(data.monthlyRemaining)} / ${fmt(data.monthlyAllotment)}`} />
        <StatCard label="קרדיטים שנרכשו" value={fmt(data.purchased)} sub="לא מתאפסים בסוף החודש" />
      </div>

      {packs.length > 0 && (
        <div className="mb-6">
          <h3 className="font-semibold mb-3">רכישת קרדיטים</h3>
          {notice && <div className="card bg-brand-50 text-brand-700 text-sm mb-3">{notice}</div>}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {packs.map((p) => (
              <div key={p.id} className={`card flex flex-col items-center text-center ${p.popular ? 'ring-2 ring-brand-500' : ''}`}>
                {p.popular && <div className="badge bg-brand-100 text-brand-700 mb-2">הכי משתלם</div>}
                <div className="text-2xl font-bold">{fmt(p.credits)}</div>
                <div className="text-sm text-gray-500 mb-3">קרדיטים</div>
                <div className="text-xl font-semibold mb-3">₪{fmt(p.amountIls)}</div>
                <button className="btn-primary w-full" disabled={!!buying} onClick={() => buy(p)}>
                  {buying === p.id ? 'מעבד…' : 'רכישה'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b font-semibold text-sm">היסטוריית תנועות</div>
        {txns.length === 0 ? (
          <div className="text-center text-gray-400 py-10 text-sm">אין תנועות עדיין</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="text-right px-4 py-2">תאריך</th>
                <th className="text-right px-4 py-2">סוג</th>
                <th className="text-right px-4 py-2">כמות</th>
                <th className="text-right px-4 py-2">פירוט</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="px-4 py-2 text-gray-500 text-xs">{new Date(t.createdAt).toLocaleString('he-IL')}</td>
                  <td className="px-4 py-2">{TXN_LABELS[t.type] || t.type}</td>
                  <td className={`px-4 py-2 font-medium ${t.amount < 0 ? 'text-gray-700' : 'text-green-600'}`}>
                    {t.amount > 0 ? `+${fmt(t.amount)}` : fmt(t.amount)}
                  </td>
                  <td className="px-4 py-2 text-gray-400 text-xs">{t.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-400 mt-4">
        לרכישת קרדיטים פנו לתמיכה. תשלום מקוון (Cardcom / Meshulam / PayPlus) יתווסף בקרוב.
      </p>
    </div>
  );
}
