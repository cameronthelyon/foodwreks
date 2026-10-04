// HTML pages. Templates live in public/*.html with {{PLACEHOLDERS}}; static
// assets are served from /assets.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { restaurantSettings } from '../restaurants.js';
import { canTakeOnlineBookings } from '../license.js';
import { sendText } from '../http.js';
import { PUBLIC_DIR, renderPage, scriptJson, sendHtml } from './helpers.js';

export function registerPages(router, app) {
  const page = (file, vars) => (ctx) => sendHtml(ctx.res, renderPage(app, file, typeof vars === 'function' ? vars(ctx) : vars));
  const notFound = (ctx, message = 'That page does not exist.') =>
    sendHtml(ctx.res, renderPage(app, 'notfound.html', { MESSAGE: message }), 404);

  router.get('/', page('index.html'));
  for (const p of ['/login', '/signup', '/forgot', '/reset']) router.get(p, page('auth.html'));
  router.get('/app', page('app.html'));
  router.get('/admin', page('admin.html'));
  router.get('/m/:code', page('manage.html'));
  router.get('/w/:id', page('waitlist.html'));

  router.get('/r/:slug', (ctx) => {
    const r = app.db.one('SELECT * FROM restaurants WHERE slug = ?', ctx.params.slug);
    if (!r) return notFound(ctx, 'We could not find that restaurant.');
    const settings = restaurantSettings(r);
    const base = app.config.baseUrl;
    // Structured data so search engines and booking agents can find the
    // reservation page directly.
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'Restaurant',
      name: r.name,
      telephone: r.phone || undefined,
      url: r.website || `${base}/r/${r.slug}`,
      servesCuisine: r.cuisine || undefined,
      acceptsReservations: true,
      address: r.address
        ? { '@type': 'PostalAddress', streetAddress: r.address, addressLocality: r.city, addressRegion: r.region, postalCode: r.postal_code, addressCountry: r.country }
        : undefined,
      potentialAction: {
        '@type': 'ReserveAction',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: `${base}/r/${r.slug}`,
          actionPlatform: ['http://schema.org/DesktopWebPlatform', 'http://schema.org/MobileWebPlatform'],
        },
        result: { '@type': 'FoodEstablishmentReservation', name: `Table at ${r.name}` },
      },
    };
    sendHtml(
      ctx.res,
      renderPage(app, 'book.html', {
        TITLE: `Book a table at ${r.name}`,
        DESCRIPTION: `Reserve a table at ${r.name}${r.city ? ` in ${r.city}` : ''}. Instant confirmation.`,
        SLUG: r.slug,
        // In the HTML itself, not only after the script runs, for search engines.
        NAME: r.name,
        META: [[r.address, r.city].filter(Boolean).join(', '), r.phone].filter(Boolean).join(' · '),
        ACCENT: settings.brandColor,
        CANONICAL: `${base}/r/${r.slug}`,
        JSONLD_RAW: scriptJson(jsonLd),
      }),
    );
  });

  const widget = readFileSync(join(PUBLIC_DIR, 'assets', 'widget.js'), 'utf8');
  router.get('/widget.js', (ctx) =>
    sendText(ctx.res, 200, widget.replace('__BASE_URL__', JSON.stringify(app.config.baseUrl)), 'text/javascript; charset=utf-8', {
      'Cache-Control': 'public, max-age=3600',
    }),
  );

  router.get('/robots.txt', (ctx) =>
    sendText(ctx.res, 200, `User-agent: *\nDisallow: /app\nDisallow: /api/\nDisallow: /m/\nDisallow: /w/\nSitemap: ${app.config.baseUrl}/sitemap.xml\n`),
  );

  // Every restaurant taking online bookings gets an indexable page: this is
  // the search footprint, so list them all.
  router.get('/sitemap.xml', (ctx) => {
    const base = app.config.baseUrl;
    const rows = app.db.all('SELECT * FROM restaurants ORDER BY id').filter((r) => canTakeOnlineBookings(r, app.now()));
    const xmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const urls = [`${base}/`, ...rows.map((r) => `${base}/r/${r.slug}`)];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${xmlText(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
    sendText(ctx.res, 200, body, 'application/xml; charset=utf-8', { 'Cache-Control': 'public, max-age=3600' });
  });
  router.get('/healthz', () => ({ ok: true, time: new Date(app.now()).toISOString() }));

  return { notFound };
}
