import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, FunnelChart, Funnel, LabelList,
  XAxis, YAxis, Tooltip, CartesianGrid, Cell, PieChart, Pie, Legend,
} from 'recharts';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, INTENT_LABELS } from '../components/ui.jsx';

const COLORS = ['#10b981', '#6366f1', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];

function Panel({ title, children }) {
  return (
    <div className="card">
      <h3 className="font-semibold mb-4">{title}</h3>
      {children}
    </div>
  );
}

export default function Analytics() {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/api/analytics/conversations?days=30'),
      api.get('/api/analytics/flows'),
      api.get('/api/analytics/links'),
      api.get('/api/analytics/questions'),
      api.get('/api/analytics/funnel'),
    ])
      .then(([conv, flows, links, questions, funnel]) =>
        setD({ conv: conv.data, flows: flows.data, links: links.data, questions: questions.data, funnel: funnel.data })
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Spinner />;
  if (!d) return null;

  const intentData = d.questions.customersByIntent.map((i) => ({ name: INTENT_LABELS[i.intent] || i.intent, value: i.count }));

  return (
    <div>
      <PageHeader title="אנליטיקס" subtitle="ביצועי הסוכן ב-30 הימים האחרונים" />

      <div className="grid lg:grid-cols-2 gap-4">
        <Panel title="שיחות ולידים לאורך זמן">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={d.conv.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="conversations" name="שיחות" stroke="#10b981" />
              <Line type="monotone" dataKey="leads" name="לידים" stroke="#6366f1" />
              <Line type="monotone" dataKey="newCustomers" name="לקוחות חדשים" stroke="#f59e0b" />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="משפך המרה">
          {d.funnel.funnel.some((f) => f.count > 0) ? (
            <ResponsiveContainer width="100%" height={260}>
              <FunnelChart>
                <Tooltip />
                <Funnel dataKey="count" data={d.funnel.funnel} isAnimationActive>
                  <LabelList position="right" dataKey="stage" fill="#374151" stroke="none" fontSize={12} />
                  <LabelList position="left" dataKey="count" fill="#111827" stroke="none" fontSize={12} />
                  {d.funnel.funnel.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Funnel>
              </FunnelChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </Panel>

        <Panel title="המרה לפי תהליך">
          {d.flows.flows.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={d.flows.flows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="started" name="התחילו" fill="#6366f1" />
                <Bar dataKey="completed" name="הושלמו" fill="#10b981" />
                <Bar dataKey="abandoned" name="ננטשו" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
          {d.flows.bestConverting && (
            <p className="text-sm text-gray-500 mt-3">
              הכי ממיר: <b className="text-green-600">{d.flows.bestConverting.name}</b> ({d.flows.bestConverting.conversionRate}%)
              {d.flows.worstConverting && d.flows.worstConverting.flowId !== d.flows.bestConverting.flowId && (
                <> · הכי פחות: <b className="text-amber-600">{d.flows.worstConverting.name}</b> ({d.flows.worstConverting.conversionRate}%)</>
              )}
            </p>
          )}
        </Panel>

        <Panel title="קליקים על קישורים">
          {d.links.links.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={d.links.links} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="sent" name="נשלחו" fill="#94a3b8" />
                <Bar dataKey="clicks" name="קליקים" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </Panel>

        <Panel title="לקוחות לפי כוונה">
          {intentData.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={intentData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                  {intentData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </Panel>

        <Panel title="נשירה לפי שאלה">
          {d.questions.dropOffByQuestion.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={d.questions.dropOffByQuestion}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis dataKey="question" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={60} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="asked" name="נשאלו" fill="#6366f1" />
                <Bar dataKey="answered" name="ענו" fill="#10b981" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <Empty />
          )}
        </Panel>
      </div>

      <Panel title="שאלות נפוצות ללא מענה (הועברו לנציג)">
        {d.questions.mostCommonUnanswered.length ? (
          <ul className="text-sm space-y-1 list-disc pr-5">
            {d.questions.mostCommonUnanswered.slice(0, 15).map((q, i) => (
              <li key={i} className="text-gray-600">{q}</li>
            ))}
          </ul>
        ) : (
          <Empty />
        )}
      </Panel>
    </div>
  );
}

function Empty() {
  return <div className="h-40 flex items-center justify-center text-gray-400 text-sm">אין מספיק נתונים עדיין</div>;
}
