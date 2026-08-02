import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { StatCard, Spinner, ErrorState, errMsg } from '../components/ui.jsx';

export default function Dashboard() {
  const [overview, setOverview] = useState(null);
  const [series, setSeries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // WhatsApp not connected yet → nudge into the onboarding wizard.
  const [waConnected, setWaConnected] = useState(true);

  function load() {
    setLoading(true);
    setError('');
    Promise.all([api.get('/api/analytics/overview'), api.get('/api/analytics/conversations?days=14')])
      .then(([o, c]) => {
        setOverview(o.data);
        setSeries(c.data.series);
      })
      .catch((err) => setError(errMsg(err)))
      .finally(() => setLoading(false));
    api.get('/api/settings/whatsapp').then((r) => setWaConnected(Boolean(r.data.connected))).catch(() => {});
  }

  useEffect(() => { load(); }, []);

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  const o = overview || {};

  const fmtTime = (s) => (s >= 60 ? `${Math.round(s / 60)} ד׳` : `${s} ש׳`);

  return (
    <div>
      <PageHeader title="דאשבורד" subtitle="סקירה כללית של פעילות הסוכן" />

      {!waConnected && (
        <div className="mb-4 rounded-2xl border border-brand-200 bg-brand-50 p-4 flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-brand-800">
            <b>עוד לא חיברתם את WhatsApp.</b> שלושה צעדים קצרים והסוכן מתחיל לענות ללקוחות.
          </div>
          <Link to="/onboarding" className="btn-primary text-sm whitespace-nowrap">להשלמת ההקמה ←</Link>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <StatCard label="סה״כ שיחות" value={o.totalConversations} />
        <StatCard label="שיחות חדשות היום" value={o.newToday} accent="text-brand-600" />
        <StatCard label="שיחות פתוחות" value={o.openConversations} />
        <StatCard label="שיחות שהושלמו" value={o.completedConversations} accent="text-green-600" />
        <StatCard label="ממתינות לנציג" value={o.waitingForHuman} accent="text-amber-600" />
        <StatCard label="סה״כ לידים" value={o.totalLeads} />
        <StatCard label="אחוז המרה" value={`${o.conversionRate}%`} accent="text-brand-600" />
        <StatCard label="זמן תגובה ממוצע" value={fmtTime(o.avgResponseTimeSec)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card lg:col-span-2">
          <h3 className="font-semibold mb-4">שיחות ב-14 הימים האחרונים</h3>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={series}>
              <defs>
                <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0054FC" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#0054FC" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Area type="monotone" dataKey="conversations" name="שיחות" stroke="#0054FC" fill="url(#g)" />
              <Area type="monotone" dataKey="leads" name="לידים" stroke="#EE03FD" fillOpacity={0} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h3 className="font-semibold mb-4">תובנות מהירות</h3>
          <ul className="space-y-3 text-sm">
            <li className="flex justify-between">
              <span className="text-gray-500">התהליך הנפוץ ביותר</span>
              <span className="font-medium">{o.mostUsedFlow?.name || '—'}</span>
            </li>
            <li className="flex justify-between">
              <span className="text-gray-500">הקישור הנלחץ ביותר</span>
              <span className="font-medium">{o.mostClickedLink?.name || '—'}</span>
            </li>
            <li className="flex justify-between">
              <span className="text-gray-500">נטשו לפני סיום</span>
              <span className="font-medium text-amber-600">{o.droppedBeforeComplete}</span>
            </li>
          </ul>
          <Link to="/conversations?needsHuman=true" className="btn-ghost w-full mt-5">
            צפייה בשיחות הממתינות ({o.waitingForHuman}) ←
          </Link>
        </div>
      </div>
    </div>
  );
}
