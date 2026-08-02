import fs from 'node:fs';
import OpenAI from 'openai';
import config from '../config/index.js';
import prisma from '../lib/prisma.js';
import { tenantWhatsAppCreds } from '../lib/tenantContext.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { downloadAndCache } from './media.js';

// ─────────────────────────────────────────────────────────────
// Receipts-by-WhatsApp: the business OWNER photographs a receipt and sends it to
// their own business number. The webhook routes it here instead of the customer
// agent: download + cache the image, extract the fields with the vision model,
// persist an Expense row, and confirm back to the owner over WhatsApp.
//
// Owner recognition: Tenant.ownerPhone (digits-only), falling back to the global
// HANDOFF_NOTIFY_PHONE. Matching is suffix-tolerant so "0501234567" and
// "972501234567" describe the same phone.
// ─────────────────────────────────────────────────────────────

const openai = config.openai.enabled ? new OpenAI({ apiKey: config.openai.apiKey }) : null;

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

// Same phone across formats: exact digits, or one is a 9-digit-suffix of the other
// (IL local ↔ international). Both must be non-empty.
function samePhone(a, b) {
  const da = digits(a);
  const db = digits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const sa = da.slice(-9);
  return sa.length === 9 && sa === db.slice(-9);
}

export function isOwnerPhone(tenant, phone) {
  return samePhone(tenant?.ownerPhone, phone) || samePhone(config.handoff.notifyPhone, phone);
}

// Vision extraction. Returns the parsed fields (nulls where unreadable) — never throws
// on model weirdness, only on transport errors.
export async function parseReceiptImage(buffer, mimeType) {
  if (!openai) {
    const err = new Error('OpenAI is not configured');
    err.status = 409;
    throw err;
  }
  const completion = await openai.chat.completions.create({
    model: config.openai.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'זו תמונה של קבלה/חשבונית עסקית (ככל הנראה בעברית). חלץ ממנה JSON בלבד במבנה: ' +
              '{"vendor": string|null, "total": number|null, "currency": "ILS"|string|null, ' +
              '"vat_amount": number|null, "date": "YYYY-MM-DD"|null, "category": string|null, ' +
              '"summary": string|null}. ' +
              'total = הסכום הכולל ששולם (כולל מע״מ). vat_amount = סכום המע״מ אם מופיע. ' +
              'category = קטגוריה קצרה בעברית (למשל: דלק, ציוד משרדי, אוכל, תוכנה, שילוח). ' +
              'summary = תיאור בן שורה. אם שדה לא קריא — null. אל תמציא ערכים.',
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` },
          },
        ],
      },
    ],
  });
  let parsed = {};
  try {
    parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}');
  } catch {
    parsed = {};
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let expenseDate = null;
  if (str(parsed.date) && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
    const d = new Date(parsed.date + 'T00:00:00Z');
    if (!Number.isNaN(d.getTime())) expenseDate = d;
  }
  return {
    vendor: str(parsed.vendor),
    total: num(parsed.total),
    currency: str(parsed.currency) || 'ILS',
    vatAmount: num(parsed.vat_amount),
    expenseDate,
    category: str(parsed.category),
    summary: str(parsed.summary),
  };
}

// Persist one parsed receipt. Idempotent on (tenantId, messageWaId) — Meta retries
// webhooks, and a retry must not double-book the expense.
export async function saveExpense({ tenantId, messageWaId, mediaId, relPath, fields }) {
  const status = fields.total == null || !fields.vendor ? 'needs_review' : 'parsed';
  const data = {
    tenantId,
    messageWaId: messageWaId || null,
    mediaId: mediaId || null,
    imagePath: relPath || null,
    vendor: fields.vendor,
    total: fields.total,
    currency: fields.currency || 'ILS',
    vatAmount: fields.vatAmount,
    expenseDate: fields.expenseDate,
    category: fields.category,
    summary: fields.summary,
    status,
  };
  if (messageWaId) {
    return prisma.expense.upsert({
      where: { tenantId_messageWaId: { tenantId, messageWaId } },
      update: {}, // webhook retry → keep the first parse
      create: data,
    });
  }
  return prisma.expense.create({ data });
}

// Hebrew month-to-date total for the confirmation message.
async function monthTotal(tenantId) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const agg = await prisma.expense.aggregate({
    where: {
      tenantId,
      OR: [
        { expenseDate: { gte: monthStart } },
        { expenseDate: null, createdAt: { gte: monthStart } },
      ],
    },
    _sum: { total: true },
  });
  return agg._sum.total ? Number(agg._sum.total) : 0;
}

function fmtAmount(n) {
  return Number(n).toLocaleString('he-IL', { maximumFractionDigits: 2 });
}

// Full pipeline for one inbound owner-receipt image. Best-effort on the reply —
// a failed WhatsApp confirmation must not lose the stored expense.
export async function processReceiptImage({ tenant, parsed }) {
  const creds = tenantWhatsAppCreds(tenant);
  const mediaId = parsed.media?.mediaId;
  if (!mediaId) return { ok: false, reason: 'no mediaId on inbound image' };

  const { filePath, mimeType, relPath } = await downloadAndCache({
    creds,
    tenantId: tenant.id,
    mediaId,
    sub: 'receipts',
  });
  const fields = await parseReceiptImage(fs.readFileSync(filePath), mimeType);
  const expense = await saveExpense({
    tenantId: tenant.id,
    messageWaId: parsed.waMessageId,
    mediaId,
    relPath,
    fields,
  });

  try {
    const total = await monthTotal(tenant.id);
    const line =
      fields.total != null
        ? `🧾 נקלטה קבלה: ${fields.vendor || 'ספק לא מזוהה'} · ₪${fmtAmount(fields.total)}${fields.category ? ` · ${fields.category}` : ''}`
        : '🧾 הקבלה נשמרה, אבל לא הצלחתי לקרוא את הסכום — סומנה לבדיקה בדשבורד.';
    await sendWhatsAppMessage(creds, parsed.phone, `${line}\n📊 סה״כ הוצאות החודש: ₪${fmtAmount(total)}`);
  } catch (err) {
    console.error('[receipts] confirmation send failed:', err.message);
  }
  return { ok: true, expenseId: expense.id, status: expense.status };
}
