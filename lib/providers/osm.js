// OpenStreetMap via the Overpass API. Free and keyless, but has no ratings:
// it contributes discovery, cuisine tags, phone and website only.
// https://wiki.openstreetmap.org/wiki/Overpass_API
import { fetchJson } from '../http.js';
import { canonicalCuisines } from '../normalize.js';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const MAX_RADIUS = 5000;
const MAX_RESULTS = 300;

export const id = 'osm';
export const label = 'OpenStreetMap';

export function isEnabled(env) {
  return env.OSM_DISABLED !== '1';
}

function address(t) {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const parts = [street, t['addr:city']].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function toRecord(el) {
  const t = el.tags || {};
  const cuisines = canonicalCuisines([t.cuisine, t.amenity === 'cafe' ? 'cafe' : null].filter(Boolean));
  if (t.diet_vegan === 'only' || t['diet:vegan'] === 'only' || t['diet:vegetarian'] === 'only') {
    cuisines.push('Vegetarian & Vegan');
  }
  return {
    source: id,
    id: `${el.type}/${el.id}`,
    name: t.name ?? '',
    lat: el.lat ?? el.center?.lat,
    lng: el.lon ?? el.center?.lon,
    address: address(t),
    phone: t.phone || t['contact:phone'] || null,
    rating: null,
    reviewCount: 0,
    price: null,
    cuisines: [...new Set(cuisines)],
    url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    website: t.website || t['contact:website'] || null,
    openNow: null,
  };
}

export async function search({ lat, lng, radius }, env) {
  const r = Math.min(Math.round(radius), MAX_RADIUS);
  const filter = `["amenity"~"^(restaurant|fast_food|cafe)$"]["name"](around:${r},${lat},${lng})`;
  const query = `[out:json][timeout:20];(node${filter};way${filter};);out center ${MAX_RESULTS};`;
  const data = await fetchJson(env.OVERPASS_URL || ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'foodwreks/0.1' },
    body: `data=${encodeURIComponent(query)}`,
    timeoutMs: 25000,
  });
  return (data.elements || []).map(toRecord).filter((rec) => rec.name && rec.lat != null);
}
