import prisma from '../lib/prisma.js';
import { normalizePhone } from '../lib/phone.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';

// Words that mean "remove me from your list". A message counts as an opt-out
// when — after stripping punctuation — it is a short message (≤8 words)
// containing one of these as a standalone word ("אנא תסירו אותי מרשימת
// התפוצה"). Substrings inside longer words don't match ("הסרט" is not "הסר").
// Better to over-suppress a borderline phrase than to keep messaging someone
// who asked to stop.
const OPT_OUT_WORDS = new Set([
  'הסר',
  'הסרה',
  'להסרה',
  'הסירו',
  'תסירו',
  'stop',
  'unsubscribe',
]);

export function isOptOutText(text) {
  const squashed = String(text || '')
    .toLowerCase()
    .replace(/[.!?,:;"'()\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!squashed) return false;
  const words = squashed.split(' ');
  return words.length <= 8 && words.some((w) => OPT_OUT_WORDS.has(w));
}

// If the inbound message is an opt-out request: record the number in the
// tenant's suppression list (every broadcast filters against it) and confirm to
// the user. Returns true when handled as an opt-out — the caller then skips the
// conversation engine. The confirmation is best-effort.
export async function handleOptOut(tenant, phone, text) {
  if (!isOptOutText(text)) return false;

  const normalized = normalizePhone(phone);
  if (!normalized) return true;

  await prisma.suppressedNumber.upsert({
    where: { tenantId_phone: { tenantId: tenant.id, phone: normalized } },
    update: {},
    create: { tenantId: tenant.id, phone: normalized, reason: 'opt_out' },
  });
  console.log(`[opt-out] tenant ${tenant.id}: ${normalized} added to suppression list`);

  try {
    await sendWhatsAppMessage(
      tenantWhatsAppCreds(tenant),
      normalized,
      'הוסרת מרשימת התפוצה שלנו ולא יישלחו אליך יותר הודעות שיווקיות. 🙏'
    );
  } catch (err) {
    console.error('[opt-out] confirmation send failed:', err.message);
  }
  return true;
}
