// Minimal HTTP toolkit on node:http: a router with :params, body parsing with
// limits, cookies, JSON responses, and static files. No framework.

import { createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createRouter() {
  const routes = [];
  const add = (method) => (pattern, ...handlers) => {
    const keys = [];
    const source = pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        if (part === '*') {
          keys.push('rest');
          return '(.*)';
        }
        return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handlers });
  };
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    match(method, path) {
      let allowed = false;
      for (const r of routes) {
        const m = r.regex.exec(path);
        if (!m) continue;
        allowed = true;
        if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
        const params = {};
        r.keys.forEach((k, i) => {
          try {
            params[k] = decodeURIComponent(m[i + 1]);
          } catch {
            params[k] = m[i + 1];
          }
        });
        return { handlers: r.handlers, params };
      }
      return allowed ? { methodNotAllowed: true } : null;
    },
  };
}

export async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function parseJsonBody(buf) {
  if (!buf.length) return {};
  try {
    const value = JSON.parse(buf.toString('utf8'));
    if (value === null || typeof value !== 'object') throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body must be a JSON object.');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  if (!prev) res.setHeader(name, value);
  else res.setHeader(name, Array.isArray(prev) ? [...prev, value] : [prev, value]);
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

export function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

// Serves files under `root`. HTML files pass through `transform` (used to
// inject the brand name). Returns false when nothing matched.
export async function serveStatic(req, res, root, urlPath, { transform, maxAge = 300 } = {}) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep) && file !== root) return false;
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const type = TYPES[extname(file)] || 'application/octet-stream';
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': `public, max-age=${maxAge}` };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  if (type.startsWith('text/html') && transform) {
    const html = transform(await readFile(file, 'utf8'));
    sendText(res, 200, html, type, { 'Cache-Control': 'no-cache' });
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end(), true;
  createReadStream(file).pipe(res);
  return true;
}
