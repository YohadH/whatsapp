import { Router } from 'express';
import config from '../config/index.js';

// Public, unauthenticated legal pages required by Meta to obtain an app token:
//   GET /privacy        → Privacy Policy
//   GET /terms          → Terms of Service
//   GET /data-deletion  → User Data Deletion instructions (Meta requirement)
const router = Router();

const { appName, companyName, contactEmail, websiteUrl } = config.legal;
const effectiveDate = config.legal.effectiveDate;

const page = (title, bodyHtml) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} — ${appName}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6; max-width: 760px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem;
      color: #1a1a1a; background: #fff;
    }
    @media (prefers-color-scheme: dark) { body { color: #e6e6e6; background: #111; } }
    h1 { font-size: 1.8rem; margin-bottom: .25rem; }
    h2 { font-size: 1.2rem; margin-top: 2rem; }
    .meta { color: #888; font-size: .9rem; margin-bottom: 2rem; }
    a { color: #2563eb; }
    footer { margin-top: 3rem; font-size: .85rem; color: #888; border-top: 1px solid #8883; padding-top: 1rem; }
  </style>
</head>
<body>
${bodyHtml}
  <footer>
    ${companyName} · <a href="mailto:${contactEmail}">${contactEmail}</a>
    · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a>
    · <a href="/data-deletion">Data Deletion</a>
  </footer>
</body>
</html>`;

const privacyHtml = page(
  'Privacy Policy',
  `
  <h1>Privacy Policy</h1>
  <p class="meta">Last updated: ${effectiveDate}</p>

  <p>This Privacy Policy explains how ${companyName} ("we", "us", "our") collects, uses,
  and protects information in connection with ${appName} (the "Service"), a WhatsApp Business
  messaging assistant that helps businesses respond to customer enquiries.</p>

  <h2>1. Information we collect</h2>
  <p>When you message a business that uses the Service through WhatsApp, we process:</p>
  <ul>
    <li><strong>WhatsApp profile data</strong> — your phone number and display name as provided by the WhatsApp Cloud API.</li>
    <li><strong>Message content</strong> — the messages you send to and receive from the business, used to provide automated responses.</li>
    <li><strong>Conversation metadata</strong> — timestamps, conversation status, flow progress, and link-click events used for analytics.</li>
  </ul>

  <h2>2. How we use information</h2>
  <ul>
    <li>To deliver automated and human responses to your enquiries.</li>
    <li>To operate predefined question flows and collect the information you choose to provide.</li>
    <li>To generate aggregate analytics for the business operating the account.</li>
  </ul>

  <h2>3. Sharing</h2>
  <p>Message content and contact details are shared with the business you contacted. We use the
  Meta / WhatsApp Cloud API to send and receive messages, subject to Meta's own terms and policies.
  We may use an AI provider (such as OpenAI) to generate responses; message text may be processed by
  that provider solely to produce a reply. We do not sell your personal data.</p>

  <h2>4. Data retention</h2>
  <p>Conversation and message data is retained for as long as needed to provide the Service and for
  legitimate business analytics, after which it is deleted or anonymised.</p>

  <h2>5. Your rights</h2>
  <p>You may request access to, correction of, or deletion of your personal data by contacting us at
  <a href="mailto:${contactEmail}">${contactEmail}</a>. You can stop messaging the business at any time.</p>

  <h2>6. Security</h2>
  <p>We apply reasonable technical and organisational measures to protect your data against unauthorised
  access, loss, or misuse.</p>

  <h2>7. Children</h2>
  <p>The Service is not directed to children under 16 and we do not knowingly collect their data.</p>

  <h2>8. Changes</h2>
  <p>We may update this policy from time to time. The "Last updated" date above reflects the latest version.</p>

  <h2>9. Contact</h2>
  <p>${companyName}, <a href="mailto:${contactEmail}">${contactEmail}</a>${
    websiteUrl ? `, <a href="${websiteUrl}">${websiteUrl}</a>` : ''
  }.</p>
`
);

const termsHtml = page(
  'Terms of Service',
  `
  <h1>Terms of Service</h1>
  <p class="meta">Last updated: ${effectiveDate}</p>

  <p>These Terms of Service ("Terms") govern your use of ${appName} (the "Service") provided by
  ${companyName} ("we", "us", "our"). By using the Service you agree to these Terms.</p>

  <h2>1. The Service</h2>
  <p>${appName} is a WhatsApp Business messaging assistant that answers customer questions, runs
  predefined flows, and routes conversations to a human agent when needed.</p>

  <h2>2. Acceptable use</h2>
  <ul>
    <li>Do not use the Service for unlawful, harmful, or abusive purposes.</li>
    <li>Do not attempt to disrupt, reverse engineer, or gain unauthorised access to the Service.</li>
    <li>You must comply with the <a href="https://www.whatsapp.com/legal/business-policy/">WhatsApp Business Policy</a> and Meta's platform terms.</li>
  </ul>

  <h2>3. Automated responses</h2>
  <p>Responses may be generated automatically and are provided for convenience. They may be incomplete
  or inaccurate and do not constitute professional advice.</p>

  <h2>4. Intellectual property</h2>
  <p>All rights in the Service and its software remain with ${companyName}. No rights are granted except
  as expressly set out in these Terms.</p>

  <h2>5. Disclaimer & liability</h2>
  <p>The Service is provided "as is" without warranties of any kind. To the maximum extent permitted by
  law, ${companyName} is not liable for any indirect or consequential damages arising from use of the Service.</p>

  <h2>6. Termination</h2>
  <p>We may suspend or terminate access to the Service at any time for breach of these Terms or to comply
  with legal obligations.</p>

  <h2>7. Changes</h2>
  <p>We may update these Terms from time to time. Continued use of the Service after changes take effect
  constitutes acceptance of the updated Terms.</p>

  <h2>8. Contact</h2>
  <p>${companyName}, <a href="mailto:${contactEmail}">${contactEmail}</a>${
    websiteUrl ? `, <a href="${websiteUrl}">${websiteUrl}</a>` : ''
  }.</p>
`
);

const dataDeletionHtml = page(
  'User Data Deletion',
  `
  <h1>User Data Deletion</h1>
  <p class="meta">Last updated: ${effectiveDate}</p>

  <p>${companyName} ("we", "us", "our") lets you request deletion of the personal data we hold
  about you in connection with ${appName} (the "Service"), a WhatsApp Business messaging assistant.</p>

  <h2>What data we hold</h2>
  <p>If you have messaged a business that uses the Service through WhatsApp, we may store your
  WhatsApp phone number and display name, the content of your messages, and conversation metadata
  (timestamps, flow progress, link-click events).</p>

  <h2>How to request deletion</h2>
  <p>To have your personal data deleted, email
  <a href="mailto:${contactEmail}?subject=Data%20Deletion%20Request">${contactEmail}</a>
  from, or referencing, the WhatsApp phone number you used, with the subject line
  <strong>"Data Deletion Request"</strong>. Please include:</p>
  <ul>
    <li>The WhatsApp phone number whose data you want deleted.</li>
    <li>The name of the business you contacted (if known).</li>
  </ul>

  <h2>What happens next</h2>
  <p>We will verify the request and delete the associated personal data — including your contact
  details, message history, and collected answers — within <strong>30 days</strong>, except where we
  are required to retain certain information to comply with a legal obligation. We will confirm by
  email once the deletion is complete.</p>

  <h2>Contact</h2>
  <p>${companyName}, <a href="mailto:${contactEmail}">${contactEmail}</a>${
    websiteUrl ? `, <a href="${websiteUrl}">${websiteUrl}</a>` : ''
  }.</p>
`
);

router.get('/privacy', (req, res) => res.type('html').send(privacyHtml));
router.get('/terms', (req, res) => res.type('html').send(termsHtml));
router.get('/data-deletion', (req, res) => res.type('html').send(dataDeletionHtml));

export default router;
