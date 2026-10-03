// Tripadvisor Content API. Nearby search returns up to 10 locations without
// ratings, so each one costs a follow-up details call (11 calls per search).
// https://tripadvisor-content-api.readme.io/reference/overview
import { fetchJson, mapLimit } from '../http.js';
import { canonicalCuisines, priceFromSymbols } from '../normalize.js';

const BASE = 'https://api.content.tripadvisor.com/api/v1';

export const id = 'tripadvisor';
export const label = 'Tripadvisor';

export function isEnabled(env) {
  return Boolean(env.TRIPADVISOR_API_KEY);
}

export function toRecord(d) {
  const rating = d.rating != null ? Number(d.rating) : null;
  return {
    source: id,
    id: String(d.location_id),
    name: d.name ?? '',
    lat: d.latitude != null ? Number(d.latitude) : undefined,
    lng: d.longitude != null ? Number(d.longitude) : undefined,
    address: d.address_obj?.address_string ?? null,
    phone: d.phone ?? null,
    rating: Number.isFinite(rating) ? rating : null,
    reviewCount: Number(d.num_reviews) || 0,
    price: priceFromSymbols(d.price_level),
    cuisines: canonicalCuisines((d.cuisine || []).map((c) => c.name)),
    url: d.web_url ?? null,
    website: d.website ?? null,
    openNow: null,
  };
}

export async function search({ lat, lng, radius }, env) {
  const headers = { Accept: 'application/json' };
  if (env.TRIPADVISOR_REFERER) headers.Referer = env.TRIPADVISOR_REFERER;
  const key = encodeURIComponent(env.TRIPADVISOR_API_KEY);
  const radiusKm = Math.max(0.1, Math.min(radius / 1000, 25)).toFixed(2);
  const nearby = await fetchJson(
    `${BASE}/location/nearby_search?latLong=${lat},${lng}&category=restaurants&radius=${radiusKm}&radiusUnit=km&language=en&key=${key}`,
    { headers },
  );
  const ids = (nearby.data || []).map((d) => d.location_id);
  const details = await mapLimit(ids, 5, (locId) =>
    fetchJson(`${BASE}/location/${locId}/details?language=en&currency=USD&key=${key}`, { headers }),
  );
  return details.filter(Boolean).map(toRecord);
}
