import * as XLSX from 'xlsx';

// Matches a whole value written in scientific notation, e.g. "9.72544E+11".
const SCI_NOTATION = /^-?\d+(?:\.\d+)?[eE][+-]?\d+$/;

// Rows as displayed text (what Excel shows), with one repair: Excel renders
// 12+-digit numbers — e.g. "9725…" phones stored as numeric cells — in
// scientific notation ("9.72544E+11"), which drops the last digits from the
// display text. When a cell's text is scientific notation but the underlying
// raw number carries more digits than the text conveys, return the raw digits
// instead. When it carries none (e.g. a CSV that literally contains
// "9.72544E+11" — the true digits no longer exist anywhere), keep the text so
// validation flags the row instead of silently messaging a wrong number.
export function sheetToRows(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });

  rows.forEach((row, i) => {
    for (const key of Object.keys(row)) {
      const text = row[key];
      const raw = rawRows[i]?.[key];
      if (
        typeof text === 'string' &&
        SCI_NOTATION.test(text.trim()) &&
        typeof raw === 'number' &&
        Number.isFinite(raw) &&
        Number(text) !== raw
      ) {
        row[key] = String(raw);
      }
    }
  });

  return rows;
}
