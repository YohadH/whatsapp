import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────
// WhatsApp Cloud API media download + disk cache.
//
// Inbound media is NOT a public URL: the webhook only carries a media id. The
// bytes require two authenticated Graph calls with the tenant's token:
//   1. GET /{media-id}            → { url, mime_type }  (url is ~5-minute-lived)
//   2. GET {url}  (Bearer token)  → the bytes
// Meta also expires the media id itself (~30 days), so every successful download
// is cached under uploads/media/<tenantId>/ and served from disk afterwards —
// old conversations keep their images forever.
// ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/uploads — same root that app.js serves at /uploads and gitignores.
export const UPLOADS_ROOT = path.resolve(__dirname, '../../uploads');

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'application/pdf': '.pdf',
};

export function extForMime(mime) {
  return EXT_BY_MIME[(mime || '').split(';')[0].trim()] || '.bin';
}

function mimeForExt(ext) {
  for (const [m, e] of Object.entries(EXT_BY_MIME)) if (e === ext) return m;
  return 'application/octet-stream';
}

// Media ids come from Meta and are numeric today, but never trust them as path
// segments — strip anything that isn't a safe id character.
function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function cacheDir(tenantId, sub = 'media') {
  return path.join(UPLOADS_ROOT, sub, safeId(tenantId));
}

// Look up an already-cached copy: uploads/<sub>/<tenantId>/<mediaId>.<any ext>.
export function findCached(tenantId, mediaId, sub = 'media') {
  const dir = cacheDir(tenantId, sub);
  const base = safeId(mediaId);
  if (!base || !fs.existsSync(dir)) return null;
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(base + '.'));
  if (!hit) return null;
  const filePath = path.join(dir, hit);
  return { filePath, mimeType: mimeForExt(path.extname(hit)) };
}

// Graph step 1: media id → short-lived download URL + mime.
export async function fetchMediaMeta(creds, mediaId) {
  const res = await fetch(
    `https://graph.facebook.com/${creds.apiVersion}/${encodeURIComponent(mediaId)}`,
    { headers: { Authorization: `Bearer ${creds.token}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `media lookup failed (${res.status})`);
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  return { url: data.url, mimeType: data.mime_type || null };
}

// Both steps: media id → { buffer, mimeType }. Throws on any failure.
export async function downloadMedia(creds, mediaId) {
  if (!creds?.enabled) {
    const err = new Error('WhatsApp credentials not configured for this tenant');
    err.status = 409;
    throw err;
  }
  const meta = await fetchMediaMeta(creds, mediaId);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${creds.token}` } });
  if (!res.ok) {
    const err = new Error(`media download failed (${res.status})`);
    err.status = 502;
    throw err;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: meta.mimeType || res.headers.get('content-type') || 'application/octet-stream' };
}

// Download once, cache forever. Returns { filePath, mimeType, relPath }.
// `sub` picks the cache bucket (media | receipts) so receipts stay browsable.
export async function downloadAndCache({ creds, tenantId, mediaId, sub = 'media' }) {
  const cached = findCached(tenantId, mediaId, sub);
  if (cached) return { ...cached, relPath: path.relative(UPLOADS_ROOT, cached.filePath) };

  const { buffer, mimeType } = await downloadMedia(creds, mediaId);
  const dir = cacheDir(tenantId, sub);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, safeId(mediaId) + extForMime(mimeType));
  fs.writeFileSync(filePath, buffer);
  return { filePath, mimeType, relPath: path.relative(UPLOADS_ROOT, filePath) };
}
