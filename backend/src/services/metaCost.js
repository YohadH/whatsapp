import prisma from '../lib/prisma.js';
import config from '../config/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant Meta (WhatsApp) conversation-cost recorder (system-gap-analysis §2.7 + §4 /
// WA-DEV-META-COST).
//
// Meta bills WhatsApp Business conversations by PRICING CATEGORY. The category rides on
// the inbound webhook's `statuses[]` events (parsed by services/whatsapp.js
// #parseStatusEvents). This module turns each billable status event into a MetaCostEntry
// row — the COST side of the margin equation, parallel to CreditTransaction (revenue).
//
// COST IS ESTIMATED from a CONFIG RATE CARD (config.metaPricing.ratesCents), which is a
// PLACEHOLDER (all 0, placeholder=true) until the owner drops in real Meta numbers. We
// never fabricate an authoritative Meta price: when placeholder is true the recorded cost
// is 0 and every row is flagged placeholder=true so the margin view can say "uncalibrated".
//
// ADDITIVE / NON-BLOCKING (AP-T8 wiring, but must never break the message flow): recording
// is best-effort. If the MetaCostEntry table is not yet migrated live (P2021/P2022/42P01),
// or any DB error occurs, we log-and-degrade to a no-op — the credit-charging logic and the
// customer's inbound message flow are completely unaffected.
// ─────────────────────────────────────────────────────────────────────────────

// Normalize whatever category Meta sends onto the current Meta pricing set the rate
// card is keyed by. Meta has changed these labels over time:
//   - current:  marketing | utility | authentication | service
//   - webhook/origin legacy: business_initiated | user_initiated | referral_conversion
// so map the legacy values onto the closest current bucket for rate lookup. `rawCategory`
// (stored separately) preserves exactly what Meta sent, so an Oct-2026 pricing-model change
// is auditable even after normalization.
export function normalizeCategory(raw) {
  const c = String(raw || '').toLowerCase().trim();
  if (!c) return 'unknown';
  if (['marketing', 'utility', 'authentication', 'service'].includes(c)) return c;
  // Legacy conversation-origin categories → current buckets.
  if (c === 'business_initiated') return 'utility'; // business-initiated ≈ utility/marketing template
  if (c === 'user_initiated') return 'service'; // user-initiated service window
  if (c === 'referral_conversion') return 'marketing'; // ad-referral → marketing
  return 'unknown';
}

// Estimate the Meta cost (in whole cents) for a normalized category from the config rate
// card. Returns { costEstimateCents, currency, placeholder }. When the rate card is a
// placeholder (owner hasn't filled real numbers) cost is 0 and placeholder=true.
export function estimateCostCents(normalizedCategory) {
  const rc = config.metaPricing || {};
  const rates = rc.ratesCents || {};
  const cents = Number.isFinite(rates[normalizedCategory]) ? rates[normalizedCategory] : (rates.unknown || 0);
  return {
    costEstimateCents: cents > 0 ? cents : 0,
    currency: rc.currency || 'USD',
    // A row is placeholder if the global flag is set OR this specific rate is still 0
    // (uncalibrated) — either way the margin view must not treat the number as real.
    placeholder: rc.placeholder !== false || !(cents > 0),
  };
}

// Postgres/Prisma "table or column not present" signals → the migration isn't applied
// live yet. Degrade to no-op rather than throwing into the webhook path.
function isMissingRelation(err) {
  const code = err?.code || err?.meta?.code;
  if (code === 'P2021' || code === 'P2022' || code === '42P01' || code === '42703') return true;
  return /relation .*does not exist|table .*does not exist|column .*does not exist/i.test(String(err?.message || ''));
}

// A duplicate MetaCostEntry — Meta redelivered the same status webhook (at-least-once
// semantics). Prisma raises P2002 on the @@unique([tenantId, waMessageId, category])
// guard; Postgres raises 23505 on the same constraint. We treat this as a benign SKIP:
// the cost was already recorded on the first delivery, so re-recording would double-count.
function isUniqueViolation(err) {
  const code = err?.code || err?.meta?.code;
  return code === 'P2002' || code === '23505';
}

/**
 * Record Meta conversation-cost entries for a tenant from parsed status events.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {Array}  args.events   — from parseStatusEvents(...).events
 * @param {(metaConversationId:string)=>Promise<string|null>} [args.resolveConversationId]
 *        optional mapper from Meta's conversation id → our Conversation.id.
 * @returns {Promise<{recorded:number, skipped:number, degraded?:boolean}>}
 *
 * Best-effort: never throws. Idempotent against Meta's at-least-once webhook
 * redelivery: a duplicate (tenantId, waMessageId, category) is rejected by the DB
 * @@unique guard and swallowed here as a benign SKIP (isUniqueViolation), so a
 * redelivered status event NEVER creates a second cost row / overstates Meta cost in
 * the margin view. A genuinely different billable category for the same waMessageId
 * still records a distinct row (the category is part of the key). Events with a null
 * waMessageId are not deduped (Postgres treats NULLs as distinct — there is nothing to
 * dedupe on). We record what Meta reports, flagged, so nothing is invented.
 */
export async function recordMetaCostEvents({ tenantId, events, resolveConversationId } = {}) {
  if (!tenantId || !Array.isArray(events) || events.length === 0) return { recorded: 0, skipped: 0 };
  let recorded = 0;
  let skipped = 0;
  for (const ev of events) {
    // Skip non-billable events (Meta marks free-tier / free-entry-point conversations
    // billable=false). We still could record them at cost 0, but a non-billable event
    // is not a cost — omit it to keep the ledger a true cost ledger.
    if (ev.billable === false) {
      skipped++;
      continue;
    }
    const normalized = normalizeCategory(ev.category);
    const { costEstimateCents, currency, placeholder } = estimateCostCents(normalized);
    let conversationId = null;
    if (resolveConversationId && ev.metaConversationId) {
      try {
        conversationId = await resolveConversationId(ev.metaConversationId);
      } catch {
        conversationId = null;
      }
    }
    try {
      await prisma.metaCostEntry.create({
        data: {
          tenantId,
          conversationId,
          metaConversationId: ev.metaConversationId || null,
          waMessageId: ev.waMessageId || null,
          category: normalized,
          rawCategory: ev.category ? String(ev.category) : null,
          pricingModel: ev.pricingModel || null,
          billable: ev.billable !== false,
          costEstimateCents,
          currency,
          placeholder,
        },
      });
      recorded++;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Meta redelivered this exact status event (at-least-once) — the cost row
        // already exists. Skip silently so we never double-count. This mirrors the
        // inbound-message idempotency guard in conversationEngine.js (which pre-checks
        // Message.tenantId_waMessageId); here we let the DB unique constraint be the
        // arbiter and swallow the collision — no throw, no effect on message/credit flow.
        skipped++;
        continue;
      }
      if (isMissingRelation(err)) {
        // Table not migrated live yet → degrade gracefully, do not break message handling.
        console.warn('[metaCost] MetaCostEntry table not migrated live — skipping cost recording');
        return { recorded, skipped, degraded: true };
      }
      // Any other DB error is also best-effort here — log and move on.
      console.error('[metaCost] failed to record cost entry:', err.message);
      skipped++;
    }
  }
  return { recorded, skipped };
}

// Convenience: parse + record in one call from a raw webhook body, given the routed
// tenant. Returns the recorder result (or a zero result when there is no pricing data).
export async function recordMetaCostFromStatuses({ tenantId, statusParse, resolveConversationId } = {}) {
  if (!tenantId || !statusParse || !Array.isArray(statusParse.events) || statusParse.events.length === 0) {
    return { recorded: 0, skipped: 0 };
  }
  return recordMetaCostEvents({ tenantId, events: statusParse.events, resolveConversationId });
}
