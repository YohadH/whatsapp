import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, Modal, EmptyState, ErrorState, errMsg } from '../components/ui.jsx';
import { FLOW_TEMPLATES, FLOW_TEMPLATE_CATEGORIES } from '../data/flowTemplates.js';

// Convert a flow template into the shape FlowEditor expects (questions carry an
// `optionsText` mirror + orderIndex; triggerWords stay an array). No id → the
// editor treats it as new and POSTs on save.
function templateToFlow(t) {
  return {
    name: t.title,
    description: t.description || '',
    triggerWords: t.triggerWords || [],
    finalMessage: t.finalMessage || '',
    sendFinalMessage: true,
    linkId: '',
    isActive: true,
    isDefault: false,
    questions: (t.questions || []).map((q, i) => ({
      questionText: q.questionText,
      questionType: q.questionType || 'text',
      options: q.options || [],
      optionsText: (q.options || []).join(', '),
      isRequired: q.isRequired ?? true,
      orderIndex: i,
    })),
  };
}

const QUESTION_TYPES = [
  { value: 'text', label: 'טקסט' },
  { value: 'phone', label: 'טלפון' },
  { value: 'email', label: 'אימייל' },
  { value: 'number', label: 'מספר' },
  { value: 'single_choice', label: 'בחירה יחידה' },
  { value: 'multiple_choice', label: 'בחירה מרובה' },
  { value: 'yes_no', label: 'כן / לא' },
  { value: 'date', label: 'תאריך' },
  { value: 'custom', label: 'מותאם אישית' },
];

const emptyFlow = () => ({
  name: '',
  description: '',
  triggerWords: [],
  finalMessage: '',
  linkId: '',
  isActive: true,
  questions: [],
});

export default function Flows() {
  const [flows, setFlows] = useState([]);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [showGallery, setShowGallery] = useState(false);

  function load() {
    setLoading(true);
    setError('');
    Promise.all([api.get('/api/flows'), api.get('/api/links')])
      .then(([f, l]) => {
        setFlows(f.data);
        setLinks(l.data);
      })
      .catch((err) => setError(errMsg(err)))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function toggleActive(flow) {
    await api.put(`/api/flows/${flow.id}`, { isActive: !flow.isActive });
    load();
  }
  async function remove(flow) {
    if (!confirm(`למחוק את התהליך "${flow.name}"?`)) return;
    await api.delete(`/api/flows/${flow.id}`);
    load();
  }

  return (
    <div>
      <PageHeader
        title="תהליכים"
        subtitle="שאלות מוגדרות מראש שהסוכן שואל את הלקוחות"
        actions={
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setShowGallery(true)}>✨ ספריית תבניות</button>
            <button className="btn-primary" onClick={() => setEditing(emptyFlow())}>+ תהליך חדש</button>
          </div>
        }
      />

      {loading ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : flows.length === 0 ? (
        <EmptyState>
          עדיין אין תהליכים.{' '}
          <button className="text-brand-600 font-medium hover:underline" onClick={() => setShowGallery(true)}>
            בחרו תבנית מוכנה
          </button>{' '}
          או צרו תהליך חדש!
        </EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {flows.map((flow) => (
            <div key={flow.id} className="card">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-lg flex items-center gap-2">
                    {flow.name}
                    <span className={`badge ${flow.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}>
                      {flow.isActive ? 'פעיל' : 'כבוי'}
                    </span>
                    {Array.isArray(flow.channels) && flow.channels.length > 0 && (
                      <span className="badge bg-slate-100 text-slate-600" title="הערוצים שבהם התהליך פועל">
                        {flow.channels.map((c) => ({ whatsapp: '🟢', instagram: '📸', messenger: '💬' }[c] || c)).join(' ')}
                      </span>
                    )}
                  </h3>
                  <p className="text-sm text-gray-500 mt-0.5">{flow.description || '—'}</p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {flow.triggerWords.map((w) => (
                  <span key={w} className="badge bg-gray-100 text-gray-600">{w}</span>
                ))}
              </div>
              <div className="mt-3 text-sm text-gray-500">{flow.questions.length} שאלות · קישור: {flow.link?.name || '—'}</div>
              <div className="mt-4 flex gap-2">
                <button className="btn-ghost" onClick={() => setEditing(flow)}>עריכה</button>
                <button className="btn-ghost" onClick={() => toggleActive(flow)}>{flow.isActive ? 'כיבוי' : 'הפעלה'}</button>
                <button className="btn-danger mr-auto" onClick={() => remove(flow)}>מחיקה</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <FlowEditor
          initial={editing}
          links={links}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {showGallery && (
        <FlowTemplateGallery
          onClose={() => setShowGallery(false)}
          onPick={(t) => {
            setShowGallery(false);
            setEditing(templateToFlow(t));
          }}
        />
      )}
    </div>
  );
}

// Gallery of ready-made flows (SmartSend-style): category chips, a card grid, and
// a live WhatsApp-style phone preview of the selected template's questions.
function FlowTemplateGallery({ onClose, onPick }) {
  const [cat, setCat] = useState('all');
  const [selected, setSelected] = useState(FLOW_TEMPLATES[0]);
  const list = cat === 'all' ? FLOW_TEMPLATES : FLOW_TEMPLATES.filter((t) => t.category === cat);

  return (
    <Modal open onClose={onClose} title="ספריית תבניות תהליכים" wide>
      <p className="text-sm text-gray-500 -mt-2 mb-3">בחרו תבנית מוכנה — היא תיפתח לעריכה כך שתוכלו להתאים אותה לעסק שלכם.</p>
      <div className="flex flex-wrap gap-2 mb-4">
        {FLOW_TEMPLATE_CATEGORIES.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c.id)}
            className={`px-3 py-1.5 rounded-full text-sm transition ${
              cat === c.id ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="grid md:grid-cols-[1fr_300px] gap-5">
        {/* Cards */}
        <div className="grid sm:grid-cols-2 gap-3 max-h-[60vh] overflow-y-auto pl-1">
          {list.map((t) => (
            <button
              key={t.key}
              onMouseEnter={() => setSelected(t)}
              onFocus={() => setSelected(t)}
              onClick={() => setSelected(t)}
              className={`text-right border rounded-xl p-4 transition hover:shadow-md ${
                selected?.key === t.key ? 'border-brand-500 ring-1 ring-brand-500 bg-brand-50/40' : 'border-slate-200'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-2xl">{t.icon}</span>
                <span className="font-semibold">{t.title}</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">{t.description}</p>
              <div className="text-[11px] text-slate-400 mt-2">{t.questions.length} שאלות</div>
            </button>
          ))}
        </div>

        {/* Live phone preview */}
        <div className="hidden md:block">
          <div className="sticky top-0">
            <PhonePreview template={selected} />
            <button className="btn-primary w-full mt-3" onClick={() => onPick(selected)}>
              השתמשו בתבנית זו
            </button>
          </div>
        </div>
      </div>

      {/* Mobile: pick button under the list */}
      <div className="md:hidden mt-4">
        <button className="btn-primary w-full" onClick={() => onPick(selected)}>השתמשו ב"{selected?.title}"</button>
      </div>
    </Modal>
  );
}

// WhatsApp-style preview: renders each flow question as an incoming (business)
// bubble, with a sample customer reply between them, so the owner sees the flow.
function PhonePreview({ template }) {
  if (!template) return null;
  return (
    <div className="rounded-2xl bg-[#0b141a] p-2 shadow-lg">
      <div className="rounded-t-xl bg-[#075E54] text-white px-3 py-2 flex items-center gap-2">
        <span className="h-7 w-7 rounded-full bg-white/20 grid place-items-center text-sm">{template.icon}</span>
        <div className="text-sm font-medium leading-none">{template.title}</div>
      </div>
      <div
        className="px-2.5 py-3 space-y-2 max-h-[52vh] overflow-y-auto"
        style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'%3E%3Crect width=\'20\' height=\'20\' fill=\'%23ece5dd\'/%3E%3C/svg%3E")' }}
      >
        {template.questions.map((q, i) => (
          <div key={i} className="space-y-2">
            {/* Business asks (incoming bubble — white, right side in RTL) */}
            <div className="flex">
              <div className="bg-white rounded-lg rounded-tr-none px-2.5 py-1.5 text-[13px] text-slate-800 shadow-sm max-w-[85%] whitespace-pre-wrap">
                {q.questionText}
                {Array.isArray(q.options) && q.options.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {q.options.map((o) => (
                      <div key={o} className="border-t border-slate-100 pt-1 text-brand-600 text-center text-xs">{o}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* Sample customer reply (outgoing bubble — green, left side in RTL) */}
            {i < template.questions.length - 1 && (
              <div className="flex justify-end">
                <div className="bg-[#dcf8c6] rounded-lg rounded-tl-none px-2.5 py-1.5 text-[13px] text-slate-800 shadow-sm">
                  {q.sample || SAMPLE_REPLIES[q.questionType] || '…'}
                </div>
              </div>
            )}
          </div>
        ))}
        {template.finalMessage && (
          <div className="flex">
            <div className="bg-white rounded-lg rounded-tr-none px-2.5 py-1.5 text-[13px] text-slate-800 shadow-sm max-w-[85%]">
              {template.finalMessage}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Plausible sample answers per question type, used only in the preview.
const SAMPLE_REPLIES = {
  text: 'דנה כהן',
  phone: '050-1234567',
  email: 'dana@email.com',
  number: '2',
  date: '12/08',
  single_choice: '✅',
  multiple_choice: '✅',
  yes_no: 'כן',
};

function FlowEditor({ initial, links, onClose, onSaved }) {
  const isNew = !initial.id;
  const [form, setForm] = useState({
    name: initial.name || '',
    description: initial.description || '',
    triggerWords: (initial.triggerWords || []).join(', '),
    finalMessage: initial.finalMessage || '',
    sendFinalMessage: initial.sendFinalMessage ?? true,
    linkId: initial.linkId || '',
    isActive: initial.isActive ?? true,
    isDefault: initial.isDefault ?? false,
    channels: Array.isArray(initial.channels) ? initial.channels : [], // [] = all channels
  });
  const [questions, setQuestions] = useState(
    (initial.questions || []).map((q) => ({ ...q, options: q.options || [], optionsText: (q.options || []).join(', ') }))
  );
  const [saving, setSaving] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function addQuestion() {
    setQuestions((qs) => [...qs, { questionText: '', questionType: 'text', options: [], optionsText: '', isRequired: true, orderIndex: qs.length }]);
  }
  function updateQuestion(i, patch) {
    setQuestions((qs) => qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  }
  function removeQuestion(i) {
    setQuestions((qs) => qs.filter((_, idx) => idx !== i));
  }
  function move(i, dir) {
    setQuestions((qs) => {
      const next = [...qs];
      const j = i + dir;
      if (j < 0 || j >= next.length) return qs;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  async function uploadVoice(i, file) {
    if (!file) return;
    updateQuestion(i, { voiceUploading: true });
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api.post('/api/uploads/audio', fd);
      updateQuestion(i, { voiceUrl: res.data.url, voiceUploading: false });
    } catch (err) {
      updateQuestion(i, { voiceUploading: false });
      alert(err.response?.data?.error || 'העלאת ההקלטה נכשלה');
    }
  }
  async function uploadImage(i, file) {
    if (!file) return;
    updateQuestion(i, { imageUploading: true });
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api.post('/api/uploads/image', fd);
      updateQuestion(i, { imageUrl: res.data.url, imageUploading: false });
    } catch (err) {
      updateQuestion(i, { imageUploading: false });
      alert(err.response?.data?.error || 'העלאת התמונה נכשלה');
    }
  }

  async function save() {
    setSaving(true);
    const payload = {
      name: form.name,
      description: form.description,
      triggerWords: form.triggerWords.split(',').map((s) => s.trim()).filter(Boolean),
      finalMessage: form.finalMessage,
      sendFinalMessage: form.sendFinalMessage,
      linkId: form.linkId || null,
      isActive: form.isActive,
      isDefault: form.isDefault,
      channels: form.channels, // [] = every channel
    };
    try {
      let flowId = initial.id;
      if (isNew) {
        const res = await api.post('/api/flows', { ...payload, questions: questions.map(serializeQ) });
        flowId = res.data.id;
      } else {
        await api.put(`/api/flows/${flowId}`, payload);
        // Sync questions: simplest robust approach — delete removed, update existing, create new.
        const existingIds = new Set((initial.questions || []).map((q) => q.id));
        const keptIds = new Set(questions.filter((q) => q.id).map((q) => q.id));
        for (const old of initial.questions || []) {
          if (!keptIds.has(old.id)) await api.delete(`/api/questions/${old.id}`);
        }
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          if (q.id && existingIds.has(q.id)) {
            await api.put(`/api/questions/${q.id}`, { ...serializeQ(q), orderIndex: i });
          } else {
            await api.post(`/api/flows/${flowId}/questions`, { ...serializeQ(q), orderIndex: i });
          }
        }
      }
      onSaved();
    } catch (err) {
      alert(err.response?.data?.error || 'שמירה נכשלה');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? 'תהליך חדש' : 'עריכת תהליך'} wide>
      <div className="space-y-4">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <label className="label">שם התהליך</label>
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label">קישור לשליחה בסיום</label>
            <select className="input" value={form.linkId} onChange={(e) => set('linkId', e.target.value)}>
              <option value="">— ללא —</option>
              {links.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label">תיאור</label>
          <input className="input" value={form.description} onChange={(e) => set('description', e.target.value)} />
        </div>
        <div>
          <label className="label">
            מילות הפעלה (מופרדות בפסיק){form.isDefault && <span className="text-gray-400 font-normal"> — לא חובה כשהתהליך מתחיל אוטומטית</span>}
          </label>
          <input className="input" value={form.triggerWords} onChange={(e) => set('triggerWords', e.target.value)} placeholder="פגישה, לקבוע, תור" />
        </div>
        <div>
          <label className="label">ערוצים {form.channels.length === 0 && <span className="text-gray-400 font-normal">— כל הערוצים</span>}</label>
          <div className="flex flex-wrap gap-2">
            {[{ v: 'whatsapp', l: '🟢 וואטסאפ' }, { v: 'instagram', l: '📸 אינסטגרם' }, { v: 'messenger', l: '💬 פייסבוק' }].map((c) => {
              const on = form.channels.includes(c.v);
              return (
                <button
                  type="button"
                  key={c.v}
                  onClick={() => set('channels', on ? form.channels.filter((x) => x !== c.v) : [...form.channels, c.v])}
                  className={`text-sm rounded-full px-3 py-1.5 border transition ${on ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                >
                  {c.l}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-gray-400 mt-1">בלי בחירה — התהליך פועל בכל הערוצים. בחרו ערוץ כדי שהאוטומציה תרוץ רק בו (למשל אינסטגרם/פייסבוק).</p>
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm mb-1">
            <input
              type="checkbox"
              checked={form.sendFinalMessage}
              onChange={(e) => set('sendFinalMessage', e.target.checked)}
            />
            שלח הודעת סיום בסוף התהליך
          </label>
          {form.sendFinalMessage ? (
            <textarea
              className="input h-20"
              placeholder="הודעת הסיום שתישלח ללקוח (אם יש קישור, הוא יצורף אוטומטית)"
              value={form.finalMessage}
              onChange={(e) => set('finalMessage', e.target.value)}
            />
          ) : (
            <p className="text-xs text-gray-400">לא תישלח הודעת סיום (אם מוגדר קישור — הוא עדיין יישלח).</p>
          )}
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} />
            תהליך פעיל
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
            התחל אוטומטית בכל הודעה (ללא צורך במילות הפעלה — למשל כשהלקוח כותב "היי")
          </label>
        </div>

        {/* Questions */}
        <div className="border-t pt-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-semibold">שאלות ({questions.length})</h4>
            <button className="btn-ghost" onClick={addQuestion}>+ הוספת שאלה</button>
          </div>
          <div className="space-y-3">
            {questions.map((q, i) => (
              <div key={i} className="border rounded-lg p-3 bg-gray-50">
                <div className="flex items-start gap-2 mb-2">
                  <span className="text-xs text-gray-400 w-5 mt-2">{i + 1}.</span>
                  <textarea
                    className="input flex-1 min-h-[2.5rem] resize-y"
                    rows={2}
                    placeholder="טקסט השאלה (אפשר כמה שורות, אימוג'י ושבירת שורה)"
                    value={q.questionText}
                    onChange={(e) => updateQuestion(i, { questionText: e.target.value })}
                  />
                  <button className="btn-ghost px-2" onClick={() => move(i, -1)}>↑</button>
                  <button className="btn-ghost px-2" onClick={() => move(i, 1)}>↓</button>
                  <button className="btn-danger px-2" onClick={() => removeQuestion(i)}>✕</button>
                </div>
                <div className="flex flex-wrap items-center gap-3 pr-7">
                  <select className="input w-40" value={q.questionType} onChange={(e) => updateQuestion(i, { questionType: e.target.value })}>
                    {QUESTION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-sm">
                    <input type="checkbox" checked={q.isRequired} onChange={(e) => updateQuestion(i, { isRequired: e.target.checked })} />
                    חובה
                  </label>
                  {['single_choice', 'multiple_choice'].includes(q.questionType) && (
                    <input
                      className="input flex-1 min-w-[200px]"
                      placeholder="אפשרויות מופרדות בפסיק"
                      value={q.optionsText ?? (q.options || []).join(', ')}
                      onChange={(e) => updateQuestion(i, { optionsText: e.target.value })}
                    />
                  )}
                </div>
                {/* Pre-recorded voice note for this question */}
                <div className="flex flex-wrap items-center gap-2 pr-7 mt-2">
                  <span className="text-sm text-gray-600">🎤 הודעה קולית:</span>
                  {q.voiceUrl ? (
                    <>
                      <audio controls src={q.voiceUrl} className="h-8 max-w-[220px]" />
                      <button
                        type="button"
                        className="btn-ghost px-2 text-red-600"
                        onClick={() => updateQuestion(i, { voiceUrl: null })}
                      >
                        הסרה
                      </button>
                    </>
                  ) : (
                    <label className="btn-ghost cursor-pointer text-sm">
                      {q.voiceUploading ? 'מעלה…' : 'העלאת הקלטה'}
                      <input
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        disabled={q.voiceUploading}
                        onChange={(e) => uploadVoice(i, e.target.files?.[0])}
                      />
                    </label>
                  )}
                  <span className="text-xs text-gray-400">לתצוגת "הודעה קולית" בוואטסאפ העלו קובץ ‎.ogg‎ (Opus)</span>
                </div>
                {/* Optional image for this question (sent together with the voice note) */}
                <div className="flex flex-wrap items-center gap-2 pr-7 mt-2">
                  <span className="text-sm text-gray-600">🖼️ תמונה:</span>
                  {q.imageUrl ? (
                    <>
                      <img src={q.imageUrl} alt="" className="h-12 w-12 object-cover rounded border" />
                      <button
                        type="button"
                        className="btn-ghost px-2 text-red-600"
                        onClick={() => updateQuestion(i, { imageUrl: null })}
                      >
                        הסרה
                      </button>
                    </>
                  ) : (
                    <label className="btn-ghost cursor-pointer text-sm">
                      {q.imageUploading ? 'מעלה…' : 'העלאת תמונה'}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        disabled={q.imageUploading}
                        onChange={(e) => uploadImage(i, e.target.files?.[0])}
                      />
                    </label>
                  )}
                  <span className="text-xs text-gray-400">תישלח יחד עם השאלה (JPG/PNG, עד 5MB)</span>
                </div>
              </div>
            ))}
            {questions.length === 0 && <p className="text-sm text-gray-400">אין שאלות עדיין</p>}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-4">
          <button className="btn-ghost" onClick={onClose}>ביטול</button>
          <button className="btn-primary" onClick={save} disabled={saving || !form.name}>
            {saving ? 'שומר…' : 'שמירה'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function serializeQ(q) {
  const raw = q.optionsText !== undefined ? q.optionsText : (q.options || []).join(',');
  return {
    questionText: q.questionText,
    questionType: q.questionType,
    options: raw.split(',').map((s) => s.trim()).filter(Boolean),
    voiceUrl: q.voiceUrl || null,
    imageUrl: q.imageUrl || null,
    isRequired: q.isRequired,
  };
}
