import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, FunnelChart, Funnel, LabelList,
  XAxis, YAxis, Tooltip, CartesianGrid, Cell, PieChart, Pie,
} from 'recharts';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, ErrorState, errMsg, INTENT_LABELS } from '../components/ui.jsx';
import { buildAnalyticsCsv, downloadCsv, analyticsFilename } from '../lib/csv.js';

// Cohesive palette — the HeyIL logo ramp (royal blue → violet → magenta) as the
// series colors, with amber/red kept for their semantic warning/error roles.
const C = {
  brand: '#0054FC',
  violet: '#8504FD',
  amber: '#f59e0b',
  red: '#ef4444',
  slate: '#94a3b8',
  ink: '#0f172a',
  grid: '#eef2f7',
  axis: '#94a3b8',
};
const PIE = [C.brand, C.violet, '#EE03FD', C.amber, '#3E7BFF', '#A94CFE', '#EE5EFD', C.red];

const nf = (n) => Number(n || 0).toLocaleString('he-IL');
const fmtTime = (s) => (s >= 60 ? `${Math.round(s / 60)} ד׳` : `${Math.round(s || 0)} ש׳`);

// ── Shared building blocks ───────────────────────────────────
function Kpi({ label, value, tone = 'ink', hint }) {
  const tones = {
    ink: 'text-slate-900',
    green: 'text-emerald-600',
    indigo: 'text-indigo-600',
    amber: 'text-amber-600',
    slate: 'text-slate-500',
  };
  const bars = { ink: 'bg-slate-300', green: 'bg-emerald-400', indigo: 'bg-indigo-400', amber: 'bg-amber-400', slate: 'bg-slate-300' };
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
      <span className={`absolute top-0 right-0 h-full w-1 ${bars[tone]}`} />
      <div className="text-[11px] font-medium tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1.5 text-[28px] leading-none font-bold tabular-nums ${tones[tone]}`}>{value}</div>
      {hint != null && <div className="mt-1.5 text-xs text-slate-400 truncate">{hint}</div>}
    </div>
  );
}

function Card({ title, subtitle, children, className = '' }) {
  return (
    <div className={`rounded-2xl bg-white border border-slate-100 shadow-sm p-5 ${className}`}>
      <div className="mb-4">
        <h3 className="font-semibold text-slate-800">{title}</h3>
        {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl bg-white/95 backdrop-blur border border-slate-100 shadow-lg px-3 py-2 text-xs min-w-[9rem]">
      {label != null && <div className="font-semibold text-slate-700 mb-1.5">{label}</div>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color || p.fill }} />
          <span className="text-slate-500">{p.name}</span>
          <span className="font-semibold text-slate-800 tabular-nums mr-auto">{nf(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

const axis = { tick: { fontSize: 11, fill: C.axis }, axisLine: false, tickLine: false };

function Empty({ label = 'אין מספיק נתונים עדיין' }) {
  return (
    <div className="h-52 flex flex-col items-center justify-center gap-3 text-slate-300">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 3v18h18" strokeLinecap="round" />
        <path d="M7 14l3-4 3 3 4-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-sm text-slate-400">{label}</span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────
export default function Analytics() {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function load() {
    setLoading(true);
    setError('');
    Promise.all([
      api.get('/api/analytics/overview'),
      api.get('/api/analytics/conversations?days=30'),
      api.get('/api/analytics/flows'),
      api.get('/api/analytics/links'),
      api.get('/api/analytics/questions'),
      api.get('/api/analytics/funnel'),
    ])
      .then(([overview, conv, flows, links, questions, funnel]) =>
        setD({ o: overview.data, conv: conv.data, flows: flows.data, links: links.data, questions: questions.data, funnel: funnel.data })
      )
      .catch((err) => setError(errMsg(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return null;

  const o = d.o || {};
  const intentData = d.questions.customersByIntent.map((i) => ({ name: INTENT_LABELS[i.intent] || i.intent, value: i.count }));

  function exportCsv() {
    downloadCsv(analyticsFilename(), buildAnalyticsCsv(d, INTENT_LABELS));
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="אנליטיקס"
        subtitle="ביצועי הסוכן ב-30 הימים האחרונים"
        actions={<button className="btn-ghost" onClick={exportCsv}>⬇ ייצוא ל-CSV</button>}
      />

      {/* KPI band — the headline numbers at a glance */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <Kpi label="סה״כ שיחות" value={nf(o.totalConversations)} hint={`${nf(o.newToday)} חדשות היום`} />
        <Kpi label="לידים" value={nf(o.totalLeads)} tone="indigo" hint={`${nf(o.droppedBeforeComplete)} נטשו לפני סיום`} />
        <Kpi label="אחוז המרה" value={`${o.conversionRate ?? 0}%`} tone="green" hint="שיחות שהפכו ללידים" />
        <Kpi label="זמן תגובה ממוצע" value={fmtTime(o.avgResponseTimeSec)} tone="slate" hint="עד תשובת הסוכן" />
        <Kpi label="ממתינות לנציג" value={nf(o.waitingForHuman)} tone="amber" hint="דורשות טיפול אנושי" />
      </div>

      {/* Hero — activity over time */}
      <Card title="פעילות לאורך זמן" subtitle="שיחות, לידים ולקוחות חדשים ב-30 הימים האחרונים">
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={d.conv.series} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id="gConv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.brand} stopOpacity={0.35} />
                <stop offset="100%" stopColor={C.brand} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gLead" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.violet} stopOpacity={0.25} />
                <stop offset="100%" stopColor={C.violet} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="date" {...axis} minTickGap={24} />
            <YAxis allowDecimals={false} {...axis} width={34} />
            <Tooltip content={<ChartTip />} cursor={{ stroke: C.slate, strokeDasharray: '4 4' }} />
            <Area type="monotone" dataKey="conversations" name="שיחות" stroke={C.brand} strokeWidth={2.5} fill="url(#gConv)" />
            <Area type="monotone" dataKey="leads" name="לידים" stroke={C.violet} strokeWidth={2} fill="url(#gLead)" />
            <Area type="monotone" dataKey="newCustomers" name="לקוחות חדשים" stroke={C.amber} strokeWidth={2} fill="none" strokeDasharray="4 3" />
          </AreaChart>
        </ResponsiveContainer>
        <Legend items={[['שיחות', C.brand], ['לידים', C.violet], ['לקוחות חדשים', C.amber]]} />
      </Card>

      {/* Supporting grid */}
      <div className="grid lg:grid-cols-2 gap-5">
        <Card title="משפך המרה" subtitle="מהשיחה הראשונה ועד ליד שהושלם">
          {d.funnel.funnel.some((f) => f.count > 0) ? (
            <ResponsiveContainer width="100%" height={260}>
              <FunnelChart>
                <Tooltip content={<ChartTip />} />
                <Funnel dataKey="count" data={d.funnel.funnel} isAnimationActive>
                  <LabelList position="right" dataKey="stage" fill={C.ink} stroke="none" fontSize={12} />
                  <LabelList position="left" dataKey="count" fill="#475569" stroke="none" fontSize={12} />
                  {d.funnel.funnel.map((_, i) => (
                    <Cell key={i} fill={PIE[i % PIE.length]} />
                  ))}
                </Funnel>
              </FunnelChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </Card>

        <Card title="ביצועים לפי תהליך" subtitle="כמה התחילו, השלימו ונטשו כל תהליך">
          {d.flows.flows.length ? (
            <>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={d.flows.flows} margin={{ top: 6, right: 8, left: -16, bottom: 0 }} barGap={2}>
                  <CartesianGrid vertical={false} stroke={C.grid} />
                  <XAxis dataKey="name" {...axis} />
                  <YAxis allowDecimals={false} {...axis} width={34} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                  <Bar dataKey="started" name="התחילו" fill={C.violet} radius={[5, 5, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="completed" name="הושלמו" fill={C.brand} radius={[5, 5, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="abandoned" name="ננטשו" fill={C.red} radius={[5, 5, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
              <Legend items={[['התחילו', C.violet], ['הושלמו', C.brand], ['ננטשו', C.red]]} />
              {d.flows.bestConverting && (
                <p className="text-sm text-slate-500 mt-3 border-t border-slate-100 pt-3">
                  הכי ממיר: <b className="text-emerald-600">{d.flows.bestConverting.name}</b> ({d.flows.bestConverting.conversionRate}%)
                  {d.flows.worstConverting && d.flows.worstConverting.flowId !== d.flows.bestConverting.flowId && (
                    <> · הכי פחות: <b className="text-amber-600">{d.flows.worstConverting.name}</b> ({d.flows.worstConverting.conversionRate}%)</>
                  )}
                </p>
              )}
            </>
          ) : (
            <Empty />
          )}
        </Card>

        <Card title="קליקים על קישורים" subtitle="נשלחו מול נלחצו">
          {d.links.links.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={d.links.links} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }} barGap={2}>
                <CartesianGrid horizontal={false} stroke={C.grid} />
                <XAxis type="number" allowDecimals={false} {...axis} />
                <YAxis type="category" dataKey="name" width={120} {...axis} />
                <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                <Bar dataKey="sent" name="נשלחו" fill={C.slate} radius={[0, 5, 5, 0]} maxBarSize={16} />
                <Bar dataKey="clicks" name="קליקים" fill={C.brand} radius={[0, 5, 5, 0]} maxBarSize={16} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </Card>

        <Card title="לקוחות לפי כוונה" subtitle="על מה הלקוחות שואלים">
          {intentData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={intentData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={52} outerRadius={92} paddingAngle={2} stroke="#fff" strokeWidth={2}>
                  {intentData.map((_, i) => (
                    <Cell key={i} fill={PIE[i % PIE.length]} />
                  ))}
                </Pie>
                <Tooltip content={<ChartTip />} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
          {intentData.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2">
              {intentData.slice(0, 8).map((it, i) => (
                <span key={i} className="flex items-center gap-1.5 text-xs text-slate-500">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: PIE[i % PIE.length] }} />
                  {it.name}
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="נשירה לפי שאלה" subtitle="היכן לקוחות עוזבים באמצע תהליך" className="lg:col-span-2">
          {d.questions.dropOffByQuestion.length ? (
            <>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={d.questions.dropOffByQuestion} margin={{ top: 6, right: 8, left: -16, bottom: 40 }} barGap={2}>
                  <CartesianGrid vertical={false} stroke={C.grid} />
                  <XAxis dataKey="question" {...axis} interval={0} angle={-15} textAnchor="end" height={70} />
                  <YAxis allowDecimals={false} {...axis} width={34} />
                  <Tooltip content={<ChartTip />} cursor={{ fill: 'rgba(148,163,184,0.08)' }} />
                  <Bar dataKey="asked" name="נשאלו" fill={C.violet} radius={[5, 5, 0, 0]} maxBarSize={30} />
                  <Bar dataKey="answered" name="ענו" fill={C.brand} radius={[5, 5, 0, 0]} maxBarSize={30} />
                </BarChart>
              </ResponsiveContainer>
              <Legend items={[['נשאלו', C.violet], ['ענו', C.brand]]} />
            </>
          ) : (
            <Empty />
          )}
        </Card>
      </div>

      <Card title="שאלות נפוצות ללא מענה" subtitle="שאלות שהסוכן העביר לנציג אנושי — הזדמנות להרחיב את מאגר הידע">
        {d.questions.mostCommonUnanswered.length ? (
          <div className="flex flex-wrap gap-2">
            {d.questions.mostCommonUnanswered.slice(0, 20).map((q, i) => (
              <span key={i} className="rounded-full bg-amber-50 text-amber-700 border border-amber-100 px-3 py-1.5 text-sm">
                {q}
              </span>
            ))}
          </div>
        ) : (
          <Empty label="כל השאלות נענו — אין מה להוסיף כרגע 🎉" />
        )}
      </Card>
    </div>
  );
}

// Compact inline legend (replaces recharts' default for a cleaner look).
function Legend({ items }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 justify-center">
      {items.map(([name, color], i) => (
        <span key={i} className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="w-3 h-1.5 rounded-full" style={{ background: color }} />
          {name}
        </span>
      ))}
    </div>
  );
}
