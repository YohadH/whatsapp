// ─────────────────────────────────────────────────────────────────────────────
// Google integration (Gmail + Calendar) — paid per-tenant add-on, OFF by default.
//
// INFRASTRUCTURE ONLY (WA-DEV-GOOGLE-READY): this ships the OAuth connect flow,
// token storage, and a Calendar/Gmail service layer behind a per-tenant feature
// flag. It is deliberately NOT wired into the live conversation engine's default
// flow — it becomes usable for a tenant only when the owner (a) supplies the
// platform Google Cloud OAuth client creds and (b) flips
// Tenant.googleIntegrationEnabled = true for that tenant (a purchased add-on).
//
// GATING (three independent gates, all must pass or every action returns a clear
// "not enabled"/"not configured"/"not connected" instead of doing anything):
//   1. PLATFORM configured — config.google.enabled (OAuth client id+secret set).
//   2. TENANT flag ON       — Tenant.googleIntegrationEnabled === true.
//   3. TENANT connected     — a stored, decryptable OAuth token set.
//
// SCHEMA-DRIFT SAFE (AP-T71): the googleIntegrationEnabled / googleTokensEnc /
// googleConnectedEmail columns and the GoogleOAuthState table now live on the
// production DB (migrations 5_google_integration + 6_google_oauth_state APPLIED
// live). The raw-SQL drift guards below are retained defensively: EVERY DB access
// here still goes through helpers that catch the "column/table does not exist"
// (Postgres 42703/42P01 / Prisma P2022/P2021) case and degrade to "not enabled"
// — never a 500 — so a fresh/unmigrated environment (a new preview DB, a restored
// backup) can never take down the tenant surface. On the live DB these guards are
// no-ops and the code returns real state.
//
// TOKENS AT REST: the OAuth token set (access + refresh) is encrypted with the
// same AES-256-GCM helper as the WhatsApp token (lib/crypto.js), keyed by
// CREDENTIALS_ENC_KEY. It is never returned to the client and never logged.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { google } from 'googleapis';
import prisma from '../lib/prisma.js';
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import config from '../config/index.js';

// How long an issued OAuth `state` nonce is valid for. The user has this long to
// complete Google's consent screen; after that the state is rejected as expired.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// A structured error the routes can translate to an HTTP status + clear message.
export class GoogleIntegrationError extends Error {
  constructor(message, { status = 400, code } = {}) {
    super(message);
    this.name = 'GoogleIntegrationError';
    this.status = status;
    this.code = code;
  }
}

// True when the Postgres error is "column does not exist" — i.e. the
// 5_google_integration migration is not present on this DB (e.g. a fresh preview
// env). Treated as "feature not live" rather than a hard failure (AP-T71 graceful
// degrade). No-op on the live DB where the migration is applied.
function isColumnMissing(err) {
  const msg = String(err?.message || '');
  return (
    err?.code === 'P2022' ||
    err?.code === '42703' ||
    /column .*does not exist/i.test(msg) ||
    /does not exist in the current database/i.test(msg)
  );
}

// True when the Postgres error is "relation/table does not exist" — i.e. the
// GoogleOAuthState table (migration 6_google_oauth_state) is not present on this
// DB (e.g. a fresh preview env). Same graceful-degrade intent as isColumnMissing
// (AP-T71): treat as "feature not live" rather than a 500. No-op on the live DB
// where the migration is applied.
function isTableMissing(err) {
  const msg = String(err?.message || '');
  return (
    err?.code === 'P2021' ||
    err?.code === '42P01' ||
    /relation .*does not exist/i.test(msg) ||
    /table .*does not exist/i.test(msg)
  );
}

// ── Gate 1: is the PLATFORM OAuth client configured at all? ──────────────────
export function googlePlatformConfigured() {
  return Boolean(config.google.enabled);
}

// ── DB access (raw SQL, drift-safe) ──────────────────────────────────────────
// Read the per-tenant Google state. Returns { enabled, connected, email, tokensEnc }.
// If the columns are not migrated live yet, returns the all-off default (never throws).
export async function getTenantGoogleState(tenantId) {
  if (!tenantId) return { enabled: false, connected: false, email: null, tokensEnc: null };
  try {
    const rows = await prisma.$queryRaw`
      SELECT "googleIntegrationEnabled" AS enabled,
             "googleTokensEnc"          AS "tokensEnc",
             "googleConnectedEmail"     AS email
      FROM "Tenant"
      WHERE "id" = ${tenantId}
      LIMIT 1`;
    const row = rows?.[0];
    if (!row) return { enabled: false, connected: false, email: null, tokensEnc: null };
    return {
      enabled: Boolean(row.enabled),
      connected: Boolean(row.tokensEnc),
      email: row.email || null,
      tokensEnc: row.tokensEnc || null,
    };
  } catch (err) {
    if (isColumnMissing(err)) {
      // Migration not applied live yet → feature is not live → treat as OFF.
      return { enabled: false, connected: false, email: null, tokensEnc: null, notMigrated: true };
    }
    throw err;
  }
}

// Persist an encrypted token set + connected email for a tenant (raw SQL, drift-safe).
async function saveTenantTokens(tenantId, { tokensEnc, email }) {
  try {
    await prisma.$executeRaw`
      UPDATE "Tenant"
      SET "googleTokensEnc" = ${tokensEnc}, "googleConnectedEmail" = ${email}
      WHERE "id" = ${tenantId}`;
  } catch (err) {
    if (isColumnMissing(err)) {
      throw new GoogleIntegrationError(
        'Google integration columns are not migrated on this database yet. Apply migration 5_google_integration first.',
        { status: 503, code: 'not_migrated' }
      );
    }
    throw err;
  }
}

// Clear a tenant's stored tokens (disconnect). Drift-safe.
export async function disconnectTenantGoogle(tenantId) {
  try {
    await prisma.$executeRaw`
      UPDATE "Tenant"
      SET "googleTokensEnc" = NULL, "googleConnectedEmail" = NULL
      WHERE "id" = ${tenantId}`;
    return { disconnected: true };
  } catch (err) {
    if (isColumnMissing(err)) return { disconnected: false, notMigrated: true };
    throw err;
  }
}

// ── OAuth state nonce (CSRF + server-side tenant binding) ────────────────────
// The OAuth `state` param is attacker-observable and replayable, so we NEVER trust
// a tenantId carried inside it. Instead /connect mints a random, single-use,
// short-TTL nonce here, bound SERVER-SIDE to the initiating tenantId; the public
// /callback resolves the incoming state back to its tenant via consumeOAuthState()
// (which deletes the row on first hit → replay-proof). All raw SQL + drift-safe.

// Create a fresh single-use state nonce bound to a tenant. Returns the state string.
// Requires the 5_google_integration migration applied (GoogleOAuthState table live);
// surfaces the not-migrated case as a clear 503 like the other write paths.
export async function createOAuthState(tenantId) {
  if (!tenantId) throw new GoogleIntegrationError('Missing tenant for OAuth state', { status: 400 });
  const state = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  try {
    await prisma.$executeRaw`
      INSERT INTO "GoogleOAuthState" ("state", "tenantId", "expiresAt")
      VALUES (${state}, ${tenantId}, ${expiresAt})`;
  } catch (err) {
    if (isColumnMissing(err) || isTableMissing(err)) {
      throw new GoogleIntegrationError(
        'Google integration is not migrated on this database yet. Apply migration 5_google_integration first.',
        { status: 503, code: 'not_migrated' }
      );
    }
    throw err;
  }
  return state;
}

// Atomically consume a state nonce: DELETE the matching, unexpired row and RETURN
// its tenantId in one statement — so the row is single-use (a replay finds nothing)
// and there is no read-then-write TOCTOU window (AP-T72). Returns the tenantId on a
// valid, unexpired, not-yet-consumed state; null for missing/unknown/expired/reused.
export async function consumeOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const now = new Date();
  try {
    const rows = await prisma.$queryRaw`
      DELETE FROM "GoogleOAuthState"
      WHERE "state" = ${state} AND "expiresAt" > ${now}
      RETURNING "tenantId"`;
    const tenantId = rows?.[0]?.tenantId || null;
    // Best-effort GC of the reused/expired row for this state (keeps the table small);
    // never fatal. A row that survived the WHERE (expired) is removed here so a later
    // replay can't even distinguish "expired" from "unknown".
    if (!tenantId) {
      try {
        await prisma.$executeRaw`DELETE FROM "GoogleOAuthState" WHERE "state" = ${state}`;
      } catch { /* GC is best-effort */ }
    }
    return tenantId;
  } catch (err) {
    if (isColumnMissing(err) || isTableMissing(err)) return null; // feature not live → reject
    throw err;
  }
}

// ── OAuth 2.0 ────────────────────────────────────────────────────────────────
// Build a fresh OAuth2 client from the platform app credentials.
function oauthClient() {
  if (!googlePlatformConfigured()) {
    throw new GoogleIntegrationError(
      'Google integration is not configured on the server (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).',
      { status: 503, code: 'not_configured' }
    );
  }
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

// Build the Google consent-screen URL for a tenant. `state` carries the tenantId
// (signed/opaque to Google) so the callback knows which tenant to attach tokens to.
// Requires: platform configured + tenant flag ON. Does NOT require an existing
// connection (that's what this flow creates).
export function buildAuthUrl({ tenantId, state }) {
  const client = oauthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // request a refresh token
    prompt: 'consent', // force refresh-token issue even on re-consent
    scope: config.google.scopes,
    include_granted_scopes: true,
    state: state || tenantId,
  });
}

// Exchange an authorization code for a token set and persist it (encrypted) on the
// tenant. Returns { email }. Requires platform configured; tenant flag is checked
// by the route before calling this.
export async function exchangeCodeAndStore({ tenantId, code }) {
  if (!code) throw new GoogleIntegrationError('Missing authorization code', { status: 400 });
  const client = oauthClient();
  const { tokens } = await client.getToken(code); // throws on a bad/expired code
  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
    throw new GoogleIntegrationError('Google returned no usable tokens', { status: 502 });
  }

  // Best-effort resolve the connected account email (never fatal).
  let email = null;
  try {
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    email = me?.data?.email || null;
  } catch {
    /* email is cosmetic; ignore lookup failures */
  }

  await saveTenantTokens(tenantId, { tokensEnc: encryptSecret(JSON.stringify(tokens)), email });
  return { email };
}

// Resolve an authorized OAuth2 client for a tenant, enforcing all three gates.
// Auto-refreshes the access token and re-persists the (possibly rotated) token set.
// Throws GoogleIntegrationError with a clear code if any gate fails.
export async function authorizedClientForTenant(tenantId) {
  if (!googlePlatformConfigured()) {
    throw new GoogleIntegrationError('Google integration is not configured on the server.', {
      status: 503,
      code: 'not_configured',
    });
  }
  const state = await getTenantGoogleState(tenantId);
  if (!state.enabled) {
    throw new GoogleIntegrationError('Google integration is not enabled for this tenant.', {
      status: 403,
      code: 'not_enabled',
    });
  }
  if (!state.connected || !state.tokensEnc) {
    throw new GoogleIntegrationError('This tenant has not connected a Google account yet.', {
      status: 409,
      code: 'not_connected',
    });
  }

  let tokens;
  try {
    tokens = JSON.parse(decryptSecret(state.tokensEnc));
  } catch {
    throw new GoogleIntegrationError('Stored Google tokens are corrupt; reconnect the account.', {
      status: 409,
      code: 'token_corrupt',
    });
  }

  const client = oauthClient();
  client.setCredentials(tokens);

  // Persist a rotated token set (Google issues a new access_token on refresh, and
  // occasionally a new refresh_token) so we never lose the refresh grant.
  client.on('tokens', async (fresh) => {
    try {
      const merged = { ...tokens, ...fresh };
      await saveTenantTokens(tenantId, {
        tokensEnc: encryptSecret(JSON.stringify(merged)),
        email: state.email,
      });
    } catch (e) {
      console.error(`[google ${tenantId}] failed to persist refreshed tokens:`, e.message);
    }
  });

  return client;
}

// ── Calendar ─────────────────────────────────────────────────────────────────
// Create a calendar event on the tenant's connected Google Calendar.
// eventDetails: { summary, description?, start (ISO), end (ISO), timeZone?,
//                 attendees?: [{email}], calendarId? }
export async function createCalendarEvent(tenantId, eventDetails = {}) {
  const auth = await authorizedClientForTenant(tenantId);
  const calendar = google.calendar({ version: 'v3', auth });
  const { summary, description, start, end, timeZone, attendees, calendarId = 'primary' } =
    eventDetails;
  if (!summary || !start || !end) {
    throw new GoogleIntegrationError('createCalendarEvent requires { summary, start, end }', {
      status: 400,
    });
  }
  const tz = timeZone || 'Asia/Jerusalem';
  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description: description || undefined,
      start: { dateTime: start, timeZone: tz },
      end: { dateTime: end, timeZone: tz },
      attendees: Array.isArray(attendees) ? attendees : undefined,
    },
  });
  return { id: res.data.id, htmlLink: res.data.htmlLink, status: res.data.status };
}

// Check availability: return the busy intervals in a time range (freebusy query).
// timeRange: { start (ISO), end (ISO), calendarId? } → { busy: [{start,end}], free: boolean }
export async function checkAvailability(tenantId, timeRange = {}) {
  const auth = await authorizedClientForTenant(tenantId);
  const calendar = google.calendar({ version: 'v3', auth });
  const { start, end, calendarId = 'primary' } = timeRange;
  if (!start || !end) {
    throw new GoogleIntegrationError('checkAvailability requires { start, end }', { status: 400 });
  }
  const res = await calendar.freebusy.query({
    requestBody: { timeMin: start, timeMax: end, items: [{ id: calendarId }] },
  });
  const busy = res.data.calendars?.[calendarId]?.busy || [];
  return { busy, free: busy.length === 0 };
}

// ── Gmail ────────────────────────────────────────────────────────────────────
// Send an email as the connected Google account.
// message: { to, subject, text, from? }
export async function sendEmail(tenantId, message = {}) {
  const auth = await authorizedClientForTenant(tenantId);
  const gmail = google.gmail({ version: 'v1', auth });
  const { to, subject, text, from } = message;
  if (!to || !subject) {
    throw new GoogleIntegrationError('sendEmail requires { to, subject }', { status: 400 });
  }
  const headers = [
    from ? `From: ${from}` : null,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
  ].filter(Boolean);
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${text || ''}`)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { id: res.data.id, threadId: res.data.threadId };
}

// List recent emails (metadata only). opts: { maxResults?, q? }
export async function listRecentEmails(tenantId, opts = {}) {
  const auth = await authorizedClientForTenant(tenantId);
  const gmail = google.gmail({ version: 'v1', auth });
  const { maxResults = 10, q } = opts;
  const list = await gmail.users.messages.list({ userId: 'me', maxResults, q });
  const ids = (list.data.messages || []).map((m) => m.id);
  // Fetch light metadata for each (subject/from/date) without message bodies.
  const messages = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    const h = Object.fromEntries((msg.data.payload?.headers || []).map((x) => [x.name, x.value]));
    messages.push({ id, snippet: msg.data.snippet, subject: h.Subject, from: h.From, date: h.Date });
  }
  return { messages };
}
