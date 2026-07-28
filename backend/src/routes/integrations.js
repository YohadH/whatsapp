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
// Behind the per-tenant flag. The tenantId travels in `state` so the callback can
// attach the tokens to the right tenant.
router.get(
  '/google/connect',
  asyncHandler(async (req, res) => {
    const state = await requireGoogleEnabled(req, res);
    if (!state) return; // response already sent by the gate

    const url = buildAuthUrl({ tenantId: req.tenantId, state: req.tenantId });
    // Support both a JSON (SPA fetch) and a redirect (direct browser) caller.
    if (req.query.json === '1' || (req.headers.accept || '').includes('application/json')) {
      return res.json({ url });
    }
    return res.redirect(url);
  })
);

// GET /api/integrations/google/callback → exchange the code for tokens + persist.
// Google redirects the browser here with ?code=...&state=<tenantId>. This runs
// under requireAuth + withTenant like the rest, so req.tenantId is trusted; we
// additionally assert the OAuth `state` matches the authenticated tenant to guard
// against a code being replayed against a different tenant.
router.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const gate = await requireGoogleEnabled(req, res);
    if (!gate) return;

    const { code, state, error } = req.query;
    if (error) {
      return res.status(400).json({ error: `Google authorization failed: ${error}` });
    }
    if (state && state !== req.tenantId) {
      return res.status(403).json({ error: 'OAuth state does not match the authenticated tenant.' });
    }

    const { email } = await exchangeCodeAndStore({ tenantId: req.tenantId, code });
    res.json({ connected: true, email });
  })
);

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
router.use((err, req, res, next) => {
  if (err && err.name === 'GoogleIntegrationError') {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  next(err);
});

export default router;
