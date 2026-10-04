// Shared route plumbing: auth wrappers, rate limits, HTML page rendering.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireMember, sessionUser } from '../auth.js';
import { HttpError } from '../http.js';
import { esc } from '../notify/templates.js';

export const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');

export function requireUser(ctx) {
  if (!ctx.user) ctx.user = sessionUser(ctx.app, ctx.req, ctx.res);
  if (!ctx.user) throw new HttpError(401, 'unauthenticated', 'Please log in.');
  return ctx.user;
}

// Middleware: signed-in member of :rid with at least `minRole`.
export const staff = (minRole = 'host') => (ctx) => {
  const user = requireUser(ctx);
  const { restaurant, role } = requireMember(ctx.app.db, user, ctx.params.rid, minRole);
  ctx.restaurant = restaurant;
  ctx.role = role;
};

export const platformAdmin = () => (ctx) => {
  const user = requireUser(ctx);
  if (!user.isPlatformAdmin) throw new HttpError(404, 'not_found', 'Not found.');
};

export const rateLimit = (name, limit, windowMs, message) => (ctx) => {
  ctx.app.limiter.check(`${name}:${ctx.ip}`, limit, windowMs, message);
};

export const int = (v, d = null) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const templates = new Map();
function template(file) {
  if (!templates.has(file) || process.env.NODE_ENV !== 'production') {
    templates.set(file, readFileSync(join(PUBLIC_DIR, file), 'utf8'));
  }
  return templates.get(file);
}

// Fills {{NAME}} placeholders. Values are HTML-escaped unless the key ends
// in _RAW (used for pre-serialized, script-safe JSON-LD).
export function renderPage(app, file, vars = {}) {
  const all = { BRAND: app.config.brand.name, BASE_URL: app.config.baseUrl, SUPPORT_EMAIL: app.config.brand.supportEmail, SOURCE_URL: app.config.brand.sourceUrl, ...vars };
  return template(file).replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => {
    if (!(key in all)) return '';
    return key.endsWith('_RAW') ? String(all[key]) : esc(all[key]);
  });
}

export function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
  });
  res.end(html);
}

// JSON safe to embed inside <script type="application/ld+json">.
export function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}
