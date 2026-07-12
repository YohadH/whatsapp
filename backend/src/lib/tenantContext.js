import { decryptSecret } from './crypto.js';
import config from '../config/index.js';

// Resolve a tenant's WhatsApp Cloud API credentials into the shape the whatsapp
// service expects. The token is decrypted on demand (never kept in plaintext at
// rest). `enabled` is false when the tenant has no usable credentials, in which
// case the service falls back to simulator mode (logs instead of sending).
export function tenantWhatsAppCreds(tenant) {
  if (!tenant) return { enabled: false };
  let token = null;
  try {
    token = decryptSecret(tenant.waTokenEnc);
  } catch (err) {
    console.error(`[tenant ${tenant.id}] failed to decrypt WhatsApp token:`, err.message);
  }
  return {
    token: token || '',
    phoneNumberId: tenant.waPhoneNumberId || '',
    businessAccountId: tenant.waBusinessAccountId || '',
    apiVersion: tenant.waApiVersion || config.whatsapp.apiVersion,
    enabled: Boolean(token && tenant.waPhoneNumberId),
  };
}
