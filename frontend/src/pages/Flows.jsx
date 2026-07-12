import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner, Modal, EmptyState } from '../components/ui.jsx';

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
  const [editing, setEditing] = useState(null);

  function load() {
    setLoading(true);
    Promise.all([api.get('/api/flows'), api.get('/api/links')])
      .then(([f, l]) => {
        setFlows(f.data);
        setLinks(l.data);
      })
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
        actions={<button className="btn-primary" onClick={() => setEditing(emptyFlow())}>+ תהליך חדש</button>}
      />

      {loading ? (
        <Spinner />
      ) : flows.length === 0 ? (
        <EmptyState>עדיין אין תהליכים. צרו את הראשון!</EmptyState>
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
    </div>
  );
}

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
