# Plan — Instagram Direct + Facebook Messenger channels

**Goal:** catch and auto-respond to **Instagram Direct** and **Facebook Messenger** conversations
through the *same* AI brain, knowledge base, flows, lead scoring, and inbox that already power
WhatsApp — one unified system, three channels.

---

## What's already done (reused unchanged)
The hard parts are channel-agnostic and stay as-is:
- The **AI agent**, **knowledge base**, **flows**, **lead scoring**, **central Claude pipeline**,
  and **human handoff** — all sit behind `handleIncomingMessage()`, which doesn't care about the channel.
- The **Meta app + Embedded Signup** infra, the **webhook signature check** (`X-Hub-Signature-256`
  with the app secret), and **AES-256-GCM** credential encryption.

So this is mostly a **channel adapter**: parse inbound, send outbound, and a small identity change.

---

## The one real change: a channel abstraction
Today a customer's identity is a **phone number** (`Customer @@unique([tenantId, phone])`).
Instagram/Messenger users have a **scoped ID** (IGSID / PSID) and **no phone**. So:

- Add **`channel`** (`whatsapp | instagram | messenger`) to `Customer`, `Conversation`, `Message`
  (existing rows backfill to `whatsapp`).
- Add **`externalId`** to `Customer` (the IGSID/PSID); make `phone` **optional**; new key
  `@@unique([tenantId, channel, externalId])` (WhatsApp uses the phone as its externalId).
- Add a generic **`channelMessageId`** (replacing the WhatsApp-only `waMessageId` assumption for dedup).
- Per-tenant connection creds for Pages/IG: **`pageId`**, **`igAccountId`**, **`pageTokenEnc`**
  (store in the existing `integrations` JSON or new columns).

---

## Phases

### Phase 0 — Channel foundations (backend only, no visible change)
- Migration: add `channel` / `externalId` / `channelMessageId`; backfill `whatsapp`.
- Refactor `handleIncomingMessage()` to take `{ channel, externalId, phone?, text, name, attachments }`.
- **Send abstraction**: one `sendMessage(conversation, text)` that dispatches by `conversation.channel`
  (WhatsApp Cloud API vs the Messenger/IG Send API).

### Phase 1 — Meta app: permissions + webhooks
- Add app permissions: `pages_messaging`, `pages_manage_metadata`, `instagram_basic`,
  `instagram_manage_messages`.
- Subscribe the app webhook to the **`messages`** field on the **page** and **instagram** objects.
- ⚠️ **App Review** (Advanced Access) needed before it works on *customers'* accounts — see prerequisites.

### Phase 2 — Connect flow (per tenant)
- Extend Embedded Signup to request Page + IG scopes → store `pageId`, `igAccountId`, encrypted Page token.
- Settings UI: **"חיבור פייסבוק / אינסטגרם"** (mirrors the WhatsApp connect), show the connected
  Page/IG handle + disconnect.
- Inbound routing: map the incoming page/IG id → tenant (like `waPhoneNumberId → tenant` today).

### Phase 3 — Inbound webhook adapter
- The single webhook branches on the payload `object`:
  `whatsapp_business_account` (existing) · `page` (Messenger) · `instagram`.
- Parse the Messenger/IG shape (`entry[].messaging[]`): `sender.id` (PSID/IGSID), `message.text`,
  attachments, **skip `is_echo`**, postbacks, **story replies**, quick replies.
- Normalize → `handleIncomingMessage()`. Signature verify already in place.

### Phase 4 — Outbound send adapter
- `messengerSend(pageToken, id, recipientId, text)` → `POST graph.facebook.com/{id}/messages`
  `{ recipient:{id}, messaging_type:'RESPONSE', message:{text} }`.
- **24-hour window enforcement**: auto-send only within 24h of the user's last message; outside the
  window → hold for a human (no proactive sends / no templates like WhatsApp).

### Phase 5 — Inbox + product polish
- **Channel badge** in שיחות (WhatsApp / IG / Messenger) + filter.
- **Broadcasts stay WhatsApp-only** (IG/Messenger policy forbids cold outbound) — hide those channels in דיוור.
- Optional extras: **comment→auto-DM** (Instagram), **story-reply** handling, **ice-breakers /
  persistent menu** (Messenger), **human-agent handoff tag** (Messenger's 7-day agent window).

---

## ⚠️ Constraints & prerequisites (must-know before committing)
- **Meta App Review**: `instagram_manage_messages` + `pages_messaging` require **Advanced Access**
  approval (submission + review, ~days–weeks). Until approved, only *your own* connected accounts work
  (dev mode) — fine for building/piloting, required before onboarding customers.
- **24-hour window, no templates**: IG & Messenger allow automated replies **only within 24h** of the
  user's last message; **no arbitrary outbound or broadcasts** (unlike WhatsApp's approved templates).
  Messenger adds limited **message tags** + a **7-day human-agent** window.
- **Instagram account** must be **Professional** (Business/Creator), **linked to a Facebook Page**, with
  messaging access enabled.
- **Rate limits** per Page/IG — handle 429s and back off.

---

## Decisions to confirm before I build
1. **Scope now** — both Instagram + Messenger, or **Instagram first** (Messenger is nearly the same adapter)?
2. **Triggers to catch** — DMs only, or also **story replies** and **comment→auto-DM**?
3. **Connect method** — Embedded Signup (one-click, needs App Review) or **paste a Page token** to start
   (faster to build + test on your own account with no review)?
4. **Identity** — OK to extend `Customer` with `channel` + `externalId` and make `phone` optional
   (simplest), vs a separate identity table?

## Rough effort
- **Core (Phases 0–4, IG + Messenger DMs end-to-end, reusing the brain):** a few focused days of work,
  plus the **Meta App Review** lead time running in parallel (external).
- **Comment→DM / story / menus:** incremental, after the core lands.
