#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WHATSAPP-QA-GAP-INBOUND-MEDIA — verification harness.
//
// Proves the fix for the QA gap: inbound WhatsApp media messages (image / audio /
// voice / video / document / sticker / location) used to be collapsed to the bare
// placeholder string "[image]"/"[audio]"/"[document]" at ingestion, so the
// Conversations inbox could only ever show that literal text — no caption, no
// filename, no way to tell what the customer sent.
//
// This drives the REAL parseIncomingMessage()/describeInboundMessage() exported from
// backend/src/services/whatsapp.js against REAL Meta Cloud API webhook payload shapes
// (no DB, no Graph API, no credentials needed — parseIncomingMessage is pure), and
// asserts each media kind now yields (a) a structured `media` descriptor with the
// media id / mime type / caption / filename, and (b) a `text` that is NEVER the bare
// "[image]" placeholder. It also confirms plain text messages are unchanged.
//
// Run from backend/:  node scripts/inbound-media.test.mjs
// Exit 0 = all cases pass; exit 1 = a case failed.
// ─────────────────────────────────────────────────────────────────────────────
import assert from 'node:assert/strict';
import { parseIncomingMessage, describeInboundMessage } from '../src/services/whatsapp.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

// Build a minimal-but-realistic inbound webhook envelope around one message object.
function envelope(message, { phoneNumberId = '15550001111', name = 'דנה כהן' } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '972500000000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name }, wa_id: '972501234567' }],
              messages: [{ from: '972501234567', timestamp: '1700000000', ...message }],
            },
          },
        ],
      },
    ],
  };
}

console.log('WHATSAPP-QA-GAP-INBOUND-MEDIA — parser fix\n');

// ── 1. Image WITH caption → caption becomes the text, media descriptor populated ──
check('image w/ caption: text = caption (not "[image]"), media captured', () => {
  const p = parseIncomingMessage(
    envelope({
      id: 'wamid.IMG1',
      type: 'image',
      image: { id: '1122334455', mime_type: 'image/jpeg', sha256: 'abc', caption: 'הנה התמונה של הכלב 🐶' },
    })
  );
  assert.equal(p.text, 'הנה התמונה של הכלב 🐶');
  assert.notEqual(p.text, '[image]');
  assert.ok(p.media, 'media descriptor must be present');
  assert.equal(p.media.kind, 'image');
  assert.equal(p.media.mediaId, '1122334455');
  assert.equal(p.media.mimeType, 'image/jpeg');
  assert.equal(p.media.caption, 'הנה התמונה של הכלב 🐶');
  assert.equal(p.media.label, 'תמונה');
});

// ── 2. Image WITHOUT caption → typed Hebrew label, still not "[image]" ──
check('image w/o caption: text = "תמונה" (typed label), never "[image]"', () => {
  const p = parseIncomingMessage(
    envelope({ id: 'wamid.IMG2', type: 'image', image: { id: '999', mime_type: 'image/png' } })
  );
  assert.equal(p.text, 'תמונה');
  assert.notEqual(p.text, '[image]');
  assert.equal(p.media.kind, 'image');
  assert.equal(p.media.mediaId, '999');
  assert.equal(p.media.caption, null);
});

// ── 3. Voice note → typed label + voice metadata ──
check('voice note: text = "הודעה קולית", media id + mime captured', () => {
  const p = parseIncomingMessage(
    envelope({ id: 'wamid.AUD1', type: 'audio', audio: { id: 'aud-77', mime_type: 'audio/ogg; codecs=opus', voice: true } })
  );
  assert.equal(p.text, 'הודעה קולית');
  assert.notEqual(p.text, '[audio]');
  assert.equal(p.media.kind, 'audio');
  assert.equal(p.media.mediaId, 'aud-77');
  assert.ok(p.media.mimeType.startsWith('audio/ogg'));
});

// ── 4. Document → filename is preserved (both as text and in descriptor) ──
check('document: text = filename, filename + mime captured (not "[document]")', () => {
  const p = parseIncomingMessage(
    envelope({
      id: 'wamid.DOC1',
      type: 'document',
      document: { id: 'doc-1', mime_type: 'application/pdf', sha256: 'x', filename: 'הצעת-מחיר.pdf' },
    })
  );
  assert.equal(p.text, 'הצעת-מחיר.pdf');
  assert.notEqual(p.text, '[document]');
  assert.equal(p.media.kind, 'document');
  assert.equal(p.media.filename, 'הצעת-מחיר.pdf');
  assert.equal(p.media.mimeType, 'application/pdf');
});

// ── 5. Document WITH caption → caption wins over filename for the preview text ──
check('document w/ caption: text = caption, filename still in descriptor', () => {
  const p = parseIncomingMessage(
    envelope({
      id: 'wamid.DOC2',
      type: 'document',
      document: { id: 'doc-2', mime_type: 'application/pdf', filename: 'invoice.pdf', caption: 'החשבונית מצורפת' },
    })
  );
  assert.equal(p.text, 'החשבונית מצורפת');
  assert.equal(p.media.filename, 'invoice.pdf');
  assert.equal(p.media.caption, 'החשבונית מצורפת');
});

// ── 6. Video, sticker, location → each gets a clean typed label, never a placeholder ──
check('video: typed label, media captured', () => {
  const p = parseIncomingMessage(
    envelope({ id: 'wamid.VID1', type: 'video', video: { id: 'vid-1', mime_type: 'video/mp4' } })
  );
  assert.equal(p.text, 'סרטון');
  assert.equal(p.media.kind, 'video');
  assert.equal(p.media.mediaId, 'vid-1');
});
check('sticker: typed label', () => {
  const p = parseIncomingMessage(
    envelope({ id: 'wamid.STK1', type: 'sticker', sticker: { id: 'stk-1', mime_type: 'image/webp', animated: false } })
  );
  assert.equal(p.text, 'מדבקה');
  assert.equal(p.media.kind, 'sticker');
});
check('location: label includes the place name when present', () => {
  const p = parseIncomingMessage(
    envelope({ id: 'wamid.LOC1', type: 'location', location: { latitude: 32.08, longitude: 34.78, name: 'תל אביב' } })
  );
  assert.equal(p.text, 'מיקום: תל אביב');
  assert.equal(p.media.kind, 'location');
});

// ── 7. Regression: plain text / button / interactive are UNCHANGED (media = null) ──
check('plain text unchanged, no media descriptor', () => {
  const p = parseIncomingMessage(envelope({ id: 'wamid.TXT1', type: 'text', text: { body: 'שלום, יש לכם זמין?' } }));
  assert.equal(p.text, 'שלום, יש לכם זמין?');
  assert.equal(p.media, null);
  assert.equal(describeInboundMessage({ type: 'text', text: { body: 'x' } }), null);
});
check('interactive reply unchanged, no media descriptor', () => {
  const p = parseIncomingMessage(
    envelope({ id: 'wamid.INT1', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'כן' } } })
  );
  assert.equal(p.text, 'כן');
  assert.equal(p.media, null);
});

// ── 8. describeInboundMessage() is null-safe on junk ──
check('describeInboundMessage null-safe on bad input', () => {
  assert.equal(describeInboundMessage(null), null);
  assert.equal(describeInboundMessage(undefined), null);
  assert.equal(describeInboundMessage({}), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
