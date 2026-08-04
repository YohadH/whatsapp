import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, Modal } from '../components/ui.jsx';
import { MESSAGE_TEMPLATES, MESSAGE_TEMPLATE_CATEGORIES } from '../data/messageTemplates.js';

const STATUS_BADGE = {
  APPROVED: 'bg-green-100 text-green-700',
  PENDING: 'bg-amber-100 text-amber-700',
  REJECTED: 'bg-red-100 text-red-600',
};
const STATUS_HE = { APPROVED: 'מאושרת', PENDING: 'ממתינה לאישור', REJECTED: 'נדחתה' };

export default function Broadcast() {
  const [templates, setTemplates] = useState([]);
  const [allTemplates, setAllTemplates] = useState([]);
  const [configured, setConfigured] = useState(false);
  const [loadingTpl, setLoadingTpl] = useState(true);
  // Create-template modal.
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');
  const [newTpl, setNewTpl] = useState({ name: '', category: 'UTILITY', language: 'he', bodyText: '', footerText: '', examples: '' });
  const [tplRefreshing, setTplRefreshing] = useState(false);
  const [editingId, setEditingId] = useState(null); // template id being edited (null = create mode)
  const [deletingName, setDeletingName] = useState('');

  const [showGallery, setShowGallery] = useState(false); // template library
  const [galleryCat, setGalleryCat] = useState('all');
  const [campaignName, setCampaignName] = useState(''); // BroadcastJob.label

  // Saved recipient lists — a reusable audience source alongside file upload.
  const [savedLists, setSavedLists] = useState([]);
  const [listContacts, setListContacts] = useState([]); // members from the chosen list
  const [chosenListId, setChosenListId] = useState('');
  const loadLists = () => api.get('/api/lists').then((r) => setSavedLists(r.data || [])).catch(() => {});
  async function pickList(id) {
    setChosenListId(id);
    if (!id) { setListContacts([]); return; }
    try {
      const r = await api.get(`/api/lists/${id}`);
      setListContacts((r.data.members || []).map((m) => ({ phone: m.phone, name: m.name })));
    } catch { setListContacts([]); }
  }

  const [mode, setMode] = useState('template'); // 'template' | 'text'
  const [templateName, setTemplateName] = useState('');
  const [languageCode, setLanguageCode] = useState('he');
  const [message, setMessage] = useState('');
  const [manualHasImage, setManualHasImage] = useState(false); // manual mode: template has image header

  const [headerImageUrl, setHeaderImageUrl] = useState('');
  const [imgUploading, setImgUploading] = useState(false);

  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [phoneColumn, setPhoneColumn] = useState('');
  const [varColumns, setVarColumns] = useState([]); // column name per variable index
  const [parsing, setParsing] = useState(false);

  const [sending, setSending] = useState(false); // POST /send in flight
  const [job, setJob] = useState(null); // the campaign being watched (polled)
  const [quota, setQuota] = useState(null); // { cap, used, remaining } rolling 24h

  // Contacts inside Meta's 24h customer-service window — the only numbers a
  // FREE-TEXT send is allowed to reach. Picked ones are merged into the send list.
  const [eligible, setEligible] = useState([]);
  const [eligibleLoading, setEligibleLoading] = useState(true);
  const [picked, setPicked] = useState(() => new Set()); // phones selected from the eligible list

  const loadEligible = () => {
    setEligibleLoading(true);
    return api
      .get('/api/broadcast/eligible')
      .then((r) => setEligible(r.data.contacts || []))
      .catch(() => setEligible([]))
      .finally(() => setEligibleLoading(false));
  };

  const togglePicked = (phone) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(phone)) next.delete(phone);
      else next.add(phone);
      return next;
    });

  // Hours left in a contact's 24h window, for the "נותרו Xש׳" hint.
  const hoursLeft = (expiresAt) => Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 3600000));

  const jobActive = job?.status === 'running';
  const canResume =
    job && ['stopped', 'quota_reached', 'aborted'].includes(job.status) && job.cursor < job.total;

  const refreshQuota = () =>
    api.get('/api/broadcast/quota').then((r) => setQuota(r.data)).catch(() => {});

  function loadTemplates() {
    return api
      .get('/api/broadcast/templates')
      .then((r) => {
        setConfigured(r.data.configured);
        const all = r.data.templates || [];
        setAllTemplates(all);
        setTemplates(all.filter((t) => t.status === 'APPROVED'));
      })
      .catch(() => setConfigured(false))
      .finally(() => setLoadingTpl(false));
  }

  async function refreshTemplates() {
    setTplRefreshing(true);
    await loadTemplates();
    setTplRefreshing(false);
  }

  function resetTemplateForm() {
    setNewTpl({ name: '', category: 'UTILITY', language: 'he', bodyText: '', footerText: '', examples: '' });
    setEditingId(null);
    setCreateErr('');
  }

  function openCreate() {
    resetTemplateForm();
    setShowCreate(true);
  }

  // Adopt a library template → prefill the create-template modal, then it goes
  // to Meta for approval like any hand-written one.
  function pickLibraryTemplate(t) {
    setNewTpl({ name: t.name, category: t.category, language: 'he', bodyText: t.bodyText, footerText: t.footerText || '', examples: t.examples || '' });
    setEditingId(null);
    setCreateErr('');
    setShowGallery(false);
    setShowCreate(true);
  }

  // Open the modal pre-filled to EDIT an existing template.
  function openEdit(t) {
    setNewTpl({ name: t.name, category: t.category || 'UTILITY', language: t.language || 'he', bodyText: t.bodyText || '', footerText: t.footerText || '', examples: '' });
    setEditingId(t.id);
    setCreateErr('');
    setShowCreate(true);
  }

  // Create OR edit, depending on editingId. Editing re-submits to Meta for approval.
  async function submitTemplate(e) {
    e.preventDefault();
    if (editingId && !window.confirm('עריכת תבנית שולחת אותה מחדש לאישור Meta — הסטטוס יחזור ל"ממתינה לאישור" עד שתאושר מחדש. להמשיך?')) return;
    setCreateErr('');
    setCreating(true);
    try {
      if (editingId) {
        await api.put(`/api/broadcast/templates/${editingId}`, newTpl);
      } else {
        await api.post('/api/broadcast/templates', newTpl);
      }
      setShowCreate(false);
      resetTemplateForm();
      await loadTemplates();
      alert(editingId
        ? 'התבנית עודכנה ונשלחה מחדש לאישור Meta. תופיע כמאושרת לאחר האישור.'
        : 'התבנית נשלחה ל-Meta לאישור. תופיע כזמינה לשליחה לאחר האישור.');
    } catch (err) {
      const m = err.response?.data?.error || '';
      setCreateErr(
        editingId && /#100|permission/i.test(m)
          ? 'עריכת תבנית דורשת הרשאת ניהול מלאה ב-Meta (נפתחת לאחר אימות עסק / Tech Provider). בינתיים ניתן לערוך אותה ב-WhatsApp Manager.'
          : m || (editingId ? 'עריכת התבנית נכשלה' : 'יצירת התבנית נכשלה')
      );
    } finally {
      setCreating(false);
    }
  }

  // Delete a template from Meta (permanent). Guarded by an explicit confirm.
  async function deleteTemplate(t) {
    if (!window.confirm(`למחוק את התבנית "${t.name}"?\n\n⚠️ הפעולה מוחקת אותה לצמיתות גם מ-Meta ולא ניתן יהיה לשלוח אותה יותר.`)) return;
    setDeletingName(t.name);
    try {
      await api.delete('/api/broadcast/templates', { params: { name: t.name } });
      await loadTemplates();
    } catch (err) {
      const m = err.response?.data?.error || '';
      alert(/#100|permission/i.test(m)
        ? 'מחיקת תבנית דורשת הרשאת ניהול מלאה ב-Meta (נפתחת לאחר אימות עסק / Tech Provider). בינתיים ניתן למחוק את התבנית ישירות ב-WhatsApp Manager, והיא תיעלם מכאן לאחר "רענון סטטוס".'
        : (m || 'מחיקת התבנית נכשלה.'));
    } finally {
      setDeletingName('');
    }
  }

  useEffect(() => {
    loadTemplates();
    refreshQuota();
    loadEligible();
    loadLists();
    // Re-attach to the last campaign (it keeps running server-side even if the
    // page was closed), or show one that's waiting to be resumed.
    api
      .get('/api/broadcast/jobs')
      .then((r) => {
        const last = (r.data || [])[0];
        if (last && (last.status === 'running' || (last.cursor < last.total && last.status !== 'completed'))) {
          setJob(last);
        }
      })
      .catch(() => {});
  }, []);

  // Poll the running job every 1.5s; stop when it reaches a final state.
  useEffect(() => {
    if (!jobActive) return;
    const t = setInterval(() => {
      api
        .get(`/api/broadcast/jobs/${job.id}`)
        .then((r) => {
          setJob(r.data);
          if (r.data.status !== 'running') refreshQuota();
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [job?.id, jobActive]);

  const selectedTpl = templates.find((t) => t.name === templateName);
  const varCount = mode === 'template' ? selectedTpl?.variableCount ?? 0 : message ? 1 : 0;
  // Whether an image header is needed: known from the template, or flagged manually.
  const imageRequired = mode === 'template' && !!selectedTpl?.hasImageHeader;

  function onPickTemplate(name) {
    setTemplateName(name);
    const t = templates.find((x) => x.name === name);
    if (t) setLanguageCode(t.language || 'he');
    setVarColumns(Array(t?.variableCount ?? 0).fill(''));
  }

  async function onFile(file) {
    if (!file) return;
    setParsing(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post('/api/broadcast/preview', fd);
      setColumns(r.data.columns || []);
      setRows(r.data.rows || []);
      const guess = (r.data.columns || []).find((c) => /phone|טלפון|נייד|mobile|מספר/i.test(c));
      setPhoneColumn(guess || r.data.columns?.[0] || '');
    } catch (err) {
      alert(err.response?.data?.error || 'קריאת הקובץ נכשלה');
    } finally {
      setParsing(false);
    }
  }

  async function uploadHeaderImage(file) {
    if (!file) return;
    setImgUploading(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post('/api/uploads/image', fd);
      setHeaderImageUrl(r.data.url);
    } catch (err) {
      alert(err.response?.data?.error || 'העלאת התמונה נכשלה');
    } finally {
      setImgUploading(false);
    }
  }

  // Persist the currently-mapped file rows as a reusable saved list.
  async function saveFileAsList() {
    const name = window.prompt('שם לרשימה החדשה:');
    if (!name?.trim()) return;
    const nameCol = varColumns[0] || columns.find((c) => /name|שם/i.test(c));
    const members = rows
      .map((r) => ({ phone: r[phoneColumn], name: nameCol ? r[nameCol] : null }))
      .filter((m) => String(m.phone ?? '').trim());
    try {
      const r = await api.post('/api/lists', { name: name.trim(), members });
      await loadLists();
      alert(`הרשימה "${r.data.name}" נשמרה (${r.data.count} נמענים${r.data.dropped ? `, ${r.data.dropped} נפסלו` : ''}).`);
    } catch (err) {
      alert(err.response?.data?.error || 'שמירת הרשימה נכשלה');
    }
  }

  function setVarCol(i, col) {
    setVarColumns((v) => {
      const next = [...v];
      next[i] = col;
      return next;
    });
  }

  const fileContacts = rows
    .map((r) => ({
      phone: r[phoneColumn],
      vars: (mode === 'template' ? varColumns : varColumns.slice(0, 1)).map((c) => (c ? r[c] : '')),
    }))
    .filter((c) => String(c.phone ?? '').trim());

  // Picked 24h-window contacts join the send list; their name fills {{1}} / {name}.
  const pickedContacts = eligible
    .filter((c) => picked.has(c.phone))
    .map((c) => ({
      phone: c.phone,
      vars: Array.from({ length: Math.max(varCount, 0) }, (_, i) => (i === 0 ? c.name || '' : '')),
    }));

  // Members from the chosen saved list; name fills {{1}}.
  const savedListContacts = listContacts.map((c) => ({
    phone: c.phone,
    vars: Array.from({ length: Math.max(varCount, 0) }, (_, i) => (i === 0 ? c.name || '' : '')),
  }));

  // Merge all sources, dedup by phone (file rows win — they may carry mapped vars).
  const seenPhones = new Set(fileContacts.map((c) => String(c.phone).trim()));
  const extra = [...pickedContacts, ...savedListContacts].filter((c) => {
    const p = String(c.phone).trim();
    if (seenPhones.has(p)) return false;
    seenPhones.add(p);
    return true;
  });
  const contacts = [...fileContacts, ...extra];

  const canSend =
    contacts.length > 0 &&
    !sending &&
    !jobActive &&
    (mode === 'template' ? templateName : message.trim()) &&
    (!imageRequired || headerImageUrl);

  async function send() {
    if (!canSend) return;
    let confirmMsg = `לשלוח ל-${contacts.length} מספרים?`;
    if (mode === 'template' && typeof quota?.remaining === 'number' && contacts.length > quota.remaining) {
      confirmMsg += `\n\nשימו לב: במכסה היומית נותרו ${quota.remaining.toLocaleString()} הודעות בלבד. השליחה תיעצר שם, ואפשר להמשיך מחר בדיוק מאותה נקודה.`;
    }
    if (!confirm(confirmMsg)) return;
    setSending(true);
    try {
      const payload =
        mode === 'template'
          ? {
              mode: 'template',
              label: campaignName.trim() || undefined,
              templateName,
              languageCode,
              contacts,
              headerImageLink: headerImageUrl || undefined,
              requireHeaderImage: imageRequired,
            }
          : { mode: 'text', label: campaignName.trim() || undefined, message, contacts };
      const r = await api.post('/api/broadcast/send', payload);
      setQuota(r.data.quota);
      const jr = await api.get(`/api/broadcast/jobs/${r.data.jobId}`);
      setJob(jr.data);
    } catch (err) {
      alert(err.response?.data?.error || 'השליחה נכשלה');
    } finally {
      setSending(false);
    }
  }

  async function stopJobNow() {
    if (!job) return;
    try {
      await api.post(`/api/broadcast/jobs/${job.id}/stop`);
      const r = await api.get(`/api/broadcast/jobs/${job.id}`);
      setJob(r.data);
      refreshQuota();
    } catch (err) {
      alert(err.response?.data?.error || 'העצירה נכשלה');
    }
  }

  async function resumeJobNow() {
    if (!job) return;
    try {
      const r = await api.post(`/api/broadcast/jobs/${job.id}/resume`);
      setJob(r.data);
    } catch (err) {
      alert(err.response?.data?.error || 'ההמשך נכשל');
    }
  }

  return (
    <div>
      <PageHeader
        title="דיוור"
        subtitle="העלאת רשימת מספרים ושליחת הודעה לכולם"
        actions={<button type="button" className="btn-primary" onClick={openCreate}>+ תבנית חדשה</button>}
      />

      {/* Template gallery — every template with its content + Meta approval status */}
      <div className="card mb-4">
        {/* Stack on mobile so the title/subtitle get the full width (buttons wrap below). */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-3 gap-3 sm:gap-2">
          <div className="w-full min-w-0">
            <h3 className="font-semibold">התבניות שלי</h3>
            <p className="text-xs text-slate-400 mt-0.5">הסטטוס מגיע ישירות מ-Meta — רק תבנית <b>מאושרת</b> ניתנת לשליחה.</p>
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap">
            <button type="button" className="btn-ghost text-xs" disabled={tplRefreshing} onClick={refreshTemplates}>
              {tplRefreshing ? 'מרענן…' : '↻ רענון סטטוס'}
            </button>
            <button type="button" className="btn-ghost text-xs" onClick={() => setShowGallery(true)}>📚 ספריית תבניות</button>
            <button type="button" className="btn-primary text-xs" onClick={openCreate}>+ תבנית חדשה</button>
          </div>
        </div>
        {loadingTpl ? (
          <Spinner />
        ) : allTemplates.length === 0 ? (
          <div className="text-center text-sm text-slate-400 py-6">
            עדיין אין תבניות. צרו את הראשונה עם <b>"תבנית חדשה"</b> — היא תישלח ל-Meta לאישור.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {allTemplates.map((t) => (
              <div key={`${t.name}:${t.language}`} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3 flex flex-col">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="font-mono text-sm text-slate-800 truncate" dir="ltr" title={t.name}>{t.name}</span>
                  <span className={`badge shrink-0 ${STATUS_BADGE[t.status] || 'bg-gray-100 text-gray-600'}`}>
                    {STATUS_HE[t.status] || t.status}
                  </span>
                </div>
                {t.bodyText && <p className="text-xs text-slate-600 whitespace-pre-wrap line-clamp-3 mb-2 flex-1">{t.bodyText}</p>}
                <div className="flex flex-wrap gap-1 text-[11px] mb-2.5">
                  <span className="badge bg-white border border-slate-200 text-slate-500">{t.language}</span>
                  {t.category && <span className="badge bg-white border border-slate-200 text-slate-500">{t.category}</span>}
                  {t.variableCount > 0 && <span className="badge bg-white border border-slate-200 text-slate-500">{t.variableCount} משתנים</span>}
                  {t.hasImageHeader && <span className="badge bg-white border border-slate-200 text-slate-500">🖼️ תמונה</span>}
                </div>
                <div className="flex gap-2 mt-auto pt-1 border-t border-slate-100">
                  <button type="button" className="flex-1 text-xs font-medium text-accent-700 hover:bg-accent-50 rounded-lg py-1.5 transition" onClick={() => openEdit(t)}>
                    עריכה
                  </button>
                  <button type="button" className="flex-1 text-xs font-medium text-red-600 hover:bg-red-50 rounded-lg py-1.5 transition disabled:opacity-50" disabled={deletingName === t.name} onClick={() => deleteTemplate(t)}>
                    {deletingName === t.name ? 'מוחק…' : 'מחיקה'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showGallery && (
        <Modal open title="📚 ספריית תבניות" onClose={() => setShowGallery(false)}>
          <p className="text-sm text-slate-500 mb-3">בחרו תבנית מוכנה — היא תיפתח לעריכה ותישלח לאישור Meta. {'{{1}}'} הם משתנים שתמלאו בעת השליחה.</p>
          <div className="flex gap-2 mb-3 flex-wrap">
            {MESSAGE_TEMPLATE_CATEGORIES.map((c) => (
              <button key={c.id} type="button" onClick={() => setGalleryCat(c.id)}
                className={`text-xs px-3 py-1.5 rounded-full border transition ${galleryCat === c.id ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                {c.label}
              </button>
            ))}
          </div>
          <div className="grid sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pr-1">
            {MESSAGE_TEMPLATES.filter((t) => galleryCat === 'all' || t.category === galleryCat).map((t) => (
              <div key={t.name} className="rounded-xl border border-slate-200 p-3 flex flex-col">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">{t.icon}</span>
                  <span className="font-medium text-sm text-ink-900">{t.title}</span>
                </div>
                {/* WhatsApp-bubble preview */}
                <div className="rounded-lg bg-[#d9fdd3] text-[13px] text-slate-800 p-2.5 whitespace-pre-wrap leading-relaxed mb-2 flex-1">
                  {t.bodyText}
                  {t.footerText && <div className="text-[11px] text-slate-500 mt-1.5">{t.footerText}</div>}
                </div>
                <button type="button" className="btn-primary text-xs w-full" onClick={() => pickLibraryTemplate(t)}>בחירה →</button>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {showCreate && (
        <Modal open title={editingId ? 'עריכת תבנית' : 'יצירת תבנית חדשה'} onClose={() => { setShowCreate(false); resetTemplateForm(); }}>
          <form onSubmit={submitTemplate} className="space-y-3">
            <p className={`text-xs rounded-lg p-2.5 ${editingId ? 'bg-amber-50 text-amber-700' : 'text-slate-500'}`}>
              {editingId
                ? '⚠️ עריכת התבנית תשלח אותה מחדש לאישור Meta — הסטטוס יחזור ל"ממתינה לאישור" עד שתאושר מחדש. (לא ניתן לערוך תבנית שכבר ממתינה לאישור.)'
                : 'התבנית נשלחת ל-Meta לאישור (בדרך כלל דקות עד 24 שעות). ניתן לשלוח אותה רק לאחר שאושרה.'}
            </p>
            <div>
              <label className="label">שם התבנית (אנגלית, מספרים וקו תחתון)</label>
              <input className="input disabled:bg-slate-100 disabled:text-slate-400" value={newTpl.name} disabled={!!editingId} onChange={(e) => setNewTpl((t) => ({ ...t, name: e.target.value }))} placeholder="appointment_reminder" required />
              {editingId && <p className="text-xs text-slate-400 mt-1">לא ניתן לשנות שם של תבנית קיימת.</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">קטגוריה</label>
                <select className="input" value={newTpl.category} onChange={(e) => setNewTpl((t) => ({ ...t, category: e.target.value }))}>
                  <option value="UTILITY">שירותית (Utility)</option>
                  <option value="MARKETING">שיווקית (Marketing)</option>
                  <option value="AUTHENTICATION">אימות (Authentication)</option>
                </select>
              </div>
              <div>
                <label className="label">שפה</label>
                <select className="input" value={newTpl.language} onChange={(e) => setNewTpl((t) => ({ ...t, language: e.target.value }))}>
                  <option value="he">עברית</option>
                  <option value="en_US">English (US)</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label">תוכן ההודעה</label>
              <textarea className="input" style={{ height: '6rem' }} value={newTpl.bodyText} onChange={(e) => setNewTpl((t) => ({ ...t, bodyText: e.target.value }))} placeholder="שלום {{1}}, התור שלך נקבע ל-{{2}}. נשמח לראותך!" required />
              <p className="text-xs text-gray-400 mt-1">השתמשו ב-{'{{1}}'}, {'{{2}}'} למשתנים דינמיים.</p>
            </div>
            <div>
              <label className="label">דוגמאות למשתנים (מופרד בפסיקים, לפי הסדר)</label>
              <input className="input" value={newTpl.examples} onChange={(e) => setNewTpl((t) => ({ ...t, examples: e.target.value }))} placeholder="ישראל, מחר בשעה 10:00" />
            </div>
            <div>
              <label className="label">כותרת תחתונה (אופציונלי)</label>
              <input className="input" value={newTpl.footerText} onChange={(e) => setNewTpl((t) => ({ ...t, footerText: e.target.value }))} placeholder="להסרה השב הסר" />
            </div>
            {createErr && <div className="text-sm text-red-600 bg-red-50 rounded p-2">{createErr}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => { setShowCreate(false); resetTemplateForm(); }}>ביטול</button>
              <button className="btn-primary" disabled={creating}>{creating ? 'שולח…' : editingId ? 'עדכון ושליחה לאישור' : 'שליחה לאישור'}</button>
            </div>
          </form>
        </Modal>
      )}

      {/* Compliance warning */}
      <div className="card mb-4 border-r-4 border-amber-400 bg-amber-50">
        <p className="text-sm text-amber-800">
          ⚠️ שליחה יזומה לרשימת מספרים מחייבת <b>תבנית מאושרת</b> (Template) והסכמת הנמענים (opt-in).
          {mode === 'text' && (
            <>
              {' '}
              במצב <b>טקסט חופשי</b> וואטסאפ ישלח <b>רק</b> למספרים שכתבו אליכם ב-24 השעות האחרונות — השאר ייכשלו.
            </>
          )}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Message setup */}
        <div className="card space-y-3">
          <h3 className="font-semibold">1. ההודעה</h3>
          <div>
            <label className="label">שם הקמפיין (לזיהוי בהיסטוריה)</label>
            <input className="input" value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="לדוגמה: מבצע קיץ 2026" />
          </div>
          <div className="flex gap-2">
            <button className={`btn-ghost text-sm ${mode === 'template' ? 'bg-brand-100 font-medium' : ''}`} onClick={() => setMode('template')}>
              תבנית מאושרת
            </button>
            <button className={`btn-ghost text-sm ${mode === 'text' ? 'bg-brand-100 font-medium' : ''}`} onClick={() => setMode('text')}>
              טקסט חופשי (24ש׳)
            </button>
          </div>

          {mode === 'template' ? (
            <>
              {loadingTpl ? (
                <Spinner />
              ) : (
                <div>
                  <label className="label">בחר תבנית מאושרת</label>
                  {/* Only approved templates are selectable — no free-text template names. */}
                  <select className="input" value={templateName} onChange={(e) => onPickTemplate(e.target.value)} disabled={!templates.length}>
                    <option value="">{templates.length ? '— בחר/י —' : 'אין תבניות מאושרות'}</option>
                    {templates.map((t) => (
                      <option key={`${t.name}:${t.language}`} value={t.name}>
                        {t.name} ({t.language}) · {t.variableCount} משתנים{t.hasImageHeader ? ' · 🖼️' : ''}
                      </option>
                    ))}
                  </select>
                  {templates.length === 0 && (
                    <div className="mt-2 text-xs text-slate-500 bg-slate-50 rounded-lg p-3">
                      אין תבניות מאושרות לשליחה. צרו תבנית ב<b>"התבניות שלי"</b> למעלה, המתינו לאישור Meta (הסטטוס יתעדכן ל<b>מאושרת</b>) — ואז היא תופיע כאן לבחירה.
                    </div>
                  )}
                  {selectedTpl && <p className="text-xs text-slate-500 mt-2 whitespace-pre-wrap bg-slate-50 rounded-lg p-3">{selectedTpl.bodyText}</p>}
                </div>
              )}

              {/* Header image — shown in template mode; required when the template has an image header */}
              <div className="border-t pt-3">
                <label className="label">
                  🖼️ תמונת Header {imageRequired ? <span className="text-red-600">(חובה לתבנית זו)</span> : <span className="text-gray-400 font-normal">(אם התבנית כוללת תמונה)</span>}
                </label>
                {headerImageUrl ? (
                  <div className="flex items-center gap-2">
                    <img src={headerImageUrl} alt="" className="h-14 w-14 object-cover rounded border" />
                    <button type="button" className="btn-ghost px-2 text-red-600" onClick={() => setHeaderImageUrl('')}>הסרה</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <label className="btn-ghost cursor-pointer text-sm">
                      {imgUploading ? 'מעלה…' : 'העלאת תמונה'}
                      <input type="file" accept="image/*" className="hidden" disabled={imgUploading} onChange={(e) => uploadHeaderImage(e.target.files?.[0])} />
                    </label>
                    <span className="text-xs text-gray-400">או הדביקו קישור:</span>
                    <input className="input flex-1" placeholder="https://…/image.jpg" value={headerImageUrl} onChange={(e) => setHeaderImageUrl(e.target.value)} />
                  </div>
                )}
              </div>
            </>
          ) : (
            <div>
              <label className="label">הודעה (השתמשו ב-{'{name}'} לשם מהעמודה)</label>
              <textarea className="input h-28" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="היי {name}! ..." />
            </div>
          )}
        </div>

        {/* File + mapping */}
        <div className="card space-y-3">
          <h3 className="font-semibold">2. רשימת המספרים</h3>

          {/* Contacts inside Meta's 24h service window — free-text eligible without a template */}
          <div className="rounded-xl border border-green-200 bg-green-50/60 p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-sm font-medium text-green-900">💬 בחלון 24 השעות של Meta ({eligible.length})</span>
              <button type="button" className="text-xs text-green-700 hover:underline" disabled={eligibleLoading} onClick={loadEligible}>
                {eligibleLoading ? 'טוען…' : '↻ רענון'}
              </button>
            </div>
            <p className="text-xs text-green-800/80 mb-2">
              לקוחות שכתבו לכם ב-24 השעות האחרונות — לפי כללי Meta מותר לשלוח להם גם <b>טקסט חופשי</b>, בלי תבנית. סמנו כדי לצרף לרשימת השליחה (השם ימלא את {'{name}'} / {'{{1}}'}).
            </p>
            {eligibleLoading ? (
              <Spinner />
            ) : eligible.length === 0 ? (
              <p className="text-xs text-green-800/70">אין כרגע לקוחות בחלון הפעיל — הרשימה מתמלאת כשלקוחות כותבים אליכם.</p>
            ) : (
              <>
                <div className="flex gap-3 mb-1.5 text-xs">
                  <button type="button" className="text-green-700 hover:underline" onClick={() => setPicked(new Set(eligible.map((c) => c.phone)))}>בחירת הכל</button>
                  {picked.size > 0 && (
                    <button type="button" className="text-slate-500 hover:underline" onClick={() => setPicked(new Set())}>ניקוי ({picked.size})</button>
                  )}
                </div>
                <ul className="max-h-44 overflow-y-auto divide-y divide-green-100">
                  {eligible.map((c) => (
                    <li key={c.phone}>
                      <label className="flex items-center gap-2.5 py-1.5 cursor-pointer text-sm">
                        <input type="checkbox" className="accent-green-600" checked={picked.has(c.phone)} onChange={() => togglePicked(c.phone)} />
                        <span className="flex-1 min-w-0 truncate">{c.name || 'ללא שם'}</span>
                        <span className="text-xs text-slate-500" dir="ltr">{c.phone}</span>
                        <span className="text-[11px] text-green-700 shrink-0">נותרו {hoursLeft(c.windowExpiresAt)}ש׳</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {/* Saved recipient lists — reusable audience */}
          {savedLists.length > 0 && (
            <div>
              <label className="label">📋 רשימה שמורה</label>
              <select className="input" value={chosenListId} onChange={(e) => pickList(e.target.value)}>
                <option value="">— בחרו רשימה —</option>
                {savedLists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.count})</option>)}
              </select>
              {chosenListId && <p className="text-xs text-green-700 mt-1">{listContacts.length} נמענים מהרשימה יצורפו לשליחה.</p>}
            </div>
          )}

          <label className="btn-ghost cursor-pointer text-sm inline-block">
            {parsing ? 'קורא…' : 'העלאת קובץ CSV / XLSX'}
            <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>

          {columns.length > 0 && (
            <>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm text-gray-600">{rows.length} שורות · {contacts.length} מספרים לשליחה</div>
                <button type="button" className="text-xs text-brand-600 hover:underline" onClick={saveFileAsList}>💾 שמירה כרשימה</button>
              </div>
              <div>
                <label className="label">עמודת טלפון</label>
                <select className="input" value={phoneColumn} onChange={(e) => setPhoneColumn(e.target.value)}>
                  {columns.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              {Array.from({ length: varCount }).map((_, i) => (
                <div key={i}>
                  <label className="label">{mode === 'template' ? `משתנה {{${i + 1}}}` : 'עמודת שם (ל-{name})'}</label>
                  <select className="input" value={varColumns[i] || ''} onChange={(e) => setVarCol(i, e.target.value)}>
                    <option value="">— ללא —</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3 flex-wrap">
        <button className="btn-primary" onClick={send} disabled={!canSend}>
          {sending ? 'יוצר קמפיין…' : jobActive ? 'קמפיין פעיל…' : `שליחה ל-${contacts.length} מספרים`}
        </button>
        {imageRequired && !headerImageUrl && <span className="text-sm text-red-600">התבנית דורשת תמונה</span>}
        {quota && (
          <span className={`text-sm ${quota.remaining === 0 ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
            מכסה יומית: נותרו {quota.remaining.toLocaleString()} מתוך {quota.cap.toLocaleString()}
          </span>
        )}
      </div>

      {job && (
        <div className="card mt-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="font-semibold">
              {{
                running: '📤 שולח…',
                completed: '✅ הקמפיין הושלם',
                stopped: '⏹️ הקמפיין נעצר',
                quota_reached: '⏸️ הושגה המכסה היומית',
                aborted: '🛑 הקמפיין נעצר אוטומטית',
              }[job.status] || job.status}
              {job.label && <span className="text-sm font-normal text-slate-500 ms-2">· {job.label}</span>}
            </h3>
            <div className="flex gap-2">
              {jobActive && (
                <button className="btn-ghost text-sm text-red-600" onClick={stopJobNow}>
                  עצירת הקמפיין
                </button>
              )}
              {canResume && (
                <button className="btn-ghost text-sm" onClick={resumeJobNow}>
                  ▶ המשך מאיפה שנעצר ({(job.total - job.cursor).toLocaleString()} נותרו)
                </button>
              )}
            </div>
          </div>

          <div>
            <div className="h-2 rounded bg-gray-100 overflow-hidden">
              <div
                className="h-2 bg-brand-500 transition-all duration-500"
                style={{ width: `${job.total ? Math.round((job.cursor / job.total) * 100) : 100}%` }}
              />
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {job.cursor.toLocaleString()} / {job.total.toLocaleString()} טופלו
              {jobActive && ' · אפשר לסגור את הדף — השליחה רצה בשרת'}
            </div>
          </div>

          <div className="flex gap-4 text-sm flex-wrap">
            <span className="text-green-700">✅ נשלחו: {job.sent.toLocaleString()}</span>
            <span className="text-red-700">❌ נכשלו: {job.failedCount.toLocaleString()}</span>
            <span className="text-gray-500">⚠️ לא תקינים: {job.invalidCount.toLocaleString()}</span>
            <span className="text-gray-500">🚫 הוסרו מדיוור: {job.suppressedCount.toLocaleString()}</span>
            {job.duplicatesRemoved > 0 && (
              <span className="text-gray-400">כפילויות שנוקו: {job.duplicatesRemoved.toLocaleString()}</span>
            )}
          </div>

          {job.abortReason && (
            <p className="text-sm text-amber-800 bg-amber-50 rounded p-2">{job.abortReason}</p>
          )}

          {(job.failures?.length > 0 || job.invalid?.length > 0) && (
            <div className="max-h-60 overflow-y-auto text-xs border rounded">
              <table className="w-full">
                <tbody>
                  {[...(job.failures || []), ...(job.invalid || [])].map((f, i) => (
                    <tr key={i} className="border-b">
                      <td className="p-1.5 font-mono">{f.phone}</td>
                      <td className="p-1.5 text-red-600">{f.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
