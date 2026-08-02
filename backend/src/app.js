import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import config from './config/index.js';
import prisma from './lib/prisma.js';
import { requireAuth, requireSuperAdmin } from './middleware/auth.js';
import { withTenant } from './middleware/tenant.js';
import { notFound, errorHandler } from './middleware/error.js';

import authRoutes from './routes/auth.js';
import whatsappRoutes from './routes/whatsapp.js';
import redirectRoutes from './routes/redirect.js';
import legalRoutes from './routes/legal.js';
import bioRoutes from './routes/bio.js';
import flowsRoutes from './routes/flows.js';
import conversationRoutes from './routes/conversations.js';
import knowledgeBaseRoutes from './routes/knowledgeBase.js';
import linkRoutes from './routes/links.js';
import analyticsRoutes from './routes/analytics.js';
import broadcastRoutes from './routes/broadcast.js';
import uploadsRoutes, { uploadsDir } from './routes/uploads.js';
import adminRoutes from './routes/admin.js';
import settingsRoutes from './routes/settings.js';
import creditsRoutes from './routes/credits.js';
import billingRoutes from './routes/billing.js';
import paymentsRoutes from './routes/payments.js';
import integrationsRoutes, { googleCallbackRouter } from './routes/integrations.js';
import expensesRoutes from './routes/expenses.js';

const app = express();

// Behind Render's proxy — needed for correct client IPs in rate limiting.
app.set('trust proxy', 1);

// Security headers. CSP is disabled because we serve inline-styled public HTML
// (the /l bio page, legal pages) and a Vite SPA; the other helmet protections
// (HSTS, X-Frame-Options, noSniff, etc.) still apply.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigins, credentials: true }));
// Capture the raw body so the WhatsApp webhook can verify Meta's HMAC signature.
app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
if (config.env !== 'test') app.use(morgan(config.isProd ? 'combined' : 'dev'));

// Throttle auth + webhook simulation to blunt brute-force / cost-abuse.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.' },
});

// Health — `commit` reflects the deployed build (Render sets RENDER_GIT_COMMIT),
// so GET /health confirms exactly which version is live. Also pings the DB so a
// green check means the datastore is actually reachable (not just the process up).
app.get('/health', async (req, res) => {
  let db = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = 'down';
  }
  res.status(db === 'ok' ? 200 : 503).json({
    ok: db === 'ok',
    db,
    commit: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),
    openai: config.openai.enabled,
  });
});

// ── Public routes ────────────────────────────────────────────
app.use('/api/auth/login', authLimiter);
app.use('/api/auth', authRoutes); // /login public, /me self-guards
app.use('/api/whatsapp/simulate', authLimiter);
app.use('/api/whatsapp', whatsappRoutes); // webhook (public) + simulator (auth-gated inside)
app.use('/api/payments', paymentsRoutes); // Stripe + PayPlus callbacks (public, signature-verified) + browser return
// Google OAuth callback is a PUBLIC top-level browser redirect from Google (no auth
// header) — mounted here, BEFORE the auth'd /api/integrations, so it isn't bounced to
// 401. It resolves the tenant from the single-use state nonce, not a session.
app.use('/api/integrations', googleCallbackRouter);
app.use('/', redirectRoutes); // /r/:linkId click tracking
app.use('/', legalRoutes); // /privacy + /terms (required by Meta for app token)
app.use('/', bioRoutes); // /l/:slug public link page ("link tree")
app.use('/uploads', express.static(uploadsDir)); // public so WhatsApp can fetch sent audio by URL

// ── Platform (super-admin) routes ────────────────────────────
app.use('/api/admin', requireAuth, requireSuperAdmin, adminRoutes); // tenant provisioning

// ── Protected, tenant-scoped admin routes (JWT + tenant) ─────
app.use('/api', requireAuth, withTenant, flowsRoutes); // /api/flows*, /api/questions/:id
app.use('/api/conversations', requireAuth, withTenant, conversationRoutes);
app.use('/api/knowledge-base', requireAuth, withTenant, knowledgeBaseRoutes);
app.use('/api/links', requireAuth, withTenant, linkRoutes);
app.use('/api/analytics', requireAuth, withTenant, analyticsRoutes);
app.use('/api/uploads', requireAuth, withTenant, uploadsRoutes); // audio upload for question voice notes
app.use('/api/broadcast', requireAuth, withTenant, broadcastRoutes); // bulk send from an uploaded list
app.use('/api/settings', requireAuth, withTenant, settingsRoutes); // tenant self-serve WhatsApp connect
app.use('/api/credits', requireAuth, withTenant, creditsRoutes); // AI credit balance + ledger
app.use('/api/billing', requireAuth, withTenant, billingRoutes); // Stripe subscription checkout (HeyIL plan)
app.use('/api/integrations', requireAuth, withTenant, integrationsRoutes); // Google add-on (flag-gated, OFF by default)
app.use('/api/expenses', requireAuth, withTenant, expensesRoutes); // receipts-by-WhatsApp expense book

// ── Serve the built frontend (single-service deploy) ───
// Two HTML entries live in dist: index.html is the public marketing landing page
// (served by express.static at /), and app.html is the React admin SPA shell.
// Static assets are served directly; any other non-API route falls back to the
// SPA shell so client-side routing (/dashboard, /login, …) works on refresh.
// Skipped in dev (no dist) where Vite serves the frontend separately on :5173.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(clientDist, 'app.html'));
  });
}

app.use(notFound);
app.use(errorHandler);

export default app;
