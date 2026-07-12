import crypto from 'node:crypto';
import config from '../config/index.js';

// AES-256-GCM encryption for secrets stored at rest (per-tenant WhatsApp
// tokens). The key comes from CREDENTIALS_ENC_KEY (32 bytes, hex or base64).
// Ciphertext format: v1:<iv-b64>:<tag-b64>:<ciphertext-b64>.

const VERSION = 'v1';

function getKey() {
  const raw = config.credentials.encKey;
  if (!raw) {
    throw new Error(
      'CREDENTIALS_ENC_KEY is not set — required to encrypt/decrypt tenant WhatsApp tokens'
    );
  }
  // Accept hex (64 chars) or base64; must decode to exactly 32 bytes.
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`CREDENTIALS_ENC_KEY must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('malformed encrypted secret');
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return pt.toString('utf8');
}

// True if a usable encryption key is configured (used to fail fast at boot).
export function encryptionConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

// Generate a fresh 32-byte key as hex — handy for `node -e` during setup.
export function generateEncKey() {
  return crypto.randomBytes(32).toString('hex');
}
