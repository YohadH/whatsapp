// ESM loader hook for the Google-integration behavioral test. It substitutes TWO
// modules so the test exercises the REAL service/route/crypto/gate logic while
// mocking ONLY the two external boundaries (the DB and the Google HTTP API):
//
//   1. `../lib/prisma.js`  → an in-memory Tenant store that faithfully implements
//      the raw-SQL tagged-template calls the service/routes use ($queryRaw /
//      $executeRaw). A module-level MIGRATED flag lets the test prove BOTH the
//      "columns not migrated live → degrade to OFF" path AND the fully-live path
//      (when not migrated, the store throws a Prisma-P2022-shaped error exactly
//      like the live DB does today).
//
//   2. `googleapis` → a fake `google` whose OAuth2 token exchange and Calendar API
//      are stubbed (the Google HTTP boundary — the only thing we can't hit without
//      real OAuth client credentials). Everything the service does AROUND those
//      calls (building the auth URL, encrypting/persisting the token set, the
//      three-gate check, request assembly) runs for real.
//
// Registered via:  node --import ./scripts/register-google-integration-loader.mjs <script>
import { pathToFileURL } from 'node:url';

// ── In-memory prisma stub source ─────────────────────────────────────────────
// A tagged-template $queryRaw/$executeRaw needs to inspect the SQL text. We keep a
// tiny store keyed by tenant id and pattern-match the (small, known) set of SQL
// statements the service + admin route issue.
const PRISMA_STUB = `
globalThis.__G = globalThis.__G || {
  migrated: false,           // simulate the live DB (columns NOT applied yet)
  tenants: new Map(),        // id -> { googleIntegrationEnabled, googleTokensEnc, googleConnectedEmail }
  oauthStates: new Map(),    // state -> { tenantId, expiresAt } (GoogleOAuthState table)
};
const G = globalThis.__G;
if (!G.oauthStates) G.oauthStates = new Map();

function p2022(col) {
  const err = new Error('The column \`Tenant.' + col + '\` does not exist in the current database.');
  err.code = 'P2022';
  return err;
}
function p2021(rel) {
  const err = new Error('The table \`public.' + rel + '\` does not exist in the current database.');
  err.code = 'P2021';
  return err;
}
// Reconstruct the SQL string from a tagged-template strings array.
function sqlText(strings) { return Array.isArray(strings) ? strings.join('?') : String(strings); }

const prisma = {
  async \$queryRaw(strings, ...vals) {
    const sql = sqlText(strings.raw || strings);
    if (/SELECT\\s+"googleIntegrationEnabled"/i.test(sql)) {
      if (!G.migrated) throw p2022('googleIntegrationEnabled');
      const id = vals[0];
      const t = G.tenants.get(id);
      if (!t) return [];
      return [{ enabled: !!t.googleIntegrationEnabled, tokensEnc: t.googleTokensEnc || null, email: t.googleConnectedEmail || null }];
    }
    // consumeOAuthState: DELETE ... WHERE state=? AND expiresAt>now RETURNING tenantId
    if (/DELETE\\s+FROM\\s+"GoogleOAuthState"/i.test(sql) && /RETURNING/i.test(sql)) {
      if (!G.migrated) throw p2021('GoogleOAuthState');
      const state = vals[0]; const now = vals[1];
      const row = G.oauthStates.get(state);
      if (!row) return [];
      const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
      const expMs = row.expiresAt instanceof Date ? row.expiresAt.getTime() : new Date(row.expiresAt).getTime();
      if (expMs > nowMs) {
        // valid + unexpired → consume (single-use) and return the tenant.
        G.oauthStates.delete(state);
        return [{ tenantId: row.tenantId }];
      }
      // expired: the WHERE excludes it → return nothing (the row stays for the GC delete).
      return [];
    }
    throw new Error('unexpected \$queryRaw: ' + sql);
  },
  async \$executeRaw(strings, ...vals) {
    const sql = sqlText(strings.raw || strings);
    // createOAuthState: INSERT INTO "GoogleOAuthState" (state, tenantId, expiresAt)
    if (/INSERT\\s+INTO\\s+"GoogleOAuthState"/i.test(sql)) {
      if (!G.migrated) throw p2021('GoogleOAuthState');
      const state = vals[0]; const tenantId = vals[1]; const expiresAt = vals[2];
      G.oauthStates.set(state, { tenantId, expiresAt });
      return 1;
    }
    // consumeOAuthState best-effort GC: DELETE FROM "GoogleOAuthState" WHERE state=?
    if (/DELETE\\s+FROM\\s+"GoogleOAuthState"/i.test(sql)) {
      if (!G.migrated) throw p2021('GoogleOAuthState');
      const state = vals[0];
      G.oauthStates.delete(state);
      return 1;
    }
    if (/UPDATE\\s+"Tenant"\\s+SET\\s+"googleIntegrationEnabled"/i.test(sql)) {
      if (!G.migrated) throw p2022('googleIntegrationEnabled');
      const enabled = vals[0]; const id = vals[1];
      const t = G.tenants.get(id) || {}; t.googleIntegrationEnabled = enabled; G.tenants.set(id, t);
      return 1;
    }
    if (/UPDATE\\s+"Tenant"\\s+SET\\s+"googleTokensEnc"\\s*=\\s*NULL/i.test(sql)) {
      if (!G.migrated) throw p2022('googleTokensEnc');
      const id = vals[0]; const t = G.tenants.get(id) || {};
      t.googleTokensEnc = null; t.googleConnectedEmail = null; G.tenants.set(id, t);
      return 1;
    }
    if (/UPDATE\\s+"Tenant"\\s+SET\\s+"googleTokensEnc"/i.test(sql)) {
      if (!G.migrated) throw p2022('googleTokensEnc');
      const tokensEnc = vals[0]; const email = vals[1]; const id = vals[2];
      const t = G.tenants.get(id) || {}; t.googleTokensEnc = tokensEnc; t.googleConnectedEmail = email; G.tenants.set(id, t);
      return 1;
    }
    throw new Error('unexpected \$executeRaw: ' + sql);
  },
  tenant: {
    async findUnique(args) { const id = args?.where?.id; return G.tenants.has(id) ? { id } : null; },
  },
};
export default prisma;
`;

// ── Fake googleapis source ───────────────────────────────────────────────────
// Only the OAuth token exchange + Calendar insert/freebusy + Gmail send/list are
// stubbed. generateAuthUrl is implemented for real-ish (builds a proper URL) so
// the test can assert scopes/redirect are correct.
const GOOGLEAPIS_STUB = `
globalThis.__GAPI = globalThis.__GAPI || { lastEventInsert: null, lastFreebusy: null, lastGmailSend: null };
const CALLS = globalThis.__GAPI;

class OAuth2 {
  constructor(clientId, clientSecret, redirectUri) {
    this.clientId = clientId; this.clientSecret = clientSecret; this.redirectUri = redirectUri; this.credentials = {};
    this._handlers = {};
  }
  generateAuthUrl(opts = {}) {
    const p = new URLSearchParams();
    p.set('client_id', this.clientId);
    p.set('redirect_uri', this.redirectUri);
    p.set('response_type', 'code');
    p.set('access_type', opts.access_type || 'offline');
    if (opts.prompt) p.set('prompt', opts.prompt);
    p.set('scope', (opts.scope || []).join(' '));
    if (opts.state) p.set('state', opts.state);
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
  }
  async getToken(code) {
    if (code === 'BAD_CODE') { const e = new Error('invalid_grant'); e.response = { status: 400 }; throw e; }
    return { tokens: { access_token: 'ya29.mock-access', refresh_token: '1//mock-refresh', scope: 'calendar gmail', expiry_date: Date.now() + 3600e3 } };
  }
  setCredentials(c) { this.credentials = c; }
  on(evt, fn) { this._handlers[evt] = fn; }
}

function makeGoogle() {
  return {
    auth: { OAuth2 },
    oauth2() { return { userinfo: { get: async () => ({ data: { email: 'owner@example-tenant.com' } }) } }; },
    calendar() {
      return {
        events: { insert: async (args) => { CALLS.lastEventInsert = args; return { data: { id: 'evt_mock_123', htmlLink: 'https://calendar.google.com/event?eid=mock', status: 'confirmed' } }; } },
        freebusy: { query: async (args) => { CALLS.lastFreebusy = args; const cal = args.requestBody.items[0].id; return { data: { calendars: { [cal]: { busy: [{ start: '2026-08-01T10:00:00Z', end: '2026-08-01T11:00:00Z' }] } } } }; } },
      };
    },
    gmail() {
      return {
        users: {
          messages: {
            send: async (args) => { CALLS.lastGmailSend = args; return { data: { id: 'msg_mock_1', threadId: 'thr_mock_1' } }; },
            list: async () => ({ data: { messages: [{ id: 'm1' }] } }),
            get: async () => ({ data: { snippet: 'hi', payload: { headers: [{ name: 'Subject', value: 'Test' }, { name: 'From', value: 'a@b.com' }] } } }),
          },
        },
      };
    },
  };
}
export const google = makeGoogle();
export default { google };
`;

function isPrismaModule(url) {
  return url.endsWith('/lib/prisma.js') || url.endsWith('\\lib\\prisma.js');
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'googleapis') {
    return { url: 'gapi-stub:googleapis', shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  if (isPrismaModule(resolved.url)) {
    return { url: 'gapi-stub:prisma', shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url === 'gapi-stub:prisma') return { format: 'module', source: PRISMA_STUB, shortCircuit: true };
  if (url === 'gapi-stub:googleapis') return { format: 'module', source: GOOGLEAPIS_STUB, shortCircuit: true };
  return nextLoad(url, context);
}
