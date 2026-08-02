import { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client.js';
import { Spinner, errMsg, INTENT_LABELS } from '../components/ui.jsx';

// WhatsApp-Web-style inbox: a conversation list on one side and a live chat
// thread on the other, with a composer to reply to the customer. The chat chrome
// deliberately uses WhatsApp's own product colors (green outgoing bubbles, beige
// doodle canvas) so it feels native to business owners — this is product chrome,
// not the HeyIL brand palette.

const WA = {
  panel: '#f0f2f5',       // list/header/composer bar
  hover: '#f5f6f6',
  active: '#e9edef',
  chatBg: '#efeae2',      // classic chat canvas
  out: '#d9fdd3',         // outgoing (agent/human) bubble
  in: '#ffffff',          // incoming (customer) bubble
  green: '#00a884',       // WhatsApp teal-green (send / accents)
  meta: '#667781',        // timestamps / secondary text
  ink: '#111b21',
};

// Subtle doodle canvas — a faint tiled pattern over the beige base.
const CHAT_BG = `${WA.chatBg} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80' viewBox='0 0 80 80'%3E%3Cg fill='%23000000' fill-opacity='0.03'%3E%3Ccircle cx='16' cy='16' r='2'/%3E%3Ccircle cx='56' cy='36' r='2'/%3E%3Ccircle cx='36' cy='64' r='2'/%3E%3C/g%3E%3C/svg%3E")`;

const FILTERS = [
  { v: '', l: 'הכל' },
  { v: 'active', l: 'פעילות' },
  { v: 'needs_human', l: 'ממתינות לנציג' },
  { v: 'completed', l: 'הושלמו' },
];

const AVATAR_COLORS = ['#0ea5a4', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2'];
function avatarColor(seed = '') {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name, phone) {
  const n = (name || '').trim();
  if (n) return n.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (phone || '?').slice(-2);
}
function hhmm(d) {
  return new Date(d).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(d) {
  const date = new Date(d);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'היום';
  if (same(date, y)) return 'אתמול';
  return date.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: 'numeric' });
}

export default function Conversations() {
  const [items, setItems] = useState([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listErr, setListErr] = useState('');
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');

  const [selId, setSelId] = useState(null);
  const [conv, setConv] = useState(null);
  const [loadingConv, setLoadingConv] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState('');
  const [mobileThread, setMobileThread] = useState(false);

  const scrollRef = useRef(null);
  const endRef = useRef(null);

  const loadList = useCallback((quiet) => {
    if (!quiet) setLoadingList(true);
    const q = new URLSearchParams();
    if (filter === 'needs_human') q.set('needsHuman', 'true');
    else if (filter) q.set('status', filter);
    q.set('pageSize', '100');
    api.get(`/api/conversations?${q.toString()}`)
      .then((r) => setItems(r.data.items || []))
      .catch((err) => setListErr(errMsg(err)))
      .finally(() => setLoadingList(false));
  }, [filter]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { const t = setInterval(() => loadList(true), 10000); return () => clearInterval(t); }, [loadList]);

  const loadConv = useCallback((id, quiet) => {
    if (!quiet) { setLoadingConv(true); setConv(null); }
    api.get(`/api/conversations/${id}`)
      .then((r) => setConv(r.data))
      .catch(() => {})
      .finally(() => setLoadingConv(false));
  }, []);

  useEffect(() => { if (selId) loadConv(selId); }, [selId, loadConv]);
  useEffect(() => {
    if (!selId) return;
    const t = setInterval(() => loadConv(selId, true), 6000);
    return () => clearInterval(t);
  }, [selId, loadConv]);

  // Auto-scroll to newest, but only if the user is already near the bottom.
  const msgCount = conv?.messages?.length || 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgCount, selId]);

  function selectConv(id) {
    setSelId(id);
    setMobileThread(true);
    setSendErr('');
    setDraft('');
  }

  async function send(e) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || sending || !selId) return;
    setSending(true); setSendErr('');
    const optim = { id: 'tmp-' + Date.now(), senderType: 'human', messageText: text, createdAt: new Date().toISOString(), _pending: true };
    setConv((c) => (c ? { ...c, messages: [...c.messages, optim] } : c));
    setDraft('');
    try {
      await api.post(`/api/conversations/${selId}/reply`, { text });
      loadConv(selId, true);
      loadList(true);
    } catch (err) {
      setConv((c) => (c ? { ...c, messages: c.messages.filter((m) => m.id !== optim.id) } : c));
      setDraft(text);
      setSendErr(err.response?.data?.error || 'שליחת ההודעה נכשלה');
    } finally {
      setSending(false);
    }
  }

  async function markDone() {
    if (!selId) return;
    await api.put(`/api/conversations/${selId}/status`, { status: 'completed' }).catch(() => {});
    loadConv(selId, true); loadList(true);
  }
  async function assignHuman() {
    if (!selId) return;
    await api.post(`/api/conversations/${selId}/assign-human`, {}).catch(() => {});
    loadConv(selId, true); loadList(true);
  }

  const q = search.trim().toLowerCase();
  const shown = q
    ? items.filter((c) =>
        (c.customer?.name || '').toLowerCase().includes(q) ||
        (c.whatsappPhone || '').includes(q) ||
        (c.lastMessage || '').toLowerCase().includes(q))
    : items;

  return (
    <div
      className="flex rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-white"
      style={{ height: 'calc(100dvh - 6rem)', minHeight: 480 }}
    >
      {/* ── Conversation list (right side in RTL) ── */}
      <aside
        className={`${mobileThread ? 'hidden' : 'flex'} md:flex w-full md:w-80 lg:w-96 shrink-0 flex-col border-l border-slate-200`}
      >
        <div className="px-4 pt-4 pb-2" style={{ background: WA.panel }}>
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-slate-800">שיחות</h1>
            <span className="text-xs text-slate-500">{items.length} שיחות</span>
          </div>
          <div className="relative mb-2">
            <svg className="absolute top-1/2 -translate-y-1/2 right-3 text-slate-400" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
            <input
              className="w-full bg-white rounded-lg border border-slate-200 pr-9 pl-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
              placeholder="חיפוש בשיחות"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {FILTERS.map((f) => (
              <button
                key={f.v}
                onClick={() => setFilter(f.v)}
                className={`text-xs rounded-full px-2.5 py-1 transition ${filter === f.v ? 'text-white' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
                style={filter === f.v ? { background: WA.green } : undefined}
              >
                {f.l}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingList ? (
            <Spinner className="h-40" />
          ) : listErr ? (
            <div className="p-6 text-sm text-red-600">{listErr}</div>
          ) : shown.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">אין שיחות להצגה</div>
          ) : (
            shown.map((c) => {
              const name = c.customer?.name || 'ללא שם';
              const sel = c.id === selId;
              return (
                <button
                  key={c.id}
                  onClick={() => selectConv(c.id)}
                  className="w-full flex items-center gap-3 px-3 py-3 text-right border-b border-slate-100 transition"
                  style={{ background: sel ? WA.active : undefined }}
                  onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = WA.hover; }}
                  onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = ''; }}
                >
                  <span className="h-11 w-11 shrink-0 rounded-full grid place-items-center text-white text-sm font-semibold" style={{ background: avatarColor(name + c.whatsappPhone) }}>
                    {initials(name, c.whatsappPhone)}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-800 truncate">{name}</span>
                      <span className="text-[11px] text-slate-400 shrink-0">{c.lastActivityAt ? hhmm(c.lastActivityAt) : ''}</span>
                    </span>
                    <span className="flex items-center justify-between gap-2 mt-0.5">
                      <span className="text-[13px] text-slate-500 truncate">{c.lastMessage || '—'}</span>
                      {c.needsHuman
                        ? <span className="shrink-0 text-[10px] rounded-full px-1.5 py-0.5 bg-amber-100 text-amber-700">נציג</span>
                        : c.status === 'completed'
                        ? <span className="shrink-0 h-2 w-2 rounded-full bg-slate-300" title="הושלמה" />
                        : <span className="shrink-0 h-2 w-2 rounded-full" style={{ background: WA.green }} title="פעילה" />}
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Chat thread (left side in RTL) ── */}
      <section className={`${mobileThread ? 'flex' : 'hidden'} md:flex flex-1 min-w-0 flex-col`}>
        {!selId ? (
          <div className="flex-1 grid place-items-center text-center px-6" style={{ background: WA.panel }}>
            <div>
              <div className="mx-auto mb-4 h-20 w-20 rounded-full grid place-items-center" style={{ background: '#dfe5e7' }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={WA.meta} strokeWidth="1.6"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
              </div>
              <h2 className="text-xl font-semibold text-slate-700">שיחות HeyIL</h2>
              <p className="text-sm text-slate-500 mt-1 max-w-sm">בחרו שיחה מהרשימה כדי לקרוא את ההיסטוריה ולכתוב ללקוח ישירות מכאן.</p>
            </div>
          </div>
        ) : (
          <>
            {/* thread header */}
            <ThreadHeader
              conv={conv}
              onBack={() => setMobileThread(false)}
              onDone={markDone}
              onAssign={assignHuman}
            />

            {/* messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 md:px-10 lg:px-16 py-4" style={{ background: CHAT_BG }}>
              {loadingConv && !conv ? (
                <Spinner className="h-40" />
              ) : (
                <MessageList messages={conv?.messages || []} endRef={endRef} />
              )}
            </div>

            {/* composer */}
            <div style={{ background: WA.panel }} className="px-3 md:px-6 py-3 border-t border-slate-200">
              {sendErr && (
                <div className="mb-2 text-xs rounded-lg bg-amber-50 text-amber-800 border border-amber-200 px-3 py-2 flex items-start justify-between gap-3">
                  <span>{sendErr}</span>
                  <Link to="/broadcast" className="shrink-0 underline whitespace-nowrap">שליחה מרובה ←</Link>
                </div>
              )}
              <form onSubmit={send} className="flex items-end gap-2">
                <textarea
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); } }}
                  placeholder="הקלידו הודעה ללקוח…"
                  className="flex-1 resize-none max-h-32 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || sending}
                  className="h-11 w-11 shrink-0 rounded-full grid place-items-center text-white disabled:opacity-50 transition"
                  style={{ background: WA.green }}
                  aria-label="שליחה"
                >
                  {sending
                    ? <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M21 12a9 9 0 1 1-6.2-8.5" strokeLinecap="round" /></svg>
                    : <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.4-7.5a1 1 0 0 0 0-1.8L3.4 3.6a1 1 0 0 0-1.4 1l1.9 6.2a1 1 0 0 0 .8.7l8.6 1.5-8.6 1.5a1 1 0 0 0-.8.7L2 19.4a1 1 0 0 0 1.4 1z" /></svg>}
                </button>
              </form>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function ThreadHeader({ conv, onBack, onDone, onAssign }) {
  const name = conv?.customer?.name || 'ללא שם';
  const phone = conv?.whatsappPhone || '';
  return (
    <div style={{ background: WA.panel }} className="flex items-center gap-3 px-3 md:px-4 py-2.5 border-b border-slate-200">
      <button onClick={onBack} className="md:hidden p-1.5 -mr-1 rounded-full hover:bg-black/5" aria-label="חזרה">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      <span className="h-10 w-10 shrink-0 rounded-full grid place-items-center text-white text-sm font-semibold" style={{ background: avatarColor(name + phone) }}>
        {initials(name, phone)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-slate-800 truncate">{name}</div>
        <div className="text-xs text-slate-500 truncate">
          {phone}{conv?.intent ? ` · ${INTENT_LABELS[conv.intent] || conv.intent}` : ''}
        </div>
      </div>
      {conv && (
        <div className="flex items-center gap-1">
          {!conv.needsHuman && conv.status !== 'completed' && (
            <IconBtn title="העבר לטיפול נציג" onClick={onAssign}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" /></svg>
            </IconBtn>
          )}
          {conv.status !== 'completed' && (
            <IconBtn title="סמן כטופל" onClick={onDone}>
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </IconBtn>
          )}
          <Link to={`/conversations/${conv.id}`} className="hidden sm:grid place-items-center h-9 w-9 rounded-full hover:bg-black/5 text-slate-600" title="פרטים מלאים">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
          </Link>
        </div>
      )}
    </div>
  );
}

function IconBtn({ title, onClick, children }) {
  return (
    <button onClick={onClick} title={title} className="grid place-items-center h-9 w-9 rounded-full hover:bg-black/5 text-slate-600 transition">
      {children}
    </button>
  );
}

function MessageList({ messages, endRef }) {
  if (messages.length === 0) {
    return <div className="h-full grid place-items-center text-sm text-slate-500">אין הודעות עדיין</div>;
  }
  let lastDay = null;
  return (
    <div className="flex flex-col gap-1.5">
      {messages.map((m) => {
        const out = m.senderType !== 'customer'; // agent / human = outgoing
        const day = dayLabel(m.createdAt);
        const showDay = day !== lastDay;
        lastDay = day;
        const senderTag = m.senderType === 'agent' ? 'סוכן AI' : m.senderType === 'human' ? 'נציג/ה' : null;
        return (
          <div key={m.id}>
            {showDay && (
              <div className="flex justify-center my-3">
                <span className="text-[11px] text-slate-600 bg-white/80 rounded-lg px-2.5 py-1 shadow-sm">{day}</span>
              </div>
            )}
            <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
              <div
                className="max-w-[78%] rounded-lg px-2.5 py-1.5 text-[14.5px] leading-relaxed whitespace-pre-wrap shadow-sm"
                style={{ background: out ? WA.out : WA.in, color: WA.ink, opacity: m._pending ? 0.7 : 1 }}
              >
                {senderTag && <div className="text-[11px] font-semibold mb-0.5" style={{ color: WA.green }}>{senderTag}</div>}
                <span>{m.messageText}</span>
                <span className="inline-block text-[10.5px] align-bottom mr-2 float-left mt-1" style={{ color: WA.meta }}>
                  {hhmm(m.createdAt)}
                </span>
              </div>
            </div>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
