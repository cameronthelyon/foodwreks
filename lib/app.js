// Builds the application: one container object passed everywhere, one
// router, one request handler. No globals, so tests can run many apps.

import { join } from 'node:path';
import { openDb } from './db.js';
import { deriveKey, makeSigner, makeVault } from './crypto.js';
import { createEventHub } from './events.js';
import { createNotifier } from './notify/index.js';
import { makeEmailProvider, makeSmsProvider } from './notify/providers.js';
import { createIntegrations } from './integrations/index.js';
import { HttpError, createRouter, parseJsonBody, readBody, sendJson, serveStatic } from './http.js';
import { assertSameOrigin, clientIp, createRateLimiter, securityHeaders } from './security.js';
import { PUBLIC_DIR, renderPage, sendHtml } from './routes/helpers.js';
import { registerPages } from './routes/pages.js';
import { registerPublic } from './routes/public.js';
import { registerAuth } from './routes/auth.js';
import { registerStaff } from './routes/staff.js';
import { registerIntegrations } from './routes/integrations.js';
import { registerGoogle } from './routes/google.js';
import { registerAdmin } from './routes/admin.js';
import { registerMcp } from './mcp.js';

const quietLog = { info() {}, warn() {}, error() {} };

export function createApp(config, { fetchImpl = globalThis.fetch, log = console, now = () => Date.now(), quiet = false } = {}) {
  const app = {
    config,
    db: openDb(config.databasePath),
    log: quiet ? quietLog : log,
    now,
    fetch: fetchImpl,
    keys: { manage: deriveKey(config.secret, 'manage-links-v1'), waitlist: deriveKey(config.secret, 'waitlist-links-v1') },
    vault: makeVault(config.secret),
    signer: makeSigner(config.secret),
    events: createEventHub(),
    limiter: createRateLimiter(),
  };
  app.notify = createNotifier(app, {
    email: makeEmailProvider(config.email, fetchImpl, app.log),
    sms: makeSmsProvider(config.sms, fetchImpl, app.log),
  });
  app.integrations = createIntegrations(app, fetchImpl);

  const router = createRouter();
  registerPages(router, app);
  registerPublic(router, app);
  registerAuth(router, app);
  registerStaff(router, app);
  registerIntegrations(router, app);
  registerGoogle(router, app);
  registerAdmin(router, app);
  registerMcp(router, app);

  app.handle = (req, res) => handle(app, router, req, res);
  app.close = () => {
    app.events.close();
    app.limiter.stop();
    app.integrations.stop();
    app.db.close();
  };
  return app;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function handle(app, router, req, res) {
  const started = Date.now();
  let path = '/';
  try {
    const url = new URL(req.url, 'http://localhost');
    path = url.pathname;
    const frameable = /^\/(r|m|w)\//.test(path);
    securityHeaders(res, { frameable, https: app.config.secureCookies });

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const match = router.match(req.method, path);
    if (!match) {
      if ((req.method === 'GET' || req.method === 'HEAD') && path.startsWith('/assets/')) {
        if (await serveStatic(req, res, join(PUBLIC_DIR, 'assets'), path.slice('/assets'.length), { maxAge: app.config.production ? 86400 : 0 })) return;
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'not_found', 'Not found.');
      return sendHtml(res, renderPage(app, 'notfound.html', { MESSAGE: 'That page does not exist.' }), 404);
    }
    if (match.methodNotAllowed) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');

    const ctx = {
      app,
      req,
      res,
      url,
      path,
      params: match.params,
      query: Object.fromEntries(url.searchParams),
      ip: clientIp(req, app.config.trustProxy),
      body: undefined,
      rawBody: Buffer.alloc(0),
    };
    if (MUTATING.has(req.method)) {
      ctx.rawBody = await readBody(req, path.includes('/import/') ? 8_000_000 : 1_000_000);
      if (path.startsWith('/api/')) {
        assertSameOrigin(req, app.config, { hasBody: ctx.rawBody.length > 0 });
        ctx.body = parseJsonBody(ctx.rawBody);
      } else if (String(req.headers['content-type'] || '').startsWith('application/json') && !path.startsWith('/webhooks/') && path !== '/mcp') {
        ctx.body = parseJsonBody(ctx.rawBody);
      }
    }

    let result;
    for (const h of match.handlers) {
      result = await h(ctx);
      if (res.headersSent || res.writableEnded) return;
    }
    sendJson(res, 200, result === undefined ? { ok: true } : result);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
    } else {
      app.log.error?.(`${req.method} ${path} failed:`, err);
      sendJson(res, 500, { error: { code: 'server_error', message: 'Something went wrong on our side. Please try again.' } });
    }
  } finally {
    if (!app.config.production && process.env.LOG_REQUESTS) app.log.info?.(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
  }
}
