import { Router } from 'express';
import prisma from '../lib/prisma.js';
import config from '../config/index.js';
import { asyncHandler } from '../middleware/error.js';
import { encryptSecret } from '../lib/crypto.js';
import { repliesToday, FREE_DAILY_AI_REPLIES } from '../lib/aiDailyQuota.js';
import { checkToken } from '../services/whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { connectWhatsApp, embeddedSignupPublicConfig } from '../services/embeddedSignup.js';
import {
  platformNumberingConfigured,
  startNumberConnect,
  verifyAndRegister,
  splitPhone,
} from '../services/numberRegistration.js';
import { WEBHOOK_SLUGS, isSafeWebhookUrl, deliverToUrl } from '../services/outboundWebhook.js';
import { getNichePack } from '../data/nichePacks.js';
import { testReplyProvider } from '../services/replyProvider.js';
import { generateKey, API_SCOPES, isValidScope } from '../lib/apiKeys.js';

// Tenant-facing account settings, scoped to the caller's OWN tenant (req.tenantId,
// set by withTenant). This lets a tenant admin self-connect their WhatsApp number
// via Meta Embedded Signup, mirroring the super-admin flow in routes/admin.js but
// always acting on their own tenant — never another's.
const router = Router();

// GET /api/settings/whatsapp → current connection state (never the token itself).
router.get(
  '/whatsapp',
  asyncHandler(async (req, res) => {
    const t = req.tenant;
    res.json({
      phoneNumberId: t.waPhoneNumberId || null,
      businessAccountId: t.waBusinessAccountId || null,
      apiVersion: t.waApiVersion || null,
      connected: Boolean(t.waTokenEnc && t.waPhoneNumberId),
      embeddedSignup: embeddedSignupPublicConfig(),
      platformNumbering: platformNumberingConfigured(),
    });
  })
);

// ── Business profile (onboarding step 1) ─────────────────────────────────────
// GET/PUT the tenant's own display name. Deliberately name-only: plan, caps and
// entitlements stay super-admin-governed in routes/admin.js.
router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    // req.tenant comes from TENANT_SELECT (no name); read the fields directly.
    const t = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: { name: true, ownerPhone: true, logoUrl: true, niche: true },
    });
    res.json({ name: t?.name || '', ownerPhone: t?.ownerPhone || '', logoUrl: t?.logoUrl || '', niche: t?.niche || '' });
  })
);

router.put(
  '/profile',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'שם העסק לא יכול להיות ריק' });
    if (name.length > 80) return res.status(400).json({ error: 'שם העסק ארוך מדי (עד 80 תווים)' });
    const data = { name };
    // ownerPhone (optional): digits-only international-ish; empty clears it.
    if ('ownerPhone' in (req.body || {})) {
      const digits = String(req.body.ownerPhone || '').replace(/\D/g, '');
      if (digits && (digits.length < 9 || digits.length > 15)) {
        return res.status(400).json({ error: 'מספר הטלפון של בעל/ת העסק לא תקין' });
      }
      data.ownerPhone = digits || null;
    }
    // logoUrl (optional): a public image URL (from /api/uploads/image); empty clears it.
    if ('logoUrl' in (req.body || {})) {
      const url = String(req.body.logoUrl || '').trim();
      if (url && !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'כתובת הלוגו אינה תקינה' });
      }
      if (url.length > 500) return res.status(400).json({ error: 'כתובת הלוגו ארוכה מדי' });
      data.logoUrl = url || null;
    }
    // niche (optional): the business vertical → drives per-niche integration recos.
    // Only the field is changed here; existing content (KB/flows) is left intact.
    if ('niche' in (req.body || {})) {
      const n = String(req.body.niche || '');
      if (n && !getNichePack(n)) return res.status(400).json({ error: 'תחום לא מוכר' });
      data.niche = n || null;
    }
    const t = await prisma.tenant.update({ where: { id: req.tenantId }, data });
    res.json({ name: t.name, ownerPhone: t.ownerPhone || '', logoUrl: t.logoUrl || '', niche: t.niche || '' });
  })
);

// ── AI provider (BYO key — Phase 3.1) ────────────────────────────────────────
// GET returns the provider + model + whether a key is stored (never the key).
// PUT sets provider/model/key; provider 'platform' (or empty) clears BYO and
// reverts to the platform OpenAI key + credits.
const AI_PROVIDERS = {
  openai: { label: 'OpenAI (ChatGPT)', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini'] },
  anthropic: { label: 'Anthropic (Claude)', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'] },
};

router.get(
  '/ai',
  asyncHandler(async (req, res) => {
    const t = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: { aiProvider: true, aiModel: true, aiApiKeyEnc: true, aiEnabled: true, aiDailyCount: true, aiDailyDate: true },
    });
    const byo = Boolean(t?.aiProvider && t?.aiApiKeyEnc);
    res.json({
      providers: AI_PROVIDERS,
      provider: t?.aiProvider || 'platform',
      model: t?.aiModel || '',
      hasKey: Boolean(t?.aiApiKeyEnc),
      // Master switch + today's free-reply usage (so the owner sees "used 3/10 today").
      // BYO-key tenants pay their own provider, so the daily cap doesn't apply to them.
      enabled: t?.aiEnabled !== false,
      byo,
      dailyLimit: FREE_DAILY_AI_REPLIES,
      usedToday: repliesToday(t),
    });
  })
);

// Toggle automatic AI replies on/off (the opt-in master switch).
router.put(
  '/ai-enabled',
  asyncHandler(async (req, res) => {
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    await prisma.tenant.update({ where: { id: req.tenantId }, data: { aiEnabled: enabled } });
    res.json({ enabled });
  })
);

// ── Facebook Messenger + Instagram Direct connection ─────────────────────────
// Stored (encrypted) under tenant.integrations.meta = { pageId, igAccountId?, pageTokenEnc }.
// Inbound routes to the tenant by pageId (Messenger) / igAccountId (Instagram); outbound
// uses the Page token (services/metaMessaging.js). Paste-token connect for now; Embedded
// Signup can populate the same fields later.
const readMeta = (t) => (t?.integrations && typeof t.integrations === 'object' ? t.integrations.meta : null) || null;

router.get(
  '/meta',
  asyncHandler(async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { integrations: true } });
    const meta = readMeta(t);
    res.json({ connected: !!(meta?.pageId && meta?.pageTokenEnc), pageId: meta?.pageId || '', igAccountId: meta?.igAccountId || '' });
  })
);

router.put(
  '/meta',
  asyncHandler(async (req, res) => {
    const pageId = String(req.body?.pageId || '').trim();
    const igAccountId = String(req.body?.igAccountId || '').trim() || null;
    const pageToken = typeof req.body?.pageToken === 'string' ? req.body.pageToken.trim() : '';
    if (!pageId) return res.status(400).json({ error: 'נדרש Page ID' });
    const t = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { integrations: true } });
    const integrations = { ...(t?.integrations && typeof t.integrations === 'object' ? t.integrations : {}) };
    const prev = integrations.meta || {};
    const pageTokenEnc = pageToken ? encryptSecret(pageToken) : prev.pageTokenEnc;
    if (!pageTokenEnc) return res.status(400).json({ error: 'נדרש Page Access Token' });
    integrations.meta = { pageId, igAccountId, pageTokenEnc };
    await prisma.tenant.update({ where: { id: req.tenantId }, data: { integrations } });
    res.json({ connected: true, pageId, igAccountId });
  })
);

router.delete(
  '/meta',
  asyncHandler(async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { integrations: true } });
    const integrations = { ...(t?.integrations && typeof t.integrations === 'object' ? t.integrations : {}) };
    delete integrations.meta;
    await prisma.tenant.update({ where: { id: req.tenantId }, data: { integrations } });
    res.json({ connected: false });
  })
);

router.put(
  '/ai',
  asyncHandler(async (req, res) => {
    const provider = String(req.body?.provider || 'platform');
    // Revert to the platform key + credits.
    if (provider === 'platform' || provider === '') {
      await prisma.tenant.update({
        where: { id: req.tenantId },
        data: { aiProvider: null, aiModel: null, aiApiKeyEnc: null },
      });
      return res.json({ provider: 'platform', hasKey: false });
    }
    if (!AI_PROVIDERS[provider]) return res.status(400).json({ error: 'ספק AI לא נתמך' });
    const model = String(req.body?.model || '').trim() || AI_PROVIDERS[provider].models[0];
    const data = { aiProvider: provider, aiModel: model };
    // Key optional on update (keep the stored one if omitted); required if none stored yet.
    const rawKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (rawKey) {
      data.aiApiKeyEnc = encryptSecret(rawKey);
    } else {
      const existing = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { aiApiKeyEnc: true } });
      if (!existing?.aiApiKeyEnc) return res.status(400).json({ error: 'נדרש מפתח API' });
    }
    const t = await prisma.tenant.update({ where: { id: req.tenantId }, data });
    res.json({ provider: t.aiProvider, model: t.aiModel, hasKey: Boolean(t.aiApiKeyEnc) });
  })
);

// ── Connect by phone number (no Embedded Signup) ─────────────────────────────
// The customer types their number + a display name; we register it under the
// PLATFORM's WABA and Meta texts them a code, which they enter to finish.

// POST /api/settings/number/start → add the number to our WABA + trigger the code.
// body: { cc, phone, displayName, codeMethod? } → { phoneNumberId }
router.post(
  '/number/start',
  asyncHandler(async (req, res) => {
    const { cc, phoneNumber } = splitPhone(req.body?.cc, req.body?.phone);
    const displayName = (req.body?.displayName || '').trim();

    // Refuse if the fully-qualified number is already connected to another tenant.
    if (cc && phoneNumber) {
      const full = cc + phoneNumber;
      const clash = await prisma.tenant.findFirst({
        where: { waPhoneNumberId: full, NOT: { id: req.tenantId } },
        select: { id: true },
      });
      if (clash) return res.status(409).json({ error: 'מספר זה כבר מחובר לחשבון אחר' });
    }

    try {
      const { phoneNumberId } = await startNumberConnect({
        cc,
        phoneNumber,
        displayName,
        codeMethod: req.body?.codeMethod,
      });
      res.json({ phoneNumberId, status: 'code_sent' });
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message });
    }
  })
);

// POST /api/settings/number/verify → verify the code, register, store on the tenant.
// body: { phoneNumberId, code } → { connected, phoneNumberId }
router.post(
  '/number/verify',
  asyncHandler(async (req, res) => {
    const phoneNumberId = String(req.body?.phoneNumberId || '').trim();
    const code = req.body?.code;
    if (!phoneNumberId || !code) return res.status(400).json({ error: 'phoneNumberId and code are required' });

    // Guard against binding a number that another tenant already holds.
    const clash = await prisma.tenant.findFirst({
      where: { waPhoneNumberId: phoneNumberId, NOT: { id: req.tenantId } },
      select: { id: true },
    });
    if (clash) return res.status(409).json({ error: 'מספר זה כבר מחובר לחשבון אחר' });

    let result;
    try {
      result = await verifyAndRegister({ phoneNumberId, code });
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message });
    }

    await prisma.tenant.update({
      where: { id: req.tenantId },
      data: {
        waPhoneNumberId: result.phoneNumberId,
        waBusinessAccountId: result.wabaId,
        waTokenEnc: encryptSecret(result.token),
      },
    });
    res.json({ connected: true, phoneNumberId: result.phoneNumberId, businessAccountId: result.wabaId });
  })
);

// GET /api/settings/embedded-signup/config → public params to launch the FB flow.
router.get(
  '/embedded-signup/config',
  asyncHandler(async (req, res) => {
    res.json(embeddedSignupPublicConfig());
  })
);

// POST /api/settings/connect-whatsapp → complete Embedded Signup for THIS tenant.
// body: { code, phoneNumberId, wabaId }
router.post(
  '/connect-whatsapp',
  asyncHandler(async (req, res) => {
    const tenantId = req.tenantId;
    const { code, phoneNumberId, wabaId } = req.body || {};

    // Refuse if this number already belongs to a different tenant.
    if (phoneNumberId) {
      const clash = await prisma.tenant.findFirst({
        where: { waPhoneNumberId: phoneNumberId, NOT: { id: tenantId } },
        select: { id: true },
      });
      if (clash) return res.status(409).json({ error: 'מספר ה-WhatsApp הזה כבר מחובר לחשבון אחר' });
    }

    let result;
    try {
      result = await connectWhatsApp({ code, phoneNumberId, wabaId });
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message });
    }

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        waPhoneNumberId: result.phoneNumberId,
        waBusinessAccountId: result.wabaId,
        waTokenEnc: encryptSecret(result.token),
      },
    });

    res.json({
      connected: true,
      phoneNumberId: result.phoneNumberId,
      businessAccountId: result.wabaId,
      register: result.register,
    });
  })
);

// POST /api/settings/whatsapp/verify → live check that the stored token works.
router.post(
  '/whatsapp/verify',
  asyncHandler(async (req, res) => {
    res.json(await checkToken(tenantWhatsAppCreds(req.tenant)));
  })
);

// POST /api/settings/whatsapp/disconnect → detach the WhatsApp number from this
// tenant. Clears ONLY the credentials (token/phone/WABA/PIN) so the agent drops
// back to simulator mode — it deletes NO customer data: conversations, leads,
// flows, expenses and knowledge base all stay untouched, ready for reconnect.
router.post(
  '/whatsapp/disconnect',
  asyncHandler(async (req, res) => {
    await prisma.tenant.update({
      where: { id: req.tenantId },
      data: {
        waTokenEnc: null,
        waPhoneNumberId: null,
        waBusinessAccountId: null,
        waPin: null,
      },
    });
    res.json({ connected: false });
  })
);

// ── Integrations (owner-toggled connections) ─────────────────────────────────
// Catalog of connectable services the owner can switch on/off. Enabled-state is
// persisted per-tenant in Tenant.integrations (JSONB map of { slug: boolean }).
// These toggles record the tenant's INTENT to use a service — they do NOT grant
// any entitlement. In particular, the Google-group toggles (gmail/calendar/sheets)
// must NOT touch Tenant.googleIntegrationEnabled: that column is the PAID Google
// add-on entitlement gate, whose SOLE writer is the super-admin route
// POST /api/admin/tenants/:id/google-integration (routes/admin.js). Deriving it
// from a tenant-side toggle here would let a tenant self-grant the paid add-on for
// free, and let an unrelated toggle silently revoke an admin-granted entitlement.
// A tenant who flips a Google toggle on but has no admin-granted entitlement still
// hits 403 "not_enabled" at /api/integrations/google/connect (integrations.js
// requireGoogleEnabled), which re-reads googleIntegrationEnabled via the service.
const INTEGRATION_CATALOG = [
  { slug: 'gmail', label: 'Gmail', desc: 'שליחת מיילים אוטומטית מתוך השיחה', group: 'google' },
  { slug: 'calendar', label: 'Google Calendar', desc: 'תיאום פגישות ויצירת אירועים ביומן', group: 'google' },
  { slug: 'sheets', label: 'Google Sheets', desc: 'ייצוא לידים ותשובות לגיליון', group: 'google' },
  { slug: 'webhook', label: 'Webhook / CRM', desc: 'שליחת לידים ל-CRM או לכל מערכת חיצונית', group: null },
  { slug: 'calendly', label: 'Calendly', desc: 'קביעת פגישות דרך Calendly', group: null },
  { slug: 'zapier', label: 'Zapier / Make', desc: 'חיבור לאלפי אפליקציות דרך אוטומציה', group: null },
];
const CATALOG_SLUGS = new Set(INTEGRATION_CATALOG.map((i) => i.slug));

// Whether an integration is actually usable RIGHT NOW (built + platform-configured),
// so the UI only presents connectable integrations and never a dead toggle:
//   - Google group (gmail/calendar/sheets): real OAuth exists but is usable only when
//     the platform has Google OAuth app credentials (config.google.enabled). The
//     per-tenant paid add-on is a further gate handled by the GoogleConnect panel.
//   - webhook / calendly / zapier: connection flow not built yet → not ready ("בקרוב").
// Update a slug here the moment its connect flow ships.
function isIntegrationReady(slug) {
  if (['gmail', 'calendar', 'sheets'].includes(slug)) return Boolean(config.google.enabled);
  if (WEBHOOK_SLUGS.includes(slug)) return true; // outbound webhook — built, connect by URL
  return false;
}
// URL-configurable integrations render a connect form (URL + secret) instead of a
// plain on/off toggle.
function isConfigurable(slug) {
  return WEBHOOK_SLUGS.includes(slug);
}
// Catalog annotated with per-item readiness + per-NICHE recommendation, filtered to
// the tenant's vertical. Each item gets { ready, configurable, statusNote,
// recommended: 'must'|'recommended'|null }; the niche's `hide` slugs are dropped
// (e.g. a support account never sees Calendar), and recommended items sort to the top.
function catalogForTenant(tenant) {
  const pack = getNichePack(tenant?.niche);
  const rec = {};
  const hide = new Set();
  if (pack) {
    for (const s of pack.integrations?.must || []) rec[s] = 'must';
    for (const s of pack.integrations?.recommended || []) rec[s] = rec[s] || 'recommended';
    for (const s of pack.integrations?.hide || []) hide.add(s);
  }
  const items = INTEGRATION_CATALOG.filter((it) => !hide.has(it.slug)).map((it) => {
    const ready = isIntegrationReady(it.slug);
    return { ...it, ready, configurable: isConfigurable(it.slug), statusNote: ready ? null : 'בקרוב', recommended: rec[it.slug] || null };
  });
  const rank = (r) => (r === 'must' ? 0 : r === 'recommended' ? 1 : 2);
  items.sort((a, b) => rank(a.recommended) - rank(b.recommended));
  return { catalog: items, nicheLabel: pack ? pack.label : null };
}

// Read the tenant's integrationConfig JSON safely, returning per-slug public config
// (the URL + whether a secret is stored — never the secret itself).
function readIntegrationConfig(tenant) {
  const raw = tenant?.integrationConfig && typeof tenant.integrationConfig === 'object' ? tenant.integrationConfig : {};
  const out = {};
  for (const slug of WEBHOOK_SLUGS) {
    const c = raw[slug] || {};
    out[slug] = { url: c.url || '', hasSecret: Boolean(c.secret) };
  }
  return out;
}

// Normalize the stored JSON (which may be null, or hold stale slugs) into a clean
// { slug: boolean } map covering exactly the current catalog.
function readIntegrations(tenant) {
  const raw = tenant?.integrations && typeof tenant.integrations === 'object' ? tenant.integrations : {};
  const out = {};
  for (const item of INTEGRATION_CATALOG) out[item.slug] = raw[item.slug] === true;
  return out;
}

// GET /api/settings/integrations → catalog (with readiness) + enabled map + per-slug
// connection config (url + hasSecret, never the secret).
router.get(
  '/integrations',
  asyncHandler(async (req, res) => {
    const { catalog, nicheLabel } = catalogForTenant(req.tenant);
    res.json({
      catalog,
      nicheLabel,
      enabled: readIntegrations(req.tenant),
      config: readIntegrationConfig(req.tenant),
    });
  })
);

// PUT /api/settings/integrations/webhook → connect a webhook target.
// body: { slug: 'webhook'|'zapier', url, secret? }. Saving a valid URL enables the
// integration; secret (optional) is used to HMAC-sign outbound bodies. Empty url
// disconnects (clears config + disables).
router.put(
  '/integrations/webhook',
  asyncHandler(async (req, res) => {
    const slug = String(req.body?.slug || '');
    if (!WEBHOOK_SLUGS.includes(slug)) return res.status(400).json({ error: 'אינטגרציה לא נתמכת' });
    const url = String(req.body?.url || '').trim();

    const t = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { integrations: true, integrationConfig: true } });
    const enabled = t?.integrations && typeof t.integrations === 'object' ? { ...t.integrations } : {};
    const cfg = t?.integrationConfig && typeof t.integrationConfig === 'object' ? { ...t.integrationConfig } : {};

    if (!url) {
      // Disconnect.
      delete cfg[slug];
      enabled[slug] = false;
    } else {
      if (!(await isSafeWebhookUrl(url))) {
        return res.status(400).json({ error: 'כתובת לא תקינה — נדרשת כתובת HTTPS ציבורית' });
      }
      // secret: keep the stored one if omitted; a new non-empty value replaces it;
      // the literal string "-" clears it.
      const prevSecret = cfg[slug]?.secret;
      let secret = prevSecret;
      if (typeof req.body?.secret === 'string') {
        const s = req.body.secret.trim();
        secret = s === '-' ? undefined : s || prevSecret;
      }
      cfg[slug] = { url, ...(secret ? { secret } : {}) };
      enabled[slug] = true;
    }

    await prisma.tenant.update({ where: { id: req.tenantId }, data: { integrations: enabled, integrationConfig: cfg } });
    res.json({ enabled, config: { [slug]: { url: cfg[slug]?.url || '', hasSecret: Boolean(cfg[slug]?.secret) } } });
  })
);

// ── Reply provider (external "escalation brain") ─────────────────────────────
// The tenant's own agent (a local Claude over an HTTPS tunnel) that HeyIL consults
// when the built-in bot is not enough. Config lives under integrationConfig.replyProvider.
router.get(
  '/reply-provider',
  asyncHandler(async (req, res) => {
    const cfg = (req.tenant?.integrationConfig && typeof req.tenant.integrationConfig === 'object' ? req.tenant.integrationConfig : {}).replyProvider || {};
    res.json({ enabled: !!cfg.enabled, url: cfg.url || '', hasSecret: !!cfg.secret, timeoutMs: cfg.timeoutMs || 30000, consultOn: cfg.consultOn || 'escalation' });
  })
);

// PUT save/toggle. body: { enabled, url, secret?, timeoutMs?, consultOn? }.
// secret: omit to keep, "-" to clear. url validated as a public HTTPS host.
router.put(
  '/reply-provider',
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const url = String(b.url || '').trim();
    const enabled = b.enabled === true;
    if (enabled) {
      if (!url) return res.status(400).json({ error: 'נדרשת כתובת endpoint' });
      if (!(await isSafeWebhookUrl(url))) return res.status(400).json({ error: 'כתובת לא תקינה — נדרשת כתובת HTTPS ציבורית' });
    }
    const t = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { integrationConfig: true } });
    const all = t?.integrationConfig && typeof t.integrationConfig === 'object' ? { ...t.integrationConfig } : {};
    const prev = all.replyProvider || {};
    let secret = prev.secret;
    if (typeof b.secret === 'string') { const s = b.secret.trim(); secret = s === '-' ? undefined : s || prev.secret; }
    const timeoutMs = Number.isInteger(b.timeoutMs) ? Math.min(60000, Math.max(3000, b.timeoutMs)) : prev.timeoutMs || 30000;
    const consultOn = b.consultOn === 'always' ? 'always' : 'escalation';
    all.replyProvider = url ? { enabled, url, ...(secret ? { secret } : {}), timeoutMs, consultOn } : { enabled: false };
    await prisma.tenant.update({ where: { id: req.tenantId }, data: { integrationConfig: all } });
    res.json({ enabled: !!all.replyProvider.enabled, url: all.replyProvider.url || '', hasSecret: !!all.replyProvider.secret, timeoutMs, consultOn });
  })
);

// POST test → send a sample reply.request and report status/latency/returned reply.
router.post(
  '/reply-provider/test',
  asyncHandler(async (req, res) => {
    const result = await testReplyProvider(req.tenant);
    if (result.ok) return res.json(result);
    return res.status(result.error === 'not_configured' ? 400 : 502).json(result);
  })
);

// ── API keys (for an external agent — ops / data-sync) ───────────────────────
// Owner-facing management (normal login auth). The Agent API itself (routes/agent.js)
// is authed by the KEY, not this session. The full key is returned ONCE on create.
router.get(
  '/api-keys',
  asyncHandler(async (req, res) => {
    const keys = await prisma.apiKey.findMany({
      where: { tenantId: req.tenantId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, createdAt: true },
    });
    res.json({ keys, scopes: API_SCOPES });
  })
);

// POST { name, scopes[] } → create a key. Returns { key } (shown ONCE — never again).
router.post(
  '/api-keys',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name || '').trim() || 'External agent';
    let scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.filter(isValidScope) : [];
    if (!scopes.length) scopes = ['read']; // never mint a scope-less key
    const { key, prefix, keyHash } = generateKey();
    const row = await prisma.apiKey.create({
      data: { tenantId: req.tenantId, name, prefix, keyHash, scopes },
      select: { id: true, name: true, prefix: true, scopes: true, createdAt: true },
    });
    res.status(201).json({ ...row, key }); // `key` shown once
  })
);

// DELETE /api-keys/:id → revoke (soft, keeps the audit row).
router.delete(
  '/api-keys/:id',
  asyncHandler(async (req, res) => {
    const { count } = await prisma.apiKey.updateMany({
      where: { id: req.params.id, tenantId: req.tenantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!count) return res.status(404).json({ error: 'Key not found' });
    res.json({ revoked: true });
  })
);

// POST /api/settings/integrations/webhook/test → send a sample payload to the
// stored URL and report the receiver's response, so the owner can confirm wiring.
router.post(
  '/integrations/webhook/test',
  asyncHandler(async (req, res) => {
    const slug = String(req.body?.slug || '');
    if (!WEBHOOK_SLUGS.includes(slug)) return res.status(400).json({ error: 'אינטגרציה לא נתמכת' });
    const t = await prisma.tenant.findUnique({ where: { id: req.tenantId }, select: { name: true, integrationConfig: true } });
    const c = (t?.integrationConfig && typeof t.integrationConfig === 'object' ? t.integrationConfig : {})[slug];
    if (!c?.url) return res.status(400).json({ error: 'לא הוגדרה כתובת webhook' });
    const payload = {
      event: 'test',
      tenant: { id: req.tenantId, name: t?.name || '' },
      contact: { name: 'לקוח לדוגמה', phone: '972500000001' },
      message: 'זוהי הודעת בדיקה מ-HeyIL ✅',
      ts: new Date().toISOString(),
    };
    const result = await deliverToUrl({ url: c.url, secret: c.secret, payload });
    if (result.ok) return res.json({ ok: true, status: result.status });
    return res.status(502).json({ ok: false, status: result.status || null, error: result.error || 'delivery_failed' });
  })
);

// PUT /api/settings/integrations → { slug, enabled } toggles one connection.
router.put(
  '/integrations',
  asyncHandler(async (req, res) => {
    const slug = String(req.body?.slug || '');
    const enabled = req.body?.enabled === true;
    if (!CATALOG_SLUGS.has(slug)) return res.status(400).json({ error: 'אינטגרציה לא מוכרת' });
    // Never let a not-ready integration be switched on — it would be a dead toggle.
    if (enabled && !isIntegrationReady(slug)) {
      return res.status(400).json({ error: 'האינטגרציה עדיין לא זמינה' });
    }
    // URL-configurable integrations are connected via /integrations/webhook (needs a URL),
    // not this plain on/off toggle.
    if (enabled && isConfigurable(slug)) {
      return res.status(400).json({ error: 'יש להזין כתובת webhook כדי להתחבר' });
    }

    const current = readIntegrations(req.tenant);
    const next = { ...current, [slug]: enabled };

    // Persist ONLY the intent map. Never derive/write googleIntegrationEnabled here —
    // that is the paid add-on entitlement, granted exclusively by the super-admin
    // route in routes/admin.js (see the block comment above). Writing it from a
    // tenant-side toggle would let a tenant self-grant the paid add-on and would let
    // an unrelated toggle clobber an admin-granted entitlement back to false.
    await prisma.tenant.update({
      where: { id: req.tenantId },
      data: { integrations: next },
    });

    res.json({ enabled: next });
  })
);

export default router;
