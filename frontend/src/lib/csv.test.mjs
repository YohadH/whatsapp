// Plain-node test (no test runner installed in this project). Run with:
//   node src/lib/csv.test.mjs   (from D:\whatsapp\frontend)
// Covers CSV formula-injection neutralization + no-regression on RFC-4180
// escaping. Exits non-zero on any failure so it works as a CI gate.

import assert from 'node:assert/strict';
import { csvCell, rowsToCsv, buildAnalyticsCsv } from './csv.js';

let passed = 0;
const check = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
};

console.log('csvCell — formula-injection neutralization');

// (a) values starting with a dangerous lead char get a single-quote prefix.
check('= is neutralized', () => {
  // Payload has single quotes (not double), no comma, no CRLF, so it is NOT
  // RFC-4180 quote-wrapped — just prefixed with a single quote to defang it.
  assert.equal(csvCell('=cmd|\'/c calc\'!A1'), `'=cmd|'/c calc'!A1`);
});
check('=HYPERLINK is neutralized', () => {
  assert.equal(csvCell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`);
});
check('+ is neutralized', () => {
  assert.equal(csvCell('+1+1'), `'+1+1`);
});
check('- is neutralized', () => {
  assert.equal(csvCell('-2+3'), `'-2+3`);
});
check('@ is neutralized', () => {
  assert.equal(csvCell('@SUM(A1)'), `'@SUM(A1)`);
});
check('leading TAB is neutralized', () => {
  // \t is not a comma/quote/CRLF, so no RFC-4180 wrapping — just the prefix.
  assert.equal(csvCell('\t=1'), `'\t=1`);
});
check('leading CR is neutralized (and \\r triggers quote-wrap)', () => {
  assert.equal(csvCell('\r=1'), `"'\r=1"`); // \r is in the escape set -> quote-wrapped
});

console.log('csvCell — no regression on legitimate values');

// (b) normal values are untouched; commas/quotes/newlines still escaped.
check('plain text unchanged', () => {
  assert.equal(csvCell('hello world'), 'hello world');
});
check('numeric-like string unchanged (no leading danger char)', () => {
  assert.equal(csvCell('42'), '42');
});
check('numbers pass through (5, 0)', () => {
  assert.equal(csvCell(5), '5');
  assert.equal(csvCell(0), '0');
});
check('null/undefined -> empty', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});
check('value with a comma is quote-wrapped', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
});
check('value with a quote is doubled + wrapped', () => {
  assert.equal(csvCell('she said "hi"'), '"she said ""hi"""');
});
check('value with a newline is quote-wrapped', () => {
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});
check('Hebrew text unchanged', () => {
  assert.equal(csvCell('שלום עולם'), 'שלום עולם');
});
// A hyphen mid-string is fine; only a LEADING hyphen is a formula risk. This
// asserts we do not over-escape internal hyphens.
check('internal hyphen unchanged', () => {
  assert.equal(csvCell('co-marketing'), 'co-marketing');
});

console.log('rowsToCsv / buildAnalyticsCsv — end-to-end injection through a real export field');

check('malicious WhatsApp messageText is neutralized in the full export', () => {
  const payload = '=cmd|\'/c calc\'!A1';
  const d = { questions: { mostCommonUnanswered: [payload] } };
  const csv = buildAnalyticsCsv(d);
  // The raw un-neutralized payload must NOT appear as a cell that begins with '='.
  // It must appear neutralized (prefixed with a single quote) somewhere in output.
  assert.ok(csv.includes(`'=cmd`), 'expected neutralized payload in export');
  // And there must be no line whose first data cell starts with a bare '=' from
  // this payload (i.e. no un-neutralized formula leaks through).
  const leaks = csv
    .split('\r\n')
    .filter((line) => line.startsWith('=cmd') || line.startsWith('"=cmd'));
  assert.equal(leaks.length, 0, 'no un-neutralized formula should reach the CSV');
});

check('rowsToCsv neutralizes across all columns uniformly', () => {
  const out = rowsToCsv(['h1', 'h2'], [['=BAD()', 'ok'], ['@BAD', '+alsoBad']]);
  const lines = out.split('\r\n');
  assert.equal(lines[1], `'=BAD(),ok`);
  assert.equal(lines[2], `'@BAD,'+alsoBad`);
});

console.log(`\nAll ${passed} assertions passed.`);
