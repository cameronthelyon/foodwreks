// Rate limiting, client IPs, CSRF origin checks, and security headers.

import { HttpError } from './http.js';

export function createRateLimiter() {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  }, 60_000);
  timer.unref();
  return {
    // Fixed window: `limit` hits per `windowMs` per key.
    hit(key, limit, windowMs) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || b.reset <= now) {
        b = { count: 0, reset: now + windowMs };
        buckets.set(key, b);
      }
      b.count++;
      return b.count <= limit;
    },
    check(key, limit, windowMs, message = 'Too many requests. Please wait a minute and try again.') {
      if (!this.hit(key, limit, windowMs)) throw new HttpError(429, 'rate_limited', message);
    },
    reset() {
      buckets.clear();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// State-changing API calls must come from our own pages. Browsers send
// Origin on cross-site POSTs; a JSON content type also forces a CORS
// preflight, which we never grant.
export function assertSameOrigin(req, config) {
  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set([config.baseUrl, `http://${req.headers.host}`, `https://${req.headers.host}`]);
    if (!allowed.has(origin)) throw new HttpError(403, 'bad_origin', 'Cross-site request blocked.');
  }
  const type = String(req.headers['content-type'] || '');
  if (!type.startsWith('application/json')) throw new HttpError(415, 'json_required', 'Send JSON.');
}

export function securityHeaders(res, { frameable = false, https = false } = {}) {
  const csp = [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    frameable ? 'frame-ancestors *' : "frame-ancestors 'none'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (!frameable) res.setHeader('X-Frame-Options', 'DENY');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
