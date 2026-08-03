import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import prisma from '../lib/prisma.js';

// ─────────────────────────────────────────────────────────────
// Outbound webhook delivery — powers the Webhook/CRM and Zapier/Make
// integrations. On a lead event we POST a JSON payload to the URL the owner
// configured. Delivery is BEST-EFFORT and never throws: it must never delay or
// break the customer-reply pipeline.
//
// Security: only public HTTPS URLs are allowed. The host is resolved and every
// resolved address is checked so a webhook can't be pointed at localhost, a
// private/link-local range, or the cloud metadata endpoint (SSRF). Bodies are
// HMAC-signed (X-HeyIL-Signature) when the owner sets a secret.
// ─────────────────────────────────────────────────────────────

const TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 2;
export const WEBHOOK_SLUGS = ['webhook', 'zapier'];

// Private / loopback / link-local / CGNAT / metadata ranges we refuse to POST to.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80')) return true; // link-local
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local fc00::/7
  if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7)); // IPv4-mapped IPv6
  return false;
}

// True only for a public HTTPS URL whose host resolves entirely to public IPs.
export async function isSafeWebhookUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(host)) return false;
  // A bare IP literal is checked directly; a hostname is resolved (all records).
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

function sign(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function postOnce(url, body, secret) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'HeyIL-Webhook/1' };
    if (secret) headers['X-HeyIL-Signature'] = sign(secret, body);
    const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
    return { ok: res.ok, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

// Deliver one payload to one URL (SSRF-checked, signed, small retry on 5xx/timeout).
// Returns { ok, status? , error? } — never throws.
export async function deliverToUrl({ url, secret, payload }) {
  if (!(await isSafeWebhookUrl(url))) return { ok: false, error: 'unsafe_or_invalid_url' };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let last = { ok: false, error: 'failed' };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      last = await postOnce(url, body, secret);
      if (last.ok) return last;
      if (last.status && last.status < 500) return last; // 4xx won't fix on retry
    } catch (err) {
      last = { ok: false, error: err?.name === 'AbortError' ? 'timeout' : err?.message || 'error' };
    }
  }
  return last;
}

// Fire a lead event to every enabled + configured webhook target of a tenant.
// FIRE-AND-FORGET: schedules the POSTs and returns immediately so the reply
// pipeline is never blocked. Never throws.
export async function deliverLeadEvent(tenantId, event, data = {}) {
  try {
    const t = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true, integrations: true, integrationConfig: true },
    });
    if (!t) return;
    const enabled = t.integrations && typeof t.integrations === 'object' ? t.integrations : {};
    const cfg = t.integrationConfig && typeof t.integrationConfig === 'object' ? t.integrationConfig : {};
    const payload = { event, tenant: { id: tenantId, name: t.name }, ...data, ts: new Date().toISOString() };
    for (const slug of WEBHOOK_SLUGS) {
      const c = cfg[slug];
      if (enabled[slug] === true && c?.url) {
        deliverToUrl({ url: c.url, secret: c.secret, payload })
          .then((r) => { if (!r.ok) console.warn(`[webhook:${slug}] delivery failed:`, r.error || r.status); })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.error('[webhook] deliverLeadEvent error:', err.message);
  }
}
