import config from '../config/index.js';

// Meta Embedded Signup — completes onboarding after the frontend flow returns an
// authorization `code` plus the customer's `phone_number_id` and `waba_id`.
//
// Steps (all against Graph):
//   1. Exchange the code for a long-lived business access token.
//   2. Subscribe our app to the WABA so its webhooks reach us.
//   3. (best-effort) Register the phone number for Cloud API messaging.
// Returns { token, phoneNumberId, wabaId } for the caller to store on the tenant.

const graph = (path) => `https://graph.facebook.com/${config.meta.graphVersion}/${path}`;

async function graphJson(url, init, label) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* keep {} */ }
  if (!res.ok || json.error) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    const err = new Error(`${label} failed: ${msg}`);
    err.status = res.status;
    err.metaError = json.error || null;
    throw err;
  }
  return json;
}

// True when the Meta app is configured for Embedded Signup.
export function embeddedSignupConfigured() {
  return Boolean(config.meta.appId && config.meta.appSecret && config.meta.configId);
}

// Public params the frontend needs to launch the flow (no secrets).
export function embeddedSignupPublicConfig() {
  return {
    configured: embeddedSignupConfigured(),
    appId: config.meta.appId,
    configId: config.meta.configId,
    graphVersion: config.meta.graphVersion,
  };
}

// 1) code → access token (business integration system-user token).
async function exchangeCodeForToken(code) {
  const url = graph(
    `oauth/access_token?client_id=${encodeURIComponent(config.meta.appId)}` +
      `&client_secret=${encodeURIComponent(config.meta.appSecret)}` +
      `&code=${encodeURIComponent(code)}`
  );
  const json = await graphJson(url, {}, 'token exchange');
  if (!json.access_token) throw new Error('token exchange returned no access_token');
  return json.access_token;
}

// 2) Subscribe our app to the customer's WABA so inbound webhooks reach us.
async function subscribeAppToWaba(wabaId, token) {
  return graphJson(
    graph(`${wabaId}/subscribed_apps`),
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    'subscribe app to WABA'
  );
}

// 3) Register the phone number for Cloud API (best-effort — the number is often
// already registered by the signup flow; a failure here shouldn't abort onboarding).
async function registerPhoneNumber(phoneNumberId, token) {
  try {
    await graphJson(
      graph(`${phoneNumberId}/register`),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', pin: '000000' }),
      },
      'register phone'
    );
    return { registered: true };
  } catch (err) {
    console.warn('[embedded-signup] phone register skipped:', err.message);
    return { registered: false, note: err.message };
  }
}

// High-level: run the full connect flow and return the credentials to store.
export async function connectWhatsApp({ code, phoneNumberId, wabaId }) {
  if (!embeddedSignupConfigured()) {
    throw Object.assign(new Error('Embedded Signup is not configured on the server'), { status: 400 });
  }
  if (!code || !phoneNumberId || !wabaId) {
    throw Object.assign(new Error('code, phoneNumberId and wabaId are required'), { status: 400 });
  }

  const token = await exchangeCodeForToken(code);
  await subscribeAppToWaba(wabaId, token);
  const register = await registerPhoneNumber(phoneNumberId, token);

  return { token, phoneNumberId, wabaId, register };
}
