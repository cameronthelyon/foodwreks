// Google Places API (New), Text Search. Up to 3 pages x 20 results.
// https://developers.google.com/maps/documentation/places/web-service/text-search
import { fetchJson } from '../http.js';
import { canonicalCuisines, priceFromGoogle } from '../normalize.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.types',
  'places.primaryType',
  'places.googleMapsUri',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.currentOpeningHours.openNow',
  'places.businessStatus',
  'nextPageToken',
].join(',');
const MAX_PAGES = 3;

export const id = 'google';
export const label = 'Google';

export function isEnabled(env) {
  return Boolean(env.GOOGLE_PLACES_API_KEY);
}

export function toRecord(p) {
  return {
    source: id,
    id: p.id,
    name: p.displayName?.text ?? '',
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    address: p.formattedAddress ?? null,
    phone: p.nationalPhoneNumber ?? null,
    rating: typeof p.rating === 'number' ? p.rating : null,
    reviewCount: p.userRatingCount ?? 0,
    price: priceFromGoogle(p.priceLevel),
    cuisines: canonicalCuisines([p.primaryType, ...(p.types || [])]),
    url: p.googleMapsUri ?? null,
    website: p.websiteUri ?? null,
    openNow: p.currentOpeningHours?.openNow ?? null,
  };
}

export async function search({ lat, lng, radius }, env) {
  const body = {
    textQuery: 'restaurants',
    pageSize: 20,
    locationBias: {
      circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(radius, 50000) },
    },
  };
  const records = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await fetchJson(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(pageToken ? { ...body, pageToken } : body),
    });
    for (const p of data.places || []) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue;
      records.push(toRecord(p));
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return records;
}
