# Credit-Based AI Billing — Design

How tenants (businesses) pay for AI usage via a prepaid **credit** balance. This
replaces the current fixed message-quota model with something you can actually
monetize and top up.

---

## 1. What a credit represents

**Recommended: 1 credit = 1 AI-answered message.**

An inbound customer message that triggers an **AI reply** costs **1 credit**. Rule-based
fallback replies, opt-outs, and system messages cost **0**. Simple for customers to
understand ("credits = messages the AI answers") and it maps directly onto the
`messagesThisPeriod` counter that already exists.

We still record **actual token usage per message internally** (for your own cost/margin
monitoring) — customers just don't see tokens.

*Alternative considered — 1 credit = N tokens:* more precise to real cost, but confusing
to sell and overkill given how cheap `gpt-4o-mini` is (see §7). Not recommended.

---

## 2. The billing model

**Recommended: plan-included monthly credits + prepaid top-up packs for overflow.**

- Each **plan** grants a **monthly credit allotment** that resets every 30 days
  (reuse today's values: Trial = 500, Starter = 5,000, Pro = 50,000).
- Beyond the monthly allotment, a tenant buys **top-up credit packs** that **do not
  reset** — they sit in a purchased balance and are consumed after the monthly ones.

**Effective credits available =** `max(0, monthlyAllotment − usedThisPeriod)` **+** `purchasedCredits`

This layers cleanly on the existing `monthlyMessageLimit` / `messagesThisPeriod` fields —
we only add the purchased balance and a ledger.

---

## 3. Data model changes

**`Tenant`** — add:
- `purchasedCredits Int @default(0)` — non-resetting balance from top-ups.
- (keep `monthlyMessageLimit` = monthly allotment, `messagesThisPeriod` = used this period)
- `lowCreditNotifiedAt DateTime?` — so we nudge to top up only once per low-balance episode.

**New model `CreditTransaction`** (the ledger — this is what powers "how much you've spent"):
| field | meaning |
|---|---|
| `id`, `tenantId`, `createdAt` | standard |
| `type` | `debit` (AI message) \| `topup` (purchase) \| `grant` (monthly reset/comp) \| `adjust` (manual) |
| `amount` | signed: `-1` for a message, `+1000` for a pack |
| `balanceAfter` | running purchased balance after this entry |
| `reason` | e.g. `ai_reply`, `pack_5000`, `monthly_reset` |
| `messageId` | link to the `Message` for debits (audit trail) |
| `tokensIn`, `tokensOut` | actual OpenAI tokens (internal cost tracking) |

The ledger gives you: per-tenant spend history, a "credits used this month" number, and
your real OpenAI cost vs. revenue.

---

## 4. Deduction logic (where it hooks in)

The engine already increments `messagesThisPeriod` in
[conversationEngine.js:309](backend/src/services/conversationEngine.js#L309). Credits hook
in right there:

```
inbound message
  → compute effective available credits
  → if available <= 0:
        skip OpenAI, use rule-based fallback,
        notify tenant admin to top up (once)
  → else:
        run OpenAI reply
        deduct 1 credit (first from monthly allotment, then purchasedCredits)
        write a CreditTransaction(debit) with token counts
```

**Out-of-credits behavior — recommended: graceful degrade.** When a tenant runs out, the
agent keeps replying using the **existing rule-based fallback** (never goes silent on a
customer) and the tenant admin gets a "top up to re-enable AI" prompt. *Alternative: hard
stop AI replies — worse customer experience, not recommended.*

---

## 5. Top-up / payment flow

1. Tenant admin opens **Credits** page → picks a pack (e.g. 1,000 / 5,000 / 20,000).
2. Redirect to a hosted checkout → pays by card.
3. Payment webhook → `purchasedCredits += pack`, write `CreditTransaction(topup)`.

**Payment provider — options:**
- **Stripe** — fastest to integrate (SDK + tooling already available in this environment),
  great for cards, works in Israel. Recommended to start.
- **Israeli local (Cardcom / Meshulam / PayPlus / Tranzila)** — better local payment
  methods (Bit, local invoicing/חשבונית מס), but more integration work. Consider later.

**Optional later:** auto-recharge (when balance < threshold, auto-buy a pack from a saved
card) — removes the "ran out mid-day" problem.

---

## 6. Where it shows in the dashboard

**Tenant admin — new "קרדיטים / Credits" page:**
- Big number: **credits remaining** (monthly + purchased).
- **Used this month** + a small usage chart.
- **Top-up** button → pack selection.
- **Transaction history** (from the ledger): date, type, amount, balance.
- A banner when low/empty: "נגמרו הקרדיטים — הסוכן עונה במצב בסיסי. טען קרדיטים להפעלת ה-AI."

**Super-admin — platform view:**
- Per-tenant: credits balance, credits used, **your OpenAI cost vs. their spend = margin**.
- Total revenue from top-ups.

---

## 7. Pricing framework (your numbers to set)

**Your actual cost is tiny.** With `gpt-4o-mini` (~$0.15 / 1M input, ~$0.60 / 1M output),
a typical WhatsApp AI reply (KB + history context in, short reply out) runs roughly
**3,000–5,000 tokens total ≈ $0.0005–0.0011 per message ≈ ₪0.002–0.005**.

So **each AI message costs you well under one agora.** That means big pricing freedom:

| If you sell a credit at | Your cost/msg | Gross margin |
|---|---|---|
| ₪0.05 | ~₪0.003 | ~94% |
| ₪0.10 | ~₪0.003 | ~97% |
| ₪0.30 | ~₪0.003 | ~99% |

**Locked HeyIL numbers (shipped — see `lib/plans.js` / `lib/creditPacks.js`):**
- **Plan:** HeyIL — **₪490/mo = 500 handled conversations** (`plan: 'heyil'`,
  `monthlyMessageLimit: 500`, `priceIls: 490`). A NEW plan, separate from `trial`.
- **Top-up packs** (1 credit = 1 handled conversation, non-resetting):
  **250 = ₪150**, **500 = ₪250** (popular), **1,000 = ₪450**.
- Plans include the monthly conversation allotment; overflow = packs.
- Keep credit price simple and round; the margin is huge either way, so price on
  **value/positioning**, not cost.

> Note: this prices your *AI* usage. WhatsApp *conversation* fees (Meta charges per
> 24-hour conversation for some message types) are separate — decide later whether to
> bundle those into credits too.

---

## 8. Build plan (phased)

1. **Core metering** — schema (`purchasedCredits`, `CreditTransaction`), deduction hook,
   graceful out-of-credits fallback, token tracking. *(Backend only — testable via simulator.)*
2. **Tenant Credits dashboard** — balance, used-this-month, history (read-only first).
3. **Top-ups** — Stripe checkout + webhook to add credits.
4. **Super-admin margin view** + low-credit notifications.
5. **Later** — auto-recharge, Israeli payment methods, bundling WhatsApp conversation fees.

Phases 1–2 deliver a working, visible credit meter without any payment integration —
you can watch credits burn down in the dashboard immediately. Phase 3 adds real money.

---

## 9. Decisions needed from you

1. **Credit unit** — 1 credit = 1 AI message (recommended) vs. token-based?
2. **Model** — monthly-included + top-up packs (recommended) vs. pure pay-as-you-go?
3. **Out-of-credits** — graceful rule-based fallback (recommended) vs. hard stop?
4. **Payment provider** — Stripe first (recommended) vs. Israeli local from the start?
5. **Prices** — pack sizes and price per credit (your call; §7 is the framework).

---

## 10. The ₪990 setup fee is intentionally OUT-OF-SCHEMA

The locked billing model includes a **one-time ₪990 setup fee** (DFY onboarding:
WhatsApp Business API connection, flow/knowledge-base configuration, go-live).

**This fee is deliberately NOT modeled anywhere in the app** — not in `lib/plans.js`,
not in `lib/creditPacks.js`, not in the `CreditPurchase` / `CreditTransaction` ledger,
not in the tenant billing schema. It is a **one-off professional-services charge sold
and invoiced OUTSIDE the application** (manual invoice / חשבונית מס), not a metered or
in-app product.

This is recorded here explicitly so nobody later "discovers" the setup fee as a
missing feature and adds a phantom code path for it. The app meters only the
recurring, usage-based side of the offer (the ₪490/mo plan + top-up conversation
packs). If the setup fee ever needs to move in-app (e.g. self-serve onboarding with
card-on-file), that is a NEW, separate decision — treat its current absence as
intentional, not a gap.
