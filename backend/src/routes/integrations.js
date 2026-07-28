import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import config from '../config/index.js';
import {
  googlePlatformConfigured,
  getTenantGoogleState,
  buildAuthUrl,
  exchangeCodeAndStore,
  disconnectTenantGoogle,
  createCalendarEvent,
  checkAvailability,
  createOAuthState,
  consumeOAuthState,
} from '../services/googleIntegration.js';

// ─────────────────────────────────────────────────────────────────────────────
// Google integration (Gmail + Calendar) — paid per-tenant add-on, OFF by default.
//
// Mounted at /api/integrations behind requireAuth + withTenant (see app.js), so
// req.tenant / req.tenantId are always the caller's OWN tenant. EVERY route here
// is gated by the per-tenant flag (Tenant.googleIntegrationEnabled): if the flag
// is OFF, the routes return 403 "not enabled" and expose nothing. This is
// infrastructure only — it is NOT wired into the live conversation engine.
// ─────────────────────────────────────────────────────────────────────────────
const router = Router();

// Small helper: require the per-tenant flag ON, else 403. Also surfaces the
// "platform not configured" (no OAuth client creds) case as 503 up front.
async function requireGoogleEnabled(req, res) {
  if (!googlePlatformConfigured()) {
    res.status(503).json({
      error: 'Google integration is not configured on the server.',
      code: 'not_configured',
    });
    return null;
  }
  const state = await getTenantGoogleState(req.tenantId);
  if (!state.enabled) {
    res.status(403).json({
      error: 'Google integration is not enabled for this account (paid add-on).',
      code: 'not_enabled',
    });
    return null;
  }
  return state;
}

// GET /api/integrations/google/status → connection state for THIS tenant.
// Safe to call regardless of the flag (returns { enabled:false } when OFF/not-live)
// so the dashboard can decide whether to render the "Connect Google" button.
router.get(
  '/google/status',
  asyncHandler(async (req, res) => {
    const state = await getTenantGoogleState(req.tenantId);
    res.json({
      platformConfigured: googlePlatformConfigured(),
      enabled: state.enabled,
      connected: state.connected,
      email: state.email,
      // Never expose tokens; only whether the columns are live yet (ops signal).
      notMigrated: Boolean(state.notMigrated),
    });
  })
);

// GET /api/integrations/google/connect → redirect to Google's consent screen.
// Behind the per-tenant flag (requireAuth+withTenant give us a trusted req.tenantId).
// We mint a random, single-use, short-TTL `state` nonce bound SERVER-SIDE to this
// tenant (createOAuthState) and hand THAT to Google — never the raw tenantId. The
// public /callback resolves the nonce back to this tenant, so a forged/replayed
// state can never plant tokens into another tenant's row.
router.get(
  '/google/connect',
  asyncHandler(async (req, res) => {
    const gate = await requireGoogleEnabled(req, res);
    if (!gate) return; // response already sent by the gate

    const state = await createOAuthState(req.tenantId);
    const url = buildAuthUrl({ tenantId: req.tenantId, state });
    // Support both a JSON (SPA fetch) and a redirect (direct browser) caller.
    if (req.query.json === '1' || (req.headers.accept || '').includes('application/json')) {
      return res.json({ url });
    }
    return res.redirect(url);
  })
);

// NOTE: GET /google/callback is intentionally NOT defined on THIS (auth-gated)
// router. Google's real OAuth redirect is a plain top-level browser GET with no
// Authorization header, so it must be a PUBLIC route — see googleCallbackRouter
// below, mounted before the auth'd /api/integrations in app.js (mirrors the public
// payments /return precedent). It resolves the tenant from the state nonce, not
// from an authenticated session.

// POST /api/integrations/google/disconnect → clear stored tokens for this tenant.
router.post(
  '/google/disconnect',
  asyncHandler(async (req, res) => {
    const state = await requireGoogleEnabled(req, res);
    if (!state) return;
    const r = await disconnectTenantGoogle(req.tenantId);
    res.json({ disconnected: Boolean(r.disconnected) });
  })
);

// ── Calendar/Gmail actions (all flag-gated + connection-gated in the service) ──
// These are the integration points the conversation engine COULD call later; they
// are exposed as admin routes now for testing/manual use, but are NOT wired into
// the live default reply flow (WA-DEV-GOOGLE-READY: infrastructure only).

// POST /api/integrations/google/calendar/events → create an event.
router.post(
  '/google/calendar/events',
  asyncHandler(async (req, res) => {
    const state = await requireGoogleEnabled(req, res);
    if (!state) return;
    const event = await createCalendarEvent(req.tenantId, req.body || {});
    res.status(201).json(event);
  })
);

// POST /api/integrations/google/calendar/availability → busy/free for a range.
router.post(
  '/google/calendar/availability',
  asyncHandler(async (req, res) => {
    const state = await requireGoogleEnabled(req, res);
    if (!state) return;
    const avail = await checkAvailability(req.tenantId, req.body || {});
    res.json(avail);
  })
);

// NOTE: Gmail send/list are implemented in the service layer (sendEmail /
// listRecentEmails) and gated the same way, but intentionally NOT exposed as
// routes here yet — sending mail as a customer's account is a higher-trust action
// we don't want reachable until the add-on's UX is designed. They stay service-
// only until then. (WA-DEV-GOOGLE-READY: infrastructure, not a live feature.)

// Translate GoogleIntegrationError → its HTTP status (else the generic 500 path).
function googleErrorTranslator(err, req, res, next) {
  if (err && err.name === 'GoogleIntegrationError') {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  next(err);
}
router.use(googleErrorTranslator);

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC callback router — mounted at /api/integrations WITHOUT requireAuth (like
// the payments /return route), BEFORE the auth'd router in app.js. This is the URL
// Google redirects the user's browser to after consent, which is a plain top-level
// GET with NO Authorization header — so it CANNOT sit behind requireAuth (that was
// the bug: every real consent bounced to 401). Instead of trusting a session, it
// resolves the tenant SERVER-SIDE from the single-use `state` nonce minted at
// /connect (consumeOAuthState), which is deleted on first use → replay-proof and
// cannot be forged to target another tenant.
// ─────────────────────────────────────────────────────────────────────────────
export const googleCallbackRouter = Router();

// GET /api/integrations/google/callback → exchange the code for tokens + persist.
// Google redirects here with ?code=...&state=<nonce>. Flow:
//   1. platform configured? (else 503 not_configured)
//   2. resolve state → tenantId (single-use consume; reject if missing/unknown/
//      expired/reused). NEVER trust a tenantId asserted in state.
//   3. that tenant's add-on flag ON? (else 403 not_enabled — a state for a tenant
//      whose add-on was turned off is not honored)
//   4. exchange the code and store the encrypted tokens on THAT tenant.
googleCallbackRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    if (!googlePlatformConfigured()) {
      return res.status(503).json({
        error: 'Google integration is not configured on the server.',
        code: 'not_configured',
      });
    }

    const { code, state, error } = req.query;
    if (error) {
      return res.status(400).json({ error: `Google authorization failed: ${error}` });
    }

    // Resolve + consume the server-side nonce. This is the ONLY source of the tenant
    // identity — never a client-asserted value. Single-use: a replay finds nothing.
    const tenantId = await consumeOAuthState(state);
    if (!tenantId) {
      return res.status(400).json({
        error: 'Invalid, expired, or already-used OAuth state.',
        code: 'invalid_state',
      });
    }

    // Re-check the add-on flag for the RESOLVED tenant (a nonce is not a license to
    // connect if the add-on was disabled between /connect and the callback).
    const tstate = await getTenantGoogleState(tenantId);
    if (!tstate.enabled) {
      return res.status(403).json({
        error: 'Google integration is not enabled for this account (paid add-on).',
        code: 'not_enabled',
      });
    }

    const { email } = await exchangeCodeAndStore({ tenantId, code });
    res.json({ connected: true, email });
  })
);
googleCallbackRouter.use(googleErrorTranslator);

export default router;
