import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, EmptyState, ErrorState, errMsg, INTENT_LABELS } from '../components/ui.jsx';

// ── Lead pipeline stages ──
// The schema has NO dedicated pipeline-stage column on Conversation (only a lifecycle
// `status` field: active | completed | abandoned | needs_human, plus needsHuman /
// leadScore / linkSent). So — per the task's "don't invent new stages / check the
// schema first" — we DERIVE the sales stage from those existing fields rather than
// adding a migration. stageOf() is the single source of truth for the mapping.
const STAGES = [
  { key: 'new', label: 'חדש', hint: 'שיחות חדשות שטרם טופלו', color: 'bg-sky-500', soft: 'bg-sky-50 border-sky-200', text: 'text-sky-700' },
  { key: 'engaged', label: 'בטיפול', hint: 'שיחה פעילה — הלקוח מתעניין', color: 'bg-indigo-500', soft: 'bg-indigo-50 border-indigo-200', text: 'text-indigo-700' },
  { key: 'qualified', label: 'ממתין לנציג', hint: 'ליד חם — מבקש נציג אנושי', color: 'bg-amber-500', soft: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
  { key: 'won', label: 'נסגר', hint: 'שיחה שהושלמה', color: 'bg-emerald-500', soft: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  { key: 'lost', label: 'אבוד', hint: 'שיחה שננטשה', color: 'bg-gray-400', soft: 'bg-gray-50 border-gray-200', text: 'text-gray-600' },
];

// Map a conversation to exactly one pipeline stage from its existing fields.
function stageOf(c) {
  if (c.status === 'completed') return 'won';
  if (c.status === 'abandoned') return 'lost';
  if (c.needsHuman || c.status === 'needs_human') return 'qualified';
  // active: split "new" vs "engaged" by whether we've made real progress with the lead.
  if (c.linkSent || (c.leadScore || 0) >= 40 || c.flow) return 'engaged';
  return 'new';
}

function scoreTone(score) {
  const s = score || 0;
  if (s >= 70) return 'bg-emerald-100 text-emerald-700';
  if (s >= 40) return 'bg-amber-100 text-amber-700';
  return 'bg-gray-100 text-gray-500';
}

function LeadCard({ c }) {
  return (
    <Link
      to={`/conversations/${c.id}`}
      className="block rounded-xl border border-gray-200 bg-white p-3 shadow-sm hover:shadow-md hover:border-brand-300 transition"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-gray-900 truncate">{c.customer?.name || 'ללא שם'}</div>
          <div className="text-xs text-gray-400 truncate" dir="ltr">{c.whatsappPhone}</div>
        </div>
        <span className={`badge shrink-0 ${scoreTone(c.leadScore)}`} title="ניקוד ליד">{c.leadScore ?? 0}</span>
      </div>
      {c.lastMessage && <div className="mt-2 text-xs text-gray-600 line-clamp-2">{c.lastMessage}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-gray-400">
        {c.intent && <span className="badge bg-gray-100 text-gray-500">{INTENT_LABELS[c.intent] || c.intent}</span>}
        {c.flow?.name && <span className="badge bg-gray-100 text-gray-500">{c.flow.name}</span>}
        <span className="mr-auto">{c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleDateString('he-IL') : ''}</span>
      </div>
    </Link>
  );
}

export default function Leads() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function load() {
    setLoading(true);
    setError('');
    // Pull a generous page of conversations; the pipeline groups them client-side by
    // derived stage (see stageOf). pageSize is capped at 100 by the API.
    api
      .get('/api/conversations?pageSize=100')
      .then((res) => setItems(res.data.items || []))
      .catch((err) => setError(errMsg(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const g = Object.fromEntries(STAGES.map((s) => [s.key, []]));
    for (const c of items) g[stageOf(c)].push(c);
    return g;
  }, [items]);

  return (
    <div>
      <PageHeader
        title="צינור לידים"
        subtitle={`${items.length} לידים לפי שלב בתהליך`}
        actions={<Link to="/conversations" className="btn-ghost">תצוגת רשימה ←</Link>}
      />

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : items.length === 0 ? (
        <EmptyState>אין לידים להצגה</EmptyState>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {STAGES.map((stage) => {
            const cards = grouped[stage.key];
            return (
              <div key={stage.key} className="w-72 shrink-0">
                <div className={`rounded-t-xl border-x border-t px-3 py-2.5 ${stage.soft}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${stage.color}`} />
                      <span className={`font-semibold text-sm ${stage.text}`}>{stage.label}</span>
                    </div>
                    <span className="badge bg-white/70 text-gray-600">{cards.length}</span>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{stage.hint}</div>
                </div>
                <div className="rounded-b-xl border border-gray-200 bg-gray-50/60 p-2 space-y-2 min-h-[8rem]">
                  {cards.length === 0 ? (
                    <div className="text-center text-xs text-gray-300 py-6">אין לידים בשלב זה</div>
                  ) : (
                    cards.map((c) => <LeadCard key={c.id} c={c} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
