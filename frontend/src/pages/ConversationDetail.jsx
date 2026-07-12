import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api/client.js';
import { Spinner, StatusBadge, INTENT_LABELS } from '../components/ui.jsx';

export default function ConversationDetail() {
  const { id } = useParams();
  const [conv, setConv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    api.get(`/api/conversations/${id}`).then((res) => {
      setConv(res.data);
      setNote(res.data.notes || '');
    }).finally(() => setLoading(false));
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  async function setStatus(status) {
    await api.put(`/api/conversations/${id}/status`, { status });
    load();
  }
  async function assignHuman() {
    await api.post(`/api/conversations/${id}/assign-human`, {});
    load();
  }
  async function saveNote() {
    setSaving(true);
    await api.post(`/api/conversations/${id}/note`, { note });
    setSaving(false);
    load();
  }
  function exportConv() {
    const blob = new Blob([JSON.stringify(conv, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conversation-${id}.json`;
    a.click();
  }

  if (loading) return <Spinner />;
  if (!conv) return <div>שיחה לא נמצאה</div>;

  return (
    <div>
      <Link to="/conversations" className="text-sm text-brand-700 hover:underline">→ חזרה לשיחות</Link>
      <div className="flex items-start justify-between mt-2 mb-6">
        <div>
          <h1 className="text-2xl font-bold">{conv.customer?.name || 'ללא שם'}</h1>
          <p className="text-sm text-gray-500">{conv.whatsappPhone} · {INTENT_LABELS[conv.intent] || '—'}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <StatusBadge status={conv.status} />
          <button onClick={() => setStatus('completed')} className="btn-ghost">סמן כטופל</button>
          <button onClick={assignHuman} className="btn-ghost">העבר לנציג</button>
          <button onClick={exportConv} className="btn-ghost">ייצוא</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chat */}
        <div className="card lg:col-span-2 p-0 flex flex-col" style={{ maxHeight: '70vh' }}>
          <div className="border-b px-5 py-3 font-semibold">היסטוריית שיחה</div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
            {conv.messages.map((m) => (
              <div key={m.id} className={`flex ${m.senderType === 'customer' ? 'justify-start' : 'justify-end'}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
                    m.senderType === 'customer'
                      ? 'bg-white border border-gray-200'
                      : m.senderType === 'human'
                      ? 'bg-amber-100'
                      : 'bg-brand-600 text-white'
                  }`}
                >
                  {m.messageText}
                  <div className={`text-[10px] mt-1 ${m.senderType === 'agent' ? 'text-white/70' : 'text-gray-400'}`}>
                    {new Date(m.createdAt).toLocaleTimeString('he-IL')}
                  </div>
                </div>
              </div>
            ))}
            {conv.messages.length === 0 && <div className="text-center text-gray-400">אין הודעות</div>}
          </div>
        </div>

        {/* Side panel */}
        <div className="space-y-4">
          <div className="card">
            <h3 className="font-semibold mb-3">פרטים</h3>
            <dl className="text-sm space-y-2">
              <Row k="ציון ליד" v={<span className="badge bg-indigo-50 text-indigo-700">{conv.leadScore}</span>} />
              <Row k="תהליך נוכחי" v={conv.flow?.name || '—'} />
              <Row k="נשלח קישור" v={conv.linkSent ? 'כן' : 'לא'} />
              <Row k="צריך נציג" v={conv.needsHuman ? 'כן' : 'לא'} />
              <Row k="נוצר" v={new Date(conv.createdAt).toLocaleString('he-IL')} />
            </dl>
          </div>

          <div className="card">
            <h3 className="font-semibold mb-3">פרטים שנאספו</h3>
            {conv.answers.length === 0 ? (
              <p className="text-sm text-gray-400">לא נאספו פרטים</p>
            ) : (
              <ul className="text-sm space-y-2">
                {conv.answers.map((a) => (
                  <li key={a.id}>
                    <div className="text-gray-500">{a.questionText || a.question?.questionText}</div>
                    <div className="font-medium">{a.answer}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h3 className="font-semibold mb-3">הערה פנימית</h3>
            <textarea className="input h-24" value={note} onChange={(e) => setNote(e.target.value)} />
            <button onClick={saveNote} className="btn-primary w-full mt-2" disabled={saving}>
              {saving ? 'שומר…' : 'שמירת הערה'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex justify-between">
      <dt className="text-gray-500">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
