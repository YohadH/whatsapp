# HeyIL — Competitive Roadmap (drafted 03/08/2026)

Source: feature-by-feature review of SmartSend (smartsend.co.il) — our largest IL
competitor — against HeyIL's current state. Screenshots reviewed: onboarding,
coexistence connect, recipient lists, campaign wizard, message-template library,
flow-template library, multi-company switcher, integrations (channels / BYO-AI /
API & automations).

## Where we already win (protect these)
- 🧾 **Receipts-by-WhatsApp expense book** — owner photographs receipts into the
  business number; vision extraction → monthly expense page + CSV. SmartSend has
  nothing like it. (Shipped 02/08.)
- **Meta 24h-window eligible picker** in דיוור — free-text-eligible contacts
  listed with countdown. They don't show this.
- **Credits business model** + Stripe billing, tenant provisioning, Hebrew-first
  landing + in-app RTL polish, honest AI/בוט labeling, 24h stale-lead restart.
- **Business-tool integrations** — Gmail, Google Calendar (booking), Google
  Sheets export, Webhook/CRM, Calendly, Zapier catalog + the paid Google add-on.
  SmartSend's integrations page has NONE of these (only BYO-AI + API/Make.com) —
  a real differentiator for service businesses that live on their calendar.

## Phase 1 — דיוור suite parity (highest value ÷ effort, no external deps)
1. **Saved recipient lists** (their "רשימות נמענים")
   - `RecipientList` + members (phone, name, vars), CRUD API, tenant-scoped.
   - Sources: manual add · CSV/XLSX import (reuse broadcast preview parser) ·
     Google Sheets later (rides the existing Google add-on plumbing).
   - Server-side phone normalization (+972 ↔ 0-prefix; reuse receipts' matcher).
   - "הרשימות שלי" panel (search/sort) + a "רשימה שמורה" source in the send flow
     alongside file-upload and the 24h picker.
2. **Template library** (their "ספריית התבניות")
   - ~15–18 curated Hebrew templates: appointment reminder/confirm, order
     confirm, shipping update, flash/seasonal sale, loyalty, review request,
     follow-up, OTP. Categories: שיווק / תפעול ושירות / אימות.
   - WhatsApp-bubble live preview ({{n}} vars, buttons) → one click prefills the
     existing create-template modal → Meta approval. No new backend.
3. **Campaign wizard polish**
   - Name/label on BroadcastJob (history stops being anonymous).
   - 3-step structure (שם+תבנית → קהל → תצוגה מקדימה ואישור), phone-frame
     preview, draft save. Flow-as-campaign (trigger a flow for an audience) as a
     stretch item.
4. **Flow-template library** (their "בחר תבנית flow")
   - Our Flow/FlowQuestion model already covers it (typed questions, choices,
     trigger words, final message, link attach) — a template is just a JSON
     blueprint created via the existing flows API on one click.
   - ~8–10 prebuilt Hebrew flows by category (מכירות / תמיכה / שיווק / כללי):
     lead-warming, appointment booking, customer-service triage, order status,
     post-sale review, event RSVP, price-quote qualifier, FAQ deflection.
   - Card grid with chat-style preview + difficulty badge, "צור flow מאפס"
     escape hatch (the current editor), adopted flows open in the editor for
     customization before activation.

## Phase 2 — Onboarding & connect trust
1. Explainer-video slots in the connect cards (0:48-style clip; owner records,
   we wire the player) + explicit "דלגו ואחברו אחר כך".
2. **Coexistence plumbing** (keep the phone app, work in parallel — the legal
   way): ingest Meta history-sync webhook payloads into Conversations/Messages,
   handle smb echo events (owner's phone-app messages appear in the inbox as
   'human'). Build behind a flag now, testable with fixtures.
3. Coexistence onboarding card + "שיתוף היסטוריית צ'אטים" opt-in — **blocked on
   Meta Tech Provider approval** (external dependency; application in progress).
   Check: min WhatsApp Business app version, IL availability.

## Phase 3 — Platform openness
1. **BYO AI key** (their Gemini/Claude/ChatGPT picker): per-tenant provider +
   API key (encrypted at rest like waTokenEnc) + model picker; falls back to the
   platform key/credits when unset.
   ⚠ BUSINESS DECISION FIRST: BYO-key bypasses the credits revenue model —
   likely a premium-plan feature, or credits stay for platform-key usage only.
2. **Tenant API key + outbound webhooks** — real webhook delivery for
   lead-created / message-received / handoff events (the Settings "Webhook/CRM"
   toggle becomes real), then Make.com / Zapier / n8n recipes + docs.

## Phase 4 — Structural
1. **Multi-company under one login** (their workspace switcher): AdminUser↔Tenant
   membership join-table with roles, sidebar switcher, self-serve "צור חברה
   חדשה" provisioning (today super-admin-only). Auth-sensitive; own migration.
2. **Multi-channel unified inbox** (Messenger + Instagram Direct): channel
   abstraction on Conversation/Message (channel enum, per-channel creds),
   Graph API webhooks for both ride the same Meta app. Largest lift — schedule
   only when WhatsApp core is saturated.

## Pricing model (owner: "I like their plan" — 03/08)
SmartSend's structure, for reference:
- **Starter ₪199/מודש** for 1,000 contacts; slider tiers: 2,500 → ₪349,
  10,000/25,000 → ₪699. "Contact" = recipient with chat history; broadcast
  recipients DON'T count as contacts (separate 1,000/mo broadcast quota).
- **₪89/מודש per extra user** (first seat included). 14-day trial, cancel
  anytime, all features in every tier (automations, templates, shop), support
  hours listed. No setup fee anywhere.
Our current model: ₪350/₪650 monthly + ₪2,500/₪4,500 setup, AI-message credits.
DFY (done-for-you) positioning vs their self-serve.

Proposed hybrid (needs owner sign-off before any billing work):
- Keep the DFY managed tiers (they fund the concierge onboarding + service).
- Add a SELF-SERVE tier (~₪199, no setup) gated on the new onboarding wizard:
  contact-count tiers metered as distinct customers with ≥1 message; monthly
  broadcast-recipient quota per tier (we already track OutboundSend); seat
  billing per extra AdminUser (schema already allows multiple per tenant).
- AI cost control for self-serve: keep credits, or pair with BYO-AI key
  (Phase 3.1) so heavy AI usage rides the customer's own key.
Implementation once approved: contact metering query + plan gates, Stripe
prices for tiers/seats, trial state (trialEndsAt exists), pricing page rewrite.

## Open decisions (owner)
- BYO-AI vs credits pricing (Phase 3.1) — which plans get it?
- Priority order confirmation: default is 1.1 → 1.2 → 1.3 → 2.x → 3.x → 4.x.
- Tech Provider application status/timeline (gates Phase 2.3).
- OpenAI billing top-up (agent AI answers + receipt extraction currently fall
  back to rules — `credit_balance_exhausted` since 02/08).
