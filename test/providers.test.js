// Parsers checked against the documented response shapes of each API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as google from '../lib/providers/google.js';
import * as yelp from '../lib/providers/yelp.js';
import * as tripadvisor from '../lib/providers/tripadvisor.js';
import * as osm from '../lib/providers/osm.js';
import * as demo from '../lib/providers/demo.js';
import { aggregate } from '../lib/aggregate.js';

test('google place -> record', () => {
  const r = google.toRecord({
    id: 'ChIJ123',
    displayName: { text: 'Tacos El Gordo', languageCode: 'en' },
    formattedAddress: '123 J St, Sacramento, CA',
    location: { latitude: 38.58, longitude: -121.49 },
    rating: 4.6,
    userRatingCount: 1532,
    priceLevel: 'PRICE_LEVEL_INEXPENSIVE',
    types: ['mexican_restaurant', 'restaurant', 'food', 'point_of_interest'],
    primaryType: 'mexican_restaurant',
    googleMapsUri: 'https://maps.google.com/?cid=1',
    currentOpeningHours: { openNow: true },
    nationalPhoneNumber: '(916) 555-0100',
  });
  assert.equal(r.name, 'Tacos El Gordo');
  assert.equal(r.price, 1);
  assert.deepEqual(r.cuisines, ['Mexican']);
  assert.equal(r.openNow, true);
  assert.equal(r.reviewCount, 1532);
});

test('yelp business -> record', () => {
  const r = yelp.toRecord({
    id: 'abc',
    name: 'Tacos El Gordo',
    rating: 4.5,
    review_count: 812,
    price: '$',
    categories: [{ alias: 'mexican', title: 'Mexican' }, { alias: 'foodtrucks', title: 'Food Trucks' }],
    coordinates: { latitude: 38.5801, longitude: -121.4902 },
    location: { display_address: ['123 J St', 'Sacramento, CA 95814'] },
    display_phone: '(916) 555-0100',
    url: 'https://www.yelp.com/biz/tacos?adjust_creative=x&utm_source=y',
    business_hours: [{ is_open_now: false }],
  });
  assert.equal(r.price, 1);
  assert.deepEqual(r.cuisines, ['Mexican']);
  assert.equal(r.url, 'https://www.yelp.com/biz/tacos');
  assert.equal(r.openNow, false);
  assert.equal(r.address, '123 J St, Sacramento, CA 95814');
});

test('tripadvisor details -> record (string numbers)', () => {
  const r = tripadvisor.toRecord({
    location_id: 987,
    name: 'Tacos El Gordo',
    latitude: '38.5802',
    longitude: '-121.4901',
    rating: '4.5',
    num_reviews: '57',
    price_level: '$$ - $$$',
    cuisine: [{ name: 'mexican', localized_name: 'Mexican' }, { name: 'latin', localized_name: 'Latin' }],
    web_url: 'https://www.tripadvisor.com/Restaurant_Review-x',
  });
  assert.equal(r.rating, 4.5);
  assert.equal(r.reviewCount, 57);
  assert.equal(r.price, 3);
  assert.deepEqual(r.cuisines, ['Mexican', 'Latin American']);
  assert.equal(r.lat, 38.5802);
});

test('osm element -> record', () => {
  const r = osm.toRecord({
    type: 'way',
    id: 42,
    center: { lat: 38.5803, lon: -121.49 },
    tags: { amenity: 'restaurant', name: 'Tacos El Gordo', cuisine: 'mexican;tacos', 'addr:housenumber': '123', 'addr:street': 'J Street' },
  });
  assert.equal(r.lat, 38.5803);
  assert.equal(r.rating, null);
  assert.deepEqual(r.cuisines, ['Mexican']);
  assert.equal(r.address, '123 J Street');
});

test('the four parsed records collapse into one restaurant', () => {
  const recs = [
    google.toRecord({ id: 'g', displayName: { text: 'Tacos El Gordo' }, location: { latitude: 38.58, longitude: -121.49 }, rating: 4.6, userRatingCount: 1532, nationalPhoneNumber: '(916) 555-0100' }),
    yelp.toRecord({ id: 'y', name: 'Tacos El Gordo', rating: 4.5, review_count: 812, coordinates: { latitude: 38.5801, longitude: -121.4902 }, display_phone: '(916) 555-0100' }),
    tripadvisor.toRecord({ location_id: 1, name: 'Tacos El Gordo', latitude: '38.5802', longitude: '-121.4901', rating: '4.5', num_reviews: '57' }),
    osm.toRecord({ type: 'node', id: 1, lat: 38.5803, lon: -121.49, tags: { name: 'Tacos El Gordo' } }),
  ];
  const { restaurants } = aggregate(recs, { lat: 38.58, lng: -121.49 });
  assert.equal(restaurants.length, 1);
  assert.equal(restaurants[0].sources.length, 4);
});

test('demo provider is deterministic and round-trips through matching', async () => {
  const q = { lat: 38.5767, lng: -121.4934, radius: 3000 };
  const a = await demo.search(q);
  const b = await demo.search(q);
  assert.deepEqual(a, b);
  const { restaurants } = aggregate(a, q, { radius: q.radius });
  // 45 generated places; a few have no coverage. Over-merging would push this well below.
  assert.ok(restaurants.length >= 38 && restaurants.length <= 45, `got ${restaurants.length}`);
  const multi = restaurants.filter((r) => r.sources.length > 1).length;
  assert.ok(multi / restaurants.length > 0.8, 'most demo places should merge across sources');
});
