// Marketing site: every page renders with its own metadata, and every
// internal link resolves.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { SITE_PAGES } from '../lib/routes/site.js';

let t;
before(async () => {
  t = await startTestApp({ env: { BRAND_NAME: 'Freeheld' } });
});
after(() => t.close());

const get = (path) => fetch(t.base + path, { redirect: 'manual' });
const pick = (html, re) => html.match(re)?.[1];

test('every site page has its own title, description, canonical URL and preview tags', async () => {
  const titles = new Set();
  const descriptions = new Set();
  for (const page of SITE_PAGES) {
    const res = await get(page.path);
    assert.equal(res.status, 200, page.path);
    const html = await res.text();
    assert.ok(!html.includes('{{'), `${page.path}: no unfilled placeholders`);
    assert.ok(!html.includes('—'), `${page.path}: no em dashes`);
    const title = pick(html, /<title>([^<]+)<\/title>/);
    assert.ok(title?.includes('Freeheld'), `${page.path}: title names the brand`);
    titles.add(title);
    descriptions.add(pick(html, /<meta name="description" content="([^"]+)"/));
    assert.equal(pick(html, /<link rel="canonical" href="([^"]+)"/), `http://localhost${page.path}`);
    assert.match(html, /<meta property="og:image" content="http:\/\/localhost\/assets\/og\.png">/);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${page.path}: exactly one h1`);
    const ld = JSON.parse(pick(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/));
    assert.ok(ld['@graph'].some((n) => n['@type'] === 'Organization'));
    if (page.crumb) assert.ok(ld['@graph'].some((n) => n['@type'] === 'BreadcrumbList'), `${page.path}: breadcrumbs`);
  }
  assert.equal(titles.size, SITE_PAGES.length, 'titles are unique');
  assert.equal(descriptions.size, SITE_PAGES.length, 'descriptions are unique');
  assert.equal((await get('/assets/og.png')).status, 200);
});

test('every internal link on the site resolves', async () => {
  const seen = new Set();
  for (const page of SITE_PAGES) {
    const html = await (await get(page.path)).text();
    for (const [, href] of html.matchAll(/href="(\/[^"#?]*)/g)) seen.add(href);
  }
  for (const href of seen) {
    const res = await get(href);
    assert.ok(res.status === 200, `${href} -> ${res.status}`);
  }
  assert.ok(seen.has('/compare/opentable') && seen.has('/switch') && seen.has('/co-op'));
});

test('the sitemap lists every site page', async () => {
  const xml = await (await get('/sitemap.xml')).text();
  for (const page of SITE_PAGES) assert.ok(xml.includes(`<loc>http://localhost${page.path}</loc>`), page.path);
});
