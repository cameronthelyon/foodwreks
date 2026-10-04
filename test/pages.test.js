// HTML pages, static assets and the embed script.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { signup, startTestApp } from './helpers.js';

let t;
before(async () => {
  t = await startTestApp({ env: { BRAND_NAME: 'Freehold' } });
});
after(() => t.close());

const get = (path) => fetch(t.base + path, { redirect: 'manual' });

test('landing, auth and app shells render with the brand', async () => {
  for (const path of ['/', '/login', '/signup', '/app', '/admin']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    assert.ok(html.includes('Freehold'), path);
    assert.ok(!html.includes('{{'), `${path} has no unfilled placeholders`);
  }
  assert.match(await (await get('/')).text(), /Own the book\./);
});

test('booking page carries structured data and is embeddable', async () => {
  const { slug } = await signup(t, { restaurantName: 'Tacos <El> "Rey"' });
  const res = await get(`/r/${slug}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors \*/);
  assert.equal(res.headers.get('x-frame-options'), null);
  const html = await res.text();
  assert.match(html, /<title>Book a table at Tacos &lt;El&gt; &quot;Rey&quot;<\/title>/);
  const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(html)[1]);
  assert.equal(ld['@type'], 'Restaurant');
  assert.equal(ld.name, 'Tacos <El> "Rey"');
  assert.equal(ld.potentialAction['@type'], 'ReserveAction');
  assert.ok(!/<script[^>]*>[^<]*<El>/.test(html), 'no raw markup injected into script');
  assert.equal((await get('/r/no-such-place')).status, 404);
});

test('widget script points at this server', async () => {
  const res = await get('/widget.js');
  assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await res.text(), /var BASE = "http:\/\/localhost";/);
});

test('static assets are served safely', async () => {
  const css = await get('/assets/css/base.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.ok(css.headers.get('etag'));
  const again = await fetch(`${t.base}/assets/css/base.css`, { headers: { 'if-none-match': css.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal((await get('/assets/../server.js')).status, 404);
  assert.equal((await get('/assets/%2e%2e/%2e%2e/package.json')).status, 404);
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/api/nope')).headers.get('content-type'), 'application/json; charset=utf-8');
  assert.match(await (await get('/robots.txt')).text(), /Disallow: \/app/);
});
