import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, StatusBadge, EmptyState, INTENT_LABELS } from '../components/ui.jsx';

const STATUS_OPTIONS = [
  { value: '', label: 'הכל' },
  { value: 'active', label: 'פעילות' },
  { value: 'needs_human', label: 'ממתינות לנציג' },
  { value: 'completed', label: 'הושלמו' },
  { value: 'abandoned', label: 'ננטשו' },
];

export default function Conversations() {
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(params.get('search') || '');

  const status = params.get('status') || '';
  const needsHuman = params.get('needsHuman') || '';

  function load() {
    setLoading(true);
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (needsHuman) q.set('needsHuman', needsHuman);
    if (search) q.set('search', search);
    api
      .get(`/api/conversations?${q.toString()}`)
      .then((res) => setData(res.data))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, needsHuman]);

  function setStatus(value) {
    const next = new URLSearchParams(params);
    if (value) next.set('status', value);
    else next.delete('status');
    next.delete('needsHuman');
    setParams(next);
  }

  return (
    <div>
      <PageHeader title="שיחות" subtitle={`${data.total} שיחות בסך הכל`} />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s.value}
            onClick={() => setStatus(s.value)}
            className={`badge px-3 py-1.5 ${
              status === s.value || (!status && !s.value) ? 'bg-brand-600 text-white' : 'bg-white border border-gray-200 text-gray-600'
            }`}
          >
            {s.label}
          </button>
        ))}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
          className="mr-auto flex gap-2"
        >
          <input className="input w-56" placeholder="חיפוש לפי שם / טלפון / הודעה" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn-ghost">חיפוש</button>
        </form>
      </div>

      {loading ? (
        <Spinner />
      ) : data.items.length === 0 ? (
        <EmptyState>אין שיחות להצגה</EmptyState>
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="text-right px-4 py-3">לקוח</th>
                <th className="text-right px-4 py-3">הודעה אחרונה</th>
                <th className="text-right px-4 py-3">כוונה</th>
                <th className="text-right px-4 py-3">תהליך</th>
                <th className="text-right px-4 py-3">סטטוס</th>
                <th className="text-right px-4 py-3">ליד</th>
                <th className="text-right px-4 py-3">פעילות אחרונה</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link to={`/conversations/${c.id}`} className="font-medium text-brand-700 hover:underline">
                      {c.customer?.name || 'ללא שם'}
                    </Link>
                    <div className="text-xs text-gray-400">{c.whatsappPhone}</div>
                  </td>
                  <td className="px-4 py-3 max-w-xs truncate text-gray-600">{c.lastMessage || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{INTENT_LABELS[c.intent] || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{c.flow?.name || '—'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                    {c.needsHuman && <span className="badge bg-amber-100 text-amber-700 mr-1">נציג</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="badge bg-indigo-50 text-indigo-700">{c.leadScore}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400">{new Date(c.lastActivityAt).toLocaleString('he-IL')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
