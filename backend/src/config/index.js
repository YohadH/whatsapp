import dotenv from 'dotenv';
dotenv.config();

const isProd = (process.env.NODE_ENV || 'development') === 'production';

// Fail fast in production if security-critical secrets are missing or left at
// their insecure dev defaults, rather than silently running exploitable.
const DEV_JWT_SECRET = 'dev-insecure-secret-change-me';
if (isProd) {
  const problems = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push('JWT_SECRET is missing or set to the insecure default');
  }
  if (!process.env.CREDENTIALS_ENC_KEY) {
    problems.push('CREDENTIALS_ENC_KEY is missing (required to store tenant WhatsApp tokens)');
  }
  if (problems.length) {
    throw new Error(`Refusing to boot in production:\n  - ${problems.join('\n  - ')}`);
  }
}

const config = {
  port: parseInt(process.env.PORT || '4010', 10),
  env: process.env.NODE_ENV || 'development',
  isProd,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4000',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwt: {
    secret: process.env.JWT_SECRET || DEV_JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // Key for encrypting per-tenant secrets (WhatsApp tokens) at rest.
  credentials: {
    encKey: process.env.CREDENTIALS_ENC_KEY || '',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    enabled: Boolean(process.env.OPENAI_API_KEY),
  },

  legal: {
    appName: process.env.LEGAL_APP_NAME || 'WhatsApp Business AI Agent',
    companyName: process.env.LEGAL_COMPANY_NAME || 'Your Company',
    contactEmail: process.env.LEGAL_CONTACT_EMAIL || 'support@example.com',
    websiteUrl: process.env.LEGAL_WEBSITE_URL || '',
    effectiveDate: process.env.LEGAL_EFFECTIVE_DATE || '2026-06-09',
  },

  bio: {
    // Public link page at /l — title/subtitle can be overridden via env.
    title: process.env.BIO_TITLE || 'ישראל בידור',
    subtitle: process.env.BIO_SUBTITLE || 'עקבו אחרינו 🎬',
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'voice-notes',
    // When configured, uploads go to Supabase Storage (persists across Render
    // deploys). Otherwise uploads fall back to local disk (dev convenience).
    enabled: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  },

  // Platform-hosted numbers: connect a customer's number by having them type it +
  // enter the verification code, registered under OUR own WABA via the Cloud API
  // (no Embedded Signup popup). Requires an approved Tech Provider app + a platform
  // WABA + system-user token. Falls back to the master WhatsApp creds if the
  // dedicated PLATFORM_* vars aren't set. `pin` is the 2-step PIN set on register.
  platformWaba: {
    id: process.env.PLATFORM_WABA_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    token: process.env.PLATFORM_WA_TOKEN || process.env.WHATSAPP_TOKEN || '',
    pin: process.env.PLATFORM_WA_PIN || '',
    graphVersion: process.env.META_GRAPH_VERSION || process.env.WHATSAPP_API_VERSION || 'v21.0',
    enabled: Boolean(
      (process.env.PLATFORM_WABA_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) &&
        (process.env.PLATFORM_WA_TOKEN || process.env.WHATSAPP_TOKEN)
    ),
  },

  // Meta app used for Embedded Signup (onboarding a customer's WABA in a few
  // clicks). appSecret is the same Meta app secret used for webhook verification.
  meta: {
    appId: process.env.META_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET || '',
    configId: process.env.META_CONFIG_ID || '', // Embedded Signup configuration id
    graphVersion: process.env.META_GRAPH_VERSION || process.env.WHATSAPP_API_VERSION || 'v21.0',
  },

  // Owner handoff notification (system-gap-analysis §2.4): when a conversation's
  // needsHuman flips true, WhatsApp the business owner's own number with context.
  // notifyPhone is the owner's E.164 number (digits only, e.g. 972501234567).
  // Leave empty to disable the alert (the DB flag + dashboard still work).
  // adminBaseUrl builds the "open conversation" link; falls back to the first
  // CORS origin (the admin SPA) when unset.
  handoff: {
    notifyPhone: (process.env.HANDOFF_NOTIFY_PHONE || '').replace(/[^\d]/g, ''),
    adminBaseUrl: process.env.ADMIN_APP_URL || '',
  },

  // Error tracking (no-op unless SENTRY_DSN is set).
  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
  },

  // Credit-pack payments. 'manual' = super-admin approves top-ups (default until an
  // Israeli card gateway + merchant account are set up). See services/payments.js.
  //
  // PayPlus (Israeli card gateway) is the wired real provider. Set PAYMENTS_PROVIDER=payplus
  // and supply the four PAYPLUS_* vars to go live. `payplus.enabled` is false (falls back to
  // 'manual') until an api-key/secret-key/page-uid trio is present, so a mis-set provider can
  // never leave a tenant unable to top up. baseUrl defaults to production; point it at the
  // PayPlus sandbox host for test-mode verification.
  payments: {
    provider: process.env.PAYMENTS_PROVIDER || 'manual', // manual | payplus | meshulam | cardcom
    payplus: {
      // REST base — production; override with the sandbox host to test end-to-end.
      baseUrl: process.env.PAYPLUS_BASE_URL || 'https://restapi.payplus.co.il/api/v1.0',
      apiKey: process.env.PAYPLUS_API_KEY || '',
      secretKey: process.env.PAYPLUS_SECRET_KEY || '',
      // The Payment Page UID from the PayPlus dashboard (which hosted page to open).
      paymentPageUid: process.env.PAYPLUS_PAYMENT_PAGE_UID || '',
      // charge_method: 1 = charge (immediate). 0 = approval only, 2 = recurring, etc.
      chargeMethod: parseInt(process.env.PAYPLUS_CHARGE_METHOD || '1', 10),
      // PayPlus signs the callback `hash` header = HMAC-SHA256(rawBody, secretKey). Their
      // docs use base64; kept configurable ('base64' | 'hex') for the sandbox-confirm step.
      hashEncoding: process.env.PAYPLUS_HASH_ENCODING || 'base64',
      enabled: Boolean(
        process.env.PAYPLUS_API_KEY &&
          process.env.PAYPLUS_SECRET_KEY &&
          process.env.PAYPLUS_PAYMENT_PAGE_UID
      ),
    },
  },

  // ── Google integration (Gmail + Calendar), OFF by default ──────────────────
  // A paid, per-tenant add-on. This block only holds the OAuth *app* credentials
  // (one Google Cloud project for the whole platform); whether a given tenant may
  // use it is a per-tenant DB flag (Tenant.googleIntegrationEnabled), NOT this.
  //
  // `enabled` here means "the platform has OAuth client credentials configured",
  // i.e. the Connect flow is *installable* — it does NOT auto-enable the feature
  // for any tenant. Until the owner registers a Google Cloud OAuth client and sets
  // these three vars, the Connect/callback routes return a clear "not configured"
  // response and nothing is exposed.
  //   - redirectUri MUST exactly match an Authorized redirect URI in the Google
  //     Cloud Console OAuth client, e.g. https://<host>/api/integrations/google/callback
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    // Falls back to publicBaseUrl + the callback path when unset.
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ||
      `${(process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, '')}/api/integrations/google/callback`,
    // Calendar (read+write events) + Gmail (send + read). Kept minimal; scopes are
    // requested at consent time and encoded into the stored token.
    scopes: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'openid',
      'email',
    ],
    enabled: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  },

  // ── Meta (WhatsApp) conversation-cost rate card ────────────────────────────
  // Per-tenant Meta-cost visibility (system-gap-analysis §2.7 + §4 / WA-DEV-META-COST).
  // Meta bills WhatsApp Business conversations by PRICING CATEGORY (the `pricing.category`
  // field on the webhook's `statuses[]` events). We estimate Meta's cost per conversation
  // from this rate card so the super-admin margin view can compare price charged vs real
  // Meta cost per tenant per month.
  //
  // IMPORTANT — these are PLACEHOLDER values, NOT real Meta prices. `placeholder` is TRUE
  // and every rate is 0 by default, so the margin view NEVER shows a fabricated/authoritative
  // Meta cost until the owner drops in the real rate-card numbers from Meta's published
  // pricing for the relevant market (https://developers.facebook.com/docs/whatsapp/pricing).
  // Rates are in whole cents of `currency` per conversation (Meta bills per 24h conversation,
  // per category). Fill META_RATE_* env vars (or edit this block) with the real per-conversation
  // rates for your billing market, then set META_PRICING_PLACEHOLDER=false.
  //
  // NOTE: Meta's Oct-2026 pricing change (§4) may move to per-message template pricing and
  // retire the "service"/conversation categories — this table is the single place to update
  // when that lands, so a pricing-model change becomes visible the moment it happens.
  metaPricing: {
    // When true, costEstimate is recorded but the margin view flags Meta cost as an
    // UNCALIBRATED placeholder (do not treat as real money). Owner sets false after
    // filling real rates.
    placeholder: process.env.META_PRICING_PLACEHOLDER
      ? process.env.META_PRICING_PLACEHOLDER !== 'false'
      : true,
    // ISO currency of the rates below (Meta bills in USD by default; some markets differ).
    currency: process.env.META_PRICING_CURRENCY || 'USD',
    // Per-conversation rate by pricing category, in whole CENTS. 0 = unset placeholder.
    // Meta's current categories: marketing | utility | authentication | service.
    // Legacy/webhook-origin values (business_initiated | user_initiated | referral_conversion)
    // are normalized onto these by services/metaCost.js#normalizeCategory().
    ratesCents: {
      marketing: parseInt(process.env.META_RATE_MARKETING_CENTS || '0', 10),
      utility: parseInt(process.env.META_RATE_UTILITY_CENTS || '0', 10),
      authentication: parseInt(process.env.META_RATE_AUTH_CENTS || '0', 10),
      service: parseInt(process.env.META_RATE_SERVICE_CENTS || '0', 10),
      // Fallback for an unknown/unmapped category (still 0 by default).
      unknown: parseInt(process.env.META_RATE_UNKNOWN_CENTS || '0', 10),
    },
  },

  // Per-tenant plan usage window (messagesThisPeriod resets after this many days).
  usage: {
    periodDays: parseInt(process.env.USAGE_PERIOD_DAYS || '30', 10),
  },

  broadcast: {
    // Default rolling-24h send cap for a new tenant (per plan; overridable per
    // tenant). Kept under a typical Meta messaging tier to leave room for
    // agent-initiated sends and retries.
    defaultDailyCap: parseInt(process.env.BROADCAST_DEFAULT_DAILY_CAP || '250', 10),
    // Optional deployment-wide hard ceiling clamping every tenant's cap (0 = off).
    platformMax: parseInt(process.env.BROADCAST_PLATFORM_MAX || '0', 10),
    // Floor for the delay between sends; campaigns can run slower, not faster.
    defaultThrottleMs: parseInt(process.env.BROADCAST_THROTTLE_MS || '300', 10),
    // Abort a campaign after this many consecutive failures.
    maxConsecutiveFailures: parseInt(process.env.BROADCAST_MAX_CONSECUTIVE_FAILURES || '15', 10),
  },

  whatsapp: {
    // These env creds are the OPTIONAL "master" fallback (single-tenant mode /
    // migration): the backfill copies them into the default tenant. In
    // multi-tenant operation each tenant carries its own credentials in the DB.
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '', // WABA ID — needed to list message templates
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'my-verify-token',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    // Meta app secret — used to verify inbound webhook signatures (X-Hub-Signature-256).
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    enabled: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
  },
};

export default config;
