import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, EmptyState, ErrorState, errMsg, INTENT_LABELS } from '../components/ui.jsx';

// ── Lead pipeline stages ──
// The schema has NO dedicated pipeline-stage column on Conversation (only a lifecycle
// `status` field: active | completed | abandoned | needs_human, plus needsHuman /
// leadScore / linkSent / tags). So — per the task's "don't invent new stages / check the
// schema first" — we DERIVE the sales stage from those existing fields rather than
// adding a migration. stageOf() is the single source of truth for the mapping.
//
// The manual "engaged" (בטיפול) move is persisted via a reserved marker in the existing
// `tags` JSON column (ENGAGED_TAG below) — NOT by overloading linkSent. Overloading
// linkSent (the previous fix) inflated leadScore by +10 and falsely showed "נשלח קישור:
// כן" for leads no link was ever sent to. `tags` is already migrated live, so this needs
// no schema change (a new column would P2022 the list/detail routes until migrated).
const ENGAGED_TAG = 'pipeline:engaged';
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
  // The engaged signal is the manual ENGAGED_TAG marker OR organic progress (a real link
  // sent, a warm score, or an active flow) — NOT linkSent standing in for a manual move.
  const tags = Array.isArray(c.tags) ? c.tags : [];
  if (tags.includes(ENGAGED_TAG) || c.linkSent || (c.leadScore || 0) >= 40 || c.flow) return 'engaged';
  return 'new';
}

// Fetch EVERY conversation for the tenant by paging through the API's { total, page,
// pageSize, items } envelope. The server caps pageSize at 100, so a tenant with more than
// 100 conversations spans several pages; we accumulate until we've collected `total` rows
// (or a page comes back short / empty, which also means we're done). A hard page ceiling
// guards against an unexpected server response causing an unbounded loop.
const PAGE_SIZE = 100;
const MAX_PAGES = 500; // 50k conversations — far beyond any realistic tenant; a safety stop.

async function fetchAllConversations() {
  const all = [];
  let page = 1;
  let total = Infinity;
  while (all.length < total && page <= MAX_PAGES) {
    const res = await api.get('/api/conversations', { params: { page, pageSize: PAGE_SIZE } });
    const data = res.data || {};
    const batch = data.items || [];
    all.push(...batch);
    // Trust the server's reported total when present; otherwise fall back to "stop when a
    // page returns fewer than a full page of results".
    total = Number.isFinite(data.total) ? data.total : (batch.length < PAGE_SIZE ? all.length : Infinity);
    if (batch.length === 0) break; // defensive: never loop on an empty page.
    page += 1;
  }
  return all;
}

function scoreTone(score) {
  const s = score || 0;
  if (s >= 70) return 'bg-emerald-100 text-emerald-700';
  if (s >= 40) return 'bg-amber-100 text-amber-700';
  return 'bg-gray-100 text-gray-500';
}

// A draggable lead card. The card BODY is the drag handle; the "open" link at the
// bottom is the click target (so dragging never accidentally navigates).
// A lead card. On desktop the body is a drag handle (mouse DnD); on every device the
// "העבר" dropdown moves it between stages (touch-friendly — drag doesn't work on mobile).
// The "פתח שיחה" link is the click target and never triggers a drag.
function LeadCard({ c, onDragStart, onDragEnd, dragging, onMove }) {
  const cur = stageOf(c);
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, c)}
      onDragEnd={onDragEnd}
      className={`rounded-xl border bg-white p-3 shadow-sm transition lg:cursor-grab lg:active:cursor-grabbing
        ${dragging ? 'opacity-40 ring-2 ring-brand-300' : 'border-slate-200 hover:shadow-md hover:border-brand-300'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold text-slate-900 truncate">{c.customer?.name || 'ללא שם'}</div>
          <div className="text-xs text-slate-400 truncate" dir="ltr">{c.whatsappPhone}</div>
        </div>
        <span className={`badge shrink-0 ${scoreTone(c.leadScore)}`} title="ניקוד ליד">{c.leadScore ?? 0}</span>
      </div>
      {c.lastMessage && <div className="mt-2 text-xs text-slate-600 line-clamp-2">{c.lastMessage}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-slate-400">
        {c.intent && <span className="badge bg-slate-100 text-slate-500">{INTENT_LABELS[c.intent] || c.intent}</span>}
        {c.flow?.name && <span className="badge bg-slate-100 text-slate-500">{c.flow.name}</span>}
        <span className="mr-auto">{c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleDateString('he-IL') : ''}</span>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <Link
          to={`/conversations/${c.id}`}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 text-center text-xs font-medium text-brand-700 border border-brand-100 rounded-lg py-1.5 hover:bg-brand-50 transition"
        >
          פתח שיחה ←
        </Link>
        <select
          value=""
          onChange={(e) => { if (e.target.value) onMove(e.target.value); e.target.value = ''; }}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 text-xs rounded-lg border border-slate-200 bg-white text-slate-600 py-1.5 pr-2 pl-1 outline-none focus:border-brand-400 cursor-pointer"
          title="העברה לשלב אחר"
        >
          <option value="">↔ העבר</option>
          {STAGES.filter((s) => s.key !== cur).map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// Dropping a card on a column changes the conversation's underlying status (stages are
// derived, not stored — see stageOf). Won/lost/qualified map cleanly; new & engaged both
// reopen the conversation as "active" (it then lands in new or engaged by its progress).
function stageAction(id, stage) {
  if (stage === 'won') return api.put(`/api/conversations/${id}/status`, { status: 'completed' });
  if (stage === 'lost') return api.put(`/api/conversations/${id}/status`, { status: 'abandoned' });
  if (stage === 'qualified') return api.post(`/api/conversations/${id}/assign-human`, {});
  // engaged: reopen as active AND set the distinct engaged marker (engaged:true → backend
  // adds ENGAGED_TAG to `tags`). This is what stageOf now reads, so the move persists on
  // reload — without touching linkSent (which would inflate leadScore +10 and falsely show
  // "נשלח קישור: כן"). status:'active' alone is a no-op (a "new" card is already active).
  if (stage === 'engaged') return api.put(`/api/conversations/${id}/status`, { status: 'active', engaged: true });
  // new: reopen as active AND clear the engaged marker (engaged:false → backend removes
  // ENGAGED_TAG), so a card dragged back out of "בטיפול" doesn't snap straight back to it.
  return api.put(`/api/conversations/${id}/status`, { status: 'active', engaged: false });
}
// Keep the optimistic patch in lock-step with what the backend persists, so the card
// lands in the right column immediately (before the reload/refetch confirms it).
function withEngagedTag(c, on) {
  const tags = (Array.isArray(c.tags) ? c.tags : []).filter((t) => t !== ENGAGED_TAG);
  return on ? [...tags, ENGAGED_TAG] : tags;
}
function optimisticPatch(c, stage) {
  if (stage === 'won') return { ...c, status: 'completed', needsHuman: false };
  if (stage === 'lost') return { ...c, status: 'abandoned', needsHuman: false };
  if (stage === 'qualified') return { ...c, status: 'needs_human', needsHuman: true };
  if (stage === 'engaged') return { ...c, status: 'active', needsHuman: false, tags: withEngagedTag(c, true) };
  return { ...c, status: 'active', needsHuman: false, tags: withEngagedTag(c, false) };
}

export default function Leads() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dragId, setDragId] = useState(null);
  const [overStage, setOverStage] = useState(null);
  const [moveErr, setMoveErr] = useState('');

  function load() {
    setLoading(true);
    setError('');
    // The pipeline groups ALL of a tenant's conversations client-side by derived stage
    // (see stageOf), so we must fetch every conversation — not just the first page. The
    // API caps pageSize at 100 (backend/src/routes/conversations.js) and returns a
    // { total, page, pageSize, items } envelope, so we page through until we've collected
    // `total` rows. Without this, tenants with >100 conversations silently lose leads from
    // the board — and because results are ordered by lastActivityAt desc, the dropped ones
    // are exactly the STALE / COOLING leads the pipeline exists to surface for follow-up.
    fetchAllConversations()
      .then((all) => setItems(all))
      .catch((err) => setError(errMsg(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const g = Object.fromEntries(STAGES.map((s) => [s.key, []]));
    for (const c of items) g[stageOf(c)].push(c);
    return g;
  }, [items]);

  function onDragStart(e, c) {
    setDragId(c.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', c.id);
  }
  function onDragEnd() {
    setDragId(null);
    setOverStage(null);
  }
  // Shared move logic — used by both drag-drop (desktop) and the card's stage dropdown
  // (works on touch). Optimistic, with revert-on-error.
  async function moveTo(id, stageKey) {
    const c = items.find((x) => x.id === id);
    if (!c || stageOf(c) === stageKey) return;
    setMoveErr('');
    setItems((prev) => prev.map((x) => (x.id === id ? optimisticPatch(x, stageKey) : x)));
    try {
      await stageAction(id, stageKey);
    } catch (err) {
      setMoveErr(errMsg(err, 'עדכון השלב נכשל'));
      load(); // revert to server truth
    }
  }
  function onDrop(e, stageKey) {
    e.preventDefault();
    setOverStage(null);
    const id = e.dataTransfer.getData('text/plain') || dragId;
    setDragId(null);
    moveTo(id, stageKey);
  }

  return (
    <div>
      <PageHeader
        title="מנהל לידים"
        subtitle={`${items.length} לידים לפי שלב · גררו כרטיס (במחשב) או השתמשו ב"העבר" כדי לשנות שלב`}
        actions={<Link to="/conversations" className="btn-ghost">תצוגת רשימה ←</Link>}
      />

      {moveErr && <div className="card bg-red-50 text-red-600 text-sm mb-3">{moveErr}</div>}

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : items.length === 0 ? (
        <EmptyState>אין לידים להצגה</EmptyState>
      ) : (
        // Mobile: columns stack vertically. Desktop: 5 equal columns fill the width (no
        // horizontal scroll) and the board fills the viewport height.
        <div className="flex flex-col lg:grid lg:grid-cols-5 gap-3 pb-2">
          {STAGES.map((stage) => {
            const cards = grouped[stage.key];
            const isOver = overStage === stage.key;
            return (
              <div key={stage.key} className="w-full flex flex-col min-w-0">
                <div className={`rounded-t-2xl border-x border-t px-3.5 py-3 ${stage.soft}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${stage.color}`} />
                      <span className={`font-bold text-sm truncate ${stage.text}`}>{stage.label}</span>
                    </div>
                    <span className={`badge bg-white/80 ${stage.text} font-semibold shrink-0`}>{cards.length}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5 truncate">{stage.hint}</div>
                </div>
                <div
                  onDragOver={(e) => { e.preventDefault(); if (overStage !== stage.key) setOverStage(stage.key); }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverStage((s) => (s === stage.key ? null : s)); }}
                  onDrop={(e) => onDrop(e, stage.key)}
                  className={`rounded-b-2xl border p-2 space-y-2 transition-colors lg:flex-1 lg:min-h-[62vh] lg:overflow-y-auto
                    ${isOver ? 'border-brand-400 border-dashed bg-brand-50/70' : 'border-slate-200 bg-slate-50/70'}`}
                >
                  {cards.length === 0 ? (
                    <div className="text-center text-xs text-slate-300 py-5">{isOver ? 'שחררו כאן' : 'אין לידים בשלב זה'}</div>
                  ) : (
                    cards.map((c) => (
                      <LeadCard
                        key={c.id}
                        c={c}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        dragging={dragId === c.id}
                        onMove={(stageKey) => moveTo(c.id, stageKey)}
                      />
                    ))
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
