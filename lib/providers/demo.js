// Synthetic data for trying the UI without API keys. Generates the same fake
// neighborhood for a given location, then emits it as overlapping, slightly
// inconsistent Google / Yelp / Tripadvisor / OSM records so the matching and
// scoring pipeline runs exactly as it would on real data. Never mixed with
// real sources: when demo mode is on, it is the only provider.
import { canonicalCuisines } from '../normalize.js';

export const id = 'demo';
export const label = 'Demo data';

const PREFIXES = ['Golden', 'Little', 'Blue', 'Old Town', 'Lucky', 'Red', 'Corner', 'Sunset', 'Green', 'Copper', 'Midtown', 'Rustic', 'Happy', 'Silver', 'Night Owl'];
const KINDS = [
  ['Taqueria', ['mexican'], 1],
  ['Pizza Co.', ['pizza', 'italian'], 2],
  ['Trattoria', ['italian'], 3],
  ['Sushi Bar', ['sushi_restaurant', 'japanese'], 3],
  ['Ramen House', ['ramen_restaurant'], 2],
  ['Pho', ['vietnamese_restaurant'], 1],
  ['Thai Kitchen', ['thai_restaurant'], 2],
  ['Curry House', ['indian_restaurant'], 2],
  ['Dumpling House', ['chinese_restaurant'], 1],
  ['Korean BBQ', ['korean_restaurant', 'barbecue_restaurant'], 3],
  ['Burger Joint', ['hamburger_restaurant', 'american_restaurant'], 1],
  ['Smokehouse', ['barbecue_restaurant'], 2],
  ['Diner', ['diner', 'breakfast_restaurant'], 1],
  ['Bistro', ['french_restaurant'], 3],
  ['Steakhouse', ['steak_house'], 4],
  ['Oyster Bar', ['seafood_restaurant'], 3],
  ['Mezze', ['mediterranean_restaurant', 'middle_eastern_restaurant'], 2],
  ['Cafe', ['cafe', 'breakfast_restaurant'], 1],
  ['Vegan Kitchen', ['vegan_restaurant'], 2],
  ['Tapas Bar', ['spanish_restaurant'], 3],
  ['Ethiopian', ['ethiopian'], 2],
  ['Deli', ['sandwich_shop'], 1],
  ['Gastropub', ['gastropub'], 2],
  ['Peruvian Grill', ['peruvian'], 2],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const yelpRound = (n) => clamp(Math.round(n * 2) / 2, 1, 5);

function neighborhood(lat, lng, radius) {
  const rand = mulberry32(Math.round(lat * 1000) * 73856093 ^ Math.round(lng * 1000) * 19349663);
  const count = 45;
  const places = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    let name;
    let kind;
    do {
      kind = KINDS[Math.floor(rand() * KINDS.length)];
      name = `${PREFIXES[Math.floor(rand() * PREFIXES.length)]} ${kind[0]}`;
    } while (used.has(name));
    used.add(name);
    const dist = Math.sqrt(rand()) * radius * 0.95;
    const bearing = rand() * 2 * Math.PI;
    const dLat = (dist * Math.cos(bearing)) / 111320;
    const dLng = (dist * Math.sin(bearing)) / (111320 * Math.cos((lat * Math.PI) / 180));
    const quality = clamp(3.2 + rand() * 1.7 + (rand() - 0.5) * 0.4, 2.5, 4.9);
    const popularity = Math.floor(Math.exp(rand() * 7.5)) + 3;
    places.push({
      i,
      name,
      types: kind[1],
      price: kind[2],
      lat: lat + dLat,
      lng: lng + dLng,
      quality,
      popularity,
      phone: `(555) ${String(100 + Math.floor(rand() * 900))}-${String(1000 + Math.floor(rand() * 9000))}`,
      street: `${100 + Math.floor(rand() * 9800)} ${['Main', 'Oak', 'J', 'K', 'Broadway', 'Folsom', 'Capitol', 'Elm'][Math.floor(rand() * 8)]} St`,
      openNow: rand() > 0.25,
      coverage: rand(),
    });
  }
  return { places, rand };
}

function jitter(rand, v, meters) {
  return v + ((rand() - 0.5) * 2 * meters) / 111320;
}

export async function search({ lat, lng, radius }) {
  const { places, rand } = neighborhood(lat, lng, Math.min(radius, 8000));
  const out = [];
  for (const p of places) {
    const base = { address: p.street, phone: p.phone };
    if (p.coverage > 0.08) {
      out.push({
        ...base,
        source: 'google',
        id: `g-${p.i}`,
        name: p.name,
        lat: jitter(rand, p.lat, 8),
        lng: jitter(rand, p.lng, 8),
        rating: round1(clamp(p.quality + (rand() - 0.4) * 0.3, 1, 5)),
        reviewCount: p.popularity * 3,
        price: p.price,
        types: p.types,
        url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}`,
        openNow: p.openNow,
      });
    }
    if (p.coverage > 0.2) {
      out.push({
        ...base,
        source: 'yelp',
        id: `y-${p.i}`,
        name: p.i % 4 === 0 ? `${p.name} Restaurant` : p.name,
        lat: jitter(rand, p.lat, 20),
        lng: jitter(rand, p.lng, 20),
        rating: yelpRound(p.quality + (rand() - 0.6) * 0.6),
        reviewCount: Math.max(1, Math.floor(p.popularity * (0.3 + rand() * 0.6))),
        price: p.price,
        types: p.types,
        url: `https://www.yelp.com/search?find_desc=${encodeURIComponent(p.name)}`,
        openNow: p.openNow,
      });
    }
    if (p.coverage > 0.55) {
      out.push({
        ...base,
        source: 'tripadvisor',
        id: `t-${p.i}`,
        name: p.name.replace(' Co.', ''),
        lat: jitter(rand, p.lat, 30),
        lng: jitter(rand, p.lng, 30),
        rating: yelpRound(p.quality + (rand() - 0.5) * 0.5),
        reviewCount: Math.max(1, Math.floor(p.popularity * 0.15)),
        price: p.price,
        types: p.types,
        url: `https://www.tripadvisor.com/Search?q=${encodeURIComponent(p.name)}`,
        openNow: null,
      });
    }
    if (p.coverage > 0.3) {
      out.push({
        source: 'osm',
        id: `o-${p.i}`,
        name: p.name,
        lat: jitter(rand, p.lat, 15),
        lng: jitter(rand, p.lng, 15),
        address: p.street,
        phone: rand() > 0.5 ? p.phone : null,
        rating: null,
        reviewCount: 0,
        price: null,
        types: p.types,
        url: null,
        openNow: null,
      });
    }
  }
  return out.map(({ types, ...r }) => ({ ...r, cuisines: canonicalCuisines(types) }));
}

export function isEnabled(env) {
  return env.FOODWREKS_DEMO === '1';
}
