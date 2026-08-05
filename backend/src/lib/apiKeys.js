import crypto from 'node:crypto';
import prisma from './prisma.js';

// Scopes a key can hold. Keep the list tight — least privilege.
export const API_SCOPES = ['read', 'write:messaging', 'write:settings', 'write:campaigns'];

export function isValidScope(s) {
  return API_SCOPES.includes(s);
}

// SHA-256 of the raw key. Keys are high-entropy (192 bits) so a fast hash is fine —
// unlike user passwords, there's nothing to brute-force.
export function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Mint a new key. Returns { key (FULL — shown once), prefix, keyHash }.
export function generateKey() {
  const key = `heyil_sk_${crypto.randomBytes(24).toString('hex')}`;
  return { key, prefix: `${key.slice(0, 16)}…`, keyHash: hashKey(key) };
}

// Resolve a raw bearer token to its live (non-revoked) ApiKey row, or null.
export async function resolveApiKey(rawKey) {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith('heyil_sk_')) return null;
  const row = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(rawKey) } });
  if (!row || row.revokedAt) return null;
  return row;
}
