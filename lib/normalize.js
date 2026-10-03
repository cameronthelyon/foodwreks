// Shared normalization helpers: names, phones, geo distance, price, cuisine.

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'restaurant', 'restaurants', 'cafe', 'bar', 'grill',
  'kitchen', 'eatery', 'co', 'company', 'inc', 'llc', 'of',
]);

export function normalizeName(name = '') {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function nameTokens(name) {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  const meaningful = tokens.filter((t) => !NAME_STOPWORDS.has(t));
  return new Set(meaningful.length ? meaningful : tokens);
}

// Similarity in [0,1]: token Jaccard, boosted to 0.9 when one name's tokens
// fully contain the other's ("Joe's" vs "Joe's Pizza - Downtown").
export function nameSimilarity(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const contained = inter === Math.min(ta.size, tb.size);
  return contained ? Math.max(jaccard, 0.9) : jaccard;
}

export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// Canonical price is an integer 1-4, or null when unknown.
const GOOGLE_PRICE = {
  PRICE_LEVEL_FREE: 1,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

export function priceFromGoogle(level) {
  return GOOGLE_PRICE[level] ?? null;
}

// Handles "$$", "££", and Tripadvisor ranges like "$$ - $$$" (rounded up).
export function priceFromSymbols(str) {
  if (!str) return null;
  const runs = String(str).match(/[$£€¥₩]+/g);
  if (!runs) return null;
  const lens = runs.map((r) => r.length);
  const avg = lens.reduce((s, n) => s + n, 0) / lens.length;
  return Math.min(4, Math.max(1, Math.ceil(avg)));
}

// Canonical cuisine list. Each entry maps from source-specific keys.
// Matching is done on lowercased keys with underscores/hyphens as spaces.
export const CUISINES = [
  ['American', ['american', 'american restaurant', 'tradamerican', 'newamerican', 'diner', 'diners', 'comfortfood', 'southern', 'soul food', 'soulfood', 'cajun']],
  ['Mexican', ['mexican', 'tex mex', 'tacos', 'burrito', 'taqueria']],
  ['Italian', ['italian', 'pasta']],
  ['Pizza', ['pizza']],
  ['Chinese', ['chinese', 'cantonese', 'szechuan', 'sichuan', 'dimsum', 'dim sum', 'dumplings', 'hotpot', 'shanghainese']],
  ['Japanese', ['japanese', 'izakaya', 'teppanyaki']],
  ['Sushi', ['sushi', 'sushi bars']],
  ['Ramen', ['ramen', 'noodles', 'noodle']],
  ['Korean', ['korean', 'korean bbq']],
  ['Thai', ['thai']],
  ['Vietnamese', ['vietnamese', 'pho', 'banh mi']],
  ['Indian', ['indian', 'pakistani', 'himalayan', 'nepalese', 'bangladeshi', 'indpak', 'south indian']],
  ['Mediterranean', ['mediterranean', 'greek', 'falafel', 'turkish', 'lebanese']],
  ['Middle Eastern', ['middle eastern', 'mideastern', 'persian', 'afghan', 'afghani', 'kebab', 'halal', 'arab', 'israeli']],
  ['French', ['french', 'bistro', 'brasserie', 'creperies', 'crepe']],
  ['Spanish', ['spanish', 'tapas', 'tapasmallplates', 'basque']],
  ['Latin American', ['latin', 'latin american', 'peruvian', 'brazilian', 'colombian', 'salvadoran', 'cuban', 'venezuelan', 'argentine', 'argentinian', 'arepas']],
  ['Caribbean', ['caribbean', 'jamaican', 'puerto rican', 'haitian', 'dominican']],
  ['African', ['african', 'ethiopian', 'eritrean', 'nigerian', 'moroccan', 'senegalese']],
  ['Seafood', ['seafood', 'fish', 'fish and chips', 'fishnchips', 'poke', 'oyster']],
  ['Steakhouse', ['steak', 'steakhouse', 'steakhouses', 'steak house']],
  ['BBQ', ['bbq', 'barbecue', 'barbeque', 'smokehouse']],
  ['Burgers', ['burger', 'burgers', 'hamburger', 'hamburger restaurant']],
  ['Sandwiches', ['sandwich', 'sandwiches', 'sandwich shop', 'delis', 'deli']],
  ['Chicken', ['chicken', 'chicken wings', 'chicken_wings', 'wings', 'fried chicken', 'chickenshop']],
  ['Breakfast & Brunch', ['breakfast', 'brunch', 'breakfast restaurant', 'brunch restaurant', 'breakfast brunch', 'pancakes']],
  ['Cafe & Bakery', ['cafe', 'coffee', 'coffee shop', 'bakery', 'bakeries', 'tea', 'cafes', 'donut', 'donuts']],
  ['Vegetarian & Vegan', ['vegetarian', 'vegan', 'raw food', 'raw_food']],
  ['Salad & Healthy', ['salad', 'healthy', 'juice', 'juicebars', 'acai', 'acai shop', 'acaibowls']],
  ['Fast Food', ['fast food', 'hotdogs', 'hot dog', 'fast food restaurant']],
  ['Dessert', ['dessert', 'desserts', 'ice cream', 'icecream', 'ice cream shop', 'frozen yogurt']],
  ['Pub & Bar Food', ['pub', 'gastropub', 'gastropubs', 'bar', 'sports bar', 'sportsbars', 'wine bar', 'beer garden', 'brewery', 'breweries']],
];

const CUISINE_LOOKUP = new Map();
for (const [canonical, keys] of CUISINES) {
  CUISINE_LOOKUP.set(canonical.toLowerCase(), canonical);
  for (const k of keys) CUISINE_LOOKUP.set(k, canonical);
}

function cleanKey(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+restaurant$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Map an arbitrary source label (Google type, Yelp alias/title, OSM cuisine
// tag, Tripadvisor cuisine name) to a canonical cuisine, or null.
export function canonicalCuisine(raw) {
  if (!raw) return null;
  const full = String(raw).toLowerCase().replace(/[_-]+/g, ' ').trim();
  return CUISINE_LOOKUP.get(full) ?? CUISINE_LOOKUP.get(cleanKey(raw)) ?? null;
}

export function canonicalCuisines(rawList) {
  const out = new Set();
  for (const raw of rawList || []) {
    // OSM packs multiple cuisines as "pizza;italian".
    for (const part of String(raw).split(/[;,]/)) {
      const c = canonicalCuisine(part.trim());
      if (c) out.add(c);
    }
  }
  return [...out];
}
