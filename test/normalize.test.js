import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalCuisines,
  haversineMeters,
  nameSimilarity,
  normalizePhone,
  priceFromGoogle,
  priceFromSymbols,
} from '../lib/normalize.js';

test('haversine is roughly right', () => {
  // 0.001 deg latitude ~ 111 m
  const d = haversineMeters({ lat: 38.5, lng: -121.5 }, { lat: 38.501, lng: -121.5 });
  assert.ok(Math.abs(d - 111.2) < 1, `got ${d}`);
});

test('name similarity handles suffixes, punctuation and accents', () => {
  assert.ok(nameSimilarity("Joe's Pizza", 'Joes Pizza Restaurant') >= 0.9);
  assert.ok(nameSimilarity('Café Bernardo', 'Cafe Bernardo - Midtown') >= 0.9);
  assert.ok(nameSimilarity('The Kitchen & Bar', 'Kitchen and Bar') >= 0.5);
  assert.ok(nameSimilarity('Golden Pho', 'Lucky Pizza Co.') < 0.2);
});

test('phone normalization keeps last 10 digits', () => {
  assert.equal(normalizePhone('+1 (916) 555-0134'), '9165550134');
  assert.equal(normalizePhone('916.555.0134'), '9165550134');
  assert.equal(normalizePhone('555-0134'), null);
  assert.equal(normalizePhone(null), null);
});

test('price normalization', () => {
  assert.equal(priceFromGoogle('PRICE_LEVEL_MODERATE'), 2);
  assert.equal(priceFromGoogle('PRICE_LEVEL_UNSPECIFIED'), null);
  assert.equal(priceFromSymbols('$$$'), 3);
  assert.equal(priceFromSymbols('$$ - $$$'), 3);
  assert.equal(priceFromSymbols('$'), 1);
  assert.equal(priceFromSymbols(''), null);
});

test('cuisine mapping across source vocabularies', () => {
  assert.deepEqual(canonicalCuisines(['mexican_restaurant', 'restaurant', 'food']), ['Mexican']);
  assert.deepEqual(canonicalCuisines(['tradamerican', 'Burgers']), ['American', 'Burgers']);
  assert.deepEqual(canonicalCuisines(['pizza;italian']), ['Pizza', 'Italian']);
  assert.deepEqual(canonicalCuisines(['sushi_restaurant']), ['Sushi']);
  assert.deepEqual(canonicalCuisines(['Steakhouse']), ['Steakhouse']);
  assert.deepEqual(canonicalCuisines(['point_of_interest']), []);
});
