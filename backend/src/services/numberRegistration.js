import crypto from 'node:crypto';
import config from '../config/index.js';

// Connect a phone number directly (no Embedded Signup popup) by hosting it under the
// PLATFORM's own WhatsApp Business Account. The customer types their number and the
// verification code Meta texts them; we drive the Cloud API onboarding:
//   1. add number to our WABA           POST /{waba-id}/phone_numbers
//   2. request a verification code      POST /{phone-number-id}/request_code
//   3. verify the code                  POST /{phone-number-id}/verify_code
//   4. register for Cloud API messaging POST /{phone-number-id}/register  (with a PIN)
// Requires an approved Tech Provider app + platform WABA + system-user token
// (config.platformWaba). See SETUP_WHATSAPP.md / CREDITS_DESIGN.md siblings.

const graph = (path) => `https://graph.facebook.com/${config.platformWaba.graphVersion}/${path}`;

async function graphCall(url, { method = 'POST', body } = {}, label) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.platformWaba.token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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

export function platformNumberingConfigured() {
  return config.platformWaba.enabled;
}

// Split a typed number into { cc, phoneNumber } as Meta expects (country code, then
// the national number without it). Accepts "+972 50-123 4567", "0501234567", etc.
export function splitPhone(rawCc, rawPhone) {
  const cc = String(rawCc || '').replace(/\D/g, '');
  let national = String(rawPhone || '').replace(/\D/g, '');
  // If the user pasted the full international number into the phone field, strip a
  // leading country code; also drop a leading trunk "0" (e.g. Israeli 05x).
  if (cc && national.startsWith(cc)) national = national.slice(cc.length);
  national = national.replace(/^0+/, '');
  return { cc, phoneNumber: national };
}

// Step 1+2: register the number on our WABA and trigger the code. Returns the new
// phone_number_id the caller must carry into verifyAndRegister.
export async function startNumberConnect({ cc, phoneNumber, displayName, codeMethod = 'SMS' }) {
  if (!platformNumberingConfigured()) {
    throw Object.assign(new Error('Platform WhatsApp account is not configured on the server'), { status: 400 });
  }
  if (!cc || !phoneNumber || !displayName) {
    throw Object.assign(new Error('country code, phone number and display name are required'), { status: 400 });
  }

  const added = await graphCall(
    graph(`${config.platformWaba.id}/phone_numbers`),
    { body: { cc, phone_number: phoneNumber, verified_name: displayName } },
    'add phone number'
  );
  const phoneNumberId = added.id;
  if (!phoneNumberId) throw new Error('Meta did not return a phone_number_id');

  await graphCall(
    graph(`${phoneNumberId}/request_code`),
    { body: { code_method: codeMethod === 'VOICE' ? 'VOICE' : 'SMS', language: 'en_US' } },
    'request verification code'
  );

  return { phoneNumberId };
}

// Step 3+4: verify the code the customer received, then register the number for Cloud
// API messaging. Returns the platform credentials to store on the tenant.
export async function verifyAndRegister({ phoneNumberId, code }) {
  if (!platformNumberingConfigured()) {
    throw Object.assign(new Error('Platform WhatsApp account is not configured on the server'), { status: 400 });
  }
  if (!phoneNumberId || !code) {
    throw Object.assign(new Error('phoneNumberId and code are required'), { status: 400 });
  }

  await graphCall(
    graph(`${phoneNumberId}/verify_code`),
    { body: { code: String(code).replace(/\D/g, '') } },
    'verify code'
  );

  // A 2-step PIN is required to register. Use the configured platform PIN, or mint a
  // random one (platform owns the number, so a per-number random PIN is fine).
  const pin = config.platformWaba.pin || String(crypto.randomInt(100000, 999999));
  await graphCall(
    graph(`${phoneNumberId}/register`),
    { body: { messaging_product: 'whatsapp', pin } },
    'register phone'
  );

  return {
    phoneNumberId,
    wabaId: config.platformWaba.id,
    token: config.platformWaba.token, // platform system-user token sends for this number
  };
}
