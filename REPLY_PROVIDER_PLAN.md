# Reply-Provider Webhook — Plan (custom local reply brain)

**Goal:** let a tenant route reply generation to **their own agent** (a local Claude
running on the owner's machine) instead of HeyIL's built-in agent — for bespoke reply
logic that can't live in the prompt/knowledge base. HeyIL POSTs each inbound customer
message (+ context) to the tenant's endpoint, waits for a reply, and sends it. If the
endpoint is slow / down / returns garbage, HeyIL **automatically falls back to the
built-in agent**, so a customer is never left without an answer.

Per-tenant + opt-in. Off by default. Never blocks the pipeline.

---

## 1. How it works — "escalation brain" (decisions locked)

Enabled **per tenant** (whole-tenant, not per-flow). But the local agent is consulted
**only when the built-in bot is not enough** — it runs the flows and answers from the
knowledge base as today, and the local agent steps in exactly where the bot would
otherwise escalate to a human. So your machine only handles the *hard* messages, not
every "היי".

```
Customer → WhatsApp → conversationEngine → built-in agent (flows / KB / BYO or platform AI)
                                                │
                        bot NOT enough? (needs_human, or no confident answer)
                          │ no                          │ yes  +  replyProvider enabled
                          ▼                              ▼
                  send the bot's reply       POST reply.request (rich context,
                                             HMAC-signed, ≤ 30s) to your local agent
                                                    │
                                   ┌── valid reply within 30s? ──┐
                                   │ yes                         │ no / error / timeout / pass
                                   ▼                             ▼
                            send the agent's reply     FALL BACK → hand off to a human
                                                        (today's needs_human behaviour)
```

Net effect: instead of "bot can't → human waits," it becomes "bot can't → your Claude
tries → if it nails it, the customer is answered instantly; if not, human as before."

**Trigger** is configurable (`consultOn`): default `'escalation'` (needs_human / no
KB answer). An `'always'` mode is available if you later want the local agent to see
every message and `pass` on the easy ones. Your choice today: **escalation**.

---

## 2. Request / response contract

**Request** — `POST <replyProviderUrl>` (JSON), header `X-HeyIL-Signature: sha256=HMAC(secret, rawBody)`:
```json
{
  "event": "reply.request",
  "tenant":   { "id": "…", "name": "…", "niche": "clinic" },
  "conversation": { "id": "…", "status": "active",
                    "currentFlowId": null, "currentQuestionId": null },
  "customer": { "name": "דנה", "phone": "972501234567" },
  "message":  { "text": "אפשר לקבוע תור למחר?" },
  "history":  [ { "role": "customer", "text": "…" }, { "role": "agent", "text": "…" } ],
  "knowledgeBase": { "…": "…" },      // optional — so the agent can ground answers
  "flows": [ { "id": "…", "name": "…", "questions": [ … ] } ],  // optional
  "ts": "2026-08-05T10:00:00Z"
}
```

**Response** — JSON (the app validates it; same shape the engine already consumes):
```json
{
  "reply": "בשמחה! לאיזה טיפול תרצו לקבוע תור?",   // required — the message to send
  "needs_human": false,                             // optional
  "lead_score": 70,                                 // optional (1–100)
  "conversation_status": "active",                  // optional
  "calendar_event": { "summary": "…", "start": "…", "end": "…" },  // optional
  "link_to_send": null                              // optional
}
```
- Only `reply` is required. Missing/invalid/empty `reply` → treated as a failure → fallback.
- The extra fields let the local agent drive handoff, lead score, calendar booking, etc.

---

## 3. Reliability & fallback (the safety net)

- **Timeout: 30s** (configurable) via AbortController. Because the provider is consulted
  only on hard/escalation cases (not every message), a longer think-time is fine — the
  alternative there was a human anyway.
- Fall back on: timeout · non-2xx · unreachable/DNS/TLS error · invalid JSON ·
  missing `reply` · explicit `pass`. Fallback here = today's needs_human hand-off.
- **One attempt** (no retry) — on any miss we fall back immediately.
- Every fallback is **logged + surfaced** (a small "provider was unreachable N times"
  stat in Settings) so the owner knows when their machine was down.
- Idempotent: called once per inbound message (existing waMessageId dedup upstream).

---

## 4. Security model

- **HTTPS only.** The local agent is exposed via a public HTTPS tunnel
  (cloudflared / ngrok / etc.). The URL is validated as a public HTTPS host
  (reuse `isSafeWebhookUrl` — rejects localhost/private/metadata) so it can't be
  pointed at an internal service.
- **HMAC-signed requests** (`X-HeyIL-Signature`) with a per-tenant secret, so the local
  agent can verify the request genuinely came from HeyIL (not a spoofer hitting the URL).
- **Secret encrypted at rest** (AES-256-GCM, same as WhatsApp/webhook secrets), never
  returned to the client, never logged.
- **No inbound trust escalation:** HeyIL only *sends* to the URL and *reads back* a
  reply; the local agent gets no HeyIL credentials from this channel. If the local
  agent needs to pull more data (leads, past convos), it uses the separate scoped
  **Agent API key** (the Ops/Data foundation) — kept independent from this secret.
- Enable/disable is a single toggle; disabling instantly reverts to the built-in agent.

---

## 5. Config

**Schema (additive):** reuse `Tenant.integrationConfig` JSONB (already exists) under a
`replyProvider` key — no migration:
```
integrationConfig.replyProvider = {
  enabled: true,
  url: "https://<your-tunnel>/reply",
  secret: "…",              // HMAC signing (encrypted at rest)
  timeoutMs: 30000,         // 30s
  consultOn: "escalation"   // 'escalation' (bot-not-enough) | 'always'
}
```
Request payload includes the **full knowledge base + flows** every call (rich context),
per the decision.

**Backend:**
- `services/replyProvider.js` → `generateViaProvider(tenant, ctx)`:
  build payload → sign → POST with timeout → validate → return the normalized
  agentResponse, or `null` to signal fallback. Never throws.
- `conversationEngine`: before the built-in `generateAgentResponse`, if the provider is
  enabled+configured, try `generateViaProvider`; use its result, else fall back.
- `routes/settings.js`: `PUT /api/settings/reply-provider` (url + secret + enabled +
  timeout, url validated) and `POST /api/settings/reply-provider/test` (send a sample
  reply.request, show status/latency/returned reply).

**UI (Settings → מנוע הבינה):** a "מוח תגובות מותאם (סוכן חיצוני)" panel — URL, optional
secret, timeout, enable toggle, **"שליחת בדיקה"** button, and a "● מחובר / כבוי" state
plus the last-fallback indicator.

---

## 6. The local-agent side (what you build on your machine)

A small always-on service that:
1. Exposes one HTTPS endpoint (via a tunnel) that receives `reply.request`.
2. Verifies `X-HeyIL-Signature` with the shared secret.
3. Runs your custom Claude logic (Claude **Agent SDK** or **Tool Runner** — with your
   own tools, prompt, memory), optionally calling the HeyIL **Agent API** for more data.
4. Returns `{ reply, … }` within the timeout.

We ship a **starter** (≈40 lines: Express/Fastify + `@anthropic-ai/sdk` tool_runner +
signature check) so you're running in minutes, plus the exact contract above.

---

## 7. Phasing

- **Phase A:** `replyProvider` config + `services/replyProvider.js` + engine hook +
  fallback + Settings panel with test-send. (Makes it live.)
- **Phase B:** fallback stats surfaced in Settings + a local-agent starter repo/snippet.
- **Phase C (optional):** streaming/typing indicator while the provider thinks; per-flow
  "provider vs built-in" routing.

---

## 8. Decisions — LOCKED

1. **Timeout — 30s.** ✓
2. **Context — rich:** full knowledge base + flows in every request. The provider is
   consulted only **when the bot is not enough** (escalation), so the bigger payload is
   fine (it's not on every message). ✓
3. **Scope — whole tenant** (one setting), consulted on the escalation trigger. ✓
4. **Pair with the Agent API — yes.** Build the scoped read/write Agent-API foundation
   alongside, so the local agent can also read leads/history/KB mid-reply. ✓

## 9. Build order (after QA)

- **Foundation:** scoped **Agent API** + API-keys (issue/revoke/scope) + audit + HMAC
  plumbing — shared with the Ops/Data-sync agents.
- **Reply provider (Phase A):** `integrationConfig.replyProvider` config +
  `services/replyProvider.js` (build rich payload → sign → POST ≤30s → validate → reply
  or fall back) + engine hook on the escalation trigger + Settings panel with test-send.
- **Phase B:** fallback stats in Settings + a ~40-line local-agent starter (Express +
  Anthropic Tool Runner + signature verify) implementing the contract.
