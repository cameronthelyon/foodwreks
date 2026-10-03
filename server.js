// FoodWreks server: zero dependencies. Serves the static UI from ./public and
// proxies restaurant sources so API keys never reach the browser.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregate } from './lib/aggregate.js';
import { TtlCache } from './lib/cache.js';
import { fetchJson } from './lib/http.js';
import * as google from './lib/providers/google.js';
import * as yelp from './lib/providers/yelp.js';
import * as tripadvisor from './lib/providers/tripadvisor.js';
import * as osm from './lib/providers/osm.js';
import * as demo from './lib/providers/demo.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const DEMO = demo.isEnabled(env);
const PROVIDERS = [google, yelp, tripadvisor, osm];
const MIN_RADIUS = 200;
const MAX_RADIUS = 40000;
const cache = new TtlCache(10 * 60 * 1000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function enabledProviders() {
  if (DEMO) return [demo];
  return PROVIDERS.filter((p) => p.isEnabled(env));
}

function parseCoords(params) {
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { lat, lng };
}

async function handleRestaurants(params, res) {
  const origin = parseCoords(params);
  if (!origin) return sendJson(res, 400, { error: 'lat and lng are required numbers' });
  const radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Number(params.get('radius')) || 2000));

  const providers = enabledProviders();
  if (!providers.length) {
    return sendJson(res, 503, { error: 'No data sources are enabled. Add API keys to .env or set FOODWREKS_DEMO=1.' });
  }

  // ~110 m grid so nearby re-searches hit the cache instead of paid APIs.
  const key = [origin.lat.toFixed(3), origin.lng.toFixed(3), radius, providers.map((p) => p.id).join(',')].join(':');
  const cached = cache.get(key);
  if (cached) return sendJson(res, 200, { ...cached, cached: true });

  const query = { ...origin, radius };
  const results = await Promise.all(
    providers.map(async (p) => {
      const started = Date.now();
      try {
        const records = await p.search(query, env);
        return { id: p.id, label: p.label, ok: true, count: records.length, ms: Date.now() - started, records };
      } catch (err) {
        console.error(`[${p.id}]`, err.message);
        return { id: p.id, label: p.label, ok: false, count: 0, ms: Date.now() - started, error: err.message, records: [] };
      }
    }),
  );

  const { restaurants, prior } = aggregate(results.flatMap((r) => r.records), origin, { radius });
  const body = {
    origin,
    radius,
    demo: DEMO,
    prior,
    generatedAt: new Date().toISOString(),
    sources: results.map(({ records, ...meta }) => meta),
    restaurants,
  };
  // Don't cache a response where a source failed; let the next request retry it.
  if (results.every((r) => r.ok)) cache.set(key, body);
  sendJson(res, 200, body);
}

async function handleGeocode(params, res) {
  const q = (params.get('q') || '').trim();
  if (!q) return sendJson(res, 400, { error: 'q is required' });
  if (DEMO) return sendJson(res, 200, { lat: 38.5767, lng: -121.4934, label: `${q} (demo: Sacramento, CA)` });
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
    const data = await fetchJson(url, { headers: { 'User-Agent': 'foodwreks/0.1 (self-hosted)' } });
    if (!data.length) return sendJson(res, 404, { error: `No match for "${q}"` });
    sendJson(res, 200, { lat: Number(data[0].lat), lng: Number(data[0].lon), label: data[0].display_name });
  } catch (err) {
    sendJson(res, 502, { error: `Geocoding failed: ${err.message}` });
  }
}

function handleConfig(res) {
  sendJson(res, 200, {
    demo: DEMO,
    sources: (DEMO ? [demo] : PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      enabled: DEMO ? true : p.isEnabled(env),
    })),
  });
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/api/restaurants') return await handleRestaurants(url.searchParams, res);
    if (url.pathname === '/api/geocode') return await handleGeocode(url.searchParams, res);
    if (url.pathname === '/api/config') return handleConfig(res);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown endpoint' });
    await serveStatic(url.pathname, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, () => {
    const active = enabledProviders().map((p) => p.label).join(', ') || 'none';
    console.log(`FoodWreks on http://localhost:${PORT}  (sources: ${active}${DEMO ? ', DEMO MODE' : ''})`);
  });
}
