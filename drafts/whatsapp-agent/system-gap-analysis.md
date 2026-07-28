# WhatsApp AI Agent — Product/Eng Gap Analysis vs Locked HeyIL Scope + Pricing

Requested by Yohad, 2026-07-28. Scope: `D:\whatsapp` (backend + frontend +
CREDITS_DESIGN.md + MULTI_TENANT.md + PROGRESS.md), HEAD `9b68f89` (verified
clean working tree). Read-only review — no production code touched.

**Locked scope (day-one core, no external integration):** Hebrew AI reply +
lead capture (name/phone/request) + mini-CRM (log/tag conversations) + handoff
to owner with context + simple owner dashboard.
**Paid-later add-ons (excluded from day-one):** calendar sync/booking,
external CRM, multi-channel (email/web/messenger), catalog/commerce.
**Locked billing model:** ₪490/mo incl. 500 *handled conversations*; 1 credit
= 1 handled conversation (24h window, unlimited messages inside it); ₪990
setup; top-up packs; all-inclusive price (incl. Meta fees); multi-tenant.

---

## 1. Current state — what the system actually does today

**Core scope — mostly built, matches the locked feature list well:**
- **Hebrew AI reply**: `services/conversationEngine.js` + `services/aiAgent.js`, OpenAI
  `gpt-4o-mini` (per `.env.example` / decision-log AP-T54, **still not owner-ratified**
  as of 2026-07-16), flow-driven with a knowledge base fallback.
- **Lead capture (name/phone/request)**: `Customer` model (`name`, `phone`, `email`),
  `FlowQuestion`/`CustomerAnswer` capture structured answers per flow; `Conversation.intent`
  captures the "request." Matches scope.
- **Mini-CRM (log/tag conversations)**: `Conversation` has `tags Json`, `notes String`,
  `leadScore Int`, `assignedTo`; `Customer` has `tags Json`. Real, working data model —
  `Conversations.jsx` / `ConversationDetail.jsx` expose it in the admin UI.
- **Handoff to owner**: `Conversation.needsHuman` boolean, set by the AI
  (`agentResponse.needs_human`) and surfaced in the dashboard/conversation list.
  **Gap** — see §2.1: this is a passive DB flag only, not an active notification.
- **Simple owner dashboard**: `Dashboard.jsx` — total/open/completed conversations,
  waiting-for-human count, leads, conversion %, avg response time, 14-day chart. Clean,
  in-scope, no over-build.
- **No premature integrations found**: grepped the whole backend for
  calendar/CRM/catalog/commerce/multi-channel integrations — **zero matches**. The
  paid-later boundary is currently respected in code, which is good discipline.

**Multi-tenancy — solid, ahead of the MVP need:**
`MULTI_TENANT.md` + `middleware/tenant.js` + per-model `tenantId` scoping,
`findFirst({id, tenantId})` / `updateMany({id, tenantId})` pattern (no IDOR),
per-tenant encrypted WhatsApp credentials, isolation test suite (`mt-isolation`).
This is real, tested infrastructure — not a gap, a strength — though it is
more machinery than a single-founder DFY rollout strictly needs on day one.

**Billing/credits — implemented, but for the WRONG unit (see §2 — this is the
headline gap):**
`lib/credits.js`, `routes/credits.js`, `CreditPurchase`/`CreditTransaction` models,
atomic race-safe charge logic (`chargeAiCredit()`), low-credit nudge dedup
(`markLowCreditNudge()`) — well-engineered plumbing. But it meters **1 credit = 1
AI-answered message** (`CREDITS_DESIGN.md` §1, `lib/credits.js:3`, `lib/creditPacks.js:2`),
not 1 credit = 1 handled *conversation* in a 24h window as the locked pricing model
requires.

**Payment collection — not wired (correctly deferred, but 0%):**
`services/payments.js` is a stub — `createCheckout()` only implements `'manual'` mode
(super-admin marks a purchase paid by hand); PayPlus/Meshulam/Cardcom/Stripe are
commented-out placeholders. No live payment path exists at all today.

---

## 2. Gaps vs the locked scope + billing model

### 2.1 Billing unit mismatch — credits meter messages, not conversations (P0)
The entire credits system (schema, deduction logic, packs, dashboard copy) is built
around **1 credit = 1 AI-reply message**. The locked model is **1 credit = 1 handled
conversation, 24h window, unlimited messages inside it**. These are not close — a
single real conversation (greeting → 2-3 clarifying Qs → answer → follow-up) can
burn 4-6 message-credits under the current meter but should cost exactly 1 under the
locked model. Shipping as-is would either (a) badly overcharge tenants relative to the
promised "500 handled conversations for ₪490," or (b) if repriced to compensate, make
the ₪490/500 anchor meaningless. **This is a rebuild of the metering unit, not a tweak.**

### 2.2 No conversation-window concept exists anywhere in the data model (P0, follows from 2.1)
There is no "billing window" on `Conversation` — no `windowStartedAt`/`windowExpiresAt`,
no link between a WhatsApp 24h service-window (which is also Meta's own conversation-
pricing unit) and a credit charge. `broadcastRunner.js`'s `sentInLast24h()` is a
**rate-limit** cap (business-initiated sends/day), unrelated to conversation billing.
Building 2.1 requires this concept from scratch: open-a-window → charge-once →
free-messages-until-window-expires → new inbound after expiry opens (and charges) a
new window.

### 2.3 No plan/pack numbers match the locked pricing (P1)
`lib/plans.js` has `trial/starter/pro` (500/5,000/50,000 message-credits) — no plan
priced ₪490 or named for HeyIL; `lib/creditPacks.js` has arbitrary example prices
(₪59/1,000, ₪249/5,000, ₪799/20,000) never ratified against real numbers. The
₪990 setup fee has no representation in code, which is fine (it's a one-time service
fee, sold outside the app) — but it should be explicitly noted as intentionally
out-of-schema so nobody later assumes it's missing.

### 2.4 Handoff-to-owner is a passive flag, not a notification (P1)
`needsHuman` is set on `Conversation` and shown in the dashboard/list — but nothing
pushes it to the owner. Grepped the whole backend for any outbound alert channel
(email/SMS/WhatsApp-to-owner/push) — **none exists** (no nodemailer, no Twilio, no
web push, no "send WhatsApp message to admin's own number"). A DFY small-business
owner who isn't staring at the dashboard will not see a handoff until they happen to
check. The locked scope says "handoff **with context**" — the context (conversation
history) is there once opened, but the *handoff itself* doesn't reach the owner
proactively. Cheapest real fix: have the bot WhatsApp the owner's own number (it
already has WhatsApp send capability) when `needsHuman` flips true.

### 2.5 No live payment collection at all (P1, expected-but-must-be-tracked)
`services/payments.js` is 100% stub (`'manual'` only). This is reasonable to defer
per `CREDITS_DESIGN.md`'s own phased build plan (Phase 3), but it means **today**
there is no way for a real tenant to actually pay for a top-up pack or the monthly
₪490 without a human manually flipping DB rows. Fine for a hand-held pilot tenant;
not fine to scale past 1-2 tenants.

### 2.6 AI backend + credit design are still un-ratified decisions (P2, process gap)
Two decisions are sitting open in `decisions/decision-log.md` /
`tasks/whatsapp-agent.md`: (a) OpenAI `gpt-4o-mini` as the reply engine (open since
2026-07-16), (b) the whole credit-unit/out-of-credits/payment-provider/pack-pricing
set (flagged 2026-07-27, "should be ratified before Phase 3"). §2.1-2.3 above should
be folded into re-opening (b) rather than treated as a separate decision — the unit
mismatch changes the answer to "credit unit" from what `CREDITS_DESIGN.md` currently
recommends.

### 2.7 Multi-tenant billing has no per-tenant Meta-cost visibility (P2, ties to §4 risk)
`MULTI_TENANT.md` documents credential isolation well, but there is no tracking of
Meta's own per-conversation/per-message charges per tenant anywhere in the codebase
(grepped for conversation "pricing_category"/"business_initiated" — the only 24h
concept found is the unrelated broadcast rate-cap, see §2.2). An "all-inclusive
price (incl. Meta fees)" promise cannot be verified or protected without this — you
are currently pricing blind to your own Meta cost per tenant.

---

## 3. Prioritized improvement plan

| # | Item | Owner | Pri | Why | Testable / done-when |
|---|---|---|---|---|---|
| 1 | Redesign credit unit: 1 credit = 1 handled conversation (24h window). Add `windowStartedAt`/`windowExpiresAt` (or equivalent) to `Conversation`; charge on first inbound message of a new window, not per AI reply; all messages inside an open window are free. Update `lib/credits.js`, `CREDITS_DESIGN.md`, `lib/creditPacks.js` accordingly. | developer | P0 | Current meter (§2.1/§2.2) contradicts the locked pricing model outright — this is the single most important fix before any tenant is billed for real. | A conversation with 5 back-and-forth AI replies inside one 24h window charges exactly 1 credit; a new inbound after the window expires opens+charges a new one. Unit test + a live simulator run. |
| 2 | Reprice plans/packs to the locked numbers: a real "₪490/mo = 500 conversations" plan in `lib/plans.js` (rename/add, don't just repurpose `trial`), and get real pack prices from Yohad for `lib/creditPacks.js` (currently placeholder ₪59/249/799). | product-manager → owner decision, then developer | P0 | Ships the actual commercial offer, not a placeholder one. | `lib/plans.js` has a plan literally priced/labeled to the ₪490/500 offer; `lib/creditPacks.js` prices are owner-approved, not example numbers. |
| 3 | Active owner handoff notification: when `needsHuman` flips true, send the owner a WhatsApp message (own number, already have send capability) with a short context summary (customer name/phone, last message, link to the conversation). | developer | P1 | §2.4 — a DB flag nobody sees is not a handoff. This is the cheapest, most on-brand fix (no new channel/vendor needed). | Trigger a `needs_human` conversation in a test tenant; confirm the owner's WhatsApp receives a message within seconds, with customer identity + a working link. |
| 4 | Ratify the credit-system decision as a single package (unit, out-of-credits behavior, payment provider, pack pricing) — supersede the 2026-07-27 open item with the corrected unit from item 1. | product-manager (facilitate) → owner | P1 | §2.6 — multiple dependent code changes are blocked on this being a real decision, not an assumption baked into shipped code. | `decisions/decision-log.md` has a dated, owner-approved entry naming all four sub-decisions explicitly, including "1 credit = 1 conversation, 24h window." |
| 5 | Wire ONE real Israeli payment path (or Stripe, if Israel entity/paperwork isn't ready) for top-up + the ₪490 monthly, even manual-trigger-to-real-charge minimum viable — replace the 100%-stub `services/payments.js`. | developer | P1 | §2.5 — cannot charge a real second/third tenant without this; fine to stay manual for the pilot tenant only. | A test top-up purchase completes via a real gateway checkout + webhook, `CreditPurchase.status` flips to `paid` automatically (not by hand), credits land in `purchasedCredits`. |
| 6 | Add per-tenant Meta conversation-cost tracking (pricing category from the webhook payload / Meta's conversation analytics API) alongside the internal credit ledger, so real margin (price charged vs Meta cost + OpenAI cost) is visible per tenant. | developer | P2 | §2.7 and the Oct-2026 Meta pricing-change risk (§4) — you can't protect an "all-inclusive" promise you can't measure. | Super-admin margin view (already speced in `CREDITS_DESIGN.md` §6) shows Meta cost, not just OpenAI cost, per tenant per month. |
| 7 | Decide + log explicitly that the ₪990 setup fee is intentionally out-of-schema (one-time service fee, not a metered/app concept) so it isn't later "discovered missing." | product-manager | P3 | Small, but §2.3 flagged it as a real ambiguity worth closing on paper. | One line in `decisions/decision-log.md` or `CREDITS_DESIGN.md` noting the setup fee is handled outside the app. |

Items 1-3 are the ship-blockers before onboarding a second paying tenant on the
locked model; item 2 needs an owner number (not just an engineering task); items
4-7 are sequencing/process + hardening.

---

## 4. Risks

**Credit measurement (P0 risk).** Today's live code charges per AI message, not per
conversation — if a tenant went live on the current meter believing they'd bought
"500 conversations," they would burn through their monthly allotment 4-6x faster
than promised the moment a customer asks more than one follow-up question. This is
the most urgent risk in this whole review; it is a promise-vs-code mismatch, not a
future concern.

**Multi-tenant billing (P1 risk).** The isolation/security side of multi-tenancy is
solid (tested, IDOR-safe). The *billing* side is not: no live payment collection
(§2.5), no per-tenant real-cost visibility (§2.7), and plan/pack pricing is still
placeholder (§2.3). Onboarding tenant #2 today means either hand-managing their
billing manually forever, or shipping items 1/2/5 first. One pilot tenant is
low-risk; scaling past that on current code is not.

**Meta cost changes from 2026-10 (P2 risk, time-boxed).** The system has no
mechanism (§2.7) to detect or absorb a Meta pricing-model change — if Meta's
per-conversation/per-message cost structure shifts in October 2026 as anticipated,
there is currently no per-tenant cost telemetry that would surface the impact on
margin before it's already eaten into revenue. Item 6 is the direct mitigation;
it doesn't need to ship before October, but the Meta cost-tracking hook should be
in place well before then so a pricing-model change is *visible* the moment it
happens, not discovered retroactively.

---

## 5. Bottom line

The **feature scope is in good shape** — Hebrew AI, lead capture, mini-CRM, and a
clean dashboard are real and match the locked day-one scope, with no premature
external-integration scope creep. The **billing model is the real gap**: the
credits system is well-engineered but meters the wrong unit entirely (messages, not
conversations), pricing numbers are placeholders, payment collection is unwired, and
handoff-to-owner has no active notification. None of this is a rewrite of the
product — it's a redesign of the metering layer (item 1) plus three focused
follow-ups (items 2-3, 5) before this is ready to bill a second real tenant on the
₪490/500-conversation offer.
