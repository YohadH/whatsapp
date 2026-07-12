import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { PageHeader } from '../components/Layout.jsx';
import { Spinner } from '../components/ui.jsx';

export default function Broadcast() {
  const [templates, setTemplates] = useState([]);
  const [configured, setConfigured] = useState(false);
  const [loadingTpl, setLoadingTpl] = useState(true);

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

  const jobActive = job?.status === 'running';
  const canResume =
    job && ['stopped', 'quota_reached', 'aborted'].includes(job.status) && job.cursor < job.total;

  const refreshQuota = () =>
    api.get('/api/broadcast/quota').then((r) => setQuota(r.data)).catch(() => {});

  useEffect(() => {
    api
      .get('/api/broadcast/templates')
      .then((r) => {
        setConfigured(r.data.configured);
        const approved = (r.data.templates || []).filter((t) => t.status === 'APPROVED');
        setTemplates(approved);
      })
      .catch(() => setConfigured(false))
      .finally(() => setLoadingTpl(false));

    refreshQuota();
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
  const imageRequired = mode === 'template' && (selectedTpl ? !!selectedTpl.hasImageHeader : manualHasImage);

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

  function setVarCol(i, col) {
    setVarColumns((v) => {
      const next = [...v];
      next[i] = col;
      return next;
    });
  }

  const contacts = rows
    .map((r) => ({
      phone: r[phoneColumn],
      vars: (mode === 'template' ? varColumns : varColumns.slice(0, 1)).map((c) => (c ? r[c] : '')),
    }))
    .filter((c) => String(c.phone ?? '').trim());

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
              templateName,
              languageCode,
              contacts,
              headerImageLink: headerImageUrl || undefined,
              requireHeaderImage: imageRequired,
            }
          : { mode: 'text', message, contacts };
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
      <PageHeader title="שליחה מרובה" subtitle="העלאת רשימת מספרים ושליחת הודעה לכולם" />

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
              ) : configured && templates.length ? (
                <div>
                  <label className="label">בחר תבנית</label>
                  <select className="input" value={templateName} onChange={(e) => onPickTemplate(e.target.value)}>
                    <option value="">— בחר/י —</option>
                    {templates.map((t) => (
                      <option key={`${t.name}:${t.language}`} value={t.name}>
                        {t.name} ({t.language}) · {t.variableCount} משתנים{t.hasImageHeader ? ' · 🖼️' : ''}
                      </option>
                    ))}
                  </select>
                  {selectedTpl && <p className="text-xs text-gray-500 mt-2 whitespace-pre-wrap bg-gray-50 rounded p-2">{selectedTpl.bodyText}</p>}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-gray-500">
                    {configured ? 'לא נמצאו תבניות מאושרות.' : 'לא הוגדר WHATSAPP_BUSINESS_ACCOUNT_ID — אפשר להזין שם תבנית ידנית.'}
                  </p>
                  <input className="input" placeholder="שם התבנית (למשל israel_promo)" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />
                  <input className="input" placeholder="קוד שפה (he)" value={languageCode} onChange={(e) => setLanguageCode(e.target.value)} />
                  <input className="input" type="number" min="0" placeholder="מספר משתנים בתבנית" value={varColumns.length} onChange={(e) => setVarColumns(Array(Math.max(0, +e.target.value || 0)).fill(''))} />
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={manualHasImage} onChange={(e) => setManualHasImage(e.target.checked)} />
                    לתבנית יש תמונת Header
                  </label>
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
          <label className="btn-ghost cursor-pointer text-sm inline-block">
            {parsing ? 'קורא…' : 'העלאת קובץ CSV / XLSX'}
            <input type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>

          {columns.length > 0 && (
            <>
              <div className="text-sm text-gray-600">{rows.length} שורות · {contacts.length} מספרים לשליחה</div>
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
