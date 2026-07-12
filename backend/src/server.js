import { initSentry, captureError } from './lib/observability.js';
initSentry(); // before anything else, so early errors are captured

import app from './app.js';
import config from './config/index.js';
import prisma from './lib/prisma.js';
import { recoverOrphanJobs } from './services/broadcastRunner.js';
import { startUsageResetScheduler } from './services/usageReset.js';
import { encryptionConfigured } from './lib/crypto.js';

// Keep the process alive on stray async errors (Node terminates on an
// unhandled rejection by default) — log loudly and report instead of dying
// silently and killing an in-flight broadcast.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  captureError(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  captureError(err, { kind: 'uncaughtException' });
});

// Boot-time warnings for weak/absent security config (non-fatal in dev).
if (!config.whatsapp.appSecret) {
  console.warn('[boot] WHATSAPP_APP_SECRET not set — inbound webhook signatures will NOT be verified.');
}
if (!encryptionConfigured()) {
  console.warn('[boot] CREDENTIALS_ENC_KEY not set — tenant WhatsApp tokens cannot be stored/decrypted.');
}

// A restart mid-broadcast leaves the job 'running' with no runner — mark such
// jobs stopped (cursor intact) so they can be resumed from the UI.
recoverOrphanJobs().catch((err) => console.error('[broadcast] orphan recovery failed:', err.message));

// Reset each tenant's monthly usage counter when its window elapses.
startUsageResetScheduler();

const server = app.listen(config.port, () => {
  console.log(`\n🟢 WhatsApp AI Agent backend running on http://localhost:${config.port}`);
  console.log(`   OpenAI:   ${config.openai.enabled ? 'enabled (' + config.openai.model + ')' : 'disabled → rule-based fallback'}`);
  console.log(`   WhatsApp: ${config.whatsapp.enabled ? 'Cloud API enabled' : 'disabled → simulator mode'}`);
  console.log(`   Webhook:  POST http://localhost:${config.port}/api/whatsapp/webhook`);
  console.log(`   Simulate: POST http://localhost:${config.port}/api/whatsapp/simulate\n`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
