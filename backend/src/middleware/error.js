import config from '../config/index.js';
import { captureError } from '../lib/observability.js';

// Wrap async route handlers so thrown errors reach the error middleware.
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    console.error('[error]', err);
    captureError(err, { method: req.method, path: req.originalUrl, tenantId: req.tenantId });
  }
  // Never leak internal exception text on 5xx in production — return a generic
  // message; the real error is logged server-side. Client errors (4xx) keep
  // their message since those are intentional, user-facing validations.
  const isServerError = status >= 500;
  const message =
    isServerError && config.isProd ? 'Internal Server Error' : err.message || 'Internal Server Error';
  res.status(status).json({
    error: message,
    ...(!isServerError && err.details ? { details: err.details } : {}),
  });
}
