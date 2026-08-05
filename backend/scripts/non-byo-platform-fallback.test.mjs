#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Regression test for board task whatsapp-agent-bug-non-byo-tenants-lose-all.
//
// THE BUG (commit e38d77c "central local-Claude pipeline as the primary engine"):
//   conversationEngine.js hardcoded `allowAI = aiOn && !!byoKey`, which made the
//   platform-OpenAI reply path UNREACHABLE for any tenant WITHOUT its own BYO key.
//   The only remaining AI path for a non-BYO tenant became the new local-Claude
//   pipeline, which is null unless PlatformConfig.replyEnabled=true — and migration
//   20 creates that row with replyEnabled DEFAULT false. Result: every existing
//   non-BYO tenant with aiEnabled:true silently degraded from real AI replies to
//   rules-only replies (a fixed Hebrew "נציג יחזור אליך" handoff), with no alert.
//
// THE FIX: restore the platform-OpenAI path as the fallback BELOW the pipeline
//   (order: BYO key → local-Claude pipeline → platform OpenAI → rules-only), metered
//   uniformly (consumeDailyFreeReply → spendOneCredit) so no double-charge.
//
// METHODOLOGY (drives the REAL engine — AP-T8/AP-T12/AP-T14):
//   Imports and calls the real handleIncomingMessage() against the live DB on
//   throwaway tenants. The ONLY mocked boundary is services/llm.js (via the ESM
//   loader): aiConfigured() simulates "a platform OpenAI key is present" and
//   chatJson() returns a DISTINCTIVE reply string (STUB_AI_REPLY). Everything else —
//   the BYO/pipeline/platform priority chain, the credit/quota meter, prisma — is
//   real. The rule-based path can NEVER produce STUB_AI_REPLY, so seeing it in the
//   reply proves the platform-OpenAI path ran. Reverting the fix makes the non-BYO
//   reply fall to rules → STUB_AI_REPLY absent → this test FAILS.
//
//   PlatformConfig.replyEnabled is forced FALSE for the duration (pipeline off) so we
//   isolate the platform-OpenAI fallback, then restored.
//
//   No WhatsApp is sent: throwaway tenants have no WA creds → sends self-simulate.
//
// Run from backend/ WITH the loader:
//   node --import ./scripts/register-non-byo-fallback-loader.mjs ./scripts/non-byo-platform-fallback.test.mjs
// Exit 0 = non-BYO tenants get real AI again + BYO unaffected + no double-charge.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

const prisma = (await import('../src/lib/prisma.js')).default;
const { handleIncomingMessage } = await import('../src/services/conversationEngine.js');

const STUB_AI_REPLY = (globalThis.__STUB_AI_REPLY = globalThis.__STUB_AI_REPLY || 'PLATFORM_OPENAI_STUB_REPLY_✓');
const LLM_CALLS = (globalThis.__LLM_CALLS = globalThis.__LLM_CALLS || { chatJson: 0, byUsed: [] });

// The fixed rule-based reply the OLD (buggy) path would send for a free-form message
// with no flow match — copied from aiAgent.ruleBasedResponse() step 4. Used to prove
// the reply is NOT the rules fallback.
const RULES_FALLBACK_REPLY = 'תודה על פנייתך! 🙂 קיבלתי את ההודעה. נציג שלנו יחזור אליך עם המידע המבוקש בהקדם.';

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `  (${detail})` : ''}`);
}

const created = { tenants: [] };

// A throwaway tenant. byo=false → non-BYO (relies on platform/pipeline). Credits +
// aiEnabled default so the free daily quota grants the first reply. No WA creds → sends
// self-simulate. Explicit select (AP-T71): Tenant.waPin is schema-only (drift), so an
// implicit SELECT * RETURNING would P2022.
async function makeTenant(tag, { byo = false } = {}) {
  const stamp = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = {
    name: `nbfb-${stamp}`,
    slug: `nbfb-${stamp}`,
    monthlyMessageLimit: 100, // has credits (also has free daily quota)
    creditsUsedThisPeriod: 0,
    purchasedCredits: 0,
    aiEnabled: true,
  };
  if (byo) {
    data.aiProvider = 'openai';
    data.aiApiKeyEnc = 'stub-enc-key'; // presence is all the engine checks for BYO
  }
  const tenant = await prisma.tenant.create({
    data,
    select: {
      id: true, name: true, slug: true,
      monthlyMessageLimit: true, creditsUsedThisPeriod: true, purchasedCredits: true,
      aiEnabled: true, aiProvider: true, aiApiKeyEnc: true,
      aiDailyDate: true, aiDailyCount: true, lowCreditNotifiedAt: true, timezone: true,
    },
  });
  created.tenants.push(tenant.id);
  const phone = `+9725${Math.floor(Math.random() * 1e7)}`;
  await prisma.customer.create({ data: { tenantId: tenant.id, name: 'Tester', phone }, select: { id: true } });
  return { tenant, phone };
}

// Force PlatformConfig.replyEnabled (and optionally replyUrl) so the pipeline is
// DETERMINISTICALLY off / on-reachable / on-unreachable — independent of whatever the
// live singleton row already holds. `url === undefined` leaves replyUrl untouched;
// `url === null` clears it; a string sets it. Always busts the 30s pipeline cache so
// this run sees the new value.
//
// IMPORTANT (why url matters): getPlatformPipeline() returns a usable pipeline ONLY when
// BOTH replyEnabled AND replyUrl are set. On the live DB the singleton already has a REAL
// replyUrl (the owner's local-Claude Cloudflare tunnel), so merely flipping replyEnabled
// true is NOT "pipeline unreachable" — it makes the pipeline fully REACHABLE and it answers,
// so the platform-OpenAI fallback (which fires only when the reply is still rules) never
// runs. To isolate the fallback, CASE4 must set replyEnabled=true with a replyUrl that is
// SSRF-safe (passes isSafeWebhookUrl: public HTTPS host) but genuinely UNREACHABLE, so
// generateViaProvider() POSTs, fails, returns null → the reply stays rules → fallback fires.
async function setPipeline({ enabled, url } = {}) {
  const update = {};
  if (enabled !== undefined) update.replyEnabled = enabled;
  if (url !== undefined) update.replyUrl = url;
  await prisma.platformConfig.upsert({
    where: { id: 'singleton' },
    update,
    create: { id: 'singleton', replyEnabled: enabled ?? false, replyUrl: url ?? null },
  }).catch((e) => console.log('platformConfig upsert warn:', e.message));
  // The pipeline module caches for 30s — bust it so this run sees the new value.
  const { invalidatePlatformPipelineCache } = await import('../src/lib/platformPipeline.js');
  invalidatePlatformPipelineCache();
}

async function main() {
  // Snapshot the ENTIRE original singleton (replyEnabled AND replyUrl) so we can restore it
  // byte-for-byte in finally — the live row holds a real production tunnel URL we must never
  // clobber. `prevExisted=false` ⇒ there was no singleton before this run.
  let prevExisted = false;
  let prevEnabled = false;
  let prevUrl = null;
  try {
    check('setup — llm stub registered (STUB_AI_REPLY observable)', typeof STUB_AI_REPLY === 'string' && LLM_CALLS && typeof LLM_CALLS.chatJson === 'number');

    // Remember + disable the pipeline so we isolate the platform-OpenAI fallback.
    const prevRow = await prisma.platformConfig.findUnique({ where: { id: 'singleton' } }).catch(() => null);
    if (prevRow) { prevExisted = true; prevEnabled = prevRow.replyEnabled; prevUrl = prevRow.replyUrl ?? null; }
    // Pipeline OFF for CASE1-3 (replyEnabled=false ⇒ getPlatformPipeline returns null regardless
    // of the live replyUrl), so those cases isolate the platform-OpenAI fallback cleanly.
    await setPipeline({ enabled: false });

    // ── CASE 1: non-BYO tenant, pipeline OFF → platform-OpenAI fallback MUST fire ──
    {
      const { tenant, phone } = await makeTenant('nonbyo');
      const llmBefore = LLM_CALLS.chatJson;
      const res = await handleIncomingMessage({
        tenant, phone, text: 'כמה עולה טיפול פנים?', name: 'Tester', waMessageId: null,
      });
      const reply = res?.agentResponse?.reply || '';
      check('CASE1 — reply is the platform-OpenAI text, NOT rules fallback',
        reply === STUB_AI_REPLY && reply !== RULES_FALLBACK_REPLY,
        `reply=${JSON.stringify(reply).slice(0, 60)}`);
      check('CASE1 — the platform-OpenAI path actually ran (chatJson called on platform source)',
        LLM_CALLS.chatJson === llmBefore + 1 && LLM_CALLS.byUsed.at(-1) === 'platform',
        `chatJson delta=${LLM_CALLS.chatJson - llmBefore} lastSource=${LLM_CALLS.byUsed.at(-1)}`);
      check('CASE1 — a reply was actually sent (replySent)', res?.replySent === true, `replySent=${res?.replySent}`);

      // Metering: exactly ONE free daily slot consumed (aiDailyCount 0→1), no credit spent
      // (free slot available), so it is NOT double-metered.
      const row = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { aiDailyCount: true, creditsUsedThisPeriod: true, purchasedCredits: true },
      });
      check('CASE1 — metered exactly once via the FREE daily quota (aiDailyCount=1, no credit spent)',
        row.aiDailyCount === 1 && row.creditsUsedThisPeriod === 0 && row.purchasedCredits === 0,
        `aiDailyCount=${row.aiDailyCount} used=${row.creditsUsedThisPeriod} purchased=${row.purchasedCredits}`);
    }

    // ── CASE 2: non-BYO, pipeline OFF, OUT of quota AND credits → NO OpenAI on our bill,
    //    falls to rules/handoff (cost-safety preserved). ───────────────────────────────
    {
      const { tenant, phone } = await makeTenant('nocredit');
      // Exhaust: no monthly limit, no purchased credits, and daily quota already maxed.
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { monthlyMessageLimit: 0, purchasedCredits: 0, aiDailyDate: null, aiDailyCount: 0 },
      });
      // Reload the in-memory tenant so hasFreeQuotaToday reads the live counters. Simulate
      // "quota used up today" by setting today's date at the cap.
      const { israelDay, FREE_DAILY_AI_REPLIES } = await import('../src/lib/aiDailyQuota.js');
      await prisma.tenant.update({ where: { id: tenant.id }, data: { aiDailyDate: israelDay(), aiDailyCount: FREE_DAILY_AI_REPLIES } });
      const fresh = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: {
          id: true, name: true, slug: true, monthlyMessageLimit: true, creditsUsedThisPeriod: true,
          purchasedCredits: true, aiEnabled: true, aiProvider: true, aiApiKeyEnc: true,
          aiDailyDate: true, aiDailyCount: true, lowCreditNotifiedAt: true, timezone: true,
        },
      });
      const llmBefore = LLM_CALLS.chatJson;
      const res = await handleIncomingMessage({ tenant: fresh, phone, text: 'שאלה כללית', name: 'Tester', waMessageId: null });
      const reply = res?.agentResponse?.reply || '';
      check('CASE2 — out of quota+credits: platform OpenAI NOT called (no spend on our bill)',
        LLM_CALLS.chatJson === llmBefore, `chatJson delta=${LLM_CALLS.chatJson - llmBefore}`);
      check('CASE2 — degrades to rules/handoff (not a real AI reply)',
        reply !== STUB_AI_REPLY, `reply=${JSON.stringify(reply).slice(0, 50)}`);
    }

    // ── CASE 3: BYO tenant → answered on its OWN key (first block), never charged a
    //    platform credit, and the fallback does NOT fire (no double-answer). ──────────
    {
      const { tenant, phone } = await makeTenant('byo', { byo: true });
      const llmBefore = LLM_CALLS.chatJson;
      const res = await handleIncomingMessage({ tenant, phone, text: 'שאלה של לקוח BYO', name: 'Tester', waMessageId: null });
      const reply = res?.agentResponse?.reply || '';
      check('CASE3 — BYO tenant still gets a real AI reply', reply === STUB_AI_REPLY, `reply=${JSON.stringify(reply).slice(0, 40)}`);
      check('CASE3 — BYO answered by exactly ONE LLM call (no fallback double-call)',
        LLM_CALLS.chatJson === llmBefore + 1 && LLM_CALLS.byUsed.at(-1) === 'tenant',
        `chatJson delta=${LLM_CALLS.chatJson - llmBefore} lastSource=${LLM_CALLS.byUsed.at(-1)}`);
      const row = await prisma.tenant.findUnique({
        where: { id: tenant.id },
        select: { aiDailyCount: true, creditsUsedThisPeriod: true, purchasedCredits: true },
      });
      check('CASE3 — BYO tenant NOT metered (no free slot, no credit)',
        row.aiDailyCount === 0 && row.creditsUsedThisPeriod === 0 && row.purchasedCredits === 0,
        `aiDailyCount=${row.aiDailyCount} used=${row.creditsUsedThisPeriod} purchased=${row.purchasedCredits}`);
    }

    // ── CASE 4: non-BYO, pipeline ON but UNREACHABLE (replyEnabled=true + a valid-but-dead
    //    replyUrl) → the pipeline block runs first, POSTs, the POST fails, generateViaProvider
    //    returns null → the reply is still rules → the platform-OpenAI fallback catches it →
    //    real AI reply. This proves the fix ADDS a fallback below the pipeline, never removes
    //    the pipeline as primary.
    //
    //    We set an explicit unreachable URL rather than clearing it: on the live DB the
    //    singleton already holds a REAL, reachable tunnel URL, so just flipping replyEnabled=true
    //    would make the pipeline ANSWER (and the fallback would correctly NOT fire) — the old
    //    setup silently tested nothing. The URL below is public HTTPS (not localhost/private, so
    //    it is NOT an SSRF that could hit an internal host) but points at a non-resolving host,
    //    so getPlatformPipeline() returns a config yet generateViaProvider() can't get a usable
    //    reply (isSafeWebhookUrl rejects the unresolvable host → returns null; equally, a
    //    reachable-but-non-JSON endpoint would normalize to null). Either way the reply stays
    //    rules and the platform-OpenAI fallback fires — deterministically, regardless of the
    //    live row. (Verified: run logs "[replyProvider] rejected unsafe/non-HTTPS url".) ──
    {
      await setPipeline({ enabled: true, url: 'https://no-such-pipeline.example.com/reply' });
      const { tenant, phone } = await makeTenant('pipeon');
      const res = await handleIncomingMessage({ tenant, phone, text: 'שאלה', name: 'Tester', waMessageId: null });
      const reply = res?.agentResponse?.reply || '';
      check('CASE4 — pipeline enabled-but-unreachable still falls through to platform OpenAI',
        reply === STUB_AI_REPLY, `reply=${JSON.stringify(reply).slice(0, 40)}`);
      await setPipeline({ enabled: false });
    }
  } finally {
    // Restore the ORIGINAL singleton exactly — BOTH replyEnabled and replyUrl (the live row
    // holds a real production tunnel URL that CASE4 overwrote; we must put it back verbatim).
    // If there was no singleton before this run, leave the fields as we created them absent.
    if (prevExisted) await setPipeline({ enabled: prevEnabled, url: prevUrl }).catch(() => {});
    if (created.tenants.length) {
      await prisma.tenant.deleteMany({ where: { id: { in: created.tenants } } }).catch((e) => console.log('cleanup warn:', e.message));
      console.log(`cleaned up ${created.tenants.length} throwaway tenant(s)`);
    }
    await prisma.$disconnect();
  }

  console.log(failed === 0 ? '\nALL CASES PASSED' : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error('TEST ERROR:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
