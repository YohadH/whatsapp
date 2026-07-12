import { Router } from 'express';
import prisma from '../lib/prisma.js';
import config from '../config/index.js';

// Public, unauthenticated per-tenant "link tree" at GET /l/:slug.
// Renders the tenant's active links flagged showOnBio as tappable buttons, each
// routed through the trackable /r/:id redirect so clicks are counted per platform.
const router = Router();

const escapeHtml = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function iconFor(url = '', name = '') {
  const s = `${url} ${name}`.toLowerCase();
  if (s.includes('instagram')) return '📸';
  if (s.includes('tiktok')) return '🎵';
  if (s.includes('youtu')) return '▶️';
  if (s.includes('facebook') || s.includes('fb.com')) return '👍';
  if (s.includes('wa.me') || s.includes('whatsapp')) return '💬';
  if (s.includes('t.me') || s.includes('telegram')) return '✈️';
  if (s.includes('spotify')) return '🎧';
  return '🔗';
}

const page = (title, subtitle, buttonsHtml) => `<!doctype html>
<html lang="he" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;
      justify-content: flex-start; gap: 1.25rem; padding: 3rem 1.25rem 4rem;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #fff; background: linear-gradient(160deg, #0f172a 0%, #1e293b 60%, #0f766e 100%);
    }
    .title { font-size: 1.9rem; font-weight: 800; margin: 0; text-align: center; }
    .subtitle { margin: 0; color: #cbd5e1; font-size: 1rem; text-align: center; }
    .links { width: 100%; max-width: 460px; display: flex; flex-direction: column; gap: 0.9rem; margin-top: 1rem; }
    .btn {
      display: flex; align-items: center; gap: 0.75rem; text-decoration: none; color: #0f172a;
      background: #fff; border-radius: 14px; padding: 1rem 1.15rem; font-size: 1.1rem; font-weight: 600;
      box-shadow: 0 6px 18px rgba(0,0,0,.25); transition: transform .12s ease, box-shadow .12s ease;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(0,0,0,.35); }
    .ico { font-size: 1.4rem; }
    .empty { color: #cbd5e1; }
    footer { margin-top: auto; color: #94a3b8; font-size: .8rem; }
  </style>
</head>
<body>
  <h1 class="title">${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ''}
  <div class="links">${buttonsHtml}</div>
  <footer>${escapeHtml(title)}</footer>
</body>
</html>`;

async function renderBio(req, res, tenant) {
  try {
    const links = await prisma.link.findMany({
      where: { tenantId: tenant.id, isActive: true, showOnBio: true },
      orderBy: { createdAt: 'asc' },
    });
    const base = config.publicBaseUrl;
    const buttons = links.length
      ? links
          .map((l) => {
            const href = l.trackClicks ? `${base}/r/${l.id}` : l.url;
            return `<a class="btn" href="${escapeHtml(href)}" target="_blank" rel="noopener">
        <span class="ico">${iconFor(l.url, l.name)}</span><span>${escapeHtml(l.name)}</span>
      </a>`;
          })
          .join('\n')
      : '<p class="empty">אין קישורים להצגה עדיין.</p>';
    const title = tenant.bioTitle || tenant.displayName || tenant.name;
    const subtitle = tenant.bioSubtitle || '';
    res.type('html').send(page(title, subtitle, buttons));
  } catch (err) {
    console.error('[bio] failed', err.message);
    res.status(500).send('Error');
  }
}

// Per-tenant bio page.
router.get('/l/:slug', async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { slug: req.params.slug } });
  if (!tenant || tenant.status === 'suspended') return res.status(404).send('Not found');
  return renderBio(req, res, tenant);
});

// Back-compat: bare /l resolves to the single tenant if there's exactly one
// (single-business deployments), else 404.
router.get('/l', async (req, res) => {
  const tenants = await prisma.tenant.findMany({ take: 2 });
  if (tenants.length !== 1) return res.status(404).send('Not found');
  return renderBio(req, res, tenants[0]);
});

export default router;
