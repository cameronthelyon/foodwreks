// Yelp Fusion business search. Up to 2 pages x 50 results.
// https://docs.developer.yelp.com/reference/v3_business_search
import { fetchJson } from '../http.js';
import { canonicalCuisines, priceFromSymbols } from '../normalize.js';

const ENDPOINT = 'https://api.yelp.com/v3/businesses/search';
const PAGE_SIZE = 50;
const MAX_PAGES = 2;

export const id = 'yelp';
export const label = 'Yelp';

export function isEnabled(env) {
  return Boolean(env.YELP_API_KEY);
}

export function toRecord(b) {
  const cats = b.categories || [];
  return {
    source: id,
    id: b.id,
    name: b.name ?? '',
    lat: b.coordinates?.latitude,
    lng: b.coordinates?.longitude,
    address: b.location?.display_address?.join(', ') ?? null,
    phone: b.display_phone || b.phone || null,
    rating: typeof b.rating === 'number' ? b.rating : null,
    reviewCount: b.review_count ?? 0,
    price: priceFromSymbols(b.price),
    cuisines: canonicalCuisines(cats.flatMap((c) => [c.alias, c.title])),
    url: b.url ? b.url.split('?')[0] : null,
    website: null,
    openNow: b.business_hours?.[0]?.is_open_now ?? null,
    imageUrl: b.image_url || null,
  };
}

export async function search({ lat, lng, radius }, env) {
  const records = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      radius: String(Math.min(Math.round(radius), 40000)),
      categories: 'restaurants,coffee,bakeries,foodtrucks,desserts',
      sort_by: 'best_match',
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    const data = await fetchJson(`${ENDPOINT}?${params}`, {
      headers: { Authorization: `Bearer ${env.YELP_API_KEY}`, Accept: 'application/json' },
    });
    const businesses = data.businesses || [];
    for (const b of businesses) {
      if (b.is_closed) continue;
      records.push(toRecord(b));
    }
    if (businesses.length < PAGE_SIZE || records.length >= (data.total ?? Infinity)) break;
  }
  return records;
}
