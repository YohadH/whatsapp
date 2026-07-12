import * as Sentry from '@sentry/node';
import config from '../config/index.js';

// Error tracking. A no-op unless SENTRY_DSN is set, so dev/test are unaffected.
// initSentry() must run before the app handles requests (called first in
// server.js); captureError() is called from the error handler and the process
// crash handlers.

let enabled = false;

export function initSentry() {
  if (!config.sentry.dsn) return false;
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.env,
    tracesSampleRate: config.sentry.tracesSampleRate,
  });
  enabled = true;
  console.log('[observability] Sentry error tracking enabled');
  return true;
}

export function sentryEnabled() {
  return enabled;
}

export function captureError(err, context) {
  if (!enabled) return;
  try {
    Sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    /* never let error reporting throw */
  }
}
