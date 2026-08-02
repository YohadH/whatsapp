import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, Modal } from '../components/ui.jsx';

// Expense book — receipts the owner photographed into WhatsApp (the webhook's
// receipt pipeline parses them with the vision model). This page is the review
// surface: monthly view, totals, corrections, receipt image, CSV export.

const fmt = (n) => Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 });
const monthNow = () => new Date().toISOString().slice(0, 7);

// Hebrew label for a 'YYYY-MM' key — the native <input type=month> popup follows
// the BROWSER locale (English month names on most machines), so the picker is a
// custom prev/next navigator instead.
const monthLabel = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const shiftMonth = (ym, delta) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// Israeli-format display date (dd.mm.yyyy) from an expense row.
function dateOf(e) {
  const iso = (e.expenseDate || e.createdAt || '').slice(0, 10);
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${Number(d)}.${Number(m)}.${y}`;
}

export default function Expenses() {
  const [month, setMonth] = useState(monthNow());
  const [items, setItems] = useState([]);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // expense being edited
  const [saving, setSaving] = useState(false);
  const [viewingImg, setViewingImg] = useState(null); // { id, url }

  function load() {
    setLoading(true);
    api
      .get('/api/expenses', { params: { month } })
      .then((r) => { setItems(r.data.items); setTotals(r.data.totals); })
      .catch(() => { setItems([]); setTotals(null); })
      .finally(() => setLoading(false));
  }
  useEffect(load, [month]);

  async function viewImage(e) {
    try {
      const r = await api.get(`/api/expenses/${e.id}/image`, { responseType: 'blob' });
      setViewingImg({ id: e.id, url: URL.createObjectURL(r.data) });
    } catch {
      alert('אין תמונה שמורה לקבלה זו');
    }
  }

  function closeImage() {
    if (viewingImg?.url) URL.revokeObjectURL(viewingImg.url);
    setViewingImg(null);
  }

  async function saveEdit(ev) {
    ev.preventDefault();
    setSaving(true);
    try {
      const { id, vendor, category, total, vatAmount, expenseDate } = editing;
      await api.put(`/api/expenses/${id}`, {
        vendor, category,
        total: total === '' ? null : total,
        vatAmount: vatAmount === '' ? null : vatAmount,
        expenseDate: expenseDate || null,
      });
      setEditing(null);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'השמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  async function remove(e) {
    if (!window.confirm(`למחוק את הקבלה${e.vendor ? ` מ-${e.vendor}` : ''}? הפעולה מוחקת גם את התמונה.`)) return;
    try {
      await api.delete(`/api/expenses/${e.id}`);
      load();
    } catch (err) {
      alert(err.response?.data?.error || 'המחיקה נכשלה');
    }
  }

  function exportCsv() {
    const head = ['תאריך', 'ספק', 'קטגוריה', 'סכום', 'מע"מ', 'מטבע', 'תיאור'];
    const rows = items.map((e) => [
      dateOf(e), e.vendor || '', e.category || '',
      e.total ?? '', e.vatAmount ?? '', e.currency || 'ILS', (e.summary || '').replace(/"/g, '""'),
    ]);
    const csv = '﻿' + [head, ...rows].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `expenses-${month}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div>
      <PageHeader
        title="הוצאות"
        subtitle="קבלות שצולמו לוואטסאפ — מפוענחות ומסודרות אוטומטית"
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-xl border border-slate-200 bg-white overflow-hidden">
              <button type="button" className="px-3 py-2 text-slate-500 hover:bg-slate-50" aria-label="חודש קודם" onClick={() => setMonth((m) => shiftMonth(m, -1))}>›</button>
              <span className="px-2 min-w-[7.5rem] text-center text-sm font-medium text-ink-900">{monthLabel(month)}</span>
              <button
                type="button"
                className="px-3 py-2 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
                aria-label="חודש הבא"
                disabled={month >= monthNow()}
                onClick={() => setMonth((m) => shiftMonth(m, 1))}
              >‹</button>
            </div>
            {month !== monthNow() && (
              <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => setMonth(monthNow())}>החודש</button>
            )}
            <button type="button" className="btn-ghost text-sm" disabled={!items.length} onClick={exportCsv}>⬇ CSV</button>
          </div>
        }
      />

      {/* how it works — shown until the habit forms */}
      <div className="card mb-4 border-r-4 border-brand-300 bg-brand-50/60">
        <p className="text-sm text-slate-700">
          📸 <b>איך זה עובד?</b> מצלמים קבלה ושולחים אותה בוואטסאפ למספר העסק — מהטלפון האישי של בעל/ת העסק
          (מגדירים אותו ב<b>הצטרפות</b> או בהגדרות). המערכת קוראת את הספק, הסכום והמע״מ ומוסיפה שורה כאן.
        </p>
      </div>

      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="card"><div className="text-xs text-slate-400 mb-1">סה״כ החודש</div><div className="text-2xl font-bold text-ink-900">₪{fmt(totals?.total || 0)}</div></div>
            <div className="card"><div className="text-xs text-slate-400 mb-1">מע״מ מצטבר</div><div className="text-2xl font-bold text-ink-900">₪{fmt(totals?.vat || 0)}</div></div>
            <div className="card"><div className="text-xs text-slate-400 mb-1">קבלות</div><div className="text-2xl font-bold text-ink-900">{totals?.count || 0}</div></div>
            <div className="card"><div className="text-xs text-slate-400 mb-1">ממתינות לבדיקה</div><div className={`text-2xl font-bold ${totals?.needsReview ? 'text-amber-600' : 'text-ink-900'}`}>{totals?.needsReview || 0}</div></div>
          </div>

          {items.length === 0 ? (
            <div className="card text-center text-slate-400 py-14">
              אין עדיין קבלות בחודש הזה. שלחו צילום קבלה לוואטסאפ של העסק — והיא תופיע כאן.
            </div>
          ) : (
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="text-right text-xs text-slate-400 border-b border-slate-100">
                    <th className="p-3 font-medium">תאריך</th>
                    <th className="p-3 font-medium">ספק</th>
                    <th className="p-3 font-medium">קטגוריה</th>
                    <th className="p-3 font-medium">סכום</th>
                    <th className="p-3 font-medium">מע״מ</th>
                    <th className="p-3 font-medium">סטטוס</th>
                    <th className="p-3 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                      <td className="p-3 whitespace-nowrap" dir="ltr">{dateOf(e)}</td>
                      <td className="p-3 font-medium text-ink-900">{e.vendor || <span className="text-slate-400">—</span>}</td>
                      <td className="p-3">{e.category ? <span className="badge bg-brand-50 text-brand-600">{e.category}</span> : <span className="text-slate-300">—</span>}</td>
                      <td className="p-3 whitespace-nowrap font-semibold">{e.total != null ? `₪${fmt(e.total)}` : <span className="text-slate-400">?</span>}</td>
                      <td className="p-3 whitespace-nowrap text-slate-500">{e.vatAmount != null ? `₪${fmt(e.vatAmount)}` : '—'}</td>
                      <td className="p-3">
                        {e.status === 'needs_review'
                          ? <span className="badge bg-amber-100 text-amber-700">לבדיקה</span>
                          : <span className="badge bg-green-100 text-green-700">נקלטה</span>}
                      </td>
                      <td className="p-3 whitespace-nowrap text-left">
                        <button type="button" className="text-brand-600 hover:underline text-xs ml-3" onClick={() => viewImage(e)}>🧾 תמונה</button>
                        <button
                          type="button"
                          className="text-slate-500 hover:underline text-xs ml-3"
                          onClick={() => setEditing({
                            id: e.id,
                            vendor: e.vendor || '',
                            category: e.category || '',
                            total: e.total ?? '',
                            vatAmount: e.vatAmount ?? '',
                            expenseDate: e.expenseDate ? e.expenseDate.slice(0, 10) : '',
                          })}
                        >
                          עריכה
                        </button>
                        <button type="button" className="text-red-500 hover:underline text-xs" onClick={() => remove(e)}>מחיקה</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing && (
        <Modal open title="עריכת קבלה" onClose={() => setEditing(null)}>
          <form onSubmit={saveEdit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><label className="label">ספק</label><input className="input" value={editing.vendor} onChange={(e) => setEditing((s) => ({ ...s, vendor: e.target.value }))} /></div>
              <div><label className="label">קטגוריה</label><input className="input" value={editing.category} onChange={(e) => setEditing((s) => ({ ...s, category: e.target.value }))} /></div>
              <div><label className="label">סכום (₪)</label><input className="input" type="number" step="0.01" min="0" value={editing.total} onChange={(e) => setEditing((s) => ({ ...s, total: e.target.value }))} /></div>
              <div><label className="label">מע״מ (₪)</label><input className="input" type="number" step="0.01" min="0" value={editing.vatAmount} onChange={(e) => setEditing((s) => ({ ...s, vatAmount: e.target.value }))} /></div>
              <div className="col-span-2"><label className="label">תאריך</label><input className="input" type="date" value={editing.expenseDate} onChange={(e) => setEditing((s) => ({ ...s, expenseDate: e.target.value }))} /></div>
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>ביטול</button>
              <button className="btn-primary" disabled={saving}>{saving ? 'שומר…' : 'שמירה'}</button>
            </div>
          </form>
        </Modal>
      )}

      {viewingImg && (
        <Modal open title="הקבלה המקורית" onClose={closeImage}>
          <img src={viewingImg.url} alt="קבלה" className="max-h-[70vh] w-auto mx-auto rounded-lg" />
        </Modal>
      )}
    </div>
  );
}
