// Test harness: a real HTTP server on an ephemeral port, an in-memory
// database, a controllable clock, and a fake fetch that records outbound calls.

import { createServer } from 'node:http';
import { createApp } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';

export const FRIDAY_NOON = Date.parse('2026-10-09T19:00:00Z'); // Fri Oct 9, 12:00 PDT

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export async function startTestApp({ env = {}, now = FRIDAY_NOON, routes = [] } = {}) {
  const clock = { t: now };
  const outbound = [];
  // routes: [{ match: (url, init) => bool, reply: (url, init) => Response }]
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    outbound.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    for (const r of routes) if (r.match(u, init)) return r.reply(u, init);
    return jsonResponse({});
  };
  const config = loadConfig({
    DATABASE_PATH: ':memory:',
    APP_SECRET: 'test-secret-0123456789-test-secret',
    BASE_URL: 'http://localhost',
    WORKER_DISABLED: '1',
    EMAIL_PROVIDER: 'console',
    BACKUP_INTERVAL_HOURS: '0',
    ...env,
  });
  const app = createApp(config, { fetchImpl, now: () => clock.t, quiet: true });
  const server = createServer(app.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    base,
    clock,
    outbound,
    routes,
    client: () => makeClient(base),
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      app.close();
    },
  };
}

export function makeClient(base) {
  const jar = new Map();
  async function request(method, path, body, headers = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      if (/Max-Age=0/.test(c)) jar.delete(k);
      else jar.set(k, pair.slice(i + 1));
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    jar,
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b = {}, h) => request('POST', p, b, h),
    patch: (p, b = {}, h) => request('PATCH', p, b, h),
    del: (p, h) => request('DELETE', p, {}, h),
  };
}

let counter = 0;
export async function signup(t, overrides = {}) {
  const c = t.client();
  counter++;
  const res = await c.post('/api/auth/signup', {
    name: 'Owner',
    email: `owner${counter}@example.com`,
    password: 'correct-horse-battery',
    restaurantName: `Test Kitchen ${counter}`,
    timezone: 'America/Los_Angeles',
    ...overrides,
  });
  if (res.status !== 200) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.data)}`);
  const rid = res.data.restaurantId;
  const restaurant = (await c.get(`/api/r/${rid}`)).data;
  return { c, rid, slug: restaurant.slug, restaurant, email: res.data.user.email };
}

export const outboxRows = (t, where = '1=1', ...args) => t.app.db.all(`SELECT * FROM outbox WHERE ${where} ORDER BY id`, ...args);
