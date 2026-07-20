import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, Modal, EmptyState, ErrorState, errMsg } from '../components/ui.jsx';

const empty = () => ({ name: '', url: '', description: '', relatedFlowId: '', isActive: true, trackClicks: true, showOnBio: false });

export default function Links() {
  const [links, setLinks] = useState([]);
  const [flows, setFlows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);

  function load() {
    setLoading(true);
    setError('');
    Promise.all([api.get('/api/links'), api.get('/api/flows')])
      .then(([l, f]) => {
        setLinks(l.data);
        setFlows(f.data);
      })
      .catch((err) => setError(errMsg(err)))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function remove(link) {
    if (!confirm(`למחוק את הקישור "${link.name}"?`)) return;
    await api.delete(`/api/links/${link.id}`);
    load();
  }

  return (
    <div>
      <PageHeader
        title="קישורים"
        subtitle="קישורים שהסוכן שולח ללקוחות (עם מעקב קליקים)"
        actions={
          <>
            <a className="btn-ghost" href="/l" target="_blank" rel="noreferrer">עמוד הקישורים ↗</a>
            <button className="btn-primary" onClick={() => setEditing(empty())}>+ קישור חדש</button>
          </>
        }
      />

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : links.length === 0 ? (
        <EmptyState>אין קישורים עדיין</EmptyState>
      ) : (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="text-right px-4 py-3">שם</th>
                <th className="text-right px-4 py-3">כתובת</th>
                <th className="text-right px-4 py-3">תהליך מקושר</th>
                <th className="text-right px-4 py-3">קליקים</th>
                <th className="text-right px-4 py-3">סטטוס</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">{l.name}</td>
                  <td className="px-4 py-3 max-w-xs truncate text-brand-700">
                    <a href={l.url} target="_blank" rel="noreferrer" className="hover:underline">{l.url}</a>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{l.relatedFlow?.name || '—'}</td>
                  <td className="px-4 py-3"><span className="badge bg-indigo-50 text-indigo-700">{l.clicksCount}</span></td>
                  <td className="px-4 py-3">
                    <span className={`badge ${l.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}>
                      {l.isActive ? 'פעיל' : 'כבוי'}
                    </span>
                    {l.showOnBio && <span className="badge bg-teal-100 text-teal-700 mr-1">בעמוד</span>}
                  </td>
                  <td className="px-4 py-3 text-left">
                    <button className="btn-ghost px-2 ml-1" onClick={() => setEditing(l)}>עריכה</button>
                    <button className="btn-danger px-2" onClick={() => remove(l)}>מחיקה</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <LinkEditor
          initial={editing}
          flows={flows}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function LinkEditor({ initial, flows, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({
    name: initial.name || '',
    url: initial.url || '',
    description: initial.description || '',
    relatedFlowId: initial.relatedFlowId || '',
    isActive: initial.isActive ?? true,
    trackClicks: initial.trackClicks ?? true,
    showOnBio: initial.showOnBio ?? false,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      const payload = { ...form, relatedFlowId: form.relatedFlowId || null };
      if (isNew) await api.post('/api/links', payload);
      else await api.put(`/api/links/${initial.id}`, payload);
      onSaved();
    } catch (err) {
      alert(err.response?.data?.error || 'שמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? 'קישור חדש' : 'עריכת קישור'}>
      <div className="space-y-4">
        <div>
          <label className="label">שם</label>
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label className="label">כתובת URL</label>
          <input className="input" value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://" />
        </div>
        <div>
          <label className="label">תיאור</label>
          <input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div>
          <label className="label">תהליך מקושר</label>
          <select className="input" value={form.relatedFlowId} onChange={(e) => set('relatedFlowId', e.target.value)}>
            <option value="">— ללא —</option>
            {flows.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} /> פעיל
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.trackClicks} onChange={(e) => set('trackClicks', e.target.checked)} /> מעקב קליקים
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.showOnBio} onChange={(e) => set('showOnBio', e.target.checked)} /> בעמוד הקישורים (/l)
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t pt-4">
          <button className="btn-ghost" onClick={onClose}>ביטול</button>
          <button className="btn-primary" onClick={save} disabled={saving || !form.name || !form.url}>
            {saving ? 'שומר…' : 'שמירה'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
