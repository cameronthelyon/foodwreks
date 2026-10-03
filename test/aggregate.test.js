import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, bayesian, blendRatings, clusterRecords } from '../lib/aggregate.js';

const origin = { lat: 38.5767, lng: -121.4934 };
const rec = (source, name, dLatM, extra = {}) => ({
  source,
  id: `${source}-${name}`,
  name,
  lat: origin.lat + dLatM / 111320,
  lng: origin.lng,
  rating: null,
  reviewCount: 0,
  price: null,
  cuisines: [],
  ...extra,
});

test('matches the same place across sources despite name and coordinate drift', () => {
  const clusters = clusterRecords([
    rec('google', "Joe's Pizza", 0, { rating: 4.6, reviewCount: 900 }),
    rec('yelp', 'Joes Pizza Restaurant', 25, { rating: 4.0, reviewCount: 300 }),
    rec('osm', "Joe's Pizza", 60),
    rec('tripadvisor', 'Joe’s Pizza', 90, { rating: 4.5, reviewCount: 40 }),
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].length, 4);
});

test('does not merge different places that are next door', () => {
  const clusters = clusterRecords([
    rec('google', 'Golden Pho', 0),
    rec('yelp', 'Lucky Taqueria', 10),
  ]);
  assert.equal(clusters.length, 2);
});

test('does not merge same-named places far apart (chains)', () => {
  const clusters = clusterRecords([
    rec('google', 'Chipotle Mexican Grill', 0),
    rec('yelp', 'Chipotle Mexican Grill', 1200),
  ]);
  assert.equal(clusters.length, 2);
});

test('phone match merges even when names diverge', () => {
  const clusters = clusterRecords([
    rec('google', 'Sakura', 0, { phone: '(916) 555-0101' }),
    rec('yelp', 'Sakura Japanese Cuisine & Sushi Bar Downtown', 120, { phone: '+19165550101' }),
  ]);
  assert.equal(clusters.length, 1);
});

test('never merges two records from the same source', () => {
  const clusters = clusterRecords([
    rec('google', 'Starbucks', 0),
    rec('google', 'Starbucks', 15),
  ]);
  assert.equal(clusters.length, 2);
});

test('blend weights by review count, capped per source', () => {
  const b = blendRatings([
    { rating: 5, reviewCount: 10 },
    { rating: 4, reviewCount: 90 },
  ]);
  assert.equal(b.mean.toFixed(2), '4.10');
  assert.equal(b.totalReviews, 100);
  const capped = blendRatings([
    { rating: 4.8, reviewCount: 20000 },
    { rating: 3.5, reviewCount: 500 },
  ]);
  assert.equal(capped.mean.toFixed(2), '4.15'); // 500 vs 500, not 20000 vs 500
  assert.equal(blendRatings([{ rating: null, reviewCount: 0 }]), null);
});

test('bayesian average ranks well-reviewed 4.7 over thinly reviewed 5.0', () => {
  const few = bayesian(5.0, 3, 4.0);
  const many = bayesian(4.7, 2000, 4.0);
  assert.ok(many > few, `${many} should beat ${few}`);
});

test('aggregate scores, sorts, tags and trims to radius', () => {
  const { restaurants, prior } = aggregate(
    [
      rec('google', 'A Place', 100, { rating: 4.7, reviewCount: 2000, price: 2, cuisines: ['Thai'] }),
      rec('yelp', 'A Place', 110, { rating: 4.5, reviewCount: 600, price: 2, cuisines: ['Thai'] }),
      rec('google', 'B Place', 300, { rating: 5.0, reviewCount: 3 }),
      rec('google', 'C Place', 500, { rating: 3.6, reviewCount: 400 }),
      rec('osm', 'D Unrated', 200),
      rec('google', 'Far Away', 9000, { rating: 4.9, reviewCount: 5000 }),
    ],
    origin,
    { radius: 2000 },
  );
  assert.deepEqual(
    restaurants.map((r) => r.name),
    ['A Place', 'B Place', 'C Place', 'D Unrated'],
  );
  assert.ok(prior > 4 && prior < 4.7);
  const a = restaurants[0];
  assert.deepEqual(a.sources.map((s) => s.source), ['google', 'yelp']);
  assert.equal(a.price, 2);
  assert.ok(a.tags.includes('top-pick'));
  assert.equal(restaurants[3].score, null);
  assert.ok(restaurants[1].score < 4.7, 'thin 5.0 is pulled toward the prior');
});

test('flags disagreement between sources', () => {
  const { restaurants } = aggregate(
    [
      rec('google', 'Split Opinion', 0, { rating: 4.8, reviewCount: 300 }),
      rec('yelp', 'Split Opinion', 20, { rating: 3.5, reviewCount: 200 }),
    ],
    origin,
  );
  assert.ok(restaurants[0].tags.includes('mixed-reviews'));
});
