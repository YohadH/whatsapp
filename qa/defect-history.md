# WhatsApp AI Agent — QA Defect History

_Append-only. Newest entries at the bottom. Rotate older entries to qa/archive/ per AP-T ROTATION discipline once this file grows long._

## 2026-08-03 — Receipts/media-proxy/onboarding/landing/entitlement verify pass (board task whatsapp-agent-wa-qa-verify-receipts-onboarding)

**Scope:** live-verified 7 commits never touched by prior QA: `40d6511` (receipts pipeline, media proxy,
onboarding wizard), `fa45820` (landing product-showcase/number-porting/CTA), `577c1d4`/`8c644e0` (HeyIL
brand palette + H-mark), `32d9ddc`/`fc125b6` (Google add-on entitlement fixes), `0da3ec7` (logo swap).

**Environment gotcha (AP-T81 pattern recurred a 3rd time on this project):** no whatsapp-agent backend
API process was running at session start — port 4010 (the project's configured `PORT`) was unbound; a
DIFFERENT unrelated project's dev server (TraderMind, `src/server.ts`, tsx) was squatting port 4000,
which could have caused a false "backend down" read if I'd checked the wrong port. Started a fresh
`node --watch src/server.js` on the correct port 4010 (this repo's own configured port) AFTER all target
commits' timestamps, confirmed via `Get-CimInstance Win32_Process`. Left it running (watch-mode, safe to
reuse) for future sessions.

**Tool gap (AP-T84 — 3rd+ consecutive occurrence):** no Playwright/browser MCP tool registered this
session (also flagged 2026-08-02 landing-split report and 2026-08-01 dispatch run 36). Filed a board task
this time instead of re-noting in prose again: `Install Playwright browser binary / register browser MCP
tool for qa-manager sessions` (P2, owner cto). All verification below is real API/DB round-trips + direct
source-code confirmation of the rendering logic, NOT pixel-verified browser screenshots — flagged
explicitly per-item below.

**Results (all PASS, 0 product defects found):**
1. Onboarding wizard 3-step flow — step 1 (`PUT /api/settings/profile` + `PUT /api/knowledge-base`
   businessDescription) round-tripped with real tenant data, restored after. Step 2/3 source-verified
   (WA_PATHS radio cards, connected-state summary, `navigate('/dashboard')`). NOT browser-verified.
2. Expenses page — `GET /api/expenses` returned real seeded receipt (vendor "דלק פז בע\"מ"), `PUT
   /api/expenses/:id` edit round-tripped and was restored, `GET /api/expenses/:id/image` returned a real
   40KB JPEG. CSV export confirmed as a correct client-side Blob builder (BOM + Hebrew-safe quoting) in
   `frontend/src/pages/Expenses.jsx:97-109` — no backend export route exists BY DESIGN (not a defect).
3. Inbox media proxy — `GET /api/conversations/media/:messageId` against a REAL inbound WhatsApp image
   message (id `cmsboim1k0007urxmk34fgy0q`, `messageText:"[image]"` in DB) returned a genuine 52KB JPEG
   (1200x1600). Source-confirmed `frontend/src/components/MessageContent.jsx` renders `<img src=blobUrl>`
   via authenticated blob fetch, typed-card fallback only on proxy failure. Strong evidence, not
   screenshot-verified.
4. Landing sections (product-showcase/number-porting/CTA) — confirmed present in served
   `frontend/index.html` (static, not SPA-routed) with matching markup/CSS from commit fa45820. Media
   queries at lines 561/591/595 wrap the new sections (509-927). Not pixel-verified on real mobile
   viewport.
5. Google add-on entitlement badge — compared `GET /api/integrations/google/status` between an entitled
   "pro" tenant (`enabled:true`) and a non-entitled "trial" tenant (`enabled:false`, temp QA admin
   created + deleted after test) — correctly discriminating. Source-confirmed
   `frontend/src/pages/Settings.jsx:137,177` locks the badge (`🔒 תוסף בתשלום`) exactly when
   `group==='google' && googleEntitled===false`.

**No regressions found** in areas touched by 577c1d4/8c644e0/0da3ec7 (brand palette/H-mark/logo) —
sampled via source grep only (icon symbol present, no dangling old-brand refs found in touched files);
not a full regression sweep.

**Board task filed:** `Install Playwright browser binary...` (P2, cto) — the missing-tool escalation.
No product defects filed this pass — everything checked came back correct.
