// Entity resolution (which records across sources are the same restaurant)
// and scoring (one comparable number per restaurant).
import { haversineMeters, nameSimilarity, normalizePhone } from './normalize.js';

// Order matters: earlier sources seed clusters and win ties on display fields.
export const SOURCE_PRIORITY = ['google', 'yelp', 'tripadvisor', 'osm'];

const MATCH = {
  phoneMaxMeters: 400, // same phone within this distance is the same place
  nearMeters: 40, // very close: accept a weaker name match
  nearMinSimilarity: 0.34,
  farMeters: 150, // further: require a strong name match
  farMinSimilarity: 0.5,
};

// Scoring knobs. See README "How scoring works".
export const SCORING = {
  priorWeight: 30, // m: reviews' worth of pull toward the prior mean
  defaultPrior: 4.0, // C when the result set has no ratings to learn from
  perSourceReviewCap: 500, // stop any one source drowning out the others
  disagreementSpread: 0.75, // stars between sources before we flag it
};

const priorityOf = (source) => {
  const i = SOURCE_PRIORITY.indexOf(source);
  return i === -1 ? SOURCE_PRIORITY.length : i;
};

function matchScore(cluster, rec) {
  if (cluster.records.some((r) => r.source === rec.source)) return 0;
  const dist = haversineMeters(cluster, rec);
  if (dist > Math.max(MATCH.farMeters, MATCH.phoneMaxMeters)) return 0;
  const phone = normalizePhone(rec.phone);
  if (phone && dist <= MATCH.phoneMaxMeters && cluster.phones.has(phone)) return 2;
  let best = 0;
  for (const r of cluster.records) best = Math.max(best, nameSimilarity(r.name, rec.name));
  if (dist <= MATCH.nearMeters && best >= MATCH.nearMinSimilarity) return best;
  if (dist <= MATCH.farMeters && best >= MATCH.farMinSimilarity) return best;
  return 0;
}

export function clusterRecords(records) {
  const valid = records.filter(
    (r) => r && r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng),
  );
  valid.sort((a, b) => priorityOf(a.source) - priorityOf(b.source));
  const clusters = [];
  for (const rec of valid) {
    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      const s = matchScore(c, rec);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    if (!best) {
      best = { lat: rec.lat, lng: rec.lng, records: [], phones: new Set() };
      clusters.push(best);
    }
    best.records.push(rec);
    const phone = normalizePhone(rec.phone);
    if (phone) best.phones.add(phone);
  }
  return clusters.map((c) => c.records);
}

function firstDefined(records, key) {
  for (const r of records) if (r[key] != null && r[key] !== '') return r[key];
  return null;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Weighted mean of per-source ratings, each weighted by its (capped) count.
export function blendRatings(records, cap = SCORING.perSourceReviewCap) {
  const rated = records.filter((r) => r.rating != null && r.reviewCount > 0);
  if (!rated.length) return null;
  let num = 0;
  let den = 0;
  let total = 0;
  for (const r of rated) {
    const w = Math.min(r.reviewCount, cap);
    num += r.rating * w;
    den += w;
    total += r.reviewCount;
  }
  const ratings = rated.map((r) => r.rating);
  return {
    mean: num / den,
    weight: den,
    totalReviews: total,
    spread: Math.max(...ratings) - Math.min(...ratings),
  };
}

// Bayesian average: pulls thinly reviewed places toward the prior so a 5.0
// with 3 reviews does not outrank a 4.7 with 2,000.
export function bayesian(mean, weight, prior, m = SCORING.priorWeight) {
  return (mean * weight + prior * m) / (weight + m);
}

export function mergeCluster(records, origin) {
  const ordered = [...records].sort((a, b) => priorityOf(a.source) - priorityOf(b.source));
  const lat = ordered[0].lat;
  const lng = ordered[0].lng;
  const cuisines = [...new Set(ordered.flatMap((r) => r.cuisines || []))];
  const prices = ordered.map((r) => r.price).filter((p) => p != null);
  const blend = blendRatings(ordered);
  return {
    id: ordered.map((r) => `${r.source}:${r.id}`).join('|'),
    name: ordered[0].name,
    lat,
    lng,
    distance: origin ? Math.round(haversineMeters(origin, { lat, lng })) : null,
    address: firstDefined(ordered, 'address'),
    phone: firstDefined(ordered, 'phone'),
    website: firstDefined(ordered, 'website'),
    imageUrl: firstDefined(ordered, 'imageUrl'),
    price: prices.length ? Math.round(median(prices)) : null,
    cuisines,
    openNow: firstDefined(ordered, 'openNow'),
    rating: blend ? Math.round(blend.mean * 100) / 100 : null,
    ratingWeight: blend?.weight ?? 0,
    totalReviews: blend?.totalReviews ?? 0,
    disagreement: blend ? blend.spread >= SCORING.disagreementSpread : false,
    score: null,
    sources: ordered.map((r) => ({
      source: r.source,
      name: r.name,
      rating: r.rating,
      reviewCount: r.reviewCount,
      url: r.url,
    })),
  };
}

export function aggregate(records, origin, { radius } = {}) {
  let restaurants = clusterRecords(records).map((c) => mergeCluster(c, origin));
  if (radius && origin) {
    // Google's text search only biases toward the circle, so trim the overflow.
    restaurants = restaurants.filter((r) => r.distance <= radius * 1.1);
  }

  // Prior = review-weighted mean of this result set, so scores are relative
  // to the local market rather than a global constant.
  const rated = restaurants.filter((r) => r.rating != null);
  const totalW = rated.reduce((s, r) => s + r.ratingWeight, 0);
  const prior = totalW
    ? rated.reduce((s, r) => s + r.rating * r.ratingWeight, 0) / totalW
    : SCORING.defaultPrior;

  for (const r of restaurants) {
    if (r.rating == null) continue;
    r.score = Math.round(bayesian(r.rating, r.ratingWeight, prior) * 100) / 100;
  }

  restaurants.sort((a, b) => {
    if (a.score == null && b.score == null) return a.distance - b.distance;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return b.score - a.score || b.totalReviews - a.totalReviews;
  });

  // Tags computed after sorting so "top pick" is the true #1.
  const reviewCounts = rated.map((r) => r.totalReviews);
  const popularLine = Math.max(200, median(reviewCounts) * 3 || 0);
  restaurants.forEach((r, i) => {
    r.tags = [];
    if (i === 0 && r.score != null) r.tags.push('top-pick');
    if (r.score != null && r.score >= prior + 0.3 && r.totalReviews < popularLine / 2 && r.totalReviews >= 15) {
      r.tags.push('hidden-gem');
    }
    if (r.totalReviews >= popularLine && r.score != null && r.score >= prior) r.tags.push('crowd-favorite');
    if (r.disagreement) r.tags.push('mixed-reviews');
  });

  return { restaurants, prior: Math.round(prior * 100) / 100 };
}
