// Behavioral + timing verification for BUG-WA-ANALYTICS-SLOW-QUESTIONS.
// Boots the REAL Express app, hits the REAL GET /api/analytics/questions against
// the REAL DB, times it, and asserts the response is CORRECT (unchanged shape +
// _distinctIntentConversations equals the pre-fix groupBy(['conversationId']).length).
// Run: node scripts/analytics-questions-perf.test.mjs
import 'dotenv/config';
import http from 'node:http';
import prisma from '../src/lib/prisma.js';
import app from '../src/app.js';
import { signToken } from '../src/middleware/auth.js';
import { EVENTS } from '../src/services/analytics.js';

const tenantId = 'cmrusmt0d0002as6487t8x48o'; // the seeded/dev tenant that HAS analytics data

function assert(c, m) { if (!c) throw new Error('ASSERT FAILED: ' + m); console.log('  ✓ ' + m); }

const server = http.createServer(app);
await new Promise((r) => server.listen(0, r));
const { port } = server.address();
const token = signToken({ sub: 'perftest-admin', role: 'admin', tenantId });

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        resolve({ ms: Date.now() - t, json: JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let failed = false;
try {
  // Ground truth: the OLD byIntent computation (groupBy then .length).
  const oldByIntent = await prisma.analyticsEvent.groupBy({
    by: ['conversationId'],
    where: { tenantId, eventName: EVENTS.INTENT_DETECTED },
  });
  const expectedDistinct = oldByIntent.filter((g) => g.conversationId !== null).length;

  // Warm the pool, then time 3 real HTTP calls.
  await apiGet('/api/analytics/questions');
  const times = [];
  let last;
  for (let i = 0; i < 3; i++) { last = await apiGet('/api/analytics/questions'); times.push(last.ms); }
  console.log(`\n⏱  /api/analytics/questions HTTP timings (ms): ${times.join(', ')}  (avg ${Math.round(times.reduce((a,b)=>a+b,0)/times.length)}ms)`);

  const j = last.json;
  console.log('\nresponse keys:', Object.keys(j).join(', '));
  assert(Array.isArray(j.customersByIntent), 'customersByIntent is an array');
  assert(Array.isArray(j.mostCommonUnanswered), 'mostCommonUnanswered is an array');
  assert(Array.isArray(j.dropOffByQuestion), 'dropOffByQuestion is an array');
  assert(typeof j._distinctIntentConversations === 'number', '_distinctIntentConversations is a number');
  assert(j._distinctIntentConversations === expectedDistinct,
    `_distinctIntentConversations (${j._distinctIntentConversations}) equals the old groupBy(['conversationId']).length (${expectedDistinct})`);
  assert(Math.max(...times) < 8000, `slowest response < 8s (was ~19s pre-fix) — got ${Math.max(...times)}ms`);
  console.log('\n✅ ALL ASSERTIONS PASSED');
} catch (e) {
  failed = true;
  console.error('\n❌ TEST FAILED:', e.message);
} finally {
  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
}
process.exit(failed ? 1 : 0);
