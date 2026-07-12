// Update the WhatsApp Business profile photo via the Graph API — the fallback
// for when WhatsApp Manager's UI upload fails.
//
// Flow (Meta's Resumable Upload API):
//   1. debug_token → app id (no extra env var needed)
//   2. POST /{app-id}/uploads → upload session id
//   3. POST /{session-id} with the image bytes → profile_picture_handle ("h")
//   4. POST /{phone-number-id}/whatsapp_business_profile with the handle
//   5. GET the profile back to confirm the new picture URL
//
// Usage (from backend/):  node scripts/wa-profile-photo.mjs path/to/photo.jpg
// Photo: square, ideally 640×640, JPG/PNG, under 5MB.
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config/index.js';

const { token, phoneNumberId, apiVersion } = config.whatsapp;
const GRAPH = `https://graph.facebook.com/${apiVersion}`;

const die = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

if (!token || !phoneNumberId) die('WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing in .env');

const file = process.argv[2];
if (!file) die('usage: node scripts/wa-profile-photo.mjs <path-to-photo.jpg>');
if (!fs.existsSync(file)) die(`file not found: ${file}`);

const bytes = fs.readFileSync(file);
if (bytes.length > 5 * 1024 * 1024) die(`file is ${(bytes.length / 1024 / 1024).toFixed(1)}MB — must be under 5MB`);
const ext = path.extname(file).toLowerCase();
const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext];
if (!mime) die(`unsupported extension "${ext}" — use .jpg / .jpeg / .png`);

const asJson = async (res, step) => {
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) die(`${step} failed (HTTP ${res.status}): ${j.error?.message || JSON.stringify(j)}`);
  return j;
};

// 1. App id from the token itself
const dbg = await asJson(
  await fetch(`${GRAPH.replace(`/${apiVersion}`, '')}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`),
  'debug_token'
);
const appId = dbg.data?.app_id;
if (!appId) die('could not resolve app id from token');
console.log(`→ app id: ${appId}`);

// 2. Open an upload session
const session = await asJson(
  await fetch(
    `${GRAPH}/${appId}/uploads?file_name=${encodeURIComponent(path.basename(file))}&file_length=${bytes.length}&file_type=${encodeURIComponent(mime)}&access_token=${encodeURIComponent(token)}`,
    { method: 'POST' }
  ),
  'create upload session'
);
console.log(`→ upload session: ${session.id}`);

// 3. Upload the bytes → handle. Note: this endpoint wants "OAuth", not "Bearer".
const uploaded = await asJson(
  await fetch(`${GRAPH}/${session.id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, file_offset: '0', 'Content-Type': 'application/octet-stream' },
    body: bytes,
  }),
  'upload file'
);
const handle = uploaded.h;
if (!handle) die(`no handle returned: ${JSON.stringify(uploaded)}`);
console.log(`→ profile_picture_handle: ${handle.slice(0, 40)}…`);

// 4. Point the business profile at the new photo
await asJson(
  await fetch(`${GRAPH}/${phoneNumberId}/whatsapp_business_profile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', profile_picture_handle: handle }),
  }),
  'update business profile'
);
console.log('→ profile updated ✓');

// 5. Read it back
const profile = await asJson(
  await fetch(`${GRAPH}/${phoneNumberId}/whatsapp_business_profile?fields=profile_picture_url,about,address`, {
    headers: { Authorization: `Bearer ${token}` },
  }),
  'read profile back'
);
const url = profile.data?.[0]?.profile_picture_url;
console.log(url ? `✅ new photo is live:\n${url}` : '⚠ updated, but no profile_picture_url returned yet (may take a minute)');
