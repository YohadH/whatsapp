// Regression test for the outbound-webhook SSRF-via-redirect fix
// (board task whatsapp-agent-fix-outbound-webhook-ssrf-redirect).
//
// THE BUG (found by bug-reviewer, HIGH severity): services/outboundWebhook.js
// validates a tenant's webhook target with isSafeWebhookUrl() (rejects
// localhost / private / link-local / CGNAT / metadata IP ranges) at save-time
// AND at delivery-time — but postOnce()'s fetch() never passed redirect:'manual'.
// Node 20's undici global fetch follows 3xx redirects transparently with NO
// re-validation of the redirect TARGET. So a tenant registers a public HTTPS
// webhook (passes the gate trivially), then has that server answer
// `302 Location: http://127.0.0.1:<port>/internal` (or a cloud-metadata URL) —
// the platform's outbound delivery follows it and hits the internal target
// (blind SSRF: internal port/service scanning + POST-based internal endpoints).
//
// THE FIX: postOnce() now passes redirect:'manual' and treats any 3xx as a
// FAILED delivery ({ ok:false, status, error:'redirect_not_followed' }) — it
// never follows the redirect.
//
// This proves it against the REAL deliverToUrl() -> postOnce() code path (no
// logic duplication). Setup:
//   (1) INTERNAL target on 127.0.0.1 — records every hit; must NEVER be hit.
//   (2) REDIRECT server on 127.0.0.1 — the tenant's "public" webhook; answers
//       302 Location: http://127.0.0.1:<internal-port>/internal (SSRF payload).
// To drive the REAL postOnce redirect handling through the REAL deliverToUrl
// gate, we stub dns.lookup so the fake public host resolves to a public IP (so
// isSafeWebhookUrl passes), and wrap global fetch with a thin pass-through that
// RECORDS the options postOnce passes and routes the https URL to the local http
// redirect server — so the module's own fetch call, its redirect:'manual'
// option, and its 3xx-handling branch all execute for real.
//
// A CONTROL leg proves the OLD behavior (default fetch, no redirect:manual)
// WOULD have followed the 302 into the internal target — i.e. the test is
// discriminating (it would fail against the pre-fix code).
//
// No DB needed. Run:  node scripts/outbound-webhook-ssrf-redirect.test.mjs  (from backend/)

import http from 'node:http';
import dns from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log(`  PASS: ${msg}`); else { console.error(`  FAIL: ${msg}`); failures++; } };

// ---- local servers -------------------------------------------------------
let internalHits = 0;
const internal = http.createServer((req, res) => {
  internalHits++;
  console.log(`  [INTERNAL] HIT ${req.method} ${req.url}  <-- SSRF reached internal service!`);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('internal-secret');
});
let redirectHits = 0;
const redirect = http.createServer((req, res) => {
  redirectHits++;
  const loc = `http://127.0.0.1:${internal.address().port}/internal`;
  console.log(`  [REDIRECT] answering 302 -> ${loc}`);
  res.writeHead(302, { Location: loc });
  res.end();
});
await new Promise((r) => internal.listen(0, '127.0.0.1', r));
await new Promise((r) => redirect.listen(0, '127.0.0.1', r));
const internalPort = internal.address().port;
const redirectPort = redirect.address().port;
console.log(`Internal target  127.0.0.1:${internalPort}`);
console.log(`Redirect server  127.0.0.1:${redirectPort}`);

// The "public" webhook URL a tenant registered.
const PUBLIC_HOST = 'evil-webhook.example.com';
const TENANT_URL = `https://${PUBLIC_HOST}/hook`;

// ---- stub dns.lookup so PUBLIC_HOST resolves to a public IP (gate passes) ----
const realLookup = dns.lookup;
dns.lookup = async function (host, opts) {
  if (host && host.toLowerCase() === PUBLIC_HOST) {
    return opts && opts.all ? [{ address: '93.184.216.34', family: 4 }] : { address: '93.184.216.34', family: 4 };
  }
  return realLookup.call(dns, host, opts);
};

// ---- stub global fetch: record options, route to the local redirect server ----
const realFetch = globalThis.fetch;
let observedRedirectOpt = '(never called)';
globalThis.fetch = function (url, opts = {}) {
  observedRedirectOpt = Object.prototype.hasOwnProperty.call(opts, 'redirect') ? opts.redirect : '(unset)';
  const u = new URL(url);
  if (u.hostname === PUBLIC_HOST) {
    const local = `http://127.0.0.1:${redirectPort}${u.pathname}`;
    return realFetch(local, opts); // real fetch, real options (incl. redirect), real http
  }
  return realFetch(url, opts);
};

// ---- import the REAL module AFTER the stubs are in place ----
const modUrl = pathToFileURL(path.resolve(import.meta.dirname, '../src/services/outboundWebhook.js')).href;
const { deliverToUrl } = await import(modUrl);

// ==== Test: real deliverToUrl() against a public webhook that 302s to 127.0.0.1 ====
console.log('\n--- Test: real deliverToUrl() vs. a public webhook that 302s to 127.0.0.1 ---');
const result = await deliverToUrl({ url: TENANT_URL, payload: { event: 'lead.created' } });
console.log('  deliverToUrl result :', JSON.stringify(result));
console.log('  redirect option postOnce passed to fetch:', observedRedirectOpt);
console.log('  redirect server hits:', redirectHits, ' internal target hits:', internalHits);

ok(observedRedirectOpt === 'manual', 'postOnce passed redirect:"manual" to fetch');
ok(internalHits === 0, 'internal target was NEVER reached (SSRF blocked)');
ok(result.ok === false, 'delivery reported as FAILED (ok=false)');
ok(result.error === 'redirect_not_followed', 'failure reason is redirect_not_followed');
ok(redirectHits >= 1, 'redirect server was actually hit (test setup valid)');

// ==== Control: prove the OLD code path (default redirect follow) WOULD SSRF ====
console.log('\n--- Control: without redirect:manual, undici FOLLOWS the 302 into 127.0.0.1 ---');
const beforeCtl = internalHits;
const ctl = await realFetch(`http://127.0.0.1:${redirectPort}/hook`, { method: 'POST', body: '{}' });
console.log(`  control status=${ctl.status} redirected=${ctl.redirected} internalHitsDelta=${internalHits - beforeCtl}`);
ok(internalHits - beforeCtl === 1 && ctl.redirected,
  'CONTROL: default fetch follows the 302 and hits internal (proves the fix is load-bearing)');

console.log(`\nRESULT: ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
internal.close(); redirect.close();
process.exit(failures === 0 ? 0 : 1);
