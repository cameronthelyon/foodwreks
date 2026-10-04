// Marketing site: one layout, one content file per page, and the metadata
// search engines and link previews read. The same table feeds the sitemap.

import { renderPage, scriptJson, sendHtml } from './helpers.js';

export const SITE_PAGES = [
  {
    path: '/',
    file: 'home.html',
    title: (b) => `${b}: reservations restaurants own`,
    description: 'Reservation software for independent restaurants. Pay $1,000 once. No cover fees, no monthly rent. Your guests and your data stay yours.',
  },
  {
    path: '/pricing',
    file: 'pricing.html',
    title: (b) => `Pricing: $1,000 once, no cover fees | ${b}`,
    description: 'One payment per location, for as long as you run it. No monthly fee, no per-cover fee, texting at cost. What lifetime means, exactly.',
    crumb: 'Pricing',
  },
  {
    path: '/compare',
    file: 'compare.html',
    title: (b) => `${b} vs OpenTable, Resy, Tock and Yelp`,
    description: 'What each reservation platform costs, who owns it, and where each is genuinely stronger than a pay-once alternative.',
    crumb: 'Compare',
  },
  {
    path: '/compare/opentable',
    file: 'compare-opentable.html',
    title: (b) => `OpenTable alternative with no cover fees | ${b}`,
    description: 'OpenTable charges up to $1.50 per network cover, including bookings from Google. Compare the cost of OpenTable with a $1,000 one-time license.',
    crumb: 'OpenTable',
    parent: '/compare',
  },
  {
    path: '/compare/resy',
    file: 'compare-resy.html',
    title: (b) => `Resy alternative you pay for once | ${b}`,
    description: 'Resy costs $289 to $459 a month, every month. Compare it with a one-time $1,000 reservation system restaurants own.',
    crumb: 'Resy',
    parent: '/compare',
  },
  {
    path: '/compare/tock',
    file: 'compare-tock.html',
    title: (b) => `Tock alternative for everyday reservations | ${b}`,
    description: 'Tock is built for prepaid experiences. If you mostly take regular reservations, compare its subscription and prepayment fees with a $1,000 one-time license.',
    crumb: 'Tock',
    parent: '/compare',
  },
  {
    path: '/compare/yelp',
    file: 'compare-yelp.html',
    title: (b) => `Yelp Guest Manager alternative | ${b}`,
    description: 'Yelp Guest Manager Basic is $159 a month with a 500-cover cap. Compare it with a $1,000 one-time reservation system with no cap.',
    crumb: 'Yelp Guest Manager',
    parent: '/compare',
  },
  {
    path: '/co-op',
    file: 'co-op.html',
    title: (b) => `A reservation system owned by restaurants | ${b}`,
    description: 'Open source under the AGPL and being formed as a cooperative of the restaurants that use it. Why that matters, and how membership is planned to work.',
    crumb: 'Co-op and open source',
  },
  {
    path: '/switch',
    file: 'switch.html',
    title: (b) => `Switch from OpenTable, Resy, Tock or Yelp | ${b}`,
    description: 'Move your guest list and future bookings in an afternoon and cut over without losing a reservation. A step-by-step guide.',
    crumb: 'Switching guide',
  },
];

function structuredData(app, page) {
  const base = app.config.baseUrl;
  const brand = app.config.brand.name;
  const org = { '@type': 'Organization', '@id': `${base}/#org`, name: brand, url: `${base}/`, logo: `${base}/assets/og.png` };
  const product = {
    '@type': 'SoftwareApplication',
    name: brand,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    url: `${base}/`,
    publisher: { '@id': `${base}/#org` },
    license: 'https://www.gnu.org/licenses/agpl-3.0.html',
    offers: { '@type': 'Offer', price: '1000', priceCurrency: 'USD', description: 'One-time license per location' },
  };
  const graph = [org];
  if (page.path === '/' || page.path === '/pricing') graph.push(product);
  if (page.crumb) {
    const trail = [{ name: 'Home', path: '/' }];
    const parent = page.parent && SITE_PAGES.find((p) => p.path === page.parent);
    if (parent) trail.push({ name: parent.crumb, path: parent.path });
    trail.push({ name: page.crumb, path: page.path });
    graph.push({
      '@type': 'BreadcrumbList',
      itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, item: `${base}${t.path}` })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

export function registerSite(router, app) {
  for (const page of SITE_PAGES) {
    router.get(page.path, (ctx) => {
      const brand = app.config.brand.name;
      const content = renderPage(app, `site/${page.file}`);
      const html = renderPage(app, 'site/layout.html', {
        TITLE: page.title(brand),
        DESCRIPTION: page.description,
        CANONICAL: `${app.config.baseUrl}${page.path}`,
        JSONLD_RAW: scriptJson(structuredData(app, page)),
        CONTENT_RAW: content,
      });
      sendHtml(ctx.res, html);
    });
  }
}
