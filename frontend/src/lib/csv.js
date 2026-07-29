// Client-side CSV export helpers for the Analytics page.
//
// No backend endpoint and no dependency: we build the CSV string from the exact
// analytics data the page already fetched/renders, then hand it to the browser
// as a Blob download. Kept as a pure module (no DOM in the string-building part)
// so buildAnalyticsCsv can be smoke-tested in isolation with plain node.

// RFC-4180 field escaping: wrap in double quotes and double any inner quote when
// the value contains a comma, quote, or a newline. A leading BOM (added in
// buildAnalyticsCsv) makes Excel read the file as UTF-8 so Hebrew renders.
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Turn an array of header strings + an array of row-arrays into CSV text
// (CRLF line endings, the RFC-4180 default that Excel expects).
export function rowsToCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

// Assemble the full multi-section analytics CSV from the page's `d` object.
// `d` has the shape produced by Analytics.jsx's load():
//   { conv, flows, links, questions, funnel }
// Each section is emitted as a titled block separated by a blank line so the
// whole export lands in one file yet stays readable in Excel/Sheets.
//
// intentLabels maps a raw intent key → its Hebrew label (INTENT_LABELS from
// ui.jsx) so the exported file matches what the user sees on screen.
export function buildAnalyticsCsv(d, intentLabels = {}) {
  if (!d) return '';
  const blocks = [];

  const section = (title, headers, rows) => {
    blocks.push(rowsToCsv([title], []));           // section title row
    blocks.push(rowsToCsv(headers, rows));         // header + data
  };

  // 1. Conversations & leads over time (daily series)
  const series = d.conv?.series || [];
  section(
    'שיחות ולידים לאורך זמן',
    ['תאריך', 'שיחות', 'לידים', 'לקוחות חדשים'],
    series.map((r) => [r.date, r.conversations ?? 0, r.leads ?? 0, r.newCustomers ?? 0])
  );

  // 2. Conversion funnel
  const funnel = d.funnel?.funnel || [];
  section(
    'משפך המרה',
    ['שלב', 'כמות'],
    funnel.map((f) => [f.stage, f.count ?? 0])
  );

  // 3. Flow performance
  const flows = d.flows?.flows || [];
  section(
    'המרה לפי תהליך',
    ['תהליך', 'התחילו', 'הושלמו', 'ננטשו', 'אחוז המרה'],
    flows.map((f) => [f.name, f.started ?? 0, f.completed ?? 0, f.abandoned ?? 0, f.conversionRate ?? 0])
  );

  // 4. Link clicks
  const links = d.links?.links || [];
  section(
    'קליקים על קישורים',
    ['קישור', 'נשלחו', 'קליקים', 'אחוז קליקים'],
    links.map((l) => [l.name, l.sent ?? 0, l.clicks ?? 0, l.clickRate ?? 0])
  );

  // 5. Customers by intent
  const byIntent = d.questions?.customersByIntent || [];
  section(
    'לקוחות לפי כוונה',
    ['כוונה', 'כמות'],
    byIntent.map((i) => [intentLabels[i.intent] || i.intent, i.count ?? 0])
  );

  // 6. Drop-off by question
  const dropOff = d.questions?.dropOffByQuestion || [];
  section(
    'נשירה לפי שאלה',
    ['שאלה', 'נשאלו', 'ענו', 'נשירה', 'אחוז נשירה'],
    dropOff.map((q) => [q.question, q.asked ?? 0, q.answered ?? 0, q.dropOff ?? 0, q.dropOffRate ?? 0])
  );

  // 7. Common unanswered questions (handed to a human)
  const unanswered = d.questions?.mostCommonUnanswered || [];
  section(
    'שאלות נפוצות ללא מענה (הועברו לנציג)',
    ['שאלה'],
    unanswered.map((q) => [q])
  );

  // Blank line between blocks; leading BOM so Excel opens it as UTF-8 (Hebrew).
  return '﻿' + blocks.join('\r\n\r\n') + '\r\n';
}

// Browser-only: trigger a download of `text` as `filename`. Split from the
// pure builders above so the string logic stays testable without a DOM.
export function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Build a dated filename like "analytics-2026-07-29.csv".
export function analyticsFilename(date = new Date()) {
  return `analytics-${date.toISOString().slice(0, 10)}.csv`;
}
