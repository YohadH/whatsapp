# QA Report — WhatsApp AI Agent (landing/dashboard split) — 2026-08-02

**Verdict:** ship-ready ✅ — route split, marketing homepage, and integration toggles all verified live with 0 defects. One verification gap flagged (no browser tool this session), not a product defect.

## Tested

| Area | Result | Evidence |
| ---- | ------ | -------- |
| Backend auth gate (protected APIs) | PASS | `curl` no-token → `401 "Missing authorization token"` on `/api/auth/me`, `/api/conversations` |
| `/dashboard`, `/login` serve SPA shell | PASS | Both return `app.html` (title "HeyIL — ניהול"), distinct from `/` |
| Client-side redirect (unauth→login click, authed→dashboard click) | NOT VERIFIED | No Playwright/browser MCP tool registered this session — flagged gap, same as 2026-07-31 pass 3 |
| `/` marketing homepage — no auth required | PASS | Plain `curl http://localhost:5173/` (no token) returns full page |
| `/` real SEO/AEO content, not stub | PASS | 75KB HTML: title/description/canonical/OG/Twitter meta, JSON-LD `@graph` (Organization+WebSite+pricing), RTL, real feature/pricing sections |
| `frontend/dist` build freshness | PASS | dist `index.html` already reflects latest reskin commit `58f2041` (teal/rounded marker count matches live source) |
| Settings → integrations toggle persists per-tenant | PASS | `PUT /api/settings/integrations` (gmail off) → re-`GET` (reload-equivalent) still shows `gmail:false` |
| Google-group toggle drives `Tenant.googleIntegrationEnabled` gate | PASS | gmail off (only google-slug on) → `google/status.enabled` flips `true→false`; calendar-only-on independently flips it back `true` |
| Non-Google toggle isolation | PASS | `webhook` toggle persists without changing `google/status.enabled` |
| Google-connect flow gated correctly | PASS | `google/connect` → `503 not_configured` (no OAuth client creds on this box; expected pre-condition ahead of the per-tenant 403 check) |
| Deploy gap vs `origin/master` | PASS | `0 0` — local HEAD `58f2041` == origin |

## Defects
None found this pass.

## Notes
- All settings-toggle test mutations were restored to their original baseline (`gmail:true, calendar:false, webhook:false`) after verification — no residual test state left in the real tenant DB.
- Landing page CTAs are WhatsApp-inquiry links (`wa.me/...`), not an app-signup form — confirmed by design (sales-funnel landing), not a missing feature.
- Standing gap: full client-side click-through of the `Protected` route component (React Router redirect behavior) still needs a browser-level pass — this task substituted backend/HTTP-level route verification, which is real evidence but not equivalent to an actual browser navigation/redirect observation.
